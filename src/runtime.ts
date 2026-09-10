import { createHash, randomUUID } from "node:crypto"

import {
  AuthenticationRequiredError,
  isWebchatSafetyBlock,
  NoResponseEvidenceError,
  PlaywrightBrowserAdapter,
  WebchatSafetyBlockError,
  loginWithSystemChrome,
  promptContractCurrent,
  sameOrigin,
  turnPrompt,
  withTurnKey,
  type AttemptLifecycle,
  type BrowserAdapterConfig,
  type BrowserProtocol,
} from "./browser.ts"
import { LOOPBACK_HOST, MODELS, model, persistRuntimeConfig, type Settings } from "./config.ts"
import { estimateTokens } from "./context.ts"
import { randomTurnKey, type ProjectedTurn } from "./http.ts"
import {
  collectOpenAIChatResult,
  ENVELOPE_CLOSE,
  ENVELOPE_OPEN,
  EnvelopeResponseFormatError,
  envelopesMatchTurnKey,
  isActionEnvelopeType,
  parseTypedEnvelope,
  StreamFrameParser,
  validateStrictEnvelopeResponse,
  type BrowserFrame,
  type FinishReason,
} from "./protocol.ts"
import { createRequestHandler, type BrowserService } from "./server.ts"
import { BindingStore, pendingDecision, ProfileLock, readOrCreateToken, type Attempt } from "./state.ts"

interface TurnAttempt extends Attempt {
  readonly sessionMarker: string
}

function browserConfig(settings: Settings): BrowserAdapterConfig {
  return {
    profilePath: settings.paths.profile,
    executablePath: settings.chromeExecutable,
    chatURL: settings.chatURL,
    streamURLPattern: settings.streamURLPattern,
    navigationTimeoutMs: settings.navigationTimeoutMs,
    streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
    selectors: { sendButton: 'button[data-testid="send-button"]' },
    loginModelName: MODELS[0]?.name,
    modelNames: MODELS.map((definition) => definition.name),
    headed: settings.browserHeaded,
    screenshotDir: settings.screenshotDir,
  }
}

function lifecycle(store: BindingStore): AttemptLifecycle<TurnAttempt> {
  return {
    async binding(sessionMarker) {
      return (await store.get(sessionMarker))?.remoteChatID
    },
    async promptContractVersion(sessionMarker) {
      return (await store.get(sessionMarker))?.context?.promptContractVersion ?? 0
    },
    async actionEnvelopeDigest(sessionMarker) {
      return (await store.get(sessionMarker))?.context?.actionEnvelopeDigest
    },
    rotate(sessionMarker, digest) {
      return store.rotate(sessionMarker, digest)
    },
    async prepare(input) {
      const current = (await store.get(input.sessionMarker))?.attempt
      const decision = pendingDecision(current, input.promptHash)
      if (decision === "fail-closed") {
        if (current) await store.attempt(input.sessionMarker, { ...current, status: "failed", updatedAt: Date.now() })
        throw new Error("a previous browser turn may have been submitted; retry explicitly to start a new turn")
      }
      if (decision === "recover" && current)
        await store.attempt(input.sessionMarker, { ...current, status: "failed", updatedAt: Date.now() })
      return {
        id: `attempt_${randomUUID()}`,
        sessionMarker: input.sessionMarker,
        promptHash: input.promptHash,
        status: "pending",
        updatedAt: Date.now(),
      }
    },
    async pending(attempt) {
      await store.attempt(attempt.sessionMarker, { ...attempt, status: "pending", updatedAt: Date.now() })
    },
    async bind(sessionMarker, remoteChatID) {
      await store.bind(sessionMarker, remoteChatID)
    },
    async complete(attempt, remoteChatID, estimatedTokens, promptContractVersion, actionEnvelopeDigest) {
      await store.complete(
        attempt.sessionMarker,
        { ...attempt, status: "complete", updatedAt: Date.now() },
        remoteChatID,
        estimatedTokens,
        promptContractVersion,
        actionEnvelopeDigest,
      )
    },
    async discard(sessionMarker) {
      await store.remove(sessionMarker)
    },
    async fail(attempt, outcome) {
      await store.attempt(attempt.sessionMarker, {
        ...attempt,
        status: outcome.definitive ? "failed" : outcome.possiblySubmitted ? "pending" : outcome.cancelled ? "cancelled" : "failed",
        updatedAt: Date.now(),
      })
    },
  }
}

export function promptHashForSingleFlight(prompt: string) {
  return createHash("sha256").update(prompt).digest("hex")
}

export interface SingleFlightStoreOptions {
  readonly maxMarkers?: number
  readonly maxBytes?: number
  readonly ttlMs?: number
}

export class SingleFlightCompletionStore {
  private readonly entries = new Map<string, { marker: string; frames: readonly BrowserFrame[]; bytes: number; expiresAt: number }>()
  private totalBytes = 0
  private readonly maxMarkers: number
  private readonly maxBytes: number
  private readonly ttlMs: number

  constructor(options: SingleFlightStoreOptions = {}) {
    this.maxMarkers = options.maxMarkers ?? 100
    this.maxBytes = options.maxBytes ?? 256 * 1024
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000
  }

  private key(marker: string, hash: string) {
    return marker + "::" + hash
  }

  private purgeExpired(now: number) {
    for (const [key, entry] of [...this.entries]) {
      if (now >= entry.expiresAt) {
        this.entries.delete(key)
        this.totalBytes -= entry.bytes
      }
    }
  }

  private distinctMarkers() {
    return new Set([...this.entries.values()].map((entry) => entry.marker)).size
  }

  get(marker: string, hash: string): readonly BrowserFrame[] | undefined {
    const now = Date.now()
    this.purgeExpired(now)
    const entry = this.entries.get(this.key(marker, hash))
    if (!entry) return undefined
    if (now >= entry.expiresAt) {
      this.entries.delete(this.key(marker, hash))
      this.totalBytes -= entry.bytes
      return undefined
    }
    return entry.frames
  }

  set(marker: string, hash: string, frames: readonly BrowserFrame[]) {
    const now = Date.now()
    this.purgeExpired(now)
    const bytes = JSON.stringify(frames).length
    const key = this.key(marker, hash)
    const existing = this.entries.get(key)
    if (existing) {
      this.totalBytes -= existing.bytes
      this.entries.delete(key)
    }
    while (this.distinctMarkers() >= this.maxMarkers && ![...this.entries.keys()].includes(key)) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      const removed = this.entries.get(oldest)
      if (removed) this.totalBytes -= removed.bytes
      this.entries.delete(oldest)
      if (this.distinctMarkers() < this.maxMarkers) break
      if ([...this.entries.keys()].length === 0) break
    }
    while (this.totalBytes + bytes > this.maxBytes && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      const removed = this.entries.get(oldest)
      if (removed) this.totalBytes -= removed.bytes
      this.entries.delete(oldest)
    }
    this.entries.set(key, { marker, frames: [...frames], bytes, expiresAt: now + this.ttlMs })
    this.totalBytes += bytes
  }
}

const protocol: BrowserProtocol<BrowserFrame> = {
  decoder: () => new StreamFrameParser(),
  text: (value) => ({ type: "text", delta: value }),
  reasoning: (value) => ({ type: "reasoning", delta: value }),
  finish: () => ({ type: "finish", reason: "stop" }),
  isTerminal: (frame) => frame.type === "finish",
}

function requiredKeysForSchema(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return []
  const required = (schema as Record<string, unknown>).required
  if (!Array.isArray(required)) return []
  return required.filter((key): key is string => typeof key === "string")
}

function hasAllRequiredKeys(input: unknown, required: readonly string[]): boolean {
  if (required.length === 0) return true
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false
  const record = input as Record<string, unknown>
  return required.every((key) => key in record)
}

class KeyedThinkingParser {
  private text = ""
  private scanAt = 0
  private blocked = false
  private readonly published: string[] = []

  constructor(
    private readonly expectedKey: string,
    private readonly offered: ReadonlySet<string>,
  ) {}

  push(chunk: string): string[] {
    this.text += chunk
    if (this.blocked) return []
    const output: string[] = []
    const publish: string[] = []
    let invalid = false
    while (true) {
      const open = this.text.indexOf(ENVELOPE_OPEN, this.scanAt)
      if (open < 0) {
        this.scanAt = Math.max(0, this.text.length - ENVELOPE_OPEN.length + 1)
        break
      }
      const close = this.text.indexOf(ENVELOPE_CLOSE, open + ENVELOPE_OPEN.length)
      if (close < 0) {
        this.scanAt = open
        break
      }
      const end = close + ENVELOPE_CLOSE.length
      let headerPrefix: string | undefined
      if (this.published.length === 0) {
        const prefix = this.text.slice(0, open)
        const header = /^\s*TURN KEY:[ \t]+(\S+)[ \t]*\r?\n\s*$/.exec(prefix)
        if (header && header[1] !== this.expectedKey) {
          this.blocked = true
          invalid = true
          break
        }
        if (header) headerPrefix = prefix
      }
      const body = this.text.slice(open + ENVELOPE_OPEN.length, close)
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        this.blocked = true
        invalid = true
        break
      }
      if (!envelopesMatchTurnKey(this.text.slice(0, end), this.expectedKey) ||
          typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
          (parsed as Record<string, unknown>).key !== this.expectedKey) {
        this.blocked = true
        invalid = true
        break
      }
      let frames: readonly BrowserFrame[]
      try {
        frames = parseTypedEnvelope(parsed, this.offered) ?? []
      } catch {
        this.blocked = true
        invalid = true
        break
      }
      if (frames.length === 0) {
        this.blocked = true
        invalid = true
        break
      }
      // Thinking is non-terminal and can be shown while the browser turn is
      // still open. Chat and actions remain transactional until the complete
      // chain, correlation key, and action inputs have all been validated.
      if (frames.some((frame) => frame.type !== "reasoning")) {
        this.blocked = true
        break
      }
      const raw = this.text.slice(open, end)
      if (headerPrefix) publish.push(headerPrefix)
      publish.push(raw)
      output.push(raw)
      this.scanAt = end
    }
    if (invalid) return []
    this.published.push(...publish)
    return output
  }

  withoutPublished(frames: readonly BrowserFrame[]): BrowserFrame[] {
    if (this.published.length === 0) return [...frames]
    const text = responseText(frames)
    const ranges: Array<{ readonly start: number; readonly end: number }> = []
    let searchAt = 0
    for (const published of this.published) {
      const start = text.indexOf(published, searchAt)
      if (start < 0) continue
      ranges.push({ start, end: start + published.length })
      searchAt = start + published.length
    }
    const output: BrowserFrame[] = []
    let textOffset = 0
    for (const frame of frames) {
      if (frame.type !== "text") {
        output.push(frame)
        continue
      }
      const start = textOffset
      const end = start + frame.delta.length
      let cursor = start
      for (const range of ranges) {
        if (range.end <= cursor || range.start >= end) continue
        if (range.start > cursor) output.push({ type: "text", delta: frame.delta.slice(cursor - start, range.start - start) })
        cursor = Math.max(cursor, Math.min(end, range.end))
      }
      if (cursor < end) output.push({ type: "text", delta: frame.delta.slice(cursor - start) })
      textOffset = end
    }
    return output
  }
}

function withDerivedKey(base: ProjectedTurn): ProjectedTurn {
  return { ...base, promptKey: randomTurnKey(), originPromptKey: base.promptKey }
}

function withRetryReference(failed: ProjectedTurn): ProjectedTurn {
  if (!failed.promptKey) throw new NoResponseEvidenceError()
  const body = `RETRY OF: ${failed.promptKey}`
  return {
    ...withDerivedKey(failed),
    primingPrompts: [],
    initialPrompt: body,
    incrementalPrompt: body,
    recoveryPrompt: body,
    compactionDigest: undefined,
    toolRepairPrompt: undefined,
  }
}

function withFormatRetryReference(failed: ProjectedTurn): ProjectedTurn {
  if (!failed.promptKey) throw new NoResponseEvidenceError()
  const body = `RETRY OF: ${failed.promptKey}\n\nFORMAT CORRECTION: Return only proper <aipass-envelope> JSON using the NEW current TURN KEY. Do not include prose outside the envelope.`
  return {
    ...withDerivedKey(failed),
    primingPrompts: [],
    initialPrompt: body,
    incrementalPrompt: body,
    recoveryPrompt: body,
    compactionDigest: undefined,
    toolRepairPrompt: undefined,
  }
}

function declaredFromEnvelopeValue(value: unknown): Array<{ readonly name: string; readonly input: unknown }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return []
  const item = value as Record<string, unknown>
  // Tool-named envelopes are normalized by the protocol parser. Their
  // arguments belong to the harness validator, not schema provisioning.
  if (typeof item.type === "string" && !isActionEnvelopeType(item.type)) return []
  if (typeof item.type !== "string") {
    // Typeless tool envelope (live terra omits "type"): same rule as
    // protocol — valid name plus id/key/input presence.
    if (typeof item.name !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(item.name)) return []
    if (item.id === undefined && item.key === undefined && item.input === undefined) return []
    return [{ name: item.name, input: item.input ?? {} }]
  }
  if (item.type === "plan") {
    if (!Array.isArray(item.steps)) return []
    const steps: Array<{ readonly name: string; readonly input: unknown }> = []
    for (const candidate of item.steps) {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue
      const step = candidate as Record<string, unknown>
      if (typeof step.name !== "string") continue
      steps.push({ name: step.name, input: step.input ?? {} })
    }
    return steps
  }
  const name = typeof item.name === "string" ? item.name : item.type
  if (typeof name !== "string") return []
  return [{ name, input: item.input ?? {} }]
}

function responseText(frames: readonly BrowserFrame[]): string {
  let text = ""
  for (const frame of frames) if (frame.type === "text") text += frame.delta
  return text
}

function isEnvelopeKeyMismatch(frames: readonly BrowserFrame[], expectedKey: string | undefined): boolean {
  if (!expectedKey) return false
  return !envelopesMatchTurnKey(responseText(frames), expectedKey)
}

function invalidEnvelopeResponse(
  frames: readonly BrowserFrame[],
  expectedKey: string | undefined,
  offered: ReadonlySet<string>,
): "key" | "format" | undefined {
  if (!expectedKey) return undefined
  if (!frames.some((frame) => frame.type === "finish") || frames.some((frame) => frame.type === "auth-required" || frame.type === "error"))
    return undefined
  const text = responseText(frames)
  if (!envelopesMatchTurnKey(text, expectedKey)) return "key"
  try {
    validateStrictEnvelopeResponse(text, offered)
    return undefined
  } catch (error) {
    return error instanceof EnvelopeResponseFormatError ? "format" : undefined
  }
}

function extractJsonObjects(text: string): unknown[] {
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

function collectDeclaredTools(frames: readonly BrowserFrame[]): Array<{ readonly name: string; readonly input: unknown }> {
  const declared: Array<{ readonly name: string; readonly input: unknown }> = []
  let text = ""
  for (const frame of frames) {
    if (frame.type === "tool-call") declared.push({ name: frame.name, input: frame.input })
    else if (frame.type === "text") text += frame.delta
  }
  const open = "<aipass-envelope>"
  const close = "</aipass-envelope>"
  let index = 0
  while (true) {
    const start = text.indexOf(open, index)
    if (start < 0) break
    const end = text.indexOf(close, start + open.length)
    if (end < 0) break
    try {
      declared.push(...declaredFromEnvelopeValue(JSON.parse(text.slice(start + open.length, end))))
    } catch {
      // Malformed envelope text surfaces downstream; ignore here.
    }
    index = end + close.length
  }
  for (const value of extractJsonObjects(text)) declared.push(...declaredFromEnvelopeValue(value))
  return declared
}

export class StandaloneBrowserService implements BrowserService {
  private readonly sessions = new Map<string, Promise<void>>()
  private readonly completions: SingleFlightCompletionStore
  private readonly pending = new Map<string, { hash: string; settled: Promise<void>; resolve: () => void }>()
  private readonly waitMs: number
  private readonly flightStore?: BindingStore
  private readonly chatURL?: string

  constructor(
    private readonly adapter: PlaywrightBrowserAdapter<BrowserFrame, TurnAttempt>,
    options: { readonly waitMs?: number; readonly store?: BindingStore; readonly cache?: SingleFlightCompletionStore; readonly chatURL?: string } = {},
  ) {
    this.waitMs = options.waitMs ?? 10_000
    this.flightStore = options.store
    this.chatURL = options.chatURL
    this.completions = options.cache ?? new SingleFlightCompletionStore()
  }

  private async acquire(session: string) {
    const previous = this.sessions.get(session) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const tail = previous.then(() => gate)
    this.sessions.set(session, tail)
    await previous
    return () => {
      release()
      if (this.sessions.get(session) === tail) this.sessions.delete(session)
    }
  }

  private async flightHash(input: ProjectedTurn): Promise<string> {
    const hashPrompt = (prompt: string) =>
      promptHashForSingleFlight(JSON.stringify([
        input.modelID, input.reasoning, input.compactionDigest, input.primingPrompts,
        input.promptKey ? withTurnKey(prompt, input.promptKey) : prompt,
      ]))
    if (!this.flightStore) return hashPrompt(input.initialPrompt)
    const record = await this.flightStore.get(input.sessionMarker)
    const binding = record?.remoteChatID
    const bound = binding !== undefined && (this.chatURL === undefined ? true : sameOrigin(binding, this.chatURL))
    const currentVersion = record?.context?.promptContractVersion
    const currentDigest = record?.context?.actionEnvelopeDigest
    const contractCurrent = promptContractCurrent(
      input.promptContractVersion,
      input.actionEnvelopeDigest,
      currentVersion,
      currentDigest,
    )
    const prompt = turnPrompt(
      {
        initialPrompt: input.initialPrompt,
        incrementalPrompt: input.incrementalPrompt,
        recoveryPrompt: input.recoveryPrompt,
        promptContractVersion: input.promptContractVersion,
        actionEnvelopeDigest: input.actionEnvelopeDigest,
        toolContinuation: input.toolContinuation,
      } as never,
      bound,
      false,
      contractCurrent,
    )
    return hashPrompt(prompt)
  }

  async *turn(input: ProjectedTurn, signal?: AbortSignal) {
    const marker = input.sessionMarker
    const hash = await this.flightHash(input)
    const cached = this.completions.get(marker, hash)
    if (cached) {
      yield* [...cached]
      return
    }
    const pending = this.pending.get(marker)
    if (pending && pending.hash === hash) {
      if (signal?.aborted) throw new Error("browser turn was cancelled")
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, this.waitMs))
      await Promise.race([pending.settled, timeout])
      const afterWait = this.completions.get(marker, hash)
      if (afterWait) {
        yield* [...afterWait]
        return
      }
    }
    let isLeader = false
    if (!this.pending.has(marker)) {
      let resolve!: () => void
      const settled = new Promise<void>((value) => (resolve = value))
      this.pending.set(marker, { hash, settled, resolve })
      isLeader = true
    }
    const release = await this.acquire(marker)
    const definition = model(input.modelID)
    const adapter = this.adapter
    const adapterTurn = async function* (projected: ProjectedTurn, recovery: boolean): AsyncGenerator<BrowserFrame> {
      let safetyTail = ""
      const linked = projected as ProjectedTurn & { originPromptKey?: string }
      const observed = {
        sessionMarker: projected.sessionMarker,
        ephemeral: false,
        primingPrompts: projected.primingPrompts,
        model: definition,
        reasoning: projected.reasoning,
        initialPrompt: projected.initialPrompt,
        incrementalPrompt: projected.incrementalPrompt,
        recoveryPrompt: projected.recoveryPrompt,
        compactionDigest: projected.compactionDigest,
        promptContractVersion: projected.promptContractVersion,
        actionEnvelopeDigest: projected.actionEnvelopeDigest,
        toolContinuation: projected.toolContinuation,
        attachments: projected.attachments,
        promptKey: projected.promptKey,
        ...(linked.originPromptKey === undefined ? {} : { originPromptKey: linked.originPromptKey }),
      }
      for await (const frame of adapter.turn(observed, signal, { forceReload: recovery })) {
        if (frame.type === "text") {
          const text = safetyTail + frame.delta
          if (isWebchatSafetyBlock(text)) throw new WebchatSafetyBlockError()
          safetyTail = text.slice(-256)
        }
        yield frame
      }
    }
    try {
      const repairPrompt = input.toolRepairPrompt
        ?? (input.toolContinuation && (input.offeredToolSchemas ?? []).length > 0
          ? "Reconsider only a lack-of-client-action-access refusal using the actions and schemas supplied during startup. Do not override safety, privacy, authorization, or policy restrictions."
          : undefined)
      const collected: BrowserFrame[] = []
      try {
        let progressed = false
        const validate = async (frames: BrowserFrame[], projected: ProjectedTurn) => {
          try {
            const failure = frames.find((frame) => frame.type === "auth-required" || frame.type === "error")
            if (failure?.type === "auth-required") throw new Error("browser authentication is required")
            if (failure?.type === "error") throw new Error(failure.message)
            if (!frames.some((frame) => frame.type === "finish"))
              throw new Error("browser stream ended without a terminal finish event")
            // Safety-filter blocks never enter the repair net: fail the turn
            // instead of re-submitting a prompt the filter already rejected.
            if (isWebchatSafetyBlock(responseText(frames))) throw new WebchatSafetyBlockError()
            if (isEnvelopeKeyMismatch(frames, projected.promptKey))
              throw new Error(`browser response TURN KEY mismatch${progressed ? " after reasoning progress" : ""}`)
            if (projected.promptKey) {
              try {
                validateStrictEnvelopeResponse(responseText(frames), new Set(projected.offeredActions))
              } catch (error) {
                if (error instanceof EnvelopeResponseFormatError)
                  throw new Error("browser response envelope format is invalid")
                throw error
              }
            }
            // Validate a copy of the terminal chain, but publish the original
            // envelopes so quoted examples cannot be decoded a second time.
            await collectOpenAIChatResult(frames, new Set(projected.offeredActions), false, progressed)
          } catch (error) {
            if (progressed) await this.adapter.discard(marker)
            throw error
          }
        }
        interface CollectedAttempt {
          readonly frames: BrowserFrame[]
          readonly progressiveParser?: KeyedThinkingParser
          readonly reasoningSource?: "dom" | "typed"
          readonly submitted: ProjectedTurn
          readonly hiddenPromptTokens: number
          readonly suppressedReasoningTokens: number
        }
        const collectOne = async function* (
          projected: ProjectedTurn,
          progressive: boolean,
          recoveryEnabled: boolean,
          suppressReasoning = false,
          noEvidenceRetry: (failed: ProjectedTurn) => ProjectedTurn = withRetryReference,
          accountNoEvidenceRetry = false,
        ): AsyncGenerator<BrowserFrame, CollectedAttempt> {
          let current = projected
          let raw: BrowserFrame[] = []
          let progressiveParser: KeyedThinkingParser | undefined
          let attemptReasoningSource: "dom" | "typed" | undefined
          let hiddenPromptTokens = 0
          let suppressedReasoning = ""
          for (let attempt = 0; ; attempt++) {
            raw = []
            attemptReasoningSource = undefined
            suppressedReasoning = ""
            progressiveParser = (progressive || suppressReasoning) && current.promptKey
              ? new KeyedThinkingParser(current.promptKey, new Set(current.offeredActions))
              : undefined
            let emitted = false
            try {
              for await (const frame of adapterTurn(current, attempt > 0)) {
                emitted = true
                if (signal?.aborted) throw new Error("browser turn was cancelled")
                // Browser-attributed DOM reasoning and complete tagged thinking
                // envelopes may cross early. Terminal chat/actions remain in raw
                // until the entire response chain validates.
                if ((progressive || suppressReasoning) && frame.type === "reasoning" && current.promptKey && frame.domTurnKey === current.promptKey) {
                  if (attemptReasoningSource === undefined || attemptReasoningSource === "dom") {
                    attemptReasoningSource = "dom"
                    if (progressive) {
                      progressed = true
                      // The physical key is validated above. Remove it at this
                      // boundary so fresh keys remain one logical response.
                      const published: BrowserFrame = { type: "reasoning", delta: frame.delta }
                      collected.push(published)
                      yield published
                    } else suppressedReasoning += frame.delta
                  }
                  continue
                }
                raw.push(frame)
                if (frame.type !== "text" || !progressiveParser) continue
                for (const envelope of progressiveParser.push(frame.delta)) {
                  if (attemptReasoningSource !== undefined && attemptReasoningSource !== "typed") continue
                  attemptReasoningSource = "typed"
                  if (progressive) {
                    progressed = true
                    const published = { type: "text" as const, delta: envelope }
                    collected.push(published)
                    yield published
                  } else {
                    const open = envelope.indexOf(ENVELOPE_OPEN)
                    const close = envelope.indexOf(ENVELOPE_CLOSE, open + ENVELOPE_OPEN.length)
                    if (open >= 0 && close >= 0) {
                      const parsed = JSON.parse(envelope.slice(open + ENVELOPE_OPEN.length, close))
                      for (const item of parseTypedEnvelope(parsed, new Set(current.offeredActions)) ?? [])
                        if (item.type === "reasoning") suppressedReasoning += item.delta
                    }
                  }
                }
              }
            } catch (error) {
              if (!(error instanceof NoResponseEvidenceError) || emitted || !recoveryEnabled || attempt > 0) throw error
              current = noEvidenceRetry(current)
              if (accountNoEvidenceRetry)
                hiddenPromptTokens += estimateTokens(withTurnKey(current.initialPrompt, current.promptKey))
              continue
            }
            break
          }
          const collectedAttempt = (frames: BrowserFrame[]): CollectedAttempt => ({
            frames,
            progressiveParser,
            reasoningSource: attemptReasoningSource,
            submitted: current,
            hiddenPromptTokens,
            suppressedReasoningTokens: estimateTokens(suppressedReasoning),
          })
          if (invalidEnvelopeResponse(raw, current.promptKey, new Set(current.offeredActions))) return collectedAttempt(raw)
          const frames: BrowserFrame[] = []
          const repair = repairPrompt
            ? () => {
                const prompt = [repairPrompt, current.incrementalPrompt].filter(Boolean).join("\n\n")
                console.error(`aipass turn repair start promptChars=${prompt.length}`)
                current = withDerivedKey({
                  ...current,
                  primingPrompts: [],
                  initialPrompt: prompt,
                  incrementalPrompt: prompt,
                  recoveryPrompt: prompt,
                  compactionDigest: undefined,
                  toolRepairPrompt: undefined,
                })
                return adapterTurn(current, false)
              }
            : undefined
          for await (const frame of repairToolRefusal(raw, repair, current.offeredActions)) frames.push(frame)
          return collectedAttempt(frames)
        }
        let hiddenPromptTokens = 0
        let hiddenCompletionTokens = 0
        let formatRetries = 0
        const hiddenAttemptCompletion = (attempt: CollectedAttempt) => {
          const frames = attempt.progressiveParser?.withoutPublished(attempt.frames) ?? attempt.frames
          let output = ""
          for (const frame of frames) {
            if (frame.type === "text" || frame.type === "reasoning") output += frame.delta
            else if (frame.type === "tool-call") output += `${frame.name}${JSON.stringify(frame.input)}`
          }
          return estimateTokens(output)
        }
        const collectValidated = async function* (
          projected: ProjectedTurn,
          progressive = false,
          suppressReasoning = false,
        ): AsyncGenerator<BrowserFrame, CollectedAttempt> {
          const recoveryEnabled = projected.initialPrompt !== projected.incrementalPrompt
          let attempt = yield* collectOne(projected, progressive, recoveryEnabled, suppressReasoning)
          hiddenPromptTokens += attempt.hiddenPromptTokens
          const invalid = invalidEnvelopeResponse(attempt.frames, attempt.submitted.promptKey, new Set(attempt.submitted.offeredActions))
          if (invalid && formatRetries === 0 && (invalid === "format" || !progressed)) {
            if (isWebchatSafetyBlock(responseText(attempt.frames))) throw new WebchatSafetyBlockError()
            if (signal?.aborted) throw new Error("browser turn was cancelled")
            formatRetries++
            hiddenCompletionTokens += hiddenAttemptCompletion(attempt)
            const retry = withFormatRetryReference(attempt.submitted)
            hiddenPromptTokens += estimateTokens(withTurnKey(retry.initialPrompt, retry.promptKey))
            console.error(`aipass turn envelope correction=${invalid} retry=true`)
            attempt = yield* collectOne(
              retry,
              progressive && !progressed,
              recoveryEnabled,
              progressed || suppressReasoning,
              withFormatRetryReference,
              true,
            )
            hiddenPromptTokens += attempt.hiddenPromptTokens
          }
          hiddenCompletionTokens += attempt.suppressedReasoningTokens
          await validate(attempt.frames, attempt.submitted)
          return attempt
        }
        let finalAttempt = yield* collectValidated(input, true)
        const missingRequired = (attempt: CollectedAttempt) => {
          const schemasByName = new Map((input.offeredToolSchemas ?? []).map((schema) => [schema.name, schema]))
          const seen = new Set<string>()
          const names: string[] = []
          for (const declared of collectDeclaredTools(attempt.frames)) {
            if (seen.has(declared.name)) continue
            seen.add(declared.name)
            const schema = schemasByName.get(declared.name)
            if (!schema || hasAllRequiredKeys(declared.input, requiredKeysForSchema(schema.inputSchema))) continue
            names.push(declared.name)
          }
          return { names, schemasByName }
        }
        let missing = missingRequired(finalAttempt)
        if (missing.names.length > 0) {
          hiddenCompletionTokens += estimateTokens(
            collectDeclaredTools(finalAttempt.frames).map((call) => `${call.name}${JSON.stringify(call.input)}`).join(""),
          )
          const provisionSchemas = missing.names.map((name) => missing.schemasByName.get(name)!).filter(Boolean)
          const provisionPrompt = [
            "Correct the previous action request using its startup schema. Missing required input fields:",
            JSON.stringify(provisionSchemas.map(schema => ({ name: schema.name, required: requiredKeysForSchema(schema.inputSchema) }))),
            input.incrementalPrompt,
          ].filter(Boolean).join("\n\n")
          hiddenPromptTokens += estimateTokens(provisionPrompt)
          console.error(`aipass turn provision start tools=${missing.names.join(",")} promptChars=${provisionPrompt.length}`)
          const provisionInput = withDerivedKey({
            ...finalAttempt.submitted,
            primingPrompts: [],
            initialPrompt: provisionPrompt,
            incrementalPrompt: provisionPrompt,
            recoveryPrompt: provisionPrompt,
            compactionDigest: undefined,
            toolRepairPrompt: undefined,
          })
          // A corrective provision is a replacement attempt, not a
          // continuation of reasoning already shown to the caller.
          finalAttempt = yield* collectValidated(provisionInput, false, progressed)
          console.error(`aipass turn provision done tools=${missing.names.join(",")} frames=${finalAttempt.frames.length}`)
          missing = missingRequired(finalAttempt)
          if (missing.names.length > 0)
            throw new Error(`corrected action is still missing required input fields for ${missing.names.join(",")}`)
        }
        // Leave envelopes intact for the serializer: decoding here would
        // let quoted envelope examples in chat text be interpreted twice.
        const finalFrames = (attempt: CollectedAttempt) => {
          const frames = attempt.progressiveParser?.withoutPublished(attempt.frames) ?? attempt.frames
          return frames.filter((frame) => frame.type !== "reasoning"
            || (!attempt.reasoningSource && (frame.domTurnKey === undefined || frame.domTurnKey === attempt.submitted.promptKey)))
        }
        if (hiddenPromptTokens || hiddenCompletionTokens) {
          const usage: BrowserFrame = { type: "usage", promptTokens: hiddenPromptTokens, completionTokens: hiddenCompletionTokens }
          collected.push(usage)
          yield usage
        }
        for (const frame of finalFrames(finalAttempt)) {
          collected.push(frame)
          yield frame
        }
        this.completions.set(marker, hash, collected)
      } finally {
        if (isLeader) {
          this.pending.get(marker)?.resolve()
          if (this.pending.get(marker)?.hash === hash) this.pending.delete(marker)
        }
      }
    } finally {
      try {
        if (input.ephemeral) await this.adapter.discard(input.sessionMarker)
      } finally {
        release()
      }
    }
  }

  async login() {
    throw new AuthenticationRequiredError()
  }

  discard(sessionMarker: string) {
    return this.adapter.discard(sessionMarker)
  }

  close() {
    return this.adapter.close()
  }
}

function iterableFrames(value: AsyncIterable<BrowserFrame> | Iterable<BrowserFrame>): AsyncIterable<BrowserFrame> {
  if (Symbol.asyncIterator in value) return value as AsyncIterable<BrowserFrame>
  return {
    async *[Symbol.asyncIterator]() {
      yield* value as Iterable<BrowserFrame>
    },
  }
}

function toolAccessRefusal(text: string) {
  // Live (terra): webchat emits U+2019 in "can’t access ...". Normalize
  // curly/typographic apostrophes to ASCII before matching.
  const normalized = text.replace(/[’‘‛`´]/g, "'")
  const explicitSafetyRationale =
    /\b(?:harmful|unsafe|dangerous|destructive|malicious|illegal|delete|deleting|remove|removing|erase|destroy|overwrite|exfiltrate|steal|credential|secret|password|token)\b/i.test(
      normalized,
    )
  const causalSafetyRationale =
    /\bwithout\s+(?:(?:valid|proper|explicit|required|necessary|the necessary)\s+)?(?:authori[sz]ation|permission)\b/i.test(
      normalized,
    ) ||
    /\b(?:would|could|may|might|risks?|compromis(?:e|es|ed|ing)|violat(?:e|es|ed|ing)|breach(?:es|ed|ing)?|expos(?:e|es|ed|ing))\b[^.]{0,100}\b(?:security|privacy|authori[sz]ation|permission)\b/i.test(
      normalized,
    ) ||
    /\b(?:cannot|can'?t|unable to)\b[^.]{0,120}\b(?:due to|because of|as|for)\b[^.]{0,100}\b(?:security|privacy|authori[sz]ation|permission)\b/i.test(
      normalized,
    )
  const actionSafetyRationale =
    /\b(?:do not|don'?t|cannot|can'?t|unable to)\s+(?:execute|run|use)\b[^.]{0,160}\b(?:security|privacy)\b/i.test(
      normalized,
    )
  if (explicitSafetyRationale || causalSafetyRationale || actionSafetyRationale) return false
  const denial = [
    /\b(?:do not|don'?t|cannot|can'?t|unable to)\s+(?:have\s+)?(?:direct\s+)?access\b/i,
    /\bno\s+(?:direct\s+)?access\b/i,
    /\b(?:do not|don'?t|cannot|can'?t)\s+have\s+(?:the\s+)?permission\s+to\s+(?:read|list|inspect|run|execute|use|access|create|write|edit|modify|update)\b/i,
    /\b(?:cannot|can'?t|unable to)\s+(?:read|list|inspect|run|execute|use|access|create|write|edit|modify|update)\b/i,
    /\b(?:do(?: not|n'?t) have the (?:capability|ability)|not capable of)\b/i,
    /\busing the available tools\b/i,
  ].some((pattern) => pattern.test(normalized))
  return denial && /\b(?:file|files|directory|folder|workspace|tool|command|shell|computer|web|network|agent|agents|subagent|subagents|skill|skills|question|questions|permission|permissions)\b/i.test(normalized)
}

// Measured (live): the model sometimes emits a bare action object without the
// <aipass-action> tags (e.g. calling a tool it remembers from thread history).
// Untagged text never becomes a tool call downstream, so route it to repair
// where the full contract re-provides the tagged format. Shape-checked only;
// the repair turn re-validates the name against offered tools.
function hasUntaggedActionCall(text: string) {
  return /\{\s*"id"\s*:\s*"[^"]*"\s*,\s*"name"\s*:\s*"[A-Za-z0-9_.:-]+"\s*,\s*"input"\s*:/.test(text)
}

// Measured (live): the model sometimes emits a bare action object without tags
// and the repair re-submit returns the same untagged shape. Convert locally:
// extract the first balanced action object, validate its name against the
// offered set, and emit it as a tool call instead of replaying the backend.
// Returns undefined when conversion is unsafe; the caller then re-submits.
function convertUntaggedAction(
  buffered: readonly BrowserFrame[],
  offeredActions: readonly string[] | undefined,
): BrowserFrame[] | undefined {
  if (!offeredActions || offeredActions.length === 0) return undefined
  let fullText = ""
  for (const frame of buffered) if (frame.type === "text") fullText += frame.delta
  const head =
    /\{\s*"id"\s*:\s*"([^"]+)"\s*,\s*"name"\s*:\s*"([A-Za-z0-9_.:-]+)"\s*,\s*"input"\s*:\s*\{/.exec(fullText)
  if (!head || head.index === undefined || head[1] === undefined || head[2] === undefined) return undefined
  const name = head[2]
  if (!offeredActions.includes(name)) return undefined
  let depth = 0
  let end = -1
  let inString = false
  let escaped = false
  for (let i = head.index; i < fullText.length; i++) {
    const char = fullText.charAt(i)
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(fullText.slice(head.index, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const action = parsed as { id?: unknown; name?: unknown; input?: unknown }
  if (typeof action.id !== "string" || action.id.length === 0 || action.name !== name) return undefined
  if (typeof action.input !== "object" || action.input === null || Array.isArray(action.input)) return undefined
  const output: BrowserFrame[] = []
  const before = fullText.slice(0, head.index)
  const after = fullText.slice(end + 1)
  if (before.trim().length > 0) output.push({ type: "text", delta: before })
  output.push({ type: "tool-call", id: action.id, name, input: action.input as Record<string, unknown> })
  if (after.trim().length > 0) output.push({ type: "text", delta: after })
  for (const frame of buffered) if (frame.type !== "text") output.push(frame)
  return output
}

export async function* repairToolRefusal(
  initial: AsyncIterable<BrowserFrame> | Iterable<BrowserFrame>,
  repair?: () => AsyncIterable<BrowserFrame> | Iterable<BrowserFrame>,
  offeredActions?: readonly string[],
): AsyncGenerator<BrowserFrame> {
  if (!repair) {
    yield* iterableFrames(initial)
    return
  }
  const iterator = iterableFrames(initial)[Symbol.asyncIterator]()
  const buffered: BrowserFrame[] = []
  let sample = ""
  let bufferedCharacters = 0
  let actionTail = ""
  let terminalReason: FinishReason | undefined
  let initialDone = false
  try {
    while (true) {
      const next = await iterator.next()
      if (next.done) {
        initialDone = true
        break
      }
      const frame = next.value
      buffered.push(frame)
      if (frame.type === "text") {
        sample = (sample + frame.delta).slice(0, 4_096)
        actionTail = (actionTail + frame.delta).slice(-256)
        bufferedCharacters += frame.delta.length
      } else if (frame.type === "reasoning") bufferedCharacters += frame.delta.length
      else if (frame.type === "finish") terminalReason = frame.reason
      if (frame.type === "tool-call" || actionTail.includes("<aipass-action>")) {
        yield* buffered
        while (true) {
          const remaining = await iterator.next()
          if (remaining.done) {
            initialDone = true
            return
          }
          yield remaining.value
        }
      }
      if (frame.type === "auth-required" || frame.type === "error" || bufferedCharacters > 64 * 1024) {
        yield* buffered
        while (true) {
          const remaining = await iterator.next()
          if (remaining.done) {
            initialDone = true
            return
          }
          yield remaining.value
        }
      }
    }
  } finally {
    if (!initialDone) await iterator.return?.()
  }
  // Typed actions already belong to the envelope validator. Their nested
  // calls and input strings are neither legacy calls nor access refusals.
  const bufferedText = responseText(buffered)
  // Safety-filter blocks never repair: the filter rejected the prompt, so a
  // re-submit would burn quota for the same block. Yield the text so the
  // caller surfaces it as a failure.
  if (isWebchatSafetyBlock(bufferedText) || isWebchatSafetyBlock(sample)) {
    console.error(`aipass turn repair skipped reason=safety-block sampleChars=${sample.length}`)
    yield* buffered
    return
  }
  const offered = new Set(offeredActions)
  const typedAction = extractJsonObjects(responseText(buffered)).some((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    const type = (value as Record<string, unknown>).type
    return isActionEnvelopeType(type, offered)
  })
  if (typedAction) {
    yield* buffered
    return
  }
  // Repair on a refusal only for completed ("stop") turns: length-truncated
  // output must not replay. An untagged action blob is a complete call
  // intent (the shape requires the full "input" key), so it repairs on any
  // explicit finish. Turns that already emitted tool calls return above.
  const refused = terminalReason === "stop" && toolAccessRefusal(sample)
  const untagged = terminalReason !== undefined && hasUntaggedActionCall(sample)
  if (untagged) {
    const converted = convertUntaggedAction(buffered, offeredActions)
    if (converted !== undefined) {
      console.error(`aipass turn repair converted=untagged reason=${terminalReason}`)
      yield* converted
      return
    }
  }
  if (refused || untagged) {
    console.error(`aipass turn repair triggered=${refused ? "refusal" : "untagged"} reason=${terminalReason}`)
    yield* iterableFrames(repair())
    return
  }
  if (terminalReason !== "stop") {
    console.error(`aipass turn repair skipped reason=${terminalReason ?? "none"} sampleChars=${sample.length}`)
  }
  yield* buffered
}

export async function* recoverNoResponseEvidence<Frame>(
  turn: (recovery: boolean) => AsyncIterable<Frame>,
  enabled: boolean,
): AsyncGenerator<Frame> {
  const limit = enabled ? 2 : 1
  for (let attempt = 0; attempt < limit; attempt++) {
    let emitted = false
    try {
      for await (const frame of turn(attempt > 0)) {
        emitted = true
        yield frame
      }
      return
    } catch (error) {
      if (!(error instanceof NoResponseEvidenceError) || emitted || attempt + 1 >= limit) throw error
    }
  }
}

export async function loginProvider(settings: Settings) {
  const lock = await ProfileLock.acquire(settings.paths)
  try {
    await loginWithSystemChrome(browserConfig(settings))
    console.log("Authenticated chat and model catalog verified.")
  } finally {
    await lock.release()
  }
}

export async function serveProvider(settings: Settings) {
  const lock = await ProfileLock.acquire(settings.paths)
  const store = new BindingStore(settings.paths.bindings)
  const token = await readOrCreateToken(settings.paths)
  const config = browserConfig(settings)
  const adapter = await PlaywrightBrowserAdapter.launch(config, lifecycle(store), protocol).catch(async (error) => {
    await lock.release()
    throw error
  })
  const browser = new StandaloneBrowserService(adapter, { store, chatURL: config.chatURL })
  const target = settings.requestedPort ?? settings.config.port ?? 0
  let server: ReturnType<typeof Bun.serve> | undefined
  let stopped = false
  let resolveStopped!: () => void
  const stoppedSignal = new Promise<void>((resolve) => (resolveStopped = resolve))
  const stop = async () => {
    if (stopped) return
    stopped = true
    await server?.stop(false)
    await browser.close()
    await lock.release()
    resolveStopped()
  }
  const start = (port: number) =>
    Bun.serve({ hostname: LOOPBACK_HOST, port, idleTimeout: 0, fetch: createRequestHandler({ token, browser, shutdown: stop }) })
  try {
    try {
      server = start(target)
    } catch (error) {
      if (settings.requestedPort !== undefined) throw error
      server = start(0)
    }
    const selectedPort = server.port
    if (typeof selectedPort !== "number" || !Number.isSafeInteger(selectedPort) || selectedPort < 1)
      throw new Error("provider server did not bind a valid loopback port")
    await persistRuntimeConfig(settings.configPath, { ...settings.config, version: 1, host: LOOPBACK_HOST, port: selectedPort })
    console.log(`OpenAI-compatible endpoint: http://${LOOPBACK_HOST}:${selectedPort}/v1`)
    const signal = () => void stop()
    process.once("SIGINT", signal)
    process.once("SIGTERM", signal)
    await stoppedSignal
    process.removeListener("SIGINT", signal)
    process.removeListener("SIGTERM", signal)
  } catch (error) {
    await stop()
    throw error
  }
}
