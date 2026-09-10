import type { ProjectedTurn } from "./http.ts"
import { authorize, parseOpenAIChatRequest, parseOpenAIResponsesRequest, requestSession } from "./http.ts"
import {
  collectOpenAIChatResult,
  openAIChatCompletion,
  openAIChatSSEChunks,
  openAIResponsesSSEChunks,
  type BrowserFrame,
  type OpenAIChatResult,
} from "./protocol.ts"
import { MODELS } from "./config.ts"
import { NoResponseEvidenceError, WebchatSafetyBlockError } from "./browser.ts"
import { streamingFrames } from "./stream-progress.ts"
import {
  SESSION_INITIALIZATION_MAX_BYTES,
  SessionInitializationCapacityError,
  SessionInitializationStore,
  sessionInitializationBytes,
  type SessionInitialization,
} from "./session-initialization.ts"

export interface BrowserService {
  turn(input: ProjectedTurn, signal?: AbortSignal): AsyncIterable<BrowserFrame>
  login(signal?: AbortSignal): Promise<void>
  discard?(sessionMarker: string): Promise<void>
  close(): Promise<void>
}

export interface RequestHandlerDependencies {
  readonly token: string
  readonly browser: BrowserService
  readonly shutdown: () => Promise<void>
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status })
}

function apiError(message: string, status: number, code: string, type = "invalid_request_error") {
  return json({ error: { message, type, param: null, code } }, status)
}

function safetyBlockError() {
  return {
    message: new WebchatSafetyBlockError().message,
    type: "browser_error",
    param: null,
    code: "webchat_safety_block",
  }
}

function sessionCapacityError() {
  return {
    message: "session initialization capacity is exhausted",
    type: "server_error",
    param: null,
    code: "session_initialization_capacity",
  }
}

function browserError(error: unknown) {
  if (error instanceof WebchatSafetyBlockError)
    return json({ error: safetyBlockError() }, 422)
  if (error instanceof NoResponseEvidenceError)
    return apiError(
      "browser submission produced activity but no recognizable assistant response",
      422,
      "browser_response_unrecognized",
      "browser_error",
    )
  return apiError(error instanceof Error ? error.message : "browser turn failed", 502, "upstream_error", "server_error")
}

function streamError(error: unknown, sequenceNumber?: number) {
  const detail = error instanceof WebchatSafetyBlockError ? safetyBlockError()
    : error instanceof SessionInitializationCapacityError ? sessionCapacityError()
    : { message: error instanceof Error ? error.message : "browser turn failed", code: "upstream_error", type: "server_error", param: null }
  return sequenceNumber === undefined
    ? `data: ${JSON.stringify({ error: detail })}\n\n`
    : `event: error\ndata: ${JSON.stringify({ ...detail, type: "error", sequence_number: sequenceNumber })}\n\n`
}

function modelObject(model: (typeof MODELS)[number]) {
  return {
    id: model.id,
    object: "model",
    created: 0,
    owned_by: "th-ai-passport",
    name: model.name,
    reasoning: ["none", ...model.thinking],
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: model.thinking.map((level) => ({ id: level, body: { reasoning: { mode: level } } })),
  }
}

async function* prepend(first: BrowserFrame, iterator: AsyncIterator<BrowserFrame>) {
  let completed = false
  try {
    yield first
    while (true) {
      const next = await iterator.next()
      if (next.done) {
        completed = true
        return
      }
      yield next.value
    }
  } finally {
    if (!completed) await iterator.return?.()
  }
}

function streamResponse(
  model: string,
  offered: ReadonlySet<string>,
  frames: AsyncIterable<BrowserFrame>,
  promptTokens: number,
  includeUsage: boolean,
  requireTool: boolean,
  onCancel: () => void,
) {
  const output = openAIChatSSEChunks(model, frames, offered, {
    promptTokens,
    includeUsage,
    requireTool,
  })[Symbol.asyncIterator]()
  const encoder = new TextEncoder()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await output.next()
        if (cancelled) return
        if (next.done) controller.close()
        else controller.enqueue(encoder.encode(next.value))
      } catch (error) {
        if (cancelled) return
        controller.enqueue(encoder.encode(streamError(error)))
        controller.close()
      }
    },
    async cancel(reason) {
      cancelled = true
      onCancel()
      await output.return?.(reason)
    },
  })
  return new Response(body, {
    headers: { "cache-control": "no-cache", "content-type": "text/event-stream" },
  })
}

function responsesObject(
  id: string,
  model: string,
  result: OpenAIChatResult,
  promptTokens: number,
) {
  const output: Array<Record<string, unknown>> = []
  if (result.reasoning)
    output.push({
      id: `rs_${crypto.randomUUID()}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: result.reasoning }],
    })
  if (result.text || !result.toolCalls.length)
    output.push({
      id: `msg_${crypto.randomUUID()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: result.text, annotations: [] }],
    })
  for (const call of result.toolCalls)
    output.push({
      id: `fc_${crypto.randomUUID()}`,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.input),
    })
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    parallel_tool_calls: true,
    usage: {
      input_tokens: promptTokens + result.promptTokens,
      output_tokens: result.completionTokens,
      total_tokens: promptTokens + result.promptTokens + result.completionTokens,
      estimated: true,
    },
  }
}

function responsesStreamResponse(
  responseID: string,
  model: string,
  offered: ReadonlySet<string>,
  frames: AsyncIterable<BrowserFrame>,
  promptTokens: number,
  requireTool: boolean,
  onComplete: (output: readonly Record<string, unknown>[]) => void,
  onAbort: () => Promise<void>,
  onCancel: () => void,
) {
  let completedOutput: readonly Record<string, unknown>[] = []
  const output = openAIResponsesSSEChunks(responseID, model, frames, offered, {
    promptTokens,
    requireTool,
    onCompletedOutput: (items) => { completedOutput = items },
  })[Symbol.asyncIterator]()
  const encoder = new TextEncoder()
  let cancelled = false
  let sequenceNumber = 0
  let settled = false
  const complete = () => {
    if (settled) return
    onComplete(completedOutput)
    settled = true
  }
  const abort = async () => {
    if (settled) return
    settled = true
    await onAbort()
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await output.next()
        if (cancelled) return
        if (next.done) {
          await abort()
          controller.close()
        } else {
          const completed = next.value.startsWith("event: response.completed\n")
          if (completed) complete()
          controller.enqueue(encoder.encode(next.value))
          sequenceNumber++
        }
      } catch (error) {
        await abort().catch((cleanupError) =>
          console.error(`aipass response stream cleanup failed type=${cleanupError instanceof Error ? cleanupError.name : "unknown"}`),
        )
        if (cancelled) return
        controller.enqueue(encoder.encode(streamError(error, sequenceNumber)))
        controller.close()
      }
    },
    async cancel(reason) {
      cancelled = true
      onCancel()
      try {
        await output.return?.(reason)
      } finally {
        await abort()
      }
    },
  })
  return new Response(body, {
    headers: { "cache-control": "no-cache", "content-type": "text/event-stream" },
  })
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { data: value }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function instructionMessages(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined
  const instructions = value.filter((candidate) => {
    const item = recordValue(candidate)
    return item.role === "system" || item.role === "developer"
  })
  return instructions.length ? instructions : undefined
}

function effectiveChatInitialization(
  input: Record<string, unknown>,
  retained: SessionInitialization | undefined,
): { readonly input: Record<string, unknown>; readonly initialization: SessionInitialization; readonly shouldRetain: boolean } {
  const explicitInstructions = instructionMessages(input.messages)
  const retainedInstructions = Array.isArray(retained?.instructions) ? retained.instructions : undefined
  const instructions = explicitInstructions ?? retainedInstructions
  const toolsPresent = hasOwn(input, "tools")
  const tools = toolsPresent ? input.tools : retained?.tools
  const effective = {
    ...input,
    ...(!explicitInstructions && instructions && Array.isArray(input.messages)
      ? { messages: [...instructions, ...input.messages] }
      : {}),
    ...(!toolsPresent && tools !== undefined ? { tools } : {}),
  }
  const initialization: SessionInitialization = {
    ...(instructions ? { instructions } : {}),
    ...(Array.isArray(tools) ? { tools } : {}),
  }
  return {
    input: effective,
    initialization,
    shouldRetain: retained !== undefined || explicitInstructions !== undefined || toolsPresent,
  }
}

function effectiveResponsesInitialization(
  input: Record<string, unknown>,
  retained: SessionInitialization | undefined,
): { readonly input: Record<string, unknown>; readonly initialization: SessionInitialization } {
  const instructionsPresent = hasOwn(input, "instructions")
  if (instructionsPresent && typeof input.instructions !== "string") throw new Error("instructions must be a string")
  const instructions = instructionsPresent ? input.instructions as string :
    typeof retained?.instructions === "string" ? retained.instructions : undefined
  const toolsPresent = hasOwn(input, "tools")
  const tools = toolsPresent ? input.tools : retained?.tools
  const effective = {
    ...input,
    ...(!instructionsPresent && instructions !== undefined ? { instructions } : {}),
    ...(!toolsPresent && tools !== undefined ? { tools } : {}),
  }
  return {
    input: effective,
    initialization: {
      ...(instructions !== undefined ? { instructions } : {}),
      ...(Array.isArray(tools) ? { tools } : {}),
    },
  }
}

function initializationCapacityError() {
  return json({ error: sessionCapacityError() }, 507)
}

function preflightRetainedInitialization(initialization: SessionInitialization): void {
  if (sessionInitializationBytes(initialization) > SESSION_INITIALIZATION_MAX_BYTES)
    throw new SessionInitializationCapacityError()
}

export function createRequestHandler(dependencies: RequestHandlerDependencies) {
  const responseHistoryBudget = 16 * 1024 * 1024
  let shutdownStarted = false
  const chatInitializations = new SessionInitializationStore()
  const responseSessions = new Map<string, {
    sessionMarker: string
    items: readonly unknown[]
    initialization: SessionInitialization
    bytes: number
  }>()
  const responseReservations = new Set<string>()
  let retainedResponseBytes = 0
  const forgetResponse = (id: string) => {
    const stored = responseSessions.get(id)
    if (!stored) return
    retainedResponseBytes -= stored.bytes
    responseSessions.delete(id)
  }
  const responseCapacityVictims = (bytes: number, previous?: string): string[] => {
    if (bytes > responseHistoryBudget) throw new SessionInitializationCapacityError()
    const predecessor = previous === undefined ? undefined : responseSessions.get(previous)
    let count = responseSessions.size - (predecessor ? 1 : 0) + 1
    let retained = retainedResponseBytes - (predecessor?.bytes ?? 0) + bytes
    const victims: string[] = []
    for (const [id, stored] of responseSessions) {
      if (count <= 1_000 && retained <= responseHistoryBudget) break
      if (id === previous || responseReservations.has(id)) continue
      victims.push(id)
      count--
      retained -= stored.bytes
    }
    if (count > 1_000 || retained > responseHistoryBudget)
      throw new SessionInitializationCapacityError()
    return victims
  }
  return async (request: Request) => {
    const failure = authorize(request.headers.get("authorization") ?? undefined, dependencies.token)
    if (failure) {
      console.error(
        `aipass auth failure reason=${failure.reason} provided_length=${failure.providedLength} expected_length=${failure.expectedLength}`,
      )
      return apiError("invalid bearer token", 401, "invalid_api_key", "authentication_error")
    }
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true })
    if (request.method === "GET" && url.pathname === "/v1/models")
      return json({
        object: "list",
        data: MODELS.map(modelObject),
      })
    if (request.method === "GET" && url.pathname.startsWith("/v1/models/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/models/".length))
      const selected = MODELS.find((model) => model.id === id)
      return selected ? json(modelObject(selected)) : apiError(`model ${id} was not found`, 404, "model_not_found")
    }
    if (request.method === "POST" && url.pathname === "/shutdown") {
      if (shutdownStarted) return apiError("provider shutdown is already in progress", 409, "shutdown_in_progress")
      shutdownStarted = true
      queueMicrotask(() => void dependencies.shutdown())
      return json({ ok: true })
    }
    if (request.method === "POST" && url.pathname === "/v1/responses") {
      let parsed: ReturnType<typeof parseOpenAIResponsesRequest>
      let responseInput: unknown
      let responseItems: readonly unknown[] = []
      let responseInitialization: SessionInitialization = {}
      let previous: string | undefined
      try {
        responseInput = await request.json()
        previous = recordValue(responseInput).previous_response_id as string | undefined
        if (previous !== undefined && typeof previous !== "string")
          return apiError("previous_response_id must be a string", 400, "invalid_request")
        const continuation = previous === undefined ? undefined : responseSessions.get(previous)
        if (previous !== undefined && continuation === undefined)
          return apiError(`previous_response_id ${previous} was not found`, 400, "previous_response_not_found")
        if (previous !== undefined && responseReservations.has(previous))
          return apiError(`previous_response_id ${previous} is already continuing`, 409, "previous_response_in_use")
        if (previous !== undefined) responseReservations.add(previous)
        const initialized = effectiveResponsesInitialization(recordValue(responseInput), continuation?.initialization)
        const body = initialized.input
        responseInitialization = initialized.initialization
        if (body.store !== false) preflightRetainedInitialization(responseInitialization)
        const currentItems = typeof body.input === "string"
          ? [{ role: "user", content: body.input }]
          : Array.isArray(body.input) ? body.input : undefined
        if (currentItems) {
          responseItems = [...(continuation?.items ?? []), ...currentItems]
          responseInput = { ...body, input: responseItems }
        }
        parsed = parseOpenAIResponsesRequest(responseInput, request.headers, continuation?.sessionMarker)
        if (parsed.store) {
          const baseBytes = Buffer.byteLength(JSON.stringify({
            items: responseItems,
            initialization: responseInitialization,
          }), "utf8")
          responseCapacityVictims(baseBytes, previous)
        }
      } catch (error) {
        if (previous !== undefined) responseReservations.delete(previous)
        if (error instanceof SessionInitializationCapacityError) return initializationCapacityError()
        return apiError(error instanceof Error ? error.message : "invalid response request", 400, "invalid_request")
      }
      const streamAbort = new AbortController()
      const rememberResponse = (output: readonly Record<string, unknown>[]) => {
        if (!parsed.store) return
        const items = [...responseItems, ...output]
        const bytes = Buffer.byteLength(JSON.stringify({ items, initialization: responseInitialization }), "utf8")
        const victims = responseCapacityVictims(bytes, previous)
        for (const id of victims) forgetResponse(id)
        if (previous !== undefined) {
          responseReservations.delete(previous)
          forgetResponse(previous)
        }
        responseSessions.set(parsed.responseID, {
          sessionMarker: parsed.turn.sessionMarker,
          items,
          initialization: responseInitialization,
          bytes,
        })
        retainedResponseBytes += bytes
      }
      if (parsed.stream) {
        const signal = AbortSignal.any([request.signal, streamAbort.signal])
        return responsesStreamResponse(
          parsed.responseID,
          parsed.turn.modelID,
          parsed.offered,
          streamingFrames(() => dependencies.browser.turn(parsed.turn, signal), signal),
          parsed.promptTokens,
          parsed.requireTool,
          rememberResponse,
          async () => {
            if (previous !== undefined) responseReservations.delete(previous)
            if (previous !== undefined) forgetResponse(previous)
            await dependencies.browser.discard?.(parsed.turn.sessionMarker)
          },
          () => streamAbort.abort(),
        )
      }
      let iterator: AsyncIterator<BrowserFrame>
      let first: IteratorResult<BrowserFrame>
      try {
        iterator = dependencies.browser.turn(parsed.turn, request.signal)[Symbol.asyncIterator]()
        first = await iterator.next()
      } catch (error) {
        if (previous !== undefined) responseReservations.delete(previous)
        return browserError(error)
      }
      if (first.done) {
        if (previous !== undefined) responseReservations.delete(previous)
        return apiError("browser turn ended before its first frame", 502, "upstream_error", "server_error")
      }
      if (first.value.type === "auth-required" || first.value.type === "error") {
        await iterator.return?.()
        if (previous !== undefined) responseReservations.delete(previous)
        return first.value.type === "auth-required"
          ? apiError("browser authentication is required", 428, "browser_authentication_required", "authentication_error")
          : apiError(first.value.message, 502, "upstream_error", "server_error")
      }
      try {
        const result = await collectOpenAIChatResult(prepend(first.value, iterator), parsed.offered, parsed.requireTool)
        const response = responsesObject(parsed.responseID, parsed.turn.modelID, result, parsed.promptTokens)
        rememberResponse(response.output)
        return json(response)
      } catch (error) {
        if (previous !== undefined) responseReservations.delete(previous)
        if (error instanceof SessionInitializationCapacityError) {
          if (previous !== undefined) forgetResponse(previous)
          await dependencies.browser.discard?.(parsed.turn.sessionMarker).catch((cleanupError) =>
            console.error(`aipass response cleanup failed type=${cleanupError instanceof Error ? cleanupError.name : "unknown"}`),
          )
          return initializationCapacityError()
        }
        return browserError(error)
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      let parsed: ReturnType<typeof parseOpenAIChatRequest>
      try {
        const input = recordValue(await request.json())
        const identified = typeof input.model === "string" && input.model
          ? requestSession(request.headers, input)
          : undefined
        const retained = identified && !identified.ephemeral
          ? chatInitializations.get(identified.marker)
          : undefined
        const initialized = effectiveChatInitialization(input, retained)
        if (identified && !identified.ephemeral && initialized.shouldRetain)
          preflightRetainedInitialization(initialized.initialization)
        parsed = parseOpenAIChatRequest(initialized.input, request.headers)
        // Admission is independent of upstream availability: once a valid
        // logical-session request updates initialization, a browser failure
        // must not make the next omitted-field retry lose that accepted state.
        if (identified && !identified.ephemeral && initialized.shouldRetain)
          chatInitializations.set(identified.marker, initialized.initialization)
      } catch (error) {
        if (error instanceof SessionInitializationCapacityError) return initializationCapacityError()
        return apiError(error instanceof Error ? error.message : "invalid chat request", 400, "invalid_request")
      }
      console.error(
        `aipass prompt projection offered=${parsed.offered.size} projected=${parsed.projectedActions.join(",")} offeredNames=${[...parsed.offered].join(",")} initial_chars=${parsed.turn.initialPrompt.length} incremental_chars=${parsed.turn.incrementalPrompt.length} promptTokens=${parsed.promptTokens}`,
      )
      let iterator: AsyncIterator<BrowserFrame>
      let first: IteratorResult<BrowserFrame>
      const streamAbort = new AbortController()
      if (parsed.stream) {
        const signal = AbortSignal.any([request.signal, streamAbort.signal])
        return streamResponse(
          parsed.turn.modelID,
          parsed.offered,
          streamingFrames(() => dependencies.browser.turn(parsed.turn, signal), signal),
          parsed.promptTokens,
          parsed.includeUsage,
          parsed.requireTool,
          () => streamAbort.abort(),
        )
      }
      try {
        iterator = dependencies.browser.turn(parsed.turn, request.signal)[Symbol.asyncIterator]()
        first = await iterator.next()
      } catch (error) {
        return browserError(error)
      }
      if (first.done) return apiError("browser turn ended before its first frame", 502, "upstream_error", "server_error")
      if (first.value.type === "auth-required") {
        await iterator.return?.()
        return apiError("browser authentication is required", 428, "browser_authentication_required", "authentication_error")
      }
      if (first.value.type === "error") {
        await iterator.return?.()
        return apiError(first.value.message, 502, "upstream_error", "server_error")
      }
      try {
        return json(
          await openAIChatCompletion(
            parsed.turn.modelID,
            prepend(first.value, iterator),
            parsed.offered,
            parsed.promptTokens,
            parsed.requireTool,
          ),
        )
      } catch (error) {
        return browserError(error)
      }
    }
    return apiError("not found", 404, "not_found")
  }
}
