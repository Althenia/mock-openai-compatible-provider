import type { ProjectedTurn } from "./http.ts"
import { authorize, parseOpenAIChatRequest, parseOpenAIResponsesRequest } from "./http.ts"
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

function browserError(error: unknown) {
  if (error instanceof WebchatSafetyBlockError)
    return apiError(
      "webchat safety filter blocked the response; revise the prompt and retry explicitly",
      422,
      "webchat_safety_block",
      "browser_error",
    )
  if (error instanceof NoResponseEvidenceError)
    return apiError(
      "browser submission produced activity but no recognizable assistant response",
      422,
      "browser_response_unrecognized",
      "browser_error",
    )
  return apiError(error instanceof Error ? error.message : "browser turn failed", 502, "upstream_error", "server_error")
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
  first: BrowserFrame,
  iterator: AsyncIterator<BrowserFrame>,
  promptTokens: number,
  includeUsage: boolean,
  requireTool: boolean,
  onCancel: () => void,
) {
  const output = openAIChatSSEChunks(model, prepend(first, iterator), offered, {
    promptTokens,
    includeUsage,
    requireTool,
  })[Symbol.asyncIterator]()
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await output.next()
        if (next.done) controller.close()
        else controller.enqueue(encoder.encode(next.value))
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) {
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
      input_tokens: promptTokens,
      output_tokens: result.completionTokens,
      total_tokens: promptTokens + result.completionTokens,
      estimated: true,
    },
  }
}

function responsesStreamResponse(
  responseID: string,
  model: string,
  offered: ReadonlySet<string>,
  first: BrowserFrame,
  iterator: AsyncIterator<BrowserFrame>,
  promptTokens: number,
  requireTool: boolean,
  onComplete: (output: readonly Record<string, unknown>[]) => void,
  onAbort: () => Promise<void>,
  onCancel: () => void,
) {
  let completedOutput: readonly Record<string, unknown>[] = []
  const output = openAIResponsesSSEChunks(responseID, model, prepend(first, iterator), offered, {
    promptTokens,
    requireTool,
    onCompletedOutput: (items) => { completedOutput = items },
  })[Symbol.asyncIterator]()
  const encoder = new TextEncoder()
  let settled = false
  const complete = () => {
    if (settled) return
    settled = true
    onComplete(completedOutput)
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
        if (next.done) {
          await abort()
          controller.close()
        } else {
          const completed = next.value.startsWith("event: response.completed\n")
          controller.enqueue(encoder.encode(next.value))
          if (completed) complete()
        }
      } catch (error) {
        await abort().catch((cleanupError) =>
          console.error(`aipass response stream cleanup failed type=${cleanupError instanceof Error ? cleanupError.name : "unknown"}`),
        )
        controller.error(error)
      }
    },
    async cancel(reason) {
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

export function createRequestHandler(dependencies: RequestHandlerDependencies) {
  const responseHistoryBudget = 16 * 1024 * 1024
  let shutdownStarted = false
  const responseSessions = new Map<string, { sessionMarker: string; items: readonly unknown[]; bytes: number }>()
  const responseReservations = new Set<string>()
  let retainedResponseBytes = 0
  const forgetResponse = (id: string) => {
    const stored = responseSessions.get(id)
    if (!stored) return
    retainedResponseBytes -= stored.bytes
    responseSessions.delete(id)
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
        const body = recordValue(responseInput)
        const currentItems = typeof body.input === "string"
          ? [{ role: "user", content: body.input }]
          : Array.isArray(body.input) ? body.input : undefined
        if (currentItems) {
          responseItems = [...(continuation?.items ?? []), ...currentItems]
          responseInput = { ...body, input: responseItems }
        }
        parsed = parseOpenAIResponsesRequest(responseInput, request.headers, continuation?.sessionMarker)
      } catch (error) {
        if (previous !== undefined) responseReservations.delete(previous)
        return apiError(error instanceof Error ? error.message : "invalid response request", 400, "invalid_request")
      }
      let iterator: AsyncIterator<BrowserFrame>
      let first: IteratorResult<BrowserFrame>
      const streamAbort = new AbortController()
      try {
        const signal = parsed.stream ? AbortSignal.any([request.signal, streamAbort.signal]) : request.signal
        iterator = dependencies.browser.turn(parsed.turn, signal)[Symbol.asyncIterator]()
        first = await iterator.next()
      } catch (error) {
        if (previous !== undefined) responseReservations.delete(previous)
        return browserError(error)
      }
      if (first.done) {
        if (previous !== undefined) responseReservations.delete(previous)
        return apiError("browser turn ended before its first frame", 502, "upstream_error", "server_error")
      }
      if (first.value.type === "auth-required") {
        await iterator.return?.()
        if (previous !== undefined) responseReservations.delete(previous)
        return apiError("browser authentication is required", 428, "browser_authentication_required", "authentication_error")
      }
      if (first.value.type === "error") {
        await iterator.return?.()
        if (previous !== undefined) responseReservations.delete(previous)
        return apiError(first.value.message, 502, "upstream_error", "server_error")
      }
      const rememberResponse = (output: readonly Record<string, unknown>[]) => {
        if (previous !== undefined) {
          responseReservations.delete(previous)
          forgetResponse(previous)
        }
        if (!parsed.store) return
        const items = [...responseItems, ...output]
        const bytes = Buffer.byteLength(JSON.stringify(items), "utf8")
        if (bytes > responseHistoryBudget) return
        responseSessions.set(parsed.responseID, { sessionMarker: parsed.turn.sessionMarker, items, bytes })
        retainedResponseBytes += bytes
        for (const id of responseSessions.keys()) {
          if (responseSessions.size <= 1_000 && retainedResponseBytes <= responseHistoryBudget) break
          if (!responseReservations.has(id)) forgetResponse(id)
        }
      }
      if (parsed.stream) {
        return responsesStreamResponse(
          parsed.responseID,
          parsed.turn.modelID,
          parsed.offered,
          first.value,
          iterator,
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
      try {
        const result = await collectOpenAIChatResult(prepend(first.value, iterator), parsed.offered, parsed.requireTool)
        const response = responsesObject(parsed.responseID, parsed.turn.modelID, result, parsed.promptTokens)
        rememberResponse(response.output)
        return json(response)
      } catch (error) {
        if (previous !== undefined) responseReservations.delete(previous)
        return browserError(error)
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      let parsed: ReturnType<typeof parseOpenAIChatRequest>
      try {
        parsed = parseOpenAIChatRequest(await request.json(), request.headers)
      } catch (error) {
        return apiError(error instanceof Error ? error.message : "invalid chat request", 400, "invalid_request")
      }
      console.error(
        `aipass prompt projection offered=${parsed.offered.size} projected=${parsed.projectedActions.join(",")} offeredNames=${[...parsed.offered].join(",")} initial_chars=${parsed.turn.initialPrompt.length} incremental_chars=${parsed.turn.incrementalPrompt.length} promptTokens=${parsed.promptTokens}`,
      )
      let iterator: AsyncIterator<BrowserFrame>
      let first: IteratorResult<BrowserFrame>
      const streamAbort = new AbortController()
      try {
        const signal = parsed.stream ? AbortSignal.any([request.signal, streamAbort.signal]) : request.signal
        iterator = dependencies.browser.turn(parsed.turn, signal)[Symbol.asyncIterator]()
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
      if (parsed.stream)
        return streamResponse(
          parsed.turn.modelID,
          parsed.offered,
          first.value,
          iterator,
          parsed.promptTokens,
          parsed.includeUsage,
          parsed.requireTool,
          () => streamAbort.abort(),
        )
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
