import { createHash, randomUUID } from "node:crypto"

import {
  AuthenticationRequiredError,
  NoResponseEvidenceError,
  PlaywrightBrowserAdapter,
  loginWithSystemChrome,
  promptContractCurrent,
  sameOrigin,
  shouldResetActionOnlyContext,
  turnPrompt,
  withTurnKey,
  type AttemptLifecycle,
  type BrowserAdapterConfig,
  type BrowserProtocol,
} from "./browser.ts"
import { LOOPBACK_HOST, MODELS, model, persistRuntimeConfig, readRuntimeConfig, type Settings } from "./config.ts"
import type { ProjectedTurn } from "./http.ts"
import { envelopesMatchTurnKey, isActionEnvelopeType, serializeToolDefinitions, StreamFrameParser, type BrowserFrame, type FinishReason } from "./protocol.ts"
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

const MAX_SHOWN_MARKERS = 100

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

function declaredFromEnvelopeValue(value: unknown): Array<{ readonly name: string; readonly input: unknown }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return []
  const item = value as Record<string, unknown>
  if (typeof item.type !== "string") {
    // Typeless tool envelope (live terra omits "type"): same rule as
    // protocol — valid name plus id/key/input presence.
    if (typeof item.name !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(item.name)) return []
    if (item.id === undefined && item.key === undefined && item.input === undefined) return []
    return [{ name: item.name, input: item.input ?? {} }]
  }
  if (item.type === "chat") return []
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
  private readonly shownSchemas = new Map<string, Set<string>>()
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

  private shownFor(marker: string): Set<string> {
    let shown = this.shownSchemas.get(marker)
    if (!shown) {
      if (this.shownSchemas.size >= MAX_SHOWN_MARKERS) {
        const oldest = this.shownSchemas.keys().next().value as string | undefined
        if (oldest !== undefined) this.shownSchemas.delete(oldest)
      }
      shown = new Set()
      this.shownSchemas.set(marker, shown)
    }
    return shown
  }

  private async flightHash(input: ProjectedTurn): Promise<string> {
    const hashPrompt = (prompt: string) =>
      promptHashForSingleFlight(input.promptKey ? withTurnKey(prompt, input.promptKey) : prompt)
    if (!this.flightStore) return hashPrompt(input.initialPrompt)
    const record = await this.flightStore.get(input.sessionMarker)
    const binding = record?.remoteChatID
    let bound = binding !== undefined && (this.chatURL === undefined ? true : sameOrigin(binding, this.chatURL))
    let currentVersion = record?.context?.promptContractVersion
    let currentDigest = record?.context?.actionEnvelopeDigest
    if (
      shouldResetActionOnlyContext(
        bound,
        input.promptContractVersion,
        input.actionEnvelopeDigest,
        currentVersion,
        currentDigest,
      )
    ) {
      bound = false
      currentVersion = undefined
      currentDigest = undefined
    }
    const contractCurrent = promptContractCurrent(
      input.promptContractVersion,
      input.actionEnvelopeDigest,
      currentVersion,
      currentDigest,
      input.toolContinuation,
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
    const adapterTurn = (projected: ProjectedTurn, recovery: boolean) =>
      this.adapter.turn({
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
      }, signal, { forceReload: recovery })
    try {
      const repairPrompt = input.toolRepairPrompt
        ?? (input.toolContinuation && (input.offeredToolSchemas ?? []).length > 0
          ? serializeToolDefinitions(
              (input.offeredToolSchemas ?? []).map((schema) => ({
                name: schema.name,
                ...(schema.description ? { description: schema.description } : {}),
                inputSchema: schema.inputSchema,
              })),
            )
          : undefined)
      const repair = repairPrompt
        ? () => {
            const prompt = [input.recoveryPrompt, repairPrompt].filter(Boolean).join("\n\n")
            console.error(`aipass turn repair start promptChars=${prompt.length}`)
            const repairInput: ProjectedTurn = {
              ...input,
              primingPrompts: [],
              initialPrompt: prompt,
              incrementalPrompt: prompt,
              recoveryPrompt: prompt,
              compactionDigest: undefined,
              toolRepairPrompt: undefined,
            }
            return recoverNoResponseEvidence((recovery) => adapterTurn(repairInput, recovery), false)
          }
        : undefined
      const shown = this.shownFor(marker)
      for (const name of input.provisionedActions ?? []) shown.add(name)
      const collected: BrowserFrame[] = []
      try {
        const collectOne = async (projected: ProjectedTurn): Promise<BrowserFrame[]> => {
          const source = recoverNoResponseEvidence(
            (recovery) => adapterTurn(projected, recovery),
            projected.initialPrompt !== projected.incrementalPrompt,
          )
          const raw: BrowserFrame[] = []
          for await (const frame of source) raw.push(frame)
          if (isEnvelopeKeyMismatch(raw, projected.promptKey)) return raw
          const frames: BrowserFrame[] = []
          for await (const frame of repairToolRefusal(raw, repair, projected.offeredActions)) frames.push(frame)
          return frames
        }
        const collectValidated = async (projected: ProjectedTurn): Promise<BrowserFrame[]> => {
          let frames = await collectOne(projected)
          if (isEnvelopeKeyMismatch(frames, projected.promptKey)) {
            console.error("aipass turn key mismatch retry=true")
            frames = await collectOne(projected)
          }
          if (isEnvelopeKeyMismatch(frames, projected.promptKey)) throw new Error("browser response TURN KEY mismatch")
          return frames
        }
        const initialCollected = await collectValidated(input)
        const schemasByName = new Map((input.offeredToolSchemas ?? []).map((schema) => [schema.name, schema]))
        const seen = new Set<string>()
        const need: string[] = []
        for (const declared of collectDeclaredTools(initialCollected)) {
          if (seen.has(declared.name)) continue
          seen.add(declared.name)
          const schema = schemasByName.get(declared.name)
          if (!schema) continue
          if (hasAllRequiredKeys(declared.input, requiredKeysForSchema(schema.inputSchema))) continue
          need.push(declared.name)
        }
        if (need.length === 0) {
          for (const frame of initialCollected) {
            collected.push(frame)
            yield frame
          }
        } else {
          const provisionSchemas = need.map((name) => schemasByName.get(name)!).filter(Boolean)
          const provisionPrompt = [input.recoveryPrompt, serializeToolDefinitions(provisionSchemas)].filter(Boolean).join("\n\n")
          console.error(`aipass turn provision start tools=${need.join(",")} promptChars=${provisionPrompt.length}`)
          for (const name of need) shown.add(name)
          const provisionInput: ProjectedTurn = {
            ...input,
            primingPrompts: [],
            initialPrompt: provisionPrompt,
            incrementalPrompt: provisionPrompt,
            recoveryPrompt: provisionPrompt,
            compactionDigest: undefined,
            toolRepairPrompt: undefined,
          }
          const provisionCollected = await collectValidated(provisionInput)
          console.error(`aipass turn provision done tools=${need.join(",")} frames=${provisionCollected.length}`)
          for (const frame of provisionCollected) {
            collected.push(frame)
            yield frame
          }
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
  const typedAction = extractJsonObjects(responseText(buffered)).some((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    const type = (value as Record<string, unknown>).type
    return isActionEnvelopeType(type)
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
  const persisted = await readRuntimeConfig(settings.configPath)
  const target = settings.requestedPort ?? persisted?.port ?? 0
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
    await persistRuntimeConfig(settings.configPath, { version: 1, host: LOOPBACK_HOST, port: selectedPort })
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
