import { randomUUID } from "node:crypto"
import { estimateTokens } from "./context.ts"

export type FinishReason = "stop" | "length" | "tool-calls"
export type BrowserFrame =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "reasoning"; readonly delta: string; readonly domTurnKey?: string }
  | { readonly type: "tool-call"; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
  | { readonly type: "finish"; readonly reason: FinishReason }
  | { readonly type: "auth-required" }
  | { readonly type: "error"; readonly message: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(value: unknown) {
  return typeof value === "string" && value.length ? value : undefined
}

function finishReason(...values: unknown[]): FinishReason {
  for (const value of values) {
    if (value === "length") return "length"
    if (value === "tool-calls" || value === "tool_calls") return "tool-calls"
    if (value === "stop") return "stop"
  }
  return "stop"
}

function normalize(value: unknown): BrowserFrame[] {
  const item = record(value)
  if (!item) return []
  const type = item.type ?? item.event
  const payload = record(item.payload) ?? item
  if (type === "text" || type === "text-delta") {
    const delta = text(payload.delta) ?? text(payload.text)
    return delta ? [{ type: "text", delta }] : []
  }
  if (type === "reasoning" || type === "reasoning-delta") {
    const delta = text(payload.delta) ?? text(payload.text)
    return delta ? [{ type: "reasoning", delta }] : []
  }
  if (type === "finish" || type === "done")
    return [{ type: "finish", reason: finishReason(payload.finishReason, payload.finish_reason, payload.reason) }]
  if (type === "auth-required" || type === "unauthorized") return [{ type: "auth-required" }]
  if (type === "error") return [{ type: "error", message: text(payload.message) ?? "Browser stream failed" }]

  const choice = record(Array.isArray(item.choices) ? item.choices[0] : undefined)
  const delta = record(choice?.delta)
  const frames: BrowserFrame[] = []
  const reasoning = text(delta?.reasoning) ?? text(delta?.reasoning_content)
  const content = text(delta?.content)
  if (reasoning) frames.push({ type: "reasoning", delta: reasoning })
  if (content) frames.push({ type: "text", delta: content })
  if (choice?.finish_reason !== undefined && choice.finish_reason !== null)
    frames.push({ type: "finish", reason: finishReason(choice.finish_reason) })
  return frames
}

export class StreamFrameParser {
  private buffer = ""
  private readonly sse: string[] = []

  push(chunk: string) {
    this.buffer += chunk
    const frames: BrowserFrame[] = []
    while (true) {
      const newline = this.buffer.indexOf("\n")
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).replace(/\r$/, "")
      this.buffer = this.buffer.slice(newline + 1)
      this.line(line, frames)
    }
    return frames
  }

  finish() {
    const frames: BrowserFrame[] = []
    if (this.buffer.length) {
      const line = this.buffer.replace(/\r$/, "")
      this.buffer = ""
      this.line(line, frames)
    }
    this.block(frames)
    return frames
  }

  private line(line: string, frames: BrowserFrame[]) {
    if (!line) return this.block(frames)
    if (line.startsWith("data:")) {
      this.sse.push(line.slice(5).trimStart())
      return
    }
    if (line.startsWith(":") || line.startsWith("event:") || line.startsWith("id:")) return
    this.candidate(line.trim(), frames)
  }

  private block(frames: BrowserFrame[]) {
    if (!this.sse.length) return
    const candidate = this.sse.splice(0).join("\n").trim()
    this.candidate(candidate, frames)
  }

  private candidate(candidate: string, frames: BrowserFrame[]) {
    if (candidate === "[DONE]") {
      frames.push({ type: "finish", reason: "stop" })
      return
    }
    if (!candidate) return
    try {
      frames.push(...normalize(JSON.parse(candidate)))
    } catch {
      // Vendor heartbeat and incomplete non-data records carry no model content.
    }
  }
}

const OPEN = "<aipass-action>"
const CLOSE = "</aipass-action>"
export const PROMPT_CONTRACT_VERSION = 24
// Mode (2 hex characters) plus a 128-bit fingerprint of projected instructions.
export const INSTRUCTION_DIGEST_PREFIX_LENGTH = 34
const MAX_TOOL_FRAME = 64 * 1024
const NAME = /^[A-Za-z0-9_.:-]{1,128}$/

export class StructuredToolShim {
  private buffer = ""

  constructor(private readonly allowed: ReadonlySet<string>) {}

  push(chunk: string): BrowserFrame[] {
    this.buffer += chunk
    const output: BrowserFrame[] = []
    while (true) {
      const open = this.buffer.indexOf(OPEN)
      if (open < 0) {
        let keep = 0
        for (let length = Math.min(this.buffer.length, OPEN.length - 1); length > 0; length--) {
          if (this.buffer.endsWith(OPEN.slice(0, length))) {
            keep = length
            break
          }
        }
        const emit = this.buffer.slice(0, this.buffer.length - keep)
        this.buffer = this.buffer.slice(this.buffer.length - keep)
        if (emit) output.push({ type: "text", delta: emit })
        break
      }
      if (open > 0) {
        output.push({ type: "text", delta: this.buffer.slice(0, open) })
        this.buffer = this.buffer.slice(open)
      }
      const close = this.buffer.indexOf(CLOSE, OPEN.length)
      if (close < 0) {
        if (this.buffer.length > MAX_TOOL_FRAME) throw new Error("structured tool frame exceeds size limit")
        break
      }
      const raw = this.buffer.slice(OPEN.length, close)
      this.buffer = this.buffer.slice(close + CLOSE.length)
      const item = record(JSON.parse(raw))
      if (!item || typeof item.id !== "string" || !NAME.test(item.id))
        throw new Error("structured tool id is invalid")
      if (typeof item.name !== "string" || !NAME.test(item.name))
        throw new Error("structured tool name is invalid")
      if (!this.allowed.has(item.name)) throw new Error(`tool ${item.name} was not offered`)
      const input = record(item.input)
      if (!input) throw new Error("structured tool input must be an object")
      output.push({ type: "tool-call", id: item.id, name: item.name, input })
    }
    return output
  }

  finish() {
    if (this.buffer.includes(OPEN)) throw new Error("structured tool frame is incomplete")
    const value = this.buffer
    this.buffer = ""
    return value ? ([{ type: "text", delta: value }] satisfies BrowserFrame[]) : []
  }
}

export function validName(value: string) {
  return NAME.test(value)
}

export const ENVELOPE_OPEN = "<aipass-envelope>"
export const ENVELOPE_CLOSE = "</aipass-envelope>"
const ENVELOPE_TYPES = new Set(["chat", "tool", "plan", "subagent", "skill", "question", "permission", "thinking"])

export function isActionEnvelopeType(value: unknown): boolean {
  return typeof value === "string" && ENVELOPE_TYPES.has(value) && value !== "chat" && value !== "thinking"
}

function envelopeInput(value: unknown): Record<string, unknown> {
  const input = record(value)
  if (input) return input
  if (value === undefined) return {}
  throw new Error("typed envelope input must be an object")
}

function normalizeQuestionInput(
  item: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (Array.isArray(input.questions) && input.questions.length > 0) return input
  const candidate =
    text(input.text) ??
    text(input.message) ??
    text(input.content) ??
    text(input.query) ??
    text(input.ask) ??
    text(item.text) ??
    text(item.message) ??
    text(item.content) ??
    text(item.query) ??
    text(item.ask)
  if (candidate === undefined) return input
  return { questions: [{ question: candidate, header: candidate, options: [] }] }
}

function envelopeID(value: unknown): string {
  if (typeof value === "string" && NAME.test(value)) return value
  return `call_${randomUUID()}`
}

// Narrow repair for model-malformed chat/thinking envelopes whose free-prose
// text contains unescaped quotes (live evidence: a rating answer containing
// "Version 1" broke JSON.parse, so the raw envelope leaked to the client as
// chat text). The envelope candidate INCLUDES its outer braces; the body is
// everything between them. The text field is last in practice, so the text
// ends at the quote immediately before the envelope close (the body's last
// char). Interior quotes survive verbatim. Only chat/thinking qualify;
// tool-bearing envelopes stay strict.
export function repairMalformedTextEnvelope(candidate: string): string | undefined {
  // Only malformed input qualifies: valid envelopes parse without repair.
  try {
    JSON.parse(candidate)
    return undefined
  } catch {
    // Fall through to repair below.
  }
  const outer = /^\s*\{([\s\S]*)\}\s*$/.exec(candidate)
  if (!outer) return undefined
  const head = /^\s*"type"\s*:\s*"(chat|thinking)"\s*,/.exec(outer[1] ?? "")
  if (!head) return undefined
  const type = head[1]!
  const body = (outer[1] ?? "").slice(head[0].length)
  const textKey = /"(text|message|content)"\s*:\s*"/.exec(body)
  if (!textKey || textKey.index === undefined) return undefined
  const textField = textKey[1]!
  const textStart = textKey.index + textKey[0].length
  const bodyTrimmed = body.trimEnd()
  // Text-closing quote: last quote in the trimmed body.
  const textEnd = bodyTrimmed.lastIndexOf('"')
  if (textEnd < textStart) return undefined
  const tail = bodyTrimmed.slice(textEnd + 1)
  // Tail must be only envelope structure: optional ,"key"/"id" fields.
  if (!/^\s*(,\s*"(?:key|id)"\s*:\s*"[^"]*"\s*)*$/.test(tail)) return undefined
  const text = body.slice(textStart, textEnd)
  // after: from the text-closing quote onward, but the envelope close brace
  // lives on the candidate, not the body — re-add it at repair time.
  const after = body.slice(textEnd + 1)
  // Escape order matters: backslashes first so existing escapes survive,
  // then quotes, then control chars. A lone trailing backslash (odd count)
  // would escape our closing quote, so double it.
  let escaped = text.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t")
  escaped = escaped.replace(/\\(?!["\\/bfnrtu])/g, "\\\\").replace(/"/g, '\\"')
  const headFields = body.slice(0, textKey.index)
  const repaired = `{"type":"${type}",${headFields}"${textField}":"${escaped}"${after}}`
  try {
    const parsed = JSON.parse(repaired)
    const item = record(parsed)
    if (!item || item.type !== type) return undefined
    const textValue = item.text ?? item.message ?? item.content
    if (typeof textValue !== "string" || !textValue) return undefined
    return repaired
  } catch {
    return undefined
  }
}

export function parseTypedEnvelope(value: unknown, offered: ReadonlySet<string>): BrowserFrame[] | undefined {
  const item = record(value)
  if (!item) return undefined
  const rawType = item.type
  if (typeof rawType !== "string" || !ENVELOPE_TYPES.has(rawType)) {
    // Live (terra): typeless tool envelope {"key":...,"id":...,"name":"read","input":{...}}
    // omits "type". Accept only confidently tool-shaped objects: valid name
    // plus id/key/input presence, validated against the offered set.
    if (typeof item.name !== "string" || !NAME.test(item.name)) return undefined
    if (item.id === undefined && item.key === undefined && item.input === undefined) return undefined
    if (offered.size === 0) return undefined
    if (!offered.has(item.name)) throw new Error(`tool ${item.name} was not offered`)
    console.error(`aipass envelope type=tool`)
    const typelessInput = envelopeInput(item.input)
    if (item.name === "question") return [{ type: "tool-call", id: envelopeID(item.id), name: item.name, input: normalizeQuestionInput(item, typelessInput) }]
    return [{ type: "tool-call", id: envelopeID(item.id), name: item.name, input: typelessInput }]
  }
  const type = rawType
  if (type === "chat") {
    const text =
      typeof item.text === "string"
        ? item.text
        : typeof item.message === "string"
          ? item.message
          : typeof item.content === "string"
            ? item.content
            : undefined
    if (typeof text !== "string" || !text) throw new Error("typed envelope chat text must be a string")
    console.error(`aipass envelope type=${type}`)
    return [{ type: "text", delta: text }]
  }
  if (type === "thinking") {
    const text =
      typeof item.text === "string"
        ? item.text
        : typeof item.message === "string"
          ? item.message
          : typeof item.content === "string"
            ? item.content
            : undefined
    if (typeof text !== "string" || !text) throw new Error("typed envelope thinking text must be a string")
    console.error(`aipass envelope type=${type}`)
    return [{ type: "reasoning", delta: text }]
  }
  if (type === "plan") {
    if (offered.size === 0) return undefined
    if (!Array.isArray(item.steps) || item.steps.length === 0) throw new Error("typed envelope plan steps invalid")
    const calls = item.steps.map((candidate, index) => {
      const step = record(candidate)
      if (!step || typeof step.name !== "string" || !NAME.test(step.name))
        throw new Error(`typed envelope plan step ${index} name invalid`)
      if (!offered.has(step.name)) throw new Error(`tool ${step.name} was not offered`)
      return {
        type: "tool-call" as const,
        id: envelopeID(step.id),
        name: step.name,
        input: envelopeInput(step.input),
      }
    })
    console.error(`aipass envelope type=${type}`)
    return calls
  }
  const name = typeof item.name === "string" ? item.name : type
  if (offered.size === 0) return undefined
  if (!NAME.test(name)) throw new Error("typed envelope name is invalid")
  if (!offered.has(name)) throw new Error(`tool ${name} was not offered`)
  console.error(`aipass envelope type=${type}`)
  const input = envelopeInput(item.input)
  if (name === "question") return [{ type: "tool-call", id: envelopeID(item.id), name, input: normalizeQuestionInput(item, input) }]
  return [{ type: "tool-call", id: envelopeID(item.id), name, input }]
}

// The turn key proves a response belongs to the asking turn. Extractors stay
// conservative: only confidently parsed envelopes count, so legacy text and
// malformed blobs keep their existing paths.
export function envelopeKey(text: string): string | undefined {
  const tagged = /<aipass-envelope>([\s\S]*?)<\/aipass-envelope>/.exec(text)?.[1]
  const candidates = tagged !== undefined ? [tagged, text] : [text]
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue
    try {
      const key = record(JSON.parse(trimmed))?.key
      if (typeof key === "string" && key) return key
    } catch {
      continue
    }
  }
  return undefined
}

// Every confidently parsed envelope key in response order: all tagged
// <aipass-envelope>{...}</aipass-envelope> bodies plus bare envelope-shaped
// JSON objects elsewhere in the text. Malformed or keyless envelopes yield
// nothing, so callers treat "shape without keys" as unattributable.
export function envelopeKeys(text: string): string[] {
  const keys: string[] = []
  const tagged = /<aipass-envelope>([\s\S]*?)<\/aipass-envelope>/g
  let match: RegExpExecArray | null
  while ((match = tagged.exec(text)) !== null) {
    try {
      const key = record(JSON.parse(match[1]))?.key
      if (typeof key === "string" && key) keys.push(key)
    } catch {
      continue
    }
  }
  const stripped = text.replace(/<aipass-envelope>[\s\S]*?<\/aipass-envelope>/g, " ")
  for (const value of scanJsonObjects(stripped)) {
    const item = record(value)
    if (!item) continue
    const itemType = item.type
    if (typeof itemType !== "string" || !ENVELOPE_TYPES.has(itemType)) {
      // Typeless tool envelope: valid name plus id/key/input presence.
      if (typeof item.name !== "string" || !NAME.test(item.name)) continue
      if (item.id === undefined && item.key === undefined && item.input === undefined) continue
    }
    const key = item.key
    if (typeof key === "string" && key) keys.push(key)
  }
  return keys
}

function scanJsonObjects(text: string): unknown[] {
  const values: unknown[] = []
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) !== "{") continue
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let j = i; j < text.length; j++) {
      const char = text.charAt(j)
      if (inString) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === "{") depth++
      else if (char === "}") {
        depth--
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    if (end === -1) break
    try {
      values.push(JSON.parse(text.slice(i, end + 1)))
    } catch {
      // Not a JSON object; keep scanning.
    }
    i = end
  }
  return values
}

export function hasEnvelopeShape(text: string): boolean {
  if (text.includes(ENVELOPE_OPEN)) return true
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false
  try {
    const shaped = record(JSON.parse(trimmed))
    if (!shaped) return false
    const type = shaped.type
    if (typeof type === "string" && ENVELOPE_TYPES.has(type)) return true
    // Typeless tool envelope (live terra omits "type").
    if (typeof shaped.name !== "string" || !NAME.test(shaped.name)) return false
    return shaped.id !== undefined || shaped.key !== undefined || shaped.input !== undefined
  } catch {
    return false
  }
}

const TURN_KEY_PREFIX = "TURN KEY:"

function echoedTurnKey(text: string): { key: string; body: string; headerLength: number } | undefined {
  const match = /^\s*TURN KEY:[ \t]+(\S+)[ \t]*\r?\n/.exec(text)
  return match ? { key: match[1]!, body: text.slice(match[0].length).trim(), headerLength: match[0].length } : undefined
}

function completionEnvelopes(text: string): Record<string, unknown>[] {
  const source = echoedTurnKey(text)?.body ?? text.trim()
  if (!(source.startsWith(ENVELOPE_OPEN) || source.startsWith("{"))) return []
  if (!(source.endsWith(ENVELOPE_CLOSE) || source.endsWith("}"))) return []
  const values = scanJsonObjects(source).map(record)
  if (!values.length) return []
  if (!values.every((item) => item && (
    typeof item.type === "string" && ENVELOPE_TYPES.has(item.type) ||
    typeof item.name === "string" && NAME.test(item.name) &&
      (item.id !== undefined || item.key !== undefined || item.input !== undefined)
  ))) return []
  return values as Record<string, unknown>[]
}

export function estimateCapturedTextTokens(text: string): number {
  const values = completionEnvelopes(text)
  if (!values.length) return estimateTokens(text)
  // DOM reasoning is already counted by the caller. Measure only semantic
  // answer/action output; raw frames still cross runtime's validation gates.
  const names = values.flatMap(value => value.type === "plan" && Array.isArray(value.steps)
    ? value.steps.map(step => record(step)?.name)
    : [value.name ?? value.type]).filter((name): name is string => typeof name === "string")
  try {
    const offered = new Set(names)
    const output = values.flatMap(value => parseTypedEnvelope(value, offered) ?? []).map(frame => {
      if (frame.type === "text") return frame.delta
      if (frame.type === "tool-call") return `${frame.name}${JSON.stringify(frame.input)}`
      return ""
    }).join("")
    return estimateTokens(output)
  } catch {
    // Malformed actions are rejected by runtime, not by passive accounting.
    return estimateTokens(text)
  }
}

// These select completion behavior; attribution and offered-action validation
// still happen before runtime publishes any frames.
export function hasTerminalEnvelope(text: string): boolean {
  const values = completionEnvelopes(text)
  return values.length > 0 && values.at(-1)?.type !== "thinking"
}

export function hasThinkingOnlyEnvelope(text: string): boolean {
  const values = completionEnvelopes(text)
  return values.length > 0 && values.every((item) => item.type === "thinking")
}

function hasIncompleteBareEnvelope(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) !== "{") continue
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let j = i; j < text.length; j++) {
      const char = text.charAt(j)
      if (inString) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === "{") depth++
      else if (char === "}") {
        depth--
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    if (end >= 0) {
      i = end
      continue
    }
    const candidate = text.slice(i)
    const typed = /"type"\s*:\s*"(?:chat|tool|plan|subagent|skill|question|permission|thinking)"/.test(candidate)
    const typeless = /"name"\s*:\s*"[A-Za-z][A-Za-z0-9_-]*"/.test(candidate) &&
      /"(?:id|key|input)"\s*:/.test(candidate)
    return typed || typeless
  }
  return false
}

// Validate every envelope before conversion can discard its correlation key.
// Ordinary non-envelope answers retain their existing compatibility behavior.
export function envelopesMatchTurnKey(text: string, expectedKey: string): boolean {
  const echo = echoedTurnKey(text)
  if (echo && completionEnvelopes(echo.body).length && echo.key !== expectedKey) return false
  let valid = true
  const remaining = text.replace(/<aipass-envelope>([\s\S]*?)<\/aipass-envelope>/g, (_match, body: string) => {
    try {
      if (record(JSON.parse(body))?.key !== expectedKey) valid = false
    } catch {
      valid = false
    }
    return " "
  })
  if (!valid || remaining.includes(ENVELOPE_OPEN)) return false
  if (hasIncompleteBareEnvelope(remaining)) return false
  for (const value of scanJsonObjects(remaining)) {
    const item = record(value)
    if (!item) continue
    const typed = typeof item.type === "string" && ENVELOPE_TYPES.has(item.type)
    const typeless = typeof item.name === "string" && NAME.test(item.name) &&
      (item.id !== undefined || item.key !== undefined || item.input !== undefined)
    if ((typed || typeless) && item.key !== expectedKey) return false
  }
  return true
}

export class TypedEnvelopeShim {
  private buffer = ""
  private leading = true

  constructor(private readonly allowed: ReadonlySet<string>, private readonly strictBareChains = false) {}

  push(chunk: string): BrowserFrame[] {
    this.buffer += chunk
    const start = this.buffer.trimStart()
    // The model can echo the submission header before its envelope. Retain
    // a candidate until its type and correlation key can be checked.
    if (this.leading && (TURN_KEY_PREFIX.startsWith(start) || start.startsWith(TURN_KEY_PREFIX))) {
      const echo = echoedTurnKey(this.buffer)
      if (!this.buffer.includes("\n") || echo && (!echo.body || echo.body.startsWith("{") || echo.body.startsWith(ENVELOPE_OPEN) || ENVELOPE_OPEN.startsWith(echo.body))) {
        if ((echo?.headerLength ?? this.buffer.length) > MAX_TOOL_FRAME) throw new Error("typed envelope frame exceeds size limit")
        const open = echo?.body.lastIndexOf(ENVELOPE_OPEN) ?? -1
        if (echo && open >= 0 && echo.body.indexOf(ENVELOPE_CLOSE, open) < 0 && echo.body.length - open > MAX_TOOL_FRAME)
          throw new Error("typed envelope frame exceeds size limit")
        return []
      }
    }
    if (start) this.leading = false
    const output: BrowserFrame[] = []
    while (true) {
      const open = this.buffer.indexOf(ENVELOPE_OPEN)
      if (open < 0) break
      if (open > 0) {
        const before = this.buffer.slice(0, open)
        this.buffer = this.buffer.slice(open)
        if (before.trim()) {
          const bare = this.tryBare(before.trim()) ?? this.tryBareChain(before.trim())
          if (bare) output.push(...bare)
          else output.push({ type: "text", delta: before })
        } else if (before) output.push({ type: "text", delta: before })
        continue
      }
      const close = this.buffer.indexOf(ENVELOPE_CLOSE, ENVELOPE_OPEN.length)
      if (close < 0) {
        if (this.buffer.length > MAX_TOOL_FRAME) throw new Error("typed envelope frame exceeds size limit")
        break
      }
      const raw = this.buffer.slice(ENVELOPE_OPEN.length, close)
      this.buffer = this.buffer.slice(close + ENVELOPE_CLOSE.length)
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        // Narrow repair for model-malformed chat/thinking envelopes whose
        // text contains unescaped quotes. Tool-bearing envelopes stay strict
        // and fall through to the prose path below.
        const repaired = repairMalformedTextEnvelope(raw)
        if (repaired) {
          try {
            parsed = JSON.parse(repaired)
            console.error("aipass envelope repaired=malformed-text")
          } catch {
            output.push({ type: "text", delta: raw })
            continue
          }
        } else {
          // Fail-open: a malformed tagged envelope is model prose, not a
          // stream-killing error. Emit it as text so the turn completes and
          // the repair net (refusal/untagged/key-mismatch) can still act.
          output.push({ type: "text", delta: raw })
          continue
        }
      }
      const frames = parseTypedEnvelope(parsed, this.allowed)
      if (frames) output.push(...frames)
      else output.push({ type: "text", delta: raw })
    }
    if (this.buffer.includes(ENVELOPE_OPEN)) return output
    const trimmed = this.buffer.trim()
    if (!trimmed) return output
    if (trimmed.startsWith("{")) return output
    let keep = 0
    for (let length = Math.min(this.buffer.length, ENVELOPE_OPEN.length - 1); length > 0; length--) {
      if (this.buffer.endsWith(ENVELOPE_OPEN.slice(0, length))) {
        keep = length
        break
      }
    }
    const emit = this.buffer.slice(0, this.buffer.length - keep)
    this.buffer = this.buffer.slice(this.buffer.length - keep)
    if (emit) output.push({ type: "text", delta: emit })
    return output
  }

  finish(): BrowserFrame[] {
    if (this.leading) {
      const original = this.buffer
      this.buffer = ""
      this.leading = false
      const echo = echoedTurnKey(original)
      if (echo && completionEnvelopes(echo.body).length) {
        if (!envelopesMatchTurnKey(original, echo.key)) throw new Error("browser response TURN KEY mismatch")
        const bare = this.tryBareChain(echo.body) ?? this.tryBare(echo.body)
        if (bare) return bare
        if (echo.body.startsWith(ENVELOPE_OPEN)) return [...this.push(echo.body), ...this.finish()]
      }
      return original.trim() ? [{ type: "text", delta: original }] : []
    }
    if (this.buffer.includes(ENVELOPE_OPEN)) throw new Error("typed envelope frame is incomplete")
    const trimmed = this.buffer.trim()
    this.buffer = ""
    if (!trimmed) return []
    // Bare multi-envelope chain: {"thinking",...}\n{"tool",...} has no tags
    // and is not one JSON object. Validate it before single-envelope repair
    // can absorb a trailing action into the first envelope's prose.
    const chain = this.tryBareChain(trimmed)
    if (chain) return chain
    const bare = this.tryBare(trimmed)
    if (bare) return bare
    if (trimmed.startsWith("{")) {
      try {
        JSON.parse(trimmed)
      } catch {
        // Same narrow repair as tryBare for a single malformed chat/thinking
        // envelope that the chain scanner could not split.
        const single = this.tryMalformedTextEnvelope(trimmed)
        if (single) return single
        return [{ type: "text", delta: trimmed }]
      }
      return [{ type: "text", delta: trimmed }]
    }
    return []
  }

  private tryBareChain(candidate: string): BrowserFrame[] | undefined {
    const frames: BrowserFrame[] = []
    let index = 0
    const text = candidate
    let parsedAny = false
    while (index < text.length) {
      while (index < text.length && /\s/.test(text.charAt(index))) index++
      if (index >= text.length) break
      if (text.charAt(index) !== "{") return undefined
      let depth = 0
      let inString = false
      let escaped = false
      let end = -1
      for (let j = index; j < text.length; j++) {
        const char = text.charAt(j)
        if (inString) {
          if (escaped) escaped = false
          else if (char === "\\") escaped = true
          else if (char === '"') inString = false
        } else if (char === '"') inString = true
        else if (char === "{") depth++
        else if (char === "}") {
          depth--
          if (depth === 0) {
            end = j
            break
          }
        }
      }
      if (end === -1) return undefined
      let value: unknown
      try {
        value = JSON.parse(text.slice(index, end + 1))
      } catch {
        return undefined
      }
      let parsed: BrowserFrame[] | undefined
      try {
        parsed = parseTypedEnvelope(value, this.allowed)
      } catch (error) {
        if (this.strictBareChains) throw error
        // Fail-open: a bare chain naming an unoffered/invalid tool is model
        // prose, not a stream-killing error. Live evidence: a hallucinated
        // {"type":"tool","name":"document_fetcher"} inside a bare chain threw
        // out of finish() and ended the provider stream with no terminal
        // finish event. Return undefined so the whole blob stays text and the
        // repair net (refusal/untagged/key-mismatch) can still act.
        return undefined
      }
      if (!parsed) return undefined
      frames.push(...parsed)
      parsedAny = true
      index = end + 1
    }
    return parsedAny ? frames : undefined
  }

  private tryBare(candidate: string): BrowserFrame[] | undefined {
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      // Narrow repair for model-malformed chat/thinking envelopes whose text
      // contains unescaped quotes (live evidence: a rating answer containing
      // "Version 1" broke JSON.parse, so the raw envelope leaked to the
      // client as chat text). Only chat/thinking envelopes qualify: their
      // text is free prose, so salvage the payload instead of passing raw
      // envelope syntax downstream. Tool-bearing envelopes stay strict.
      return this.tryMalformedTextEnvelope(candidate)
    }
    // JSON parses but is not a valid envelope (unoffered tool, bad shape):
    // rethrow the validation error so invalid calls fail before dispatch.
    return parseTypedEnvelope(parsed, this.allowed) ?? undefined
  }

  private tryMalformedTextEnvelope(candidate: string): BrowserFrame[] | undefined {
    const repaired = repairMalformedTextEnvelope(candidate)
    if (!repaired) return undefined
    try {
      const frames = parseTypedEnvelope(JSON.parse(repaired), this.allowed)
      if (frames?.length) {
        console.error("aipass envelope repaired=malformed-text")
        return frames
      }
      return undefined
    } catch (error) {
      if (error instanceof Error && /not offered|invalid|must be/.test(error.message)) throw error
      return undefined
    }
  }
}

export const EVERY_TURN_ENVELOPE_GUARD =
  "EVERY TURN: reply with only <aipass-envelope>{...}</aipass-envelope> envelope(s) carrying the current turn key; put results into envelope fields and emit no text outside envelopes. The envelope is strict JSON: escape every double quote inside text as \\\" so the envelope always parses."

export const WEBCHAT_ROLE_INSTRUCTION = [
  "You are a text-generation assistant working only as the backend. Generate text to assist the client, which does the actual work: reason, plan, choose actions, and answer using supplied user, agent, and workspace instructions.",
  "Answer from context or request an offered client action, not manual user work.",
  "Actions are data, not native calls: never execute them yourself or decline for lack of native access.",
  "The client handles permissions, executes actions, and returns results; requests are not approval or success.",
  "Files, folders, shell, MCP: use exact offered names and schema-valid input; do not guess arguments.",
  "Claim success only from client results. Preserve site instructions, safety, privacy, and authorization.",
  "No offered actions: chat.",
  'FIRST line: "TURN KEY: <key>". Every envelope: verbatim "key", unique "id".',
  "Replies and refusals: only <aipass-envelope>{...}</aipass-envelope>, no outside prose, JSON, or fences.",
  "Thinking is optional reasoning, never a final answer; chat ends the turn.",
  'Shapes: {"type":"thinking","key":"<key>","id":"reason_1","text":"..."} | {"type":"chat","key":"<key>","id":"answer_1","text":"..."}.',
  "Every response carries the current turn key: never emit text outside envelopes.",
].join(" ")

export function serializeToolDefinitions(
  tools: readonly { readonly name: string; readonly description?: string; readonly inputSchema: unknown }[],
  actionsAvailable = tools.length > 0,
  includeRole = true,
  includeActionProtocol = true,
) {
  const role = includeRole ? WEBCHAT_ROLE_INSTRUCTION : ""
  if (!actionsAvailable) return role
  const definitions = tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
  }))
  const actionProtocol = includeActionProtocol ? [
    'When an offered action is needed, request the calling client by emitting exactly <aipass-envelope>{"type":"tool","key":"<key>","id":"call_unique","name":"offered_name","input":{}}</aipass-envelope>, with input matching that action\'s schema.',
    "Use the full schemas supplied during startup. Every action input must satisfy its schema, including all required fields. Do not guess arguments.",
    "Do not emit legacy <aipass-action> wrappers. Stop after an action envelope; the client will return the result so you can continue.",
    "Respond in English unless the user explicitly requests another language in their message.",
    "Responses are a chain of one or more typed envelopes and nothing else: thinking* then at most one action group (tool | plan | subagent | skill | question | permission) then thinking* then a final chat or action envelope.",
    "Multi-step work uses plan with a steps array. A final action envelope means the client executes the requested actions and continues the loop with a new turn key until a chat envelope finalizes.",
    'Action shapes: {"type":"tool","key":"<key>","id":"call_1","name":"offered_name","input":{}} | {"type":"plan","key":"<key>","id":"plan_1","steps":[{"id":"call_1","name":"offered_name","input":{}}]} | {"type":"subagent","key":"<key>","id":"call_1","input":{}} | {"type":"skill","key":"<key>","id":"call_1","input":{}} | {"type":"question","key":"<key>","id":"call_1","input":{}} | {"type":"permission","key":"<key>","id":"call_1","input":{}}.',
  ].join(" ") : ""
  return [role, actionProtocol, tools.length ? `Offered actions:\n${JSON.stringify(definitions)}` : ""].filter(Boolean).join("\n\n")
}

function chunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finish_reason: string | null = null,
) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`
}

function iterable<A>(value: AsyncIterable<A> | Iterable<A>): AsyncIterable<A> {
  if (Symbol.asyncIterator in value) return value as AsyncIterable<A>
  return {
    async *[Symbol.asyncIterator]() {
      yield* value as Iterable<A>
    },
  }
}

function reasoningSourceFilter() {
  let domTurnKey: string | undefined
  return (frame: BrowserFrame) => {
    if (frame.type !== "reasoning") return true
    domTurnKey ??= frame.domTurnKey
    return !domTurnKey || frame.domTurnKey === domTurnKey
  }
}

export async function* openAIChatSSEChunks(
  model: string,
  input: AsyncIterable<BrowserFrame> | Iterable<BrowserFrame>,
  offered: ReadonlySet<string>,
  options: { readonly promptTokens?: number; readonly includeUsage?: boolean; readonly requireTool?: boolean } = {},
) {
  const id = `chatcmpl_${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const shim = new StructuredToolShim(offered)
  const envelope = new TypedEnvelopeShim(offered)
  let terminal: FinishReason | undefined
  let toolIndex = 0
  let text = ""
  let reasoning = ""
  let toolOutput = ""
  const keepReasoning = reasoningSourceFilter()
  yield chunk(id, created, model, { role: "assistant" })
  const emit = (frame: BrowserFrame) => {
    if (!keepReasoning(frame)) return []
    if (frame.type === "text") {
      text += frame.delta
      return [chunk(id, created, model, { content: frame.delta })]
    }
    if (frame.type === "reasoning") {
      reasoning += frame.delta
      return [chunk(id, created, model, { reasoning_content: frame.delta })]
    }
    if (frame.type === "tool-call") {
      if (!offered.has(frame.name)) throw new Error(`tool ${frame.name} was not offered`)
      toolOutput += `${frame.name}${JSON.stringify(frame.input)}`
      return [
        chunk(id, created, model, {
          tool_calls: [
            {
              index: toolIndex++,
              id: frame.id,
              type: "function",
              function: { name: frame.name, arguments: JSON.stringify(frame.input) },
            },
          ],
        }),
      ]
    }
    return []
  }
  for await (const frame of iterable(input)) {
    if (frame.type === "finish") {
      terminal ??= frame.reason
      continue
    }
    if (frame.type === "auth-required") throw new Error("browser authentication is required")
    if (frame.type === "error") throw new Error(frame.message)
    const legacy = frame.type === "text" ? shim.push(frame.delta) : [frame]
    const expanded: BrowserFrame[] = []
    for (const item of legacy) {
      if (item.type === "text") expanded.push(...envelope.push(item.delta))
      else expanded.push(item)
    }
    for (const item of expanded) for (const output of emit(item)) yield output
  }
  if (!terminal) throw new Error("browser stream ended without a terminal finish event")
  for (const item of shim.finish()) {
    if (item.type === "text") for (const env of envelope.push(item.delta)) for (const output of emit(env)) yield output
    else for (const output of emit(item)) yield output
  }
  for (const item of envelope.finish()) for (const output of emit(item)) yield output
  if (options.requireTool && toolIndex === 0) throw new Error("tool_choice required but no tool call was produced")
  const reason = toolIndex > 0 || terminal === "tool-calls" ? "tool_calls" : terminal
  yield chunk(id, created, model, {}, reason)
  if (options.includeUsage) {
    const promptTokens = options.promptTokens ?? 0
    const completionTokens = estimateTokens(`${reasoning}${text}${toolOutput}`)
    yield `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        estimated: true,
      },
    })}\n\n`
  }
  yield "data: [DONE]\n\n"
}

export async function openAIChatSSE(
  model: string,
  input: AsyncIterable<BrowserFrame> | Iterable<BrowserFrame>,
  offered: ReadonlySet<string>,
) {
  let output = ""
  for await (const value of openAIChatSSEChunks(model, input, offered)) output += value
  return output
}

function responsesEvent(type: string, sequenceNumber: number, value: Record<string, unknown>) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequenceNumber, ...value })}\n\n`
}

export async function* openAIResponsesSSEChunks(
  responseID: string,
  model: string,
  input: AsyncIterable<BrowserFrame> | Iterable<BrowserFrame>,
  offered: ReadonlySet<string>,
  options: {
    readonly promptTokens: number
    readonly requireTool?: boolean
    readonly onCompletedOutput?: (output: readonly Record<string, unknown>[]) => void
  },
) {
  const createdAt = Math.floor(Date.now() / 1000)
  const shim = new StructuredToolShim(offered)
  const envelope = new TypedEnvelopeShim(offered)
  const output: Array<Record<string, unknown>> = []
  let sequence = 0
  let terminal: FinishReason | undefined
  let toolOutput = ""
  let messageIndex: number | undefined
  let reasoningIndex: number | undefined
  let messageID = ""
  let reasoningID = ""
  let text = ""
  let reasoning = ""
  let toolCalls = 0
  const keepReasoning = reasoningSourceFilter()
  const base = {
    id: responseID,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    model,
    output: [],
    parallel_tool_calls: true,
    usage: null,
  }
  yield responsesEvent("response.created", sequence++, { response: base })
  yield responsesEvent("response.in_progress", sequence++, { response: base })

  const emit = (frame: BrowserFrame) => {
    if (!keepReasoning(frame)) return []
    const events: string[] = []
    if (frame.type === "text") {
      if (messageIndex === undefined) {
        messageIndex = output.length
        messageID = `msg_${randomUUID()}`
        output.push({ id: messageID, type: "message", status: "in_progress", role: "assistant", content: [] })
        events.push(
          responsesEvent("response.output_item.added", sequence++, {
            output_index: messageIndex,
            item: output[messageIndex],
          }),
          responsesEvent("response.content_part.added", sequence++, {
            item_id: messageID,
            output_index: messageIndex,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          }),
        )
      }
      text += frame.delta
      events.push(
        responsesEvent("response.output_text.delta", sequence++, {
          item_id: messageID,
          output_index: messageIndex,
          content_index: 0,
          delta: frame.delta,
          logprobs: [],
        }),
      )
    } else if (frame.type === "reasoning") {
      if (reasoningIndex === undefined) {
        reasoningIndex = output.length
        reasoningID = `rs_${randomUUID()}`
        output.push({ id: reasoningID, type: "reasoning", summary: [] })
        events.push(
          responsesEvent("response.output_item.added", sequence++, {
            output_index: reasoningIndex,
            item: output[reasoningIndex],
          }),
          responsesEvent("response.reasoning_summary_part.added", sequence++, {
            item_id: reasoningID,
            output_index: reasoningIndex,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
          }),
        )
      }
      reasoning += frame.delta
      events.push(
        responsesEvent("response.reasoning_summary_text.delta", sequence++, {
          item_id: reasoningID,
          output_index: reasoningIndex,
          summary_index: 0,
          delta: frame.delta,
        }),
      )
    } else if (frame.type === "tool-call") {
      if (!offered.has(frame.name)) throw new Error(`tool ${frame.name} was not offered`)
      const outputIndex = output.length
      const arguments_ = JSON.stringify(frame.input)
      const item = {
        id: `fc_${randomUUID()}`,
        type: "function_call",
        status: "in_progress",
        call_id: frame.id,
        name: frame.name,
        arguments: "",
      }
      output.push(item)
      toolCalls++
      toolOutput += `${frame.name}${arguments_}`
      events.push(
        responsesEvent("response.output_item.added", sequence++, { output_index: outputIndex, item }),
        responsesEvent("response.function_call_arguments.delta", sequence++, {
          item_id: item.id,
          output_index: outputIndex,
          delta: arguments_,
        }),
        responsesEvent("response.function_call_arguments.done", sequence++, {
          item_id: item.id,
          output_index: outputIndex,
          arguments: arguments_,
        }),
      )
      const completed = { ...item, status: "completed", arguments: arguments_ }
      output[outputIndex] = completed
      events.push(
        responsesEvent("response.output_item.done", sequence++, { output_index: outputIndex, item: completed }),
      )
    }
    return events
  }

  for await (const frame of iterable(input)) {
    if (frame.type === "finish") {
      terminal ??= frame.reason
      continue
    }
    if (frame.type === "auth-required") throw new Error("browser authentication is required")
    if (frame.type === "error") throw new Error(frame.message)
    const legacy = frame.type === "text" ? shim.push(frame.delta) : [frame]
    const expanded: BrowserFrame[] = []
    for (const item of legacy) {
      if (item.type === "text") expanded.push(...envelope.push(item.delta))
      else expanded.push(item)
    }
    for (const item of expanded) for (const event of emit(item)) yield event
  }
  if (!terminal) throw new Error("browser stream ended without a terminal finish event")
  for (const item of shim.finish()) {
    if (item.type === "text") for (const env of envelope.push(item.delta)) for (const event of emit(env)) yield event
    else for (const event of emit(item)) yield event
  }
  for (const item of envelope.finish()) for (const event of emit(item)) yield event
  if (options.requireTool && toolCalls === 0) throw new Error("tool_choice required but no tool call was produced")

  if (reasoningIndex !== undefined) {
    const completed = { id: reasoningID, type: "reasoning", summary: [{ type: "summary_text", text: reasoning }] }
    output[reasoningIndex] = completed
    yield responsesEvent("response.reasoning_summary_text.done", sequence++, {
      item_id: reasoningID,
      output_index: reasoningIndex,
      summary_index: 0,
      text: reasoning,
    })
    yield responsesEvent("response.reasoning_summary_part.done", sequence++, {
      item_id: reasoningID,
      output_index: reasoningIndex,
      summary_index: 0,
      part: completed.summary[0],
    })
    yield responsesEvent("response.output_item.done", sequence++, { output_index: reasoningIndex, item: completed })
  }
  if (messageIndex !== undefined) {
    const content = { type: "output_text", text, annotations: [] }
    const completed = { id: messageID, type: "message", status: "completed", role: "assistant", content: [content] }
    output[messageIndex] = completed
    yield responsesEvent("response.output_text.done", sequence++, {
      item_id: messageID,
      output_index: messageIndex,
      content_index: 0,
      text,
      logprobs: [],
    })
    yield responsesEvent("response.content_part.done", sequence++, {
      item_id: messageID,
      output_index: messageIndex,
      content_index: 0,
      part: content,
    })
    yield responsesEvent("response.output_item.done", sequence++, { output_index: messageIndex, item: completed })
  }
  const completionTokens = estimateTokens(`${reasoning}${text}${toolOutput}`)
  const usage = {
    input_tokens: options.promptTokens,
    output_tokens: completionTokens,
    total_tokens: options.promptTokens + completionTokens,
    estimated: true,
  }
  options.onCompletedOutput?.(output)
  yield responsesEvent("response.completed", sequence++, {
    response: { ...base, status: "completed", output, usage },
  })
}

export interface OpenAIChatResult {
  readonly text: string
  readonly reasoning: string
  readonly toolCalls: readonly {
    readonly id: string
    readonly name: string
    readonly input: Record<string, unknown>
  }[]
  readonly finishReason: FinishReason
  readonly completionTokens: number
}

export async function collectOpenAIChatResult(
  input: AsyncIterable<BrowserFrame> | Iterable<BrowserFrame>,
  offered: ReadonlySet<string>,
  requireTool = false,
  strictBareChains = false,
): Promise<OpenAIChatResult> {
  const shim = new StructuredToolShim(offered)
  const envelope = new TypedEnvelopeShim(offered, strictBareChains)
  let text = ""
  let reasoning = ""
  const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
  let terminal: FinishReason | undefined
  const keepReasoning = reasoningSourceFilter()
  const collect = (frame: BrowserFrame) => {
    if (!keepReasoning(frame)) return
    if (frame.type === "text") text += frame.delta
    else if (frame.type === "reasoning") reasoning += frame.delta
    else if (frame.type === "tool-call") {
      if (!offered.has(frame.name)) throw new Error(`tool ${frame.name} was not offered`)
      toolCalls.push({ id: frame.id, name: frame.name, input: frame.input })
    } else if (frame.type === "finish") terminal ??= frame.reason
    else if (frame.type === "auth-required") throw new Error("browser authentication is required")
    else if (frame.type === "error") throw new Error(frame.message)
  }
  for await (const frame of iterable(input)) {
    const legacy = frame.type === "text" ? shim.push(frame.delta) : [frame]
    for (const item of legacy) {
      if (item.type === "text") envelope.push(item.delta).forEach(collect)
      else collect(item)
    }
  }
  for (const item of shim.finish()) {
    if (item.type === "text") envelope.push(item.delta).forEach(collect)
    else collect(item)
  }
  envelope.finish().forEach(collect)
  if (!terminal) throw new Error("browser stream ended without a terminal finish event")
  if (requireTool && toolCalls.length === 0) throw new Error("tool_choice required but no tool call was produced")
  const finish = toolCalls.length ? "tool-calls" : terminal
  const completionTokens = estimateTokens(
    `${reasoning}${text}${toolCalls.map((call) => `${call.name}${JSON.stringify(call.input)}`).join("")}`,
  )
  return { text, reasoning, toolCalls, finishReason: finish, completionTokens }
}

export async function openAIChatCompletion(
  model: string,
  input: AsyncIterable<BrowserFrame> | Iterable<BrowserFrame>,
  offered: ReadonlySet<string>,
  promptTokens: number,
  requireTool = false,
) {
  const result = await collectOpenAIChatResult(input, offered, requireTool)
  const message: Record<string, unknown> = {
    role: "assistant",
    content: result.text || result.toolCalls.length ? result.text || null : "",
  }
  if (result.reasoning) message.reasoning_content = result.reasoning
  if (result.toolCalls.length)
    message.tool_calls = result.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.input) },
    }))
  return {
    id: `chatcmpl_${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: result.finishReason === "tool-calls" ? "tool_calls" : result.finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: result.completionTokens,
      total_tokens: promptTokens + result.completionTokens,
      estimated: true,
    },
  }
}
