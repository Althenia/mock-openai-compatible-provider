import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { model, type Reasoning } from "./config.ts"
import { INSTRUCTION_DIGEST_PREFIX_LENGTH, PROMPT_CONTRACT_VERSION, WEBCHAT_ROLE_INSTRUCTION, serializeToolDefinitions, validName } from "./protocol.ts"
import { compactionDigest, estimateTokens } from "./context.ts"

export interface OfferedToolSchema {
  readonly name: string
  readonly description?: string
  readonly inputSchema: unknown
}

// Per-turn repo nonce (uuidv7: time-ordered random). The submit carries it as
// TURN KEY; the response must echo it as envelope key, proving attribution.
export function randomTurnKey(): string {
  const bytes = randomBytes(16)
  const time = BigInt(Date.now())
  bytes[0] = Number((time >> 40n) & 0xffn)
  bytes[1] = Number((time >> 32n) & 0xffn)
  bytes[2] = Number((time >> 24n) & 0xffn)
  bytes[3] = Number((time >> 16n) & 0xffn)
  bytes[4] = Number((time >> 8n) & 0xffn)
  bytes[5] = Number(time & 0xffn)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export interface ProjectedTurn {
  readonly sessionMarker: string
  readonly ephemeral: boolean
  readonly primingPrompts: readonly string[]
  readonly modelID: string
  readonly reasoning: Reasoning
  readonly initialPrompt: string
  readonly incrementalPrompt: string
  readonly recoveryPrompt: string
  readonly compactionDigest?: string
  readonly promptContractVersion: number
  readonly actionEnvelopeDigest: string
  readonly toolContinuation: boolean
  readonly toolRepairPrompt?: string
  // Full offered tool-name set: validates locally converted untagged actions.
  readonly offeredActions: readonly string[]
  // Staged by the adapter (download/decode/copy, then +button upload); descriptors only.
  readonly attachments?: readonly RequestAttachment[]
  // Repo nonce submitted as TURN KEY; the response envelope must echo it.
  readonly promptKey?: string
  // Full offered schemas plus the subset whose full schema was shown up front.
  readonly offeredToolSchemas: readonly OfferedToolSchema[]
  readonly provisionedActions: readonly string[]
}

export interface ParsedChatRequest {
  readonly turn: ProjectedTurn
  readonly offered: ReadonlySet<string>
  readonly projectedActions: readonly string[]
  readonly stream: boolean
  readonly includeUsage: boolean
  readonly promptTokens: number
  readonly requireTool: boolean
}

export interface ParsedResponsesRequest extends ParsedChatRequest {
  readonly responseID: string
  readonly store: boolean
}

export type AuthFailureReason =
  | "missing_authorization"
  | "malformed_authorization"
  | "authorization_length_mismatch"
  | "token_mismatch"

export interface AuthFailure {
  readonly reason: AuthFailureReason
  readonly providedLength: number
  readonly expectedLength: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function attachmentPlaceholder(part: Record<string, unknown>): string | undefined {
  const kind = typeof part.type === "string" ? part.type : undefined
  const image = record(part.image_url)
  if (kind === "image_url" || image) {
    if (image && typeof image.url !== "string") return undefined
    return "[attachment:image]"
  }
  if (kind === "input_file" || kind === "file" || record(part.input_file) || record(part.file)) {
    const file = record(part.input_file) ?? record(part.file) ?? {}
    const name = typeof file.filename === "string" && file.filename ? `:${file.filename}` : ""
    return `[attachment:file${name}]`
  }
  return undefined
}

function content(value: unknown, field: string) {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (!Array.isArray(value)) throw new Error(`${field} content must be text`)
  return value
    .map((part, index) => {
      const item = record(part)
      if (!item) throw new Error(`${field} content part ${index} must be text`)
      if (typeof item.text === "string") return item.text
      const placeholder = attachmentPlaceholder(item)
      if (placeholder !== undefined) return placeholder
      throw new Error(`${field} content part ${index} must be text`)
    })
    .join("\n")
}

export interface RequestAttachment {
  readonly kind: "image" | "file"
  // Exactly one of url (https:, file:, or absolute path; staged by the adapter)
  // or data (base64 payload) is present.
  readonly url?: string
  readonly data?: string
  readonly mime?: string
  readonly filename?: string
}

// Parse-time bound on inline base64 payloads; remote/path sizes bind at staging.
const ATTACHMENT_INLINE_CAP = 15_000_000
const ATTACHMENT_COUNT_CAP = 5

function attachmentDescriptor(part: Record<string, unknown>, field: string, index: number): RequestAttachment | undefined {
  const kind = typeof part.type === "string" ? part.type : undefined
  const image = record(part.image_url)
  if (kind === "image_url" || image) {
    const url = image && typeof image.url === "string" ? image.url : undefined
    if (!url) throw new Error(`${field} content part ${index} image_url url is required`)
    const dataMatch = /^data:([^;,]+)?;base64,(.*)$/s.exec(url)
    if (dataMatch) {
      const payload = dataMatch[2] ?? ""
      if (payload.length > ATTACHMENT_INLINE_CAP) throw new Error(`${field} content part ${index} is too large`)
      return { kind: "image", data: payload, mime: dataMatch[1] }
    }
    if (/^https?:\/\//i.test(url) || url.startsWith("file://") || url.startsWith("/")) return { kind: "image", url }
    throw new Error(`${field} content part ${index} image_url must be https:, data:, file:, or an absolute path`)
  }
  const file = record(part.input_file) ?? record(part.file)
  if (kind === "input_file" || kind === "file" || file) {
    const source = file ?? {}
    if (typeof source.file_id === "string" && source.file_id) throw new Error(`${field} content part ${index} file_id references are not supported; send file_data`)
    const filename = typeof source.filename === "string" && source.filename ? source.filename : undefined
    const mime = typeof source.mime === "string" ? source.mime : undefined
    if (typeof source.file_data === "string" && source.file_data) {
      if (source.file_data.length > ATTACHMENT_INLINE_CAP) throw new Error(`${field} content part ${index} is too large`)
      return { kind: "file", data: source.file_data, mime, filename }
    }
    if (typeof source.url === "string" && source.url) {
      if (/^https?:\/\//i.test(source.url) || source.url.startsWith("file://") || source.url.startsWith("/"))
        return { kind: "file", url: source.url, mime, filename }
    }
    if (typeof source.path === "string" && source.path.startsWith("/")) return { kind: "file", url: source.path, mime, filename }
    throw new Error(`${field} content part ${index} file needs file_data, an https:/file: url, or an absolute path`)
  }
  return undefined
}

export function messageAttachments(messages: unknown): RequestAttachment[] {
  if (!Array.isArray(messages)) return []
  const found: RequestAttachment[] = []
  for (let index = 0; index < messages.length; index++) {
    const item = record(messages[index])
    if (!item || item.role !== "user" || !Array.isArray(item.content)) continue
    for (let partIndex = 0; partIndex < item.content.length; partIndex++) {
      const part = record(item.content[partIndex])
      if (!part) continue
      const descriptor = attachmentDescriptor(part, `messages[${index}]`, partIndex)
      if (descriptor) {
        if (found.length >= ATTACHMENT_COUNT_CAP) throw new Error(`messages[${index}] carries too many attachments (max ${ATTACHMENT_COUNT_CAP})`)
        found.push(descriptor)
      }
    }
  }
  return found
}

type MessageProjection = "instructions" | "conversation"

function stripLoweredSystemUpdates(value: string) {
  return value
    .replace(/(?:^|\n)<system-update>\n[\s\S]*?\n<\/system-update>(?=\n|$)/g, "")
    .trim()
}

function serializeMessages(value: unknown, projection: MessageProjection, omitLoweredSystemUpdates = false) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("messages must be a non-empty array")
  return value
    .flatMap((message, index) => {
      const item = record(message)
      if (!item) throw new Error(`messages[${index}] must be an object`)
      const role = item.role
      if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant" && role !== "tool")
        throw new Error(`messages[${index}].role is invalid`)
      const instruction = role === "system" || role === "developer"
      if ((projection === "instructions") !== instruction) return []
      const rawValue = content(item.content, `messages[${index}]`)
      const value =
        omitLoweredSystemUpdates && role === "user" ? stripLoweredSystemUpdates(rawValue) : rawValue
      if (omitLoweredSystemUpdates && role === "user" && rawValue && !value) return []
      if (role === "tool") {
        if (typeof item.tool_call_id !== "string" || !item.tool_call_id)
          throw new Error(`messages[${index}].tool_call_id is required`)
        return [`TOOL RESULT ${item.tool_call_id}: ${value}`]
      }
      const calls = Array.isArray(item.tool_calls)
        ? item.tool_calls.map((candidate, callIndex) => {
            const call = record(candidate)
            const function_ = record(call?.function)
            if (
              typeof call?.id !== "string" ||
              typeof function_?.name !== "string" ||
              !validName(function_.name) ||
              typeof function_.arguments !== "string" ||
              !function_.arguments
            )
              throw new Error(`messages[${index}].tool_calls[${callIndex}] is invalid`)
            return `TOOL CALL ${call.id} ${function_.name}: ${function_.arguments}`
          })
        : []
      const reasoning = role === "assistant" && typeof item.reasoning_content === "string" && item.reasoning_content
        ? [`ASSISTANT REASONING: ${item.reasoning_content}`]
        : []
      return [[...reasoning, `${String(role).toUpperCase()}: ${value}`, ...calls].join("\n")]
    })
    .join("\n\n")
}

function incrementalMessages(value: unknown, conversation: string, omitLoweredSystemUpdates = false) {
  if (!Array.isArray(value)) return conversation
  let latestAssistant = -1
  for (let index = 0; index < value.length; index++) {
    if (record(value[index])?.role === "assistant") latestAssistant = index
  }
  if (latestAssistant < 0) return conversation
  const suffix = value.slice(latestAssistant + 1)
  return suffix.length ? serializeMessages(suffix, "conversation", omitLoweredSystemUpdates) : conversation
}

function toolContinuation(value: unknown) {
  if (!Array.isArray(value)) return false
  for (let index = value.length - 1; index >= 0; index--) {
    const role = record(value[index])?.role
    if (role === "system" || role === "developer") continue
    if (role === "user") {
      const item = record(value[index])
      const messageText = stripLoweredSystemUpdates(content(item?.content, `messages[${index}]`))
      if (!messageText) continue
    }
    return role === "tool"
  }
  return false
}

function tools(value: unknown) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("tools must be an array")
  return value.map((candidate, index) => {
    const item = record(candidate)
    const function_ = record(item?.function)
    if (
      item?.type !== "function" ||
      typeof function_?.name !== "string" ||
      !validName(function_.name) ||
      !record(function_.parameters)
    )
      throw new Error(`tools[${index}] is invalid`)
    return {
      name: function_.name,
      description: typeof function_.description === "string" ? function_.description : undefined,
      inputSchema: function_.parameters,
    }
  })
}

function toolSelection(definitions: ReturnType<typeof tools>, value: unknown) {
  if (value === undefined || value === "auto") return { definitions, required: false }
  if (value === "none") return { definitions: [] as ReturnType<typeof tools>, required: false }
  if (value === "required") {
    if (definitions.length === 0) throw new Error("tool_choice required needs at least one tool")
    return { definitions, required: true }
  }
  const choice = record(value)
  const function_ = record(choice?.function)
  if (choice?.type !== "function" || typeof function_?.name !== "string")
    throw new Error("tool_choice must be auto, none, required, or a named function")
  const selected = definitions.filter((definition) => definition.name === function_.name)
  if (selected.length === 0) throw new Error(`tool_choice function ${function_.name} was not offered`)
  return { definitions: selected, required: true }
}

function shortDescription(value?: string): string {
  if (!value) return ""
  return value.split("\n")[0]?.trim().slice(0, 80) ?? ""
}

function toolNameIndex(offered: readonly { readonly name: string; readonly description?: string }[]): string {
  if (!offered.length) return ""
  const lines = offered.map((tool) => {
    const short = shortDescription(tool.description)
    return short ? `- ${tool.name}: ${short}` : `- ${tool.name}`
  })
  return `Offered tool index (complete; schemas follow within budget). Respond in English unless the user explicitly requests another language in their message. Tool shape: {"type":"tool","key":"<key>","id":"call_1","name":"offered_name","input":{}}.\n${lines.join("\n")}`
}

function declaredToolNames(messages: unknown): string[] {
  if (!Array.isArray(messages)) return []
  const declared: string[] = []
  for (const candidate of messages) {
    const item = record(candidate)
    if (!item || !Array.isArray(item.tool_calls)) continue
    for (const call of item.tool_calls) {
      const name = record(call)?.function ? record(record(call)?.function)?.name : undefined
      if (typeof name === "string" && validName(name) && !declared.includes(name)) declared.push(name)
    }
  }
  return declared
}

function escapeRegExp(value: string) {
  return value
    .split("")
    .map((ch) => (/[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch))
    .join("")
}

function latestUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return ""
  for (let index = messages.length - 1; index >= 0; index--) {
    const item = record(messages[index])
    if (!item || item.role !== "user") continue
    try {
      const text = content(item.content, `messages[${index}]`)
      const stripped = stripLoweredSystemUpdates(text).trim()
      if (stripped) return stripped
    } catch {
      continue
    }
  }
  return ""
}

export function namedOfferedTools(messages: unknown, offeredNames: readonly string[]): string[] {
  const text = latestUserText(messages)
  if (!text) return []
  return offeredNames.filter((name) => {
    if (!validName(name)) return false
    try {
      return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "i").test(text)
    } catch {
      return false
    }
  })
}

// File-operation verb aliases: tool-name matching alone misses "create a new
// file" / "delete the folder" because no offered tool is literally named
// "create" or "delete". Map file-op verbs to the offered mutation tools so
// create/update/delete of files/folders project full schemas up front:
// patch covers add/update/delete files, write covers create, edit covers
// update, shell covers delete/folder operations.
export function fileOpAliasedTools(messages: unknown, offeredNames: readonly string[]): string[] {
  const text = latestUserText(messages)
  if (!text) return []
  const hasFileNoun = /\b(files?|folders?|director(?:y|ies)|paths?|filenames?)\b/i.test(text)
  const hasMkdir = /\b(mkdir|rmdir)\b/i.test(text)
  if (!hasFileNoun && !hasMkdir) return []
  const verbCreate = /\b(creat\w*|add\w*|\bnew\b|writ\w*)\b/i.test(text)
  const verbUpdate = /\b(updat\w*|edit\w*|modif\w*|patch\w*|fix\w*|chang\w*|append\w*)\b/i.test(text)
  const verbDelete = /\b(delet\w*|remov\w*|\brm\b|\bdel\b|rmdir|unlink)\b/i.test(text)
  if (!verbCreate && !verbUpdate && !verbDelete) return []
  const out: string[] = []
  const take = (name: string) => {
    if (offeredNames.includes(name) && !out.includes(name)) out.push(name)
  }
  // patch is the only file delete path (Add/Update/Delete File headers).
  take("patch")
  if (verbCreate) take("write")
  if (verbUpdate) take("edit")
  if (verbDelete || hasMkdir || /\b(folders?|director(?:y|ies))\b/i.test(text)) take("shell")
  return out
}

function session(headers: Headers, input: Record<string, unknown>, override?: string | null) {
  if (override === null) return { marker: `anon_${randomUUID()}`, ephemeral: true }
  const raw =
    override ??
    headers.get("x-session-id") ??
    headers.get("x-session-affinity") ??
    headers.get("x-client-request-id") ??
    (typeof input.session_id === "string" ? input.session_id : undefined) ??
    (typeof input.prompt_cache_key === "string" ? input.prompt_cache_key : undefined) ??
    (typeof input.previous_response_id === "string" ? input.previous_response_id : undefined) ??
    (typeof input.user === "string" ? input.user : undefined)
  if (raw === null || raw === undefined) return { marker: `anon_${randomUUID()}`, ephemeral: true }
  const value = raw.trim()
  if (!value || value.length > 256 || [...value].some((character) => /[\u0000-\u001f\u007f]/.test(character)))
    throw new Error("session identifier is invalid")
  return { marker: value, ephemeral: false }
}

function responsesMessages(input: Record<string, unknown>) {
  const messages: Array<Record<string, unknown>> = []
  if (typeof input.instructions === "string" && input.instructions)
    messages.push({ role: "developer", content: input.instructions })
  if (typeof input.input === "string") messages.push({ role: "user", content: input.input })
  else if (Array.isArray(input.input)) {
    for (const [index, candidate] of input.input.entries()) {
      const item = record(candidate)
      if (!item) throw new Error(`input[${index}] must be an object`)
      if (item.type === "function_call") {
        if (
          typeof item.call_id !== "string" ||
          typeof item.name !== "string" ||
          typeof item.arguments !== "string"
        )
          throw new Error(`input[${index}] function_call is invalid`)
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [{ id: item.call_id, function: { name: item.name, arguments: item.arguments } }],
        })
      } else if (item.type === "function_call_output") {
        if (typeof item.call_id !== "string") throw new Error(`input[${index}] function_call_output is invalid`)
        messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output })
      } else if (item.type === "reasoning") {
        if (!Array.isArray(item.summary)) throw new Error(`input[${index}] reasoning summary must be an array`)
        messages.push({ role: "assistant", content: "", reasoning_content: content(item.summary, `input[${index}].summary`) })
      } else {
        const role = item.role ?? "user"
        messages.push({ role, content: item.content })
      }
    }
  } else throw new Error("input must be text or an array")
  if (messages.every((message) => message.role === "system" || message.role === "developer"))
    throw new Error("input must include a conversation message")
  return messages
}

export function parseOpenAIResponsesRequest(
  value: unknown,
  headers: Headers,
  continuationSession?: string,
): ParsedResponsesRequest {
  const input = record(value)
  if (!input) throw new Error("request body must be an object")
  if (input.store === false && input.previous_response_id !== undefined)
    throw new Error("store false cannot continue a stored response")
  const responseID = `resp_${randomUUID()}`
  const store = input.store !== false
  const responseTools = input.tools === undefined
    ? undefined
    : Array.isArray(input.tools)
      ? input.tools.map((candidate, index) => {
          const tool = record(candidate)
          if (tool?.type !== "function" || typeof tool.name !== "string" || !record(tool.parameters))
            throw new Error(`tools[${index}] is invalid`)
          return {
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          }
        })
      : input.tools
  const responseChoice = record(input.tool_choice)
  const toolChoice =
    responseChoice?.type === "function" && typeof responseChoice.name === "string"
      ? { type: "function", function: { name: responseChoice.name } }
      : input.tool_choice
  const parsed = parseOpenAIChatRequest(
    {
      ...input,
      messages: responsesMessages(input),
      tools: responseTools,
      tool_choice: toolChoice,
      reasoning: record(input.reasoning)?.effort
        ? { mode: record(input.reasoning)?.effort }
        : input.reasoning,
      session_id: continuationSession ?? (store ? responseID : undefined),
    },
    headers,
    continuationSession ?? (store ? responseID : null),
  )
  return { ...parsed, responseID, store }
}

export function parseOpenAIChatRequest(value: unknown, headers: Headers, sessionOverride?: string | null): ParsedChatRequest {
  const input = record(value)
  if (!input || typeof input.model !== "string" || !input.model) throw new Error("model is required")
  if (input.n !== undefined && input.n !== 1) throw new Error("n must be 1")
  if (input.logprobs === true) throw new Error("logprobs are not supported")
  const responseFormat = record(input.response_format)?.type
  if (responseFormat !== undefined && responseFormat !== "text")
    throw new Error("only text response_format is supported")
  model(input.model)
  const sessionValue = session(headers, input, sessionOverride)
  const sessionMarker = sessionValue.marker
  const instructionMode = input.instruction_mode ?? "preserve"
  if (instructionMode !== "preserve" && instructionMode !== "action-only")
    throw new Error("instruction_mode must be preserve or action-only")
  // Validate before projecting individual instruction messages so original
  // system/developer boundaries and ordering survive transport.
  serializeMessages(input.messages, "instructions")
  const instructions = instructionMode === "action-only" ? [] : (input.messages as unknown[])
    .filter(message => ["system", "developer"].includes(String(record(message)?.role)))
    .map(message => serializeMessages([message], "instructions"))
  const primingPrompts = [WEBCHAT_ROLE_INSTRUCTION, ...instructions].map(prompt =>
    `${prompt}\n\nStartup instruction only. No task or turn key yet. Acknowledge briefly with READY, then wait for the next submission. Do not request actions during startup.`,
  )
  const omitLoweredSystemUpdates = instructionMode === "action-only"
  const conversation = serializeMessages(input.messages, "conversation", omitLoweredSystemUpdates)
  const incrementalTranscript = incrementalMessages(input.messages, conversation, omitLoweredSystemUpdates)
  const selection = toolSelection(tools(input.tools), input.tool_choice)
  const stream = input.stream === true
  if (stream && selection.required) throw new Error("streaming with required tool_choice is not supported")
  const offeredTools = selection.definitions
  const continuingTool = toolContinuation(input.messages)
  // Agentic routing: every submit carries the full offered NAME index (names
  // plus one-line short descriptions, always fits the byte budget, never
  // capped). The model declares intent through the typed envelope; full JSON
  // schemas are provisioned for declared/named tools within the submit budget.
  // Tools arrive via the OpenAI request tools[] and differ per harness
  // (codex/claude/opencode/pi/ycoding). Live evidence: a 17-tool full-schema
  // start prompt (~24k chars) stalls with no response frames; the budgeted
  // projection answers. Chat answers need no schemas.
  const TOOL_CONTRACT_SUBMIT_BUDGET = 3_000
  const declared = declaredToolNames(input.messages)
  const offeredNames = offeredTools.map((tool) => tool.name)
  const named = [...new Set([...namedOfferedTools(input.messages, offeredNames), ...fileOpAliasedTools(input.messages, offeredNames)])]
  const provisionCandidates = selection.required
    ? offeredTools
    : offeredTools.filter((tool) => declared.includes(tool.name) || named.includes(tool.name))
  // Stall protection on schema bodies only, never on the name index.
  // Explicitly named offered tools are exempt from the cumulative budget:
  // a live latest-request mention always projects its full schema even when
  // its singleton body exceeds the budget. Budget applies only to non-named
  // (declared-only) candidates; declared-plus-named ordering is preserved.
  const namedSet = new Set(named)
  const nonNamedCandidates = provisionCandidates.filter((tool) => !namedSet.has(tool.name))
  const budgetedNonNamed = nonNamedCandidates.filter(
    (_, index) =>
      serializeToolDefinitions(nonNamedCandidates.slice(0, index + 1)).length <= TOOL_CONTRACT_SUBMIT_BUDGET,
  )
  const budgetedNonNamedSet = new Set(budgetedNonNamed.map((tool) => tool.name))
  const provisioned =
    selection.required
      ? provisionCandidates
      : provisionCandidates.filter(
          (tool) => namedSet.has(tool.name) || budgetedNonNamedSet.has(tool.name),
        )
  const nameIndex = toolNameIndex(offeredTools)
  const schemaContract = serializeToolDefinitions(provisioned, offeredTools.length > 0, false)
  const actionContract = [schemaContract, nameIndex].filter(Boolean).join("\n")
  // Repair re-provides the full offered set: a decline often means the capped
  // projection hid the needed tool. Concise-natural contracts answer fast at
  // this size (measured); dense-synthetic extremes may still idle out once.
  const offeredContract = serializeToolDefinitions(offeredTools)
  const requiredNotice =
    selection.required && provisioned.length > 0
      ? "You must request one of the available actions before giving a final answer."
      : ""
  const toolDefinitions = [actionContract, requiredNotice].filter(Boolean).join("\n")
  // Startup is submitted serially by the browser. Every task still carries
  // current action schemas and chronological conversation, not startup text.
  // The guard itself is injected at submit time (withTurnKey), so it need
  // not be duplicated in the projected prompts here.
  const initialPrompt = [toolDefinitions, conversation].filter(Boolean).join("\n")
  const autoToolChoice = input.tool_choice === undefined || input.tool_choice === "auto"
  const toolRepairPrompt = autoToolChoice && offeredTools.length > 0
    ? [
        "Re-evaluate only whether the available client actions change your previous response.",
        "Do not override safety, privacy, authorization, or policy restrictions.",
        "If the previous response declined solely because you believed no client action was available and an action is needed for the unresolved latest user request, emit exactly one action frame now.",
        "Otherwise preserve the prior refusal or answer normally.",
        offeredContract,
      ].join("\n")
    : undefined
  const rawActionEnvelopeDigest = createHash("sha256")
    .update(JSON.stringify([PROMPT_CONTRACT_VERSION, primingPrompts, toolDefinitions]))
    .digest("hex")
  // Keep instruction identity separate so tool-schema provisioning can reuse
  // a continuation without suppressing a changed preserved instruction block.
  const instructionDigest = createHash("sha256").update(JSON.stringify(primingPrompts)).digest("hex")
  const actionEnvelopeDigest = [
    instructionMode === "action-only" ? "a0" : "b0",
    instructionDigest.slice(0, INSTRUCTION_DIGEST_PREFIX_LENGTH - 2),
    rawActionEnvelopeDigest.slice(INSTRUCTION_DIGEST_PREFIX_LENGTH),
  ].join("")
  // Bound incremental turns are delta-only, like real LLM inference: the
  // remote chat already holds the system/agents instructions (primed once),
  // prior history, and previously shown schemas. Tool continuations resend
  // only their schemas plus the latest delta (results since the last
  // assistant message), never the full call/result chain. Full history is
  // resent only via the recovery path (contract change / reload /
  // compaction) or the repair/provision fallback.
  // Preserve mode keeps the full initial shape for the first turn; the
  // incremental delta alone routes bound continuations.
  const incrementalPrompt = instructionMode === "preserve" && !continuingTool
    ? initialPrompt
    : continuingTool
      ? [toolDefinitions, incrementalTranscript].filter(Boolean).join("\n")
      : incrementalTranscript
  // A recovery reload has no bound remote history, so it replays the full
  // conversation: the model needs the preceding request for context.
  const recoveryConversation = conversation
  // Recovery replays the full contract: no bound history survives a reload.
  const recoveryPrompt = [toolDefinitions, recoveryConversation].filter(Boolean).join("\n")
  const reasoningMode = record(input.reasoning)?.mode ?? record(input.reasoning)?.effort
  if (
    reasoningMode !== undefined &&
    input.reasoning_effort !== undefined &&
    reasoningMode !== input.reasoning_effort
  )
    throw new Error("reasoning.mode conflicts with reasoning_effort")
  const reasoningValue = reasoningMode ?? input.reasoning_effort ?? "none"
  if (!["none", "low", "medium", "high", "max"].includes(String(reasoningValue)))
    throw new Error("reasoning.mode is invalid")
  return {
    turn: {
      sessionMarker,
      ephemeral: sessionValue.ephemeral,
      primingPrompts,
      modelID: input.model,
      reasoning: reasoningValue as Reasoning,
      initialPrompt,
      incrementalPrompt,
      recoveryPrompt,
      compactionDigest: compactionDigest(input.messages),
      promptContractVersion: PROMPT_CONTRACT_VERSION,
      actionEnvelopeDigest,
      toolContinuation: continuingTool,
      toolRepairPrompt: continuingTool ? undefined : toolRepairPrompt,
      offeredActions: offeredTools.map((tool) => tool.name),
      attachments: messageAttachments(input.messages),
      promptKey: randomTurnKey(),
      offeredToolSchemas: offeredTools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
      })),
      provisionedActions: provisioned.map((tool) => tool.name),
    },
    offered: new Set(offeredTools.map((tool) => tool.name)),
    projectedActions: provisioned.map((tool) => tool.name),
    stream,
    includeUsage: record(input.stream_options)?.include_usage === true,
    promptTokens: estimateTokens(initialPrompt) + primingPrompts.reduce((total, prompt) => total + estimateTokens(prompt), 0),
    requireTool: selection.required,
  }
}

export function authorize(value: string | undefined, credential: string): AuthFailure | undefined {
  const expected = `Bearer ${credential}`
  if (value === undefined)
    return { reason: "missing_authorization", providedLength: 0, expectedLength: expected.length }
  const token = value.startsWith("Bearer ") ? value.slice(7) : undefined
  if (!token || /\s/.test(token))
    return {
      reason: "malformed_authorization",
      providedLength: value.length,
      expectedLength: expected.length,
    }
  if (value.length !== expected.length)
    return {
      reason: "authorization_length_mismatch",
      providedLength: value.length,
      expectedLength: expected.length,
    }
  if (!timingSafeEqual(Buffer.from(value), Buffer.from(expected)))
    return { reason: "token_mismatch", providedLength: value.length, expectedLength: expected.length }
  return undefined
}
