import { createHash } from "node:crypto"
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, errors, type BrowserContext, type Locator, type Page } from "playwright-core"
import { estimateTokens } from "./context.ts"
import { browserControlState } from "./browser-diagnostics.ts"
import { THINKING_LABELS } from "./model-catalog.ts"
import { INSTRUCTION_DIGEST_PREFIX_LENGTH, estimateCapturedTextTokens, hasTerminalEnvelope, hasThinkingOnlyEnvelope, type BrowserFrame } from "./protocol.ts"

export type ReasoningLevel = "none" | "low" | "medium" | "high" | "max"

export interface BrowserModel {
  readonly id: string
  readonly name: string
  readonly thinking: readonly Exclude<ReasoningLevel, "none">[]
}

export interface BrowserSelectors {
  readonly authenticatedChat?: string
  readonly modelLoader?: string
  readonly modelOptions?: string
  readonly promptInput?: string
  readonly sendButton?: string
}

export interface BrowserAdapterConfig {
  readonly profilePath: string
  readonly executablePath: string
  readonly chatURL: string
  readonly streamURLPattern?: string
  readonly navigationTimeoutMs?: number
  readonly streamIdleTimeoutMs?: number
  readonly selectors?: BrowserSelectors
  readonly loginModelName?: string
  readonly modelNames?: readonly string[]
  readonly headed?: boolean
  readonly screenshotDir?: string
}

export interface BrowserTurnInput {
  readonly sessionMarker: string
  readonly ephemeral: boolean
  readonly primingPrompts: readonly string[]
  readonly model: BrowserModel
  readonly reasoning: ReasoningLevel
  readonly initialPrompt: string
  readonly incrementalPrompt: string
  readonly recoveryPrompt: string
  readonly compactionDigest?: string
  readonly promptContractVersion: number
  readonly actionEnvelopeDigest: string
  readonly toolContinuation: boolean
  // Staged + uploaded by the adapter before submit; descriptors only (see RequestAttachment).
  readonly attachments?: readonly TurnAttachment[]
  // Repo nonce appended at fill time (never hashed); the response must echo it.
  readonly promptKey?: string
}

export interface TurnAttachment {
  readonly kind: "image" | "file"
  readonly url?: string
  readonly data?: string
  readonly mime?: string
  readonly filename?: string
}

const ATTACHMENT_STAGE_CAP = 15_000_000
const THINKING_REVEAL_TIMEOUT_MS = 2_000
const DOM_STABILITY_MS = 4_000

export function safeAttachmentBasename(name?: string, index = 0) {
  const raw = basename(name ?? "")
  const sanitized = raw
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 100)
  if (!sanitized || sanitized === "." || sanitized === ".." || sanitized === "_") return `attachment-${index}`
  return sanitized
}

export interface StagedAttachmentFile {
  readonly path: string
  readonly filename: string
}

export interface StagedAttachments {
  readonly dir: string | null
  readonly files: StagedAttachmentFile[]
}

export async function stageAttachments(
  attachments: readonly TurnAttachment[],
): Promise<StagedAttachments> {
  if (attachments.length === 0) return { dir: null, files: [] }
  const dir = join(tmpdir(), `aipass-attachments-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  try {
    const files: StagedAttachmentFile[] = []
    for (let index = 0; index < attachments.length; index++) {
      const attachment = attachments[index]!
      const filename = safeAttachmentBasename(attachment.filename, index)
      const path = join(dir, `${index}-${filename}`)
      if (typeof attachment.data === "string" && attachment.data) {
        if (attachment.data.length > ATTACHMENT_STAGE_CAP)
          throw new Error(`attachment ${index} is too large`)
        const bytes = Buffer.from(attachment.data, "base64")
        if (bytes.length > ATTACHMENT_STAGE_CAP) throw new Error(`attachment ${index} is too large`)
        await writeFile(path, bytes)
      } else if (typeof attachment.url === "string" && attachment.url) {
        const url = attachment.url
        if (url.startsWith("file://")) {
          await copyFile(fileURLToPath(url), path)
        } else if (url.startsWith("/")) {
          await copyFile(url, path)
        } else if (/^https?:\/\//i.test(url)) {
          const response = await fetch(url)
          if (!response.ok) throw new Error(`attachment ${index} download failed`)
          const bytes = Buffer.from(await response.arrayBuffer())
          if (bytes.length > ATTACHMENT_STAGE_CAP) throw new Error(`attachment ${index} is too large`)
          await writeFile(path, bytes)
        } else {
          throw new Error(`attachment ${index} needs file_data, an https:/file: url, or an absolute path`)
        }
      } else {
        throw new Error(`attachment ${index} needs file_data, an https:/file: url, or an absolute path`)
      }
      files.push({ path, filename })
    }
    return { dir, files }
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

interface StagedUploadPage {
  locator(selector: string): {
    first(): {
      setInputFiles(files: string | readonly string[]): Promise<void>
      click(options?: unknown): Promise<void>
    }
  }
  evaluate?(pageFunction: () => unknown): Promise<unknown>
  waitForEvent?(
    event: "filechooser",
    optionsOrPredicate?: { readonly timeout?: number },
  ): Promise<{ setFiles(files: string | readonly string[]): Promise<void> }>
}

const TRIGGER_TIMEOUT_MS = 2_000
const MENU_TIMEOUT_MS = 3_000
const FILE_CHOOSER_TIMEOUT_MS = 8_000
const MENU_POLL_ATTEMPTS = 10
const MENU_POLL_INTERVAL_MS = 150

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// Ordered trigger candidates: aria-labeled attach/upload buttons first so a
// bare [data-slot="dropdown-menu-trigger"] never resolves to an unrelated
// menu (e.g. the conversation kebab menu) via .first(). Composer-scoped
// fallbacks come before the unscoped last resort.
const TRIGGER_CANDIDATES = [
  'button[data-slot="dropdown-menu-trigger"][aria-label*="Attach" i]',
  'button[data-slot="dropdown-menu-trigger"][aria-label*="Upload" i]',
  'button[data-slot="dropdown-menu-trigger"][aria-label*="File" i]',
  'button[data-slot="dropdown-menu-trigger"][aria-label*="Image" i]',
  'button[data-slot="dropdown-menu-trigger"][aria-label*="Plus" i]',
  'button[data-slot="dropdown-menu-trigger"][aria-label*="ไฟล์" i]',
  'button[data-slot="dropdown-menu-trigger"][aria-label*="รูป" i]',
  'button[data-slot="dropdown-menu-trigger"][aria-label*="อัปโหลด" i]',
  'button[aria-label*="Attach" i]',
  'button[aria-label*="Upload file" i]',
  'button[aria-label*="Plus" i]',
  'button[aria-label*="อัปโหลด" i]',
  // Generic trigger excluding the known conversation kebab menu: the live
  // probe resolved a bare trigger to aria-label="Conversation actions"
  // data-testid="conversation-kebab-menu". Excluding it lets the first
  // remaining trigger (the composer attach menu) win without guessing its
  // label. Element type is left open: the trigger may not be a <button>.
  '[data-slot="dropdown-menu-trigger"]:not([aria-label*="Conversation" i]):not([data-testid*="kebab" i])',
  'form [data-slot="dropdown-menu-trigger"]:not([aria-label*="Conversation" i]):not([data-testid*="kebab" i])',
  'div:has(textarea) [data-slot="dropdown-menu-trigger"]',
  'div:has([contenteditable]) [data-slot="dropdown-menu-trigger"]',
  'div:has(button[data-testid="send-button"]) [data-slot="dropdown-menu-trigger"]:not([aria-label*="Conversation" i]):not([data-testid*="kebab" i])',
  'button[data-testid*="attach" i]',
  'button[data-testid*="upload" i]',
  'button[data-testid*="plus" i]',
] as const

// Ordered menu-item candidates: exact EN/TH labels from the live UI first
// ("Upload File or Image" / "อัปโหลดไฟล์หรือรูป"), then generic fallbacks.
const MENU_CANDIDATES = [
  '[data-slot="dropdown-menu-item"]:has-text("Upload File or Image")',
  '[data-slot="dropdown-menu-item"]:has-text("อัปโหลดไฟล์หรือรูป")',
  '[data-slot="dropdown-menu-item"]:has-text("Upload")',
  '[data-slot="dropdown-menu-item"]:has-text("file")',
  '[data-slot="dropdown-menu-item"]:has-text("image")',
  '[role="menuitem"]:has-text("Upload File or Image")',
  '[role="menuitem"]:has-text("อัปโหลดไฟล์หรือรูป")',
  '[role="menuitem"]:has-text("Upload")',
  'button:has-text("Upload files")',
  'button:has-text("Upload images")',
] as const

async function domClick(page: StagedUploadPage, fn: () => unknown): Promise<boolean> {
  if (typeof page.evaluate !== "function") return false
  try {
    return !!(await page.evaluate(fn))
  } catch {
    return false
  }
}

// DOM-first trigger click: runs inside the page so it never resolves to an
// unrelated menu (e.g. the conversation kebab menu) via .first(). Excludes
// Conversation/kebab triggers, prefers composer-scoped ones. Returns true
// when a trigger was clicked. Structure-only: inspects tags/attributes,
// never message text.
function clickUploadTriggerDom(): boolean {
  const triggers = [...document.querySelectorAll('[data-slot="dropdown-menu-trigger"]')]
  // Live fingerprint (22 triggers, 20 kebab): the only non-kebab triggers
  // were user-menu-trigger and one bare trigger inside the composer div.
  // Exclude conversation/kebab AND user-menu so the composer attach trigger
  // wins without guessing its label.
  const bad = (el: Element) =>
    /conversation/i.test(el.getAttribute("aria-label") ?? "") ||
    /kebab/i.test(el.getAttribute("data-testid") ?? "") ||
    /user-menu/i.test(el.getAttribute("data-testid") ?? "")
  const candidates = triggers.filter((el) => !bad(el))
  if (!candidates.length) return false
  const score = (el: Element) => {
    let value = 0
    if (el.closest("form")) value += 4
    if (el.closest("div:has(textarea), div:has([contenteditable])")) value += 2
    if (/attach|upload|file|image|plus/i.test(el.getAttribute("aria-label") ?? "")) value += 3
    if (/attach|upload|plus/i.test(el.getAttribute("data-testid") ?? "")) value += 2
    return value
  }
  candidates.sort((a, b) => score(b) - score(a))
  const best = candidates[0]
  if (!best || !(best instanceof HTMLElement)) return false
  best.click()
  return true
}

// DOM-first menu-item click: clicks the Upload File or Image item (EN/TH)
// inside the open dropdown menu. Returns true when an item was clicked.
function clickUploadMenuItemDom(): boolean {
  const items = [...document.querySelectorAll('[data-slot="dropdown-menu-item"], [role="menuitem"]')]
  if (!items.length) return false
  const labels = ["upload file or image", "อัปโหลดไฟล์หรือรูป"]
  const textOf = (el: Element) => (el.textContent ?? "").trim().toLowerCase()
  let best = items.find((el) => labels.includes(textOf(el)))
  if (!best) best = items.find((el) => textOf(el).includes("upload"))
  if (!best || !(best instanceof HTMLElement)) return false
  best.click()
  return true
}

// Failure-path structure-only fingerprint: trigger/menu/input counts plus
// control names. Never includes message text.
async function logUploadFingerprint(page: StagedUploadPage): Promise<void> {
  if (typeof page.evaluate !== "function") return
  try {
    const snapshot = await page.evaluate(() => {
      const triggers = [...document.querySelectorAll('[data-slot="dropdown-menu-trigger"]')]
      const isKebab = (el: Element) => /kebab/i.test(el.getAttribute("data-testid") ?? "")
      const pick = (el: Element) => {
        const parent = el.parentElement
        return `${el.tagName.toLowerCase()}[aria-label="${(el.getAttribute("aria-label") ?? "").slice(0, 40)}"][data-testid="${(el.getAttribute("data-testid") ?? "").slice(0, 40)}"]<${parent ? parent.tagName.toLowerCase() : "?"}[class="${(parent?.getAttribute("class") ?? "").slice(0, 40)}"]`
      }
      const menuItems = [...document.querySelectorAll('[data-slot="dropdown-menu-item"], [role="menuitem"]')]
      const inputs = [...document.querySelectorAll('input[type="file"]')]
      const inputPick = (el: Element) =>
        `[accept="${(el.getAttribute("accept") ?? "").slice(0, 60)}"][name="${(el.getAttribute("name") ?? "").slice(0, 30)}"][id="${(el.getAttribute("id") ?? "").slice(0, 30)}"][multiple=${el.hasAttribute("multiple")}]<${el.parentElement ? el.parentElement.tagName.toLowerCase() : "?"}`
      const composer = document.querySelector("form, div:has(textarea), div:has([contenteditable])")
      return JSON.stringify({
        triggers: triggers.length,
        kebab: triggers.filter(isKebab).length,
        // Non-kebab triggers first: these are the real attach candidates.
        triggerNames: [...triggers.filter((el) => !isKebab(el)), ...triggers.filter(isKebab)].slice(0, 8).map(pick),
        menuItems: menuItems.length,
        menuNames: menuItems.slice(0, 8).map((el) => (el.textContent ?? "").trim().slice(0, 40)),
        fileInputs: inputs.length,
        fileInputNames: inputs.slice(0, 4).map(inputPick),
        forms: document.querySelectorAll("form").length,
        textareas: document.querySelectorAll("textarea, [contenteditable]").length,
        composerTag: composer ? composer.tagName.toLowerCase() : null,
      })
    })
    const raw = String(snapshot)
    // Emit in chunks: single log lines truncate, and the tail (non-kebab
    // triggers, menu item names) is the diagnostic payload we need.
    for (let i = 0; i < raw.length; i += 1000) {
      console.error(`aipass upload fingerprint[${i / 1000}] ${raw.slice(i, i + 1000)}`)
    }
  } catch {
    // Fingerprint is best-effort diagnostics only.
  }
}

async function clickFirstCandidate(
  page: StagedUploadPage,
  candidates: readonly string[],
  timeoutMs: number,
): Promise<void> {
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      await page.locator(candidate).first().click({ timeout: timeoutMs })
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error("attachment upload control not found")
}

export async function uploadStagedFiles(
  page: StagedUploadPage,
  files: readonly { readonly path: string }[],
): Promise<void> {
  if (files.length === 0) return
  const paths = files.map((file) => file.path)
  const single = paths.length === 1 ? paths[0]! : [...paths]
  const setHiddenInput = () =>
    page.locator('input[type="file"]').first().setInputFiles(single)
  // Dismiss any open menu so it never intercepts the send click. Anonymous
  // on purpose: no named contract, best-effort only.
  const dismissMenu = async () => {
    if (typeof page.evaluate !== "function") return
    try {
      await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        ;(document.activeElement as HTMLElement | null)?.blur?.()
        return true
      })
    } catch {
      // Best-effort only.
    }
  }
  // Poll the DOM menu until it renders: the dropdown menu mounts
  // asynchronously after the trigger click, so a single attempt misses it.
  const clickMenuPoll = async () => {
    for (let attempt = 0; attempt < MENU_POLL_ATTEMPTS; attempt++) {
      if (await domClick(page, clickUploadMenuItemDom)) return true
      if (attempt + 1 < MENU_POLL_ATTEMPTS) await sleep(MENU_POLL_INTERVAL_MS)
    }
    return false
  }
  // DOM-first path: runs inside the page so the click can never resolve to
  // an unrelated menu (e.g. the conversation kebab menu) via .first().
  // Falls back to ordered locator candidates when evaluate is unavailable.
  // Race the menu-item click against the native file chooser: some menu
  // items open the OS picker directly while others reveal a hidden
  // input[type=file]. Whichever path wins uploads; the loser is ignored.
  const viaDom = async () => {
    if (typeof page.waitForEvent === "function") {
      const chooser = page
        .waitForEvent("filechooser", { timeout: FILE_CHOOSER_TIMEOUT_MS })
        .then((event) => event.setFiles(single))
        .catch(() => undefined)
      try {
        if (!(await domClick(page, clickUploadTriggerDom)))
          await clickFirstCandidate(page, TRIGGER_CANDIDATES, TRIGGER_TIMEOUT_MS)
        if (!(await clickMenuPoll())) {
          try {
            await clickFirstCandidate(page, MENU_CANDIDATES, MENU_TIMEOUT_MS)
          } catch {
            // Menu never matched: fall back to the direct hidden input
            // below (live probe showed fileInputs=2 with zero menu items).
          }
        }
      } finally {
        await chooser
      }
      try {
        await setHiddenInput()
        // Reaching here without a menu match means the direct input did
        // the upload; log it so live probes can confirm the route.
        console.error("aipass upload direct input fallback files=1")
      } catch {
        // Already uploaded via the file chooser path; nothing left to do.
      }
      await dismissMenu()
      return
    }
    const triggerOk =
      (await domClick(page, clickUploadTriggerDom)) ||
      (await clickFirstCandidate(page, TRIGGER_CANDIDATES, TRIGGER_TIMEOUT_MS).then(
        () => true,
        () => false,
      ))
    if (!triggerOk) throw new Error("attachment upload control not found")
    if (await clickMenuPoll()) {
      try {
        await setHiddenInput()
      } catch {
        // Menu click opened the OS picker with no hidden input; the
        // filechooser race above handles that when available. Without
        // waitForEvent there is nothing further to try.
      }
      await dismissMenu()
      return
    }
    try {
      await clickFirstCandidate(page, MENU_CANDIDATES, MENU_TIMEOUT_MS)
      await setHiddenInput()
      await dismissMenu()
      return
    } catch {
      // Menu never matched: fall back to the direct hidden input before
      // giving up. The live probe showed fileInputs=2 with zero menu
      // items, so this path is the real upload route there.
    }
    try {
      await setHiddenInput()
      console.error("aipass upload direct input fallback files=1")
      await dismissMenu()
      return
    } catch (error) {
      throw error instanceof Error ? error : new Error("attachment upload control not found")
    }
  }
  try {
    await viaDom()
  } catch (error) {
    await logUploadFingerprint(page)
    throw error instanceof Error ? error : new Error("attachment upload control not found")
  }
}

export async function cleanupStagedFiles(dir: string | null | undefined): Promise<void> {
  if (!dir) return
  await rm(dir, { recursive: true, force: true })
}

export interface StepScreenshotPage {
  screenshot(options?: { readonly path?: string }): Promise<unknown>
}

export async function captureStepScreenshot(
  page: StepScreenshotPage,
  dir: string | null | undefined,
  name: string,
): Promise<string | undefined> {
  const target = dir?.trim()
  if (!target) return undefined
  const raw = basename(name ?? "")
  const cleaned = raw
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 80)
  const sanitized = !cleaned || cleaned === "." || cleaned === ".." || cleaned === "_" ? "step" : cleaned
  const path = join(target, `${Date.now()}-${sanitized}.png`)
  try {
    await mkdir(target, { recursive: true })
    await page.screenshot({ path })
    console.error(`aipass screenshot step=${name} path=${path}`)
    return path
  } catch {
    console.error(`aipass screenshot step=${name} failed`)
    return undefined
  }
}

export function withTurnKey(prompt: string, promptKey?: string): string {
  if (!promptKey) return prompt
  return `TURN KEY: ${promptKey}\n\n${prompt}`
}

export function promptContractCurrent(
  expectedVersion: number,
  expectedDigest: string,
  currentVersion: number | undefined,
  currentDigest: string | undefined,
  toolContinuation: boolean,
) {
  if (currentVersion !== expectedVersion) return false
  if (currentDigest === expectedDigest) return true
  const digestPattern = /^[a-f0-9]{64}$/
  return toolContinuation && currentDigest !== undefined && digestPattern.test(currentDigest) && digestPattern.test(expectedDigest) &&
    currentDigest.slice(0, INSTRUCTION_DIGEST_PREFIX_LENGTH) === expectedDigest.slice(0, INSTRUCTION_DIGEST_PREFIX_LENGTH)
}

export function turnPrompt(input: BrowserTurnInput, bound: boolean, recovery: boolean, contractCurrent: boolean) {
  return recovery || (bound && !contractCurrent)
    ? input.recoveryPrompt
    : bound
      ? input.incrementalPrompt
      : input.initialPrompt
}

export function responseEvidenceTimeoutMs(prompt: string, toolContinuation = false) {
  const estimatedTokens = estimateTokens(prompt)
  const minimum = toolContinuation ? 45_000 : 8_000
  return Math.min(45_000, minimum + Math.max(0, estimatedTokens - 2_000))
}

export function shouldResetActionOnlyContext(
  bound: boolean,
  expectedVersion: number,
  expectedDigest: string,
  currentVersion: number | undefined,
  currentDigest: string | undefined,
) {
  return bound && expectedDigest.startsWith("a0") &&
    (currentVersion !== expectedVersion || !currentDigest?.startsWith("a0"))
}

export interface AttemptPreparation {
  readonly id: string
  readonly promptHash: string
}

export interface AttemptLifecycle<Attempt extends AttemptPreparation = AttemptPreparation> {
  binding(sessionMarker: string): Promise<string | undefined>
  promptContractVersion?(sessionMarker: string): Promise<number>
  actionEnvelopeDigest?(sessionMarker: string): Promise<string | undefined>
  rotate?(sessionMarker: string, compactionDigest: string): Promise<boolean>
  /** Performs the durable same-hash pending-attempt ambiguity check. */
  prepare(input: { readonly sessionMarker: string; readonly prompt: string; readonly promptHash: string }): Promise<Attempt>
  /** Persists the point after which the browser click may have submitted the prompt. */
  pending(attempt: Attempt): Promise<void>
  bind(sessionMarker: string, remoteChatID: string): Promise<void>
  complete(
    attempt: Attempt,
    remoteChatID: string | undefined,
    estimatedTokens: number,
    promptContractVersion: number | undefined,
    actionEnvelopeDigest: string | undefined,
  ): Promise<void>
  fail(
    attempt: Attempt,
    outcome: { readonly possiblySubmitted: boolean; readonly cancelled: boolean; readonly definitive: boolean },
  ): Promise<void>
  discard?(sessionMarker: string): Promise<void>
}

export interface FrameDecoder<Frame> {
  push(chunk: string): readonly Frame[]
  finish(): readonly Frame[]
}

export interface BrowserProtocol<Frame> {
  decoder(): FrameDecoder<Frame>
  text(value: string): Frame
  reasoning?(value: string): Frame
  finish(reason: "stop"): Frame
  isTerminal(frame: Frame): boolean
}

export class BrowserResponse<Frame extends BrowserFrame> {
  private readonly streams = new Map<number, { decoder: FrameDecoder<Frame>; hasText: boolean; finished: boolean }>()
  private readonly frames: Frame[] = []
  private completed = false
  private domThinking = ""
  private domTurnKey: string | undefined
  outputEstimate = 0

  constructor(private readonly protocol: BrowserProtocol<Frame>) {}

  progress(completion: DomCompletion, turnKey: string): readonly Frame[] {
    if (this.completed || !completion.attributed || !turnKey || !this.protocol.reasoning) return []
    const text = completion.thinking.map(formatThinkingSegment).join("\n\n")
    // SSE cannot retract content. Ignore DOM rewrites/remounts until the
    // original prefix reappears; never replay a revised or repeated panel.
    if (!text.startsWith(this.domThinking) || text.length <= this.domThinking.length) return []
    const delta = text.slice(this.domThinking.length)
    this.outputEstimate += estimateTokens(text) - estimateTokens(this.domThinking)
    this.domThinking = text
    this.domTurnKey = turnKey
    return [{ ...this.protocol.reasoning(delta), domTurnKey: turnKey }]
  }

  push(chunk: string, responseID = 0): readonly Frame[] {
    if (this.completed) return []
    let stream = this.streams.get(responseID)
    if (!stream) {
      stream = { decoder: this.protocol.decoder(), hasText: false, finished: false }
      this.streams.set(responseID, stream)
    }
    if (!stream.finished) this.append(stream.decoder.push(chunk), stream)
    return []
  }

  finish(responseID = 0, deferDomThinking = false): readonly Frame[] {
    if (this.completed) return []
    const stream = this.streams.get(responseID)
    if (!stream) return []
    if (!stream.finished) {
      this.append(stream.decoder.finish(), stream)
      stream.finished = true
    }
    const textPending = [...this.streams.values()].some((item) => item.hasText && !item.finished)
    return stream.hasText && !textPending && this.hasCapturedTerminalEnvelope() && !(deferDomThinking && this.domTurnKey)
      ? this.publishCapturedFrames() : []
  }

  get pendingDomCompletion(): boolean {
    return !this.completed && !!this.domTurnKey && this.hasCapturedTerminalEnvelope() &&
      ![...this.streams.values()].some(stream => stream.hasText && !stream.finished)
  }

  confirm(completion: DomCompletion, baseline: number): readonly Frame[] {
    if (this.completed || completion.assistantCount <= baseline || !isSettledResponse(completion)) return []
    const capturedText = this.capturedText()
    const domText = completion.text.trim()
    if (hasTerminalEnvelope(domText) && domText.startsWith(capturedText.trim()) && domText.length > capturedText.trim().length)
      return this.publishDomCompletion(completion)
    if (hasTerminalEnvelope(capturedText)) return this.publishCapturedFrames()
    if (hasThinkingOnlyEnvelope(domText)) return []
    return this.publishDomCompletion(completion)
  }

  private publishDomCompletion(completion: DomCompletion): readonly Frame[] {
    const reasoning = this.domTurnKey
      ? this.progress(completion, this.domTurnKey)
      : completion.thinking.length
      ? completion.thinking.flatMap((segment) => {
          const delta = formatThinkingSegment(segment)
          return delta && this.protocol.reasoning ? [this.protocol.reasoning(delta)] : []
        })
      : this.frames.filter((frame) => frame.type === "reasoning")
    const capturedText = this.capturedText().trim()
    const capturedThinking = hasThinkingOnlyEnvelope(capturedText) && !completion.text.trim().startsWith(capturedText)
      ? this.frames.filter((frame) => frame.type === "text")
      : []
    const prefix = capturedThinking.length && !completion.thinking.length
      ? this.frames.filter((frame) => frame.type === "reasoning" || frame.type === "text")
      : [...reasoning, ...capturedThinking]
    return this.publish([...prefix, this.protocol.text(completion.text), this.terminalFrame()])
  }

  private terminalFrame(): Frame {
    return this.frames.find((frame) => frame.type === "finish" && frame.reason !== "stop") ??
      this.frames.find((frame) => this.protocol.isTerminal(frame)) ?? this.protocol.finish("stop")
  }

  private hasCapturedTerminalEnvelope(): boolean {
    return hasTerminalEnvelope(this.capturedText())
  }

  private capturedText(): string {
    return this.frames.map((frame) => frame.type === "text" ? frame.delta : "").join("")
  }

  private publishCapturedFrames(): readonly Frame[] {
    const frames = this.frames.filter((frame) => !this.protocol.isTerminal(frame))
    frames.push(this.terminalFrame())
    return this.publish(frames)
  }

  private append(frames: readonly Frame[], stream: { hasText: boolean }) {
    for (const frame of frames) {
      if (frame.type === "error") throw new Error(frame.message)
      if (frame.type === "auth-required") throw new AuthenticationRequiredError()
      if (frame.type === "text") stream.hasText = true
      this.frames.push(frame)
    }
  }

  private publish(frames: Frame[]): readonly Frame[] {
    this.completed = true
    if (this.domTurnKey) frames = frames.filter((frame) => frame.type !== "reasoning" || frame.domTurnKey === this.domTurnKey)
    let text = ""
    for (const frame of frames) {
      if (frame.type === "text" && this.domTurnKey) text += frame.delta
      else if (frame.type === "text" || (frame.type === "reasoning" && !frame.domTurnKey)) this.outputEstimate += estimateTokens(frame.delta)
      else if (frame.type === "tool-call") this.outputEstimate += estimateTokens(JSON.stringify(frame.input))
    }
    if (this.domTurnKey) this.outputEstimate += estimateCapturedTextTokens(text)
    return frames
  }
}

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("TH-AI Passport browser authentication is required; run the login command and retry explicitly")
    this.name = "AuthenticationRequiredError"
  }
}

export class BrowserCaptureTimeoutError extends Error {
  constructor() {
    super("browser capture wait timed out")
    this.name = "BrowserCaptureTimeoutError"
  }
}

export class BrowserTurnAbortedError extends Error {
  constructor() {
    super("browser turn was cancelled")
    this.name = "AbortError"
  }
}

export class NoResponseEvidenceError extends Error {
  constructor() {
    super("browser submission produced no response evidence")
    this.name = "NoResponseEvidenceError"
  }
}

function aborted(signal?: AbortSignal) {
  if (!signal?.aborted) return
  throw new BrowserTurnAbortedError()
}

function abortable<A>(operation: Promise<A>, signal?: AbortSignal): Promise<A> {
  if (!signal) return operation
  if (signal.aborted) {
    void operation.catch(() => undefined)
    return Promise.reject(new BrowserTurnAbortedError())
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      reject(new BrowserTurnAbortedError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

export function isSameOrigin(candidate: string, origin: string) {
  try {
    return new URL(candidate, origin).origin === new URL(origin).origin
  } catch {
    return false
  }
}

export interface StreamMatchInput {
  readonly url: string
  readonly contentType: string
  readonly streamPattern?: string
  readonly pageOrigin?: string
}

/**
 * Narrow stream recognition for chunk capture. SSE/NDJSON and an explicit
 * pattern always match. Same-origin JSON/text also matches so a chat backend
 * that streams JSON lines is not misclassified as unrecognized activity.
 * Cross-origin subresources never match and are ignored unless SSE/NDJSON
 * or an explicit pattern identifies them.
 */
export function isStreamMatch(input: StreamMatchInput) {
  const contentType = (input.contentType ?? "").toLowerCase()
  if (input.streamPattern && input.url.includes(input.streamPattern)) return true
  if (contentType.includes("text/event-stream") || contentType.includes("ndjson")) return true
  if (input.pageOrigin && isSameOrigin(input.url, input.pageOrigin)) {
    if (contentType.includes("json") || contentType.startsWith("text/")) return true
  }
  return false
}

export function sameOrigin(candidate: string, expected: string) {
  try {
    return new URL(candidate).origin === new URL(expected).origin
  } catch {
    return false
  }
}

export interface NoResponseEvidence {
  readonly elapsedMs: number
  readonly responseCount: number
  readonly matchedResponse: boolean
  readonly baselineAssistantCount: number
  readonly currentAssistantCount: number
}

export function classifyNoResponseEvidence(evidence: NoResponseEvidence) {
  return (
    evidence.elapsedMs >= 8_000 &&
    evidence.responseCount > 0 &&
    !evidence.matchedResponse &&
    evidence.currentAssistantCount <= evidence.baselineAssistantCount
  )
}

export interface ModelSelectionSurface {
  open(modelName: string, timeoutMs: number, signal?: AbortSignal): Promise<void>
  expand(modelName: string, timeoutMs: number, signal?: AbortSignal): Promise<void>
  processingLevel(modelName: string, timeoutMs: number, signal?: AbortSignal): Promise<ReasoningLevel>
  openProcessing(modelName: string, timeoutMs: number, signal?: AbortSignal): Promise<void>
  chooseProcessing(modelName: string, level: Exclude<ReasoningLevel, "none">, timeoutMs: number, signal?: AbortSignal): Promise<void>
  verifyProcessing(modelName: string, level: ReasoningLevel, timeoutMs: number, signal?: AbortSignal): Promise<void>
  confirm(modelName: string, timeoutMs: number, signal?: AbortSignal): Promise<void>
  select(modelName: string, timeoutMs: number, signal?: AbortSignal): Promise<void>
  waitClosed(modelName: string, timeoutMs: number, signal?: AbortSignal): Promise<void>
}

interface ModelSelectionInput extends BrowserModel {
  readonly reasoning: ReasoningLevel
}

interface SelectionDeadline {
  readonly timeoutMs?: number
  readonly now?: () => number
  readonly signal?: AbortSignal
  readonly onStage?: (stage: string) => void
  readonly onDeadline?: () => void
}

/**
 * Selects one model under a single deadline. Every operation re-resolves its
 * locator so a card or dialog rerender cannot leave a stale control behind.
 */
export async function selectModel(
  surface: ModelSelectionSurface,
  input: ModelSelectionInput,
  options: SelectionDeadline = {},
) {
  aborted(options.signal)
  if (input.reasoning !== "none" && !input.thinking.includes(input.reasoning))
    throw new Error(`AIPass model ${input.id} does not support thinking level ${input.reasoning}`)

  const now = options.now ?? performance.now.bind(performance)
  const started = now()
  const budget = Math.min(options.timeoutMs ?? 20_000, 20_000)
  const deadline = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
  const remaining = () => {
    const value = Math.ceil(budget - (now() - started))
    if (value <= 0) throw new Error("AIPass model selection exceeded its 20 second deadline")
    return value
  }
  const within = async <A>(stage: string, operation: (timeoutMs: number) => Promise<A>) => {
    aborted(signal)
    const timeoutMs = remaining()
    options.onStage?.(stage)
    const timer = setTimeout(() => { options.onDeadline?.(); deadline.abort() }, timeoutMs)
    try {
      const value = await abortable(operation(timeoutMs), signal)
      aborted(signal)
      return value
    } catch (error) {
      aborted(options.signal)
      if (deadline.signal.aborted) throw new Error(`AIPass model ${stage} exceeded the 20 second selection deadline`)
      throw error
    } finally { clearTimeout(timer) }
  }

  await within("selector open", (timeout) => surface.open(input.name, timeout, signal))
  if (input.thinking.length === 0) {
    await within("selection", (timeout) => surface.select(input.name, timeout, signal))
  } else {
    await within("thinking expansion", (timeout) => surface.expand(input.name, timeout, signal))
    const current = await within("thinking value", (timeout) => surface.processingLevel(input.name, timeout, signal))
    if (current !== "none" && !input.thinking.includes(current))
      throw new Error(`AIPass model ${input.id} displays an unsupported thinking level`)
    if (current !== input.reasoning) {
      // Selecting the current option toggles it off; an already-correct value must not be clicked again.
      const choice = input.reasoning === "none" ? current : input.reasoning
      if (choice !== "none") {
        await within("thinking dialog", (timeout) => surface.openProcessing(input.name, timeout, signal))
        await within("thinking level", (timeout) => surface.chooseProcessing(input.name, choice, timeout, signal))
      }
    }
    await within("thinking verification", (timeout) => surface.verifyProcessing(input.name, input.reasoning, timeout, signal))
    await within("confirmation", (timeout) => surface.confirm(input.name, timeout, signal))
  }
  await within("selection closed", (timeout) => surface.waitClosed(input.name, timeout, signal))
}

export class PlaywrightModelSelectionSurface implements ModelSelectionSurface {
  constructor(
    private readonly page: Page,
    private readonly selectors: BrowserSelectors = {},
    private readonly modelNames: readonly string[] = [],
  ) {}

  private dialog() {
    return this.page.getByTestId("model-selector-modal")
  }

  private card(name: string) {
    return this.dialog().locator(this.selectors.modelOptions ?? '[data-testid="model-card"]')
      .filter({ has: this.page.getByText(name, { exact: true }) })
  }

  private processing(name: string) {
    return this.card(name).getByTestId("thinking-level-trigger")
  }

  private loader(modelName: string) {
    const names = this.modelNames.length ? this.modelNames : [modelName]
    const pattern = new RegExp(`^(?:${names.map(escapeRegex).join("|")})(?: (?:${names.map(escapeRegex).join("|")}))?$`)
    return this.selectors.modelLoader
      ? this.page.locator(this.selectors.modelLoader).first()
      : this.page.getByRole("button", { name: pattern }).first()
  }

  async open(modelName: string, timeoutMs: number, signal?: AbortSignal) {
    aborted(signal)
    await this.loader(modelName).click({ timeout: timeoutMs, signal })
    aborted(signal)
    await this.dialog().waitFor({ state: "visible", timeout: timeoutMs, signal })
  }

  async expand(modelName: string, timeoutMs: number, signal?: AbortSignal) {
    aborted(signal)
    const action = this.card(modelName).getByRole("button", { name: /^(?:More settings|ตั้งค่าเพิ่มเติม|Confirm|ยืนยัน)$/ })
    const label = await action.innerText({ timeout: timeoutMs, signal })
    if (/^(?:More settings|ตั้งค่าเพิ่มเติม)$/.test(label.trim())) {
      aborted(signal)
      await action.click({ timeout: timeoutMs, signal })
    }
    aborted(signal)
    await this.processing(modelName).waitFor({ state: "visible", timeout: timeoutMs, signal })
  }

  async processingLevel(modelName: string, timeoutMs: number, signal?: AbortSignal): Promise<ReasoningLevel> {
    aborted(signal)
    const text = await this.processing(modelName).innerText({ timeout: timeoutMs, signal })
    const value = text.replace(/^(?:Processing|การประมวลผล)/, "").trim()
    if (!value) return "none"
    for (const level of ["low", "medium", "high", "max"] as const)
      if (THINKING_LABELS[level].includes(value)) return level
    throw new Error(`AIPass model ${modelName} has an unrecognized Processing value`)
  }

  async openProcessing(modelName: string, timeoutMs: number, signal?: AbortSignal) {
    aborted(signal)
    // The picker dismisses popovers on scroll; expose the whole row before opening it.
    await this.processing(modelName).scrollIntoViewIfNeeded({ timeout: timeoutMs, signal })
    aborted(signal)
    await this.processing(modelName).getByText(/^(?:Processing|การประมวลผล)$/).click({ timeout: timeoutMs, signal })
  }

  async chooseProcessing(modelName: string, level: Exclude<ReasoningLevel, "none">, timeoutMs: number, signal?: AbortSignal) {
    aborted(signal)
    const trigger = this.card(modelName).locator('[data-testid="thinking-level-trigger"][aria-expanded="true"][aria-controls]')
    await trigger.waitFor({ state: "visible", timeout: timeoutMs, signal })
    const id = await trigger.getAttribute("aria-controls", { timeout: timeoutMs, signal })
    if (!id) throw new Error(`AIPass model ${modelName} did not identify its Processing dropdown`)
    const popup = this.page.locator(`[id=${JSON.stringify(id)}][role="dialog"][data-slot="popover-content"][data-open]:not([data-closed])`)
    aborted(signal)
    const option = popup.getByRole("button", { name: new RegExp(`^(?:${THINKING_LABELS[level].map(escapeRegex).join("|")})$`) })
    await option.waitFor({ state: "visible", timeout: timeoutMs, signal })
    aborted(signal)
    // Activate the verified button without pointer-induced scrolling or keyboard focus changes.
    await option.evaluate(element => {
      if (!(element instanceof HTMLButtonElement) || element.disabled || !element.checkVisibility())
        throw new Error("AIPass Processing option is not actionable")
      element.click()
    }, undefined, { timeout: timeoutMs, signal })
  }

  async verifyProcessing(modelName: string, level: ReasoningLevel, timeoutMs: number, signal?: AbortSignal) {
    aborted(signal)
    const value = level === "none" ? "" : `(?:${THINKING_LABELS[level].map(escapeRegex).join("|")})`
    await this.processing(modelName).filter({ hasText: new RegExp(`^\\s*(?:Processing|การประมวลผล)\\s*${value}\\s*$`) })
      .waitFor({ state: "visible", timeout: timeoutMs, signal })
  }

  async confirm(modelName: string, timeoutMs: number, signal?: AbortSignal) {
    aborted(signal)
    await this.card(modelName).getByRole("button", { name: /^(?:Confirm|ยืนยัน)$/ }).click({ timeout: timeoutMs, signal })
  }

  async select(modelName: string, timeoutMs: number, signal?: AbortSignal) {
    aborted(signal)
    await this.card(modelName).getByRole("button", { name: /^(?:Select|เลือก|Confirm|ยืนยัน)$/ }).click({ timeout: timeoutMs, signal })
  }

  async waitClosed(modelName: string, timeoutMs: number, signal?: AbortSignal) {
    aborted(signal)
    await this.dialog().waitFor({ state: "hidden", timeout: timeoutMs, signal })
    aborted(signal)
    const name = escapeRegex(modelName)
    await this.loader(modelName).filter({ hasText: new RegExp(`^\\s*${name}(?:\\s+${name})?\\s*$`) })
      .waitFor({ state: "visible", timeout: timeoutMs, signal })
  }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export interface TempChatControl {
  state(timeoutMs: number, signal?: AbortSignal): Promise<"on" | "off" | "unknown">
  click(timeoutMs: number, signal?: AbortSignal): Promise<void>
}

export interface TempChatSurface {
  control(timeoutMs: number, signal?: AbortSignal): Promise<TempChatControl | undefined>
}

type SetupOperationOwner = <A>(operation: Promise<A>) => Promise<A>

class LocatorTempChatControl implements TempChatControl {
  constructor(
    private readonly locator: Locator,
    private readonly kind: "checkbox" | "switch" | "button" | "link",
    private readonly ownOperation: SetupOperationOwner,
  ) {}

  async state(timeoutMs: number, signal?: AbortSignal): Promise<"on" | "off" | "unknown"> {
    aborted(signal)
    if (this.kind === "checkbox" || this.kind === "switch") {
      try {
        return (await this.locator.isChecked({ timeout: timeoutMs, signal })) ? "on" : "off"
      } catch {
        aborted(signal)
        // Fall through to aria attributes below.
      }
    }
    if (this.kind === "link") return this.linkState(timeoutMs, signal)
    for (const attribute of ["aria-checked", "aria-pressed"]) {
      const value = await this.locator.getAttribute(attribute, { timeout: timeoutMs, signal }).catch(() => null)
      aborted(signal)
      if (value === "true") return "on"
      if (value === "false") return "off"
    }
    await this.logFingerprint(timeoutMs, signal)
    return "unknown"
  }

  private async linkState(timeoutMs: number, signal?: AbortSignal): Promise<"on" | "off" | "unknown"> {
    const [pressed, dataState, shape] = await Promise.all([
      this.locator.getAttribute("aria-pressed", { timeout: timeoutMs, signal }).catch(() => null),
      this.locator.getAttribute("data-state", { timeout: timeoutMs, signal }).catch(() => null),
      this.ownOperation(this.locator
        .evaluate((element: Element) => ({
          temporaryUrl: element.ownerDocument.location.href.includes("temporary-chat"),
          circles: element.querySelectorAll("circle").length,
          paths: element.querySelectorAll("path").length,
        }), undefined, { timeout: timeoutMs, signal }))
        .catch(() => null),
    ])
    aborted(signal)
    const state = interpretToggleIcon({
      pressed,
      dataState,
      temporaryUrl: shape?.temporaryUrl ?? null,
      circles: shape?.circles ?? 0,
      paths: shape?.paths ?? 0,
      shapeOk: shape !== null,
    })
    if (state === "unknown") await this.logFingerprint(timeoutMs, signal)
    return state
  }

  /**
   * Failure-path structure only: tag/attribute presence, parent chain, and
   * icon counts. Never reads text or arbitrary attribute values.
   */
  private async logFingerprint(timeoutMs: number, signal?: AbortSignal) {
    const fingerprint = await this.ownOperation(this.locator
      .evaluate((element: Element) => {
        const pick = (node: Element | null) => {
          if (!node) return null
          const attributes: string[] = []
          for (const name of [
            "data-testid",
            "data-role",
            "data-state",
            "aria-label",
            "aria-checked",
            "aria-pressed",
            "aria-expanded",
            "type",
            "role",
          ]) {
            if (node.hasAttribute(name)) attributes.push(name)
          }
          return `${node.tagName.toLowerCase().slice(0, 80)}${attributes.map(name => `[${name}]`).join("")}`
        }
        const siblings: Array<string | null> = []
        let next: Element | null = element.nextElementSibling
        while (next && siblings.length < 3) {
          siblings.push(pick(next))
          next = next.nextElementSibling
        }
        return {
          self: pick(element),
          children: [...element.children]
            .slice(0, 6)
            .map((child) => child.tagName.toLowerCase().slice(0, 80)),
          siblings,
          parent: pick(element.parentElement),
          grandparent: pick(element.parentElement?.parentElement ?? null),
          svg: element.querySelectorAll("svg").length,
          paths: element.querySelectorAll("path").length,
          circles: element.querySelectorAll("circle").length,
        }
      }, undefined, { timeout: timeoutMs, signal }))
      .catch(() => null)
    aborted(signal)
    if (fingerprint) console.error(`aipass temp chat unreadable kind=${this.kind} ${JSON.stringify(fingerprint)}`)
  }

  async click(timeoutMs: number, signal?: AbortSignal) {
    aborted(signal)
    const deadline = Date.now() + Math.max(timeoutMs, 0)
    await this.locator.click({ timeout: timeoutMs, signal })
    aborted(signal)
    if (this.kind !== "link") return
    while (Date.now() < deadline) {
      const temporary = await this.ownOperation(this.locator
        .evaluate((element: Element) => element.ownerDocument.location.href.includes("temporary-chat"), undefined,
          { timeout: Math.max(1, deadline - Date.now()), signal }))
        .catch(() => false)
      aborted(signal)
      if (temporary) return
      await abortable(new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now())))), signal)
    }
  }
}

/**
 * Stateless link-toggle state. The temporary-chat page URL is ground truth;
 * explicit pressed/data-state attributes win next; otherwise a check-mark
 * icon (circle plus check path) means on and a bare circle means off. A
 * successfully read toggle on a plain page is the verified temp affordance
 * waiting to be enabled. Anything else stays unknown so the turn stays
 * fail-open and never clicks blind.
 */
export function interpretToggleIcon(input: {
  readonly pressed?: string | null
  readonly dataState?: string | null
  readonly temporaryUrl?: boolean | null
  readonly circles: number
  readonly paths: number
  readonly shapeOk: boolean
}): "on" | "off" | "unknown" {
  if (input.temporaryUrl === true) return "on"
  if (input.pressed === "true" || input.dataState === "on" || input.dataState === "checked") return "on"
  if (input.pressed === "false" || input.dataState === "off" || input.dataState === "unchecked") return "off"
  if (input.temporaryUrl === false && input.shapeOk) return "off"
  if (input.paths > 0) return "on"
  if (input.circles > 0) return "off"
  return "unknown"
}

export class PlaywrightTempChatSurface implements TempChatSurface {
  constructor(
    private readonly page: Page,
    private readonly ownOperation: SetupOperationOwner = operation => operation,
  ) {}

  private async visible(locator: Locator, timeoutMs: number, signal?: AbortSignal) {
    aborted(signal)
    try {
      await locator.waitFor({ state: "visible", timeout: timeoutMs, signal })
      aborted(signal)
      return true
    } catch {
      aborted(signal)
      return false
    }
  }

  async control(timeoutMs: number, signal?: AbortSignal): Promise<TempChatControl | undefined> {
    const per = Math.max(500, Math.floor(Math.min(Math.max(timeoutMs, 0), 6000) / 8))
    const stages: Record<string, boolean> = {}
    const named = this.page.getByRole("checkbox", { name: /temp|temporary|ชั่วคราว/i }).first()
    stages.checkbox = await this.visible(named, per, signal)
    if (stages.checkbox) return new LocatorTempChatControl(named, "checkbox", this.ownOperation)
    const switched = this.page.getByRole("switch", { name: /temp|temporary|ชั่วคราว/i }).first()
    stages.switch = await this.visible(switched, per, signal)
    if (stages.switch) return new LocatorTempChatControl(switched, "switch", this.ownOperation)
    const toggle = this.page.getByRole("button", { name: /temp|temporary|ชั่วคราว/i }).first()
    stages.button = await this.visible(toggle, per, signal)
    if (stages.button) return new LocatorTempChatControl(toggle, "button", this.ownOperation)
    const chatLink = this.page.getByRole("link", { name: /แชทใหม่|new chat/i }).first()
    stages.chat_link = await this.visible(chatLink, per, signal)
    stages.toggle_link = false
    if (stages.chat_link) {
      const toggleLink = chatLink.locator("xpath=following::a[1]")
      if (await this.visible(toggleLink, per, signal)) {
        const [linkBox, toggleBox] = await Promise.all([
          this.ownOperation(chatLink.boundingBox({ timeout: per, signal })),
          this.ownOperation(toggleLink.boundingBox({ timeout: per, signal })),
        ])
        aborted(signal)
        const sameRow =
          !!linkBox && !!toggleBox && Math.abs(toggleBox.y - linkBox.y) <= 40 && toggleBox.x >= linkBox.x
        stages.toggle_link = sameRow
        if (sameRow) return new LocatorTempChatControl(toggleLink, "link", this.ownOperation)
        const describe = (box: { x: number; y: number } | null) =>
          box ? `${Math.round(box.x)},${Math.round(box.y)}` : "none"
        console.error(`aipass temp chat toggle link off-row link=${describe(linkBox)} toggle=${describe(toggleBox)}`)
      }
    }
    const menu = this.page.getByRole("button", { name: /menu|เมนู|sidebar|แถบด้านข้าง/i }).first()
    stages.menu = await this.visible(menu, per, signal)
    console.error(
      `aipass temp chat not found checkbox=${stages.checkbox} switch=${stages.switch} button=${stages.button} chat_link=${stages.chat_link} toggle_link=${stages.toggle_link} menu=${stages.menu}`,
    )
    return undefined
  }
}

/**
 * Attempts temporary mode within one eight-second budget. Lookup failures
 * stay fail-open, but caller cancellation must not continue prompt setup.
 */
export async function ensureTempChat(
  surface: TempChatSurface,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<"on" | "off" | "unavailable"> {
  aborted(options.signal)
  const budget = Math.min(options.timeoutMs ?? 8000, 8000)
  if (budget <= 0) return "unavailable"
  const deadline = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
  const started = performance.now()
  const timer = setTimeout(() => deadline.abort(), budget)
  const step = async <A>(limit: number, operation: (timeoutMs: number) => Promise<A>) => {
    const remaining = Math.ceil(budget - (performance.now() - started))
    if (remaining <= 0) deadline.abort()
    aborted(signal)
    const value = await abortable(operation(Math.min(limit, remaining)), signal)
    aborted(signal)
    return value
  }
  try {
    const control = await step(budget, timeout => surface.control(timeout, signal))
    if (!control) return "unavailable"
    const before = await step(3000, timeout => control.state(timeout, signal))
    if (before === "on") return "on"
    if (before === "unknown") return "unavailable"
    await step(5000, timeout => control.click(timeout, signal))
    return (await step(3000, timeout => control.state(timeout, signal))) === "on" ? "on" : "off"
  } catch (error) {
    aborted(options.signal)
    if (error instanceof BrowserTurnAbortedError && !deadline.signal.aborted) throw error
    return "unavailable"
  } finally {
    clearTimeout(timer)
  }
}

export interface CaptureTransport {
  exposeBinding(
    name: string,
    callback: (source: unknown, value: unknown) => void | Promise<void>,
  ): Promise<unknown>
  addInitScript(script: unknown, argument?: unknown): Promise<unknown>
  evaluate(script: unknown, argument?: unknown): Promise<unknown>
}

export type ResponseContentType = "sse" | "ndjson" | "json" | "text" | "other" | "empty"

export type CaptureEvent = (
  | { readonly type: "chunk"; readonly chunk: string }
  | { readonly type: "finish" }
  | { readonly type: "error"; readonly message: string }
  | {
      readonly type: "response"
      readonly matched: boolean
      readonly selected: boolean
      readonly bodyPresent: boolean
      readonly contentType: ResponseContentType
    }
  ) & { readonly responseID: number } | {
      readonly type: "dom"
      readonly assistantCount: number
      readonly complete: boolean
      readonly text: string
    }

type CapturedMessage = CaptureEvent & { readonly generation: string }

function capturedMessage(value: unknown): CapturedMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const item = value as Record<string, unknown>
  if (typeof item.generation !== "string") return undefined
  if (
    item.type === "dom" &&
    typeof item.assistantCount === "number" &&
    typeof item.complete === "boolean" &&
    typeof item.text === "string"
  )
    return {
      generation: item.generation,
      type: "dom",
      assistantCount: item.assistantCount,
      complete: item.complete,
      text: item.text,
    }
  if (typeof item.responseID !== "number" || !Number.isSafeInteger(item.responseID) || item.responseID <= 0) return undefined
  const source = { generation: item.generation, responseID: item.responseID }
  if (item.type === "chunk" && typeof item.chunk === "string")
    return { ...source, type: "chunk", chunk: item.chunk }
  if (item.type === "finish") return { ...source, type: "finish" }
  if (item.type === "error" && typeof item.message === "string")
    return { ...source, type: "error", message: item.message }
  if (
    item.type === "response" &&
    typeof item.matched === "boolean" &&
    typeof item.selected === "boolean" &&
    typeof item.bodyPresent === "boolean" &&
    ["sse", "ndjson", "json", "text", "other", "empty"].includes(String(item.contentType))
  )
    return {
      ...source,
      type: "response",
      matched: item.matched,
      selected: item.selected,
      bodyPresent: item.bodyPresent,
      contentType: item.contentType as ResponseContentType,
    }
  return undefined
}

type EventWaiter = {
  readonly resolve: (event: CaptureEvent | undefined) => void
  readonly reject: (error: unknown) => void
}

class CaptureQueue {
  private readonly events: CaptureEvent[] = []
  private readonly waiters: EventWaiter[] = []
  private stopped = false
  private failure: unknown

  push(event: CaptureEvent) {
    if (this.stopped) return
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(event)
    else this.events.push(event)
    // Response finishes and errors do not own the generation's lifetime.
  }

  fail(error: unknown) {
    if (this.stopped) return
    this.failure = error
    this.stopped = true
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  stop() {
    this.events.length = 0
    if (this.stopped) return
    this.stopped = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve(undefined)
  }

  hasPendingSelected(accepted: ReadonlySet<number>) {
    return this.stopped || this.events.some(event => event.type === "response"
      ? event.selected && event.bodyPresent
      : event.type !== "dom" && accepted.has(event.responseID))
  }

  next(options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}) {
    const event = this.events.shift()
    if (event) return Promise.resolve(event)
    if (this.failure !== undefined) return Promise.reject(this.failure)
    if (this.stopped) return Promise.resolve(undefined)
    return new Promise<CaptureEvent | undefined>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let active = true
      const finish = (operation: () => void) => {
        if (!active) return
        active = false
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener("abort", onAbort)
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        operation()
      }
      const waiter: EventWaiter = {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      }
      const onAbort = () => waiter.reject(new BrowserTurnAbortedError())
      this.waiters.push(waiter)
      if (options.signal?.aborted) onAbort()
      else options.signal?.addEventListener("abort", onAbort, { once: true })
      if (options.timeoutMs !== undefined)
        timer = setTimeout(() => waiter.reject(new BrowserCaptureTimeoutError()), Math.max(0, options.timeoutMs))
    })
  }
}

export interface ActivePageCapture {
  readonly generation: string
  next(options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<CaptureEvent | undefined>
  hasPendingSelected(accepted: ReadonlySet<number>): boolean
  cleanup(): Promise<void>
}

const STREAM_BINDING = "__aipassStream"
const STREAM_GENERATION = "__aipassStreamGeneration"
const STREAM_ARM = "__aipassStreamArm"

export class PageStreamCapture {
  private active: { readonly generation: string; readonly queue: CaptureQueue; readonly stop: () => Promise<void> } | undefined
  private readonly operations = new Set<Promise<unknown>>()

  private constructor(private readonly page: CaptureTransport) {}

  static async install(page: CaptureTransport, config: {
    readonly streamURLPattern?: string
    readonly signal?: AbortSignal
    readonly onStage?: (stage: string) => void
  }) {
    aborted(config.signal)
    const capture = new PageStreamCapture(page)
    config.onStage?.("capture-binding")
    await page.exposeBinding(STREAM_BINDING, (_source, value) => capture.receive(value))
    aborted(config.signal)
    config.onStage?.("capture-script")
    await page.addInitScript(installCaptureScript, {
      bindingName: STREAM_BINDING,
      generationKey: STREAM_GENERATION,
      armKey: STREAM_ARM,
      streamPattern: config.streamURLPattern ?? "",
    })
    return capture
  }

  private receive(value: unknown) {
    const message = capturedMessage(value)
    if (!message || message.generation !== this.active?.generation) return
    const { generation: _generation, ...event } = message
    this.active.queue.push(event)
  }

  private track<A>(operation: Promise<A>): Promise<A> {
    this.operations.add(operation)
    return operation.finally(() => this.operations.delete(operation))
  }

  stop(): Promise<void> {
    this.active?.stop()
    return Promise.allSettled([...this.operations]).then(() => undefined)
  }

  async activate(baselineAssistantCount: number, prompt = ""): Promise<ActivePageCapture> {
    this.active?.queue.stop()
    const generation = crypto.randomUUID()
    const queue = new CaptureQueue()
    const armed = this.track(Promise.resolve().then(() => this.page.evaluate(
      ({ armKey, generation, baseline, prompt }: { armKey: string; generation: string; baseline: number; prompt: string }) => {
        const arm = (globalThis as unknown as Record<string, unknown>)[armKey]
        if (typeof arm !== "function") throw new Error("browser stream capture is unavailable")
        ;(arm as (generation: string, baseline: number, prompt: string) => void)(generation, baseline, prompt)
      },
      { armKey: STREAM_ARM, generation, baseline: baselineAssistantCount, prompt },
    )))
    let cleanup: Promise<void> | undefined
    const stop = () => {
      queue.stop()
      if (this.active?.generation !== generation) return cleanup ?? Promise.resolve()
      this.active = undefined
      // A cancelled activate() may still arm remotely. Own its settlement and
      // disarm afterward, without touching a newer generation on this page.
      cleanup = this.track(armed.catch(() => undefined).then(() => this.page.evaluate(
        ({ armKey, generationKey, generation, value }: { armKey: string; generationKey: string; generation: string; value: string }) => {
          const scope = globalThis as unknown as Record<string, unknown>
          const arm = scope[armKey]
          if (scope[generationKey] === generation && typeof arm === "function")
            (arm as (generation: string, baseline: number) => void)(value, 0)
        },
        { armKey: STREAM_ARM, generationKey: STREAM_GENERATION, generation, value: "" },
      )).then(() => undefined, () => undefined))
      return cleanup
    }
    this.active = { generation, queue, stop }
    await armed
    return {
      generation,
      next: (options) => queue.next(options),
      hasPendingSelected: (accepted) => queue.hasPendingSelected(accepted),
      cleanup: stop,
    }
  }
}

function installCaptureScript(input: {
  bindingName: string
  generationKey: string
  armKey: string
  streamPattern: string
}) {
  const scope = globalThis as unknown as Record<string, unknown>
  if (scope[input.armKey]) return
  let observer: MutationObserver | undefined
  let submittedPrompt = ""
  const readers = new Map<ReadableStreamDefaultReader<Uint8Array>, string>()
  let headersPending = 0
  const recent: Array<{ path: string; matched: boolean; category: string; bytes: number }> = []
  const note = (url: string, matched: boolean, category: string, bytes = -1) => {
    let path = url
    try {
      path = new URL(url, location.href).pathname
    } catch {}
    recent.push({ path: path.slice(0, 80), matched, category, bytes })
    if (recent.length > 12) recent.shift()
  }
  scope[`${input.armKey}Pending`] = () => ({
    headers: headersPending,
    readers: readers.size,
    recent: recent.slice(),
    ui: {
      stop: !!document.querySelector(
        'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Cancel" i]',
      ),
      dialog: !!document.querySelector('[role="dialog"]'),
      toolish: !!document.querySelector('[data-testid*="tool" i], [class*="tool-call"], [class*="function-call"]'),
      send: !!document.querySelector('button[data-testid="send-button"], button[type="submit"]'),
    },
  })
  const send = (message: CapturedMessage) => {
    const binding = scope[input.bindingName]
    if (typeof binding === "function") void (binding as (value: CapturedMessage) => Promise<void>)(message)
  }
  const generation = () => (typeof scope[input.generationKey] === "string" ? String(scope[input.generationKey]) : "")
  const assistantNodes = () => {
    const primary = [...document.querySelectorAll('[data-role="assistant"]')]
    if (primary.length) return primary
    const role = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
    if (role.length) return role
    return [...document.querySelectorAll('[data-testid*="assistant" i], [data-testid*="bot" i]')]
  }
  const latestAssistantText = (latest: Element | undefined) => {
    if (!latest) return ""
    for (const selector of [".markdown-content", ".markdown", "[data-markdown]", 'div[class*="markdown"]']) {
      const text = (latest.querySelector<HTMLElement>(selector)?.innerText ?? "").trim()
      if (text) return text
    }
    return ((latest as HTMLElement).innerText ?? "").trim()
  }
  const sendSettled = () => {
    const candidates = [
      document.querySelector<HTMLButtonElement>('button[data-testid="send-button"]'),
      document.querySelector<HTMLButtonElement>('button[type="submit"]'),
      document.querySelector<HTMLButtonElement>('button[aria-label*="Send" i]'),
    ].filter((button): button is HTMLButtonElement => !!button)
    for (const button of candidates) {
      if (button.disabled === true || button.getAttribute("aria-disabled") === "true") return true
    }
    if (candidates.length === 0) {
      const stop = document.querySelector(
        'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Cancel" i]',
      )
      return !stop
    }
    return false
  }
  const DOM_STABLE_MS = 4000
  let lastDomText = ""
  let lastDomChange = 0
  let stableTimer: ReturnType<typeof setTimeout> | undefined
  const dom = (value: string, baseline: number) => {
    if (!value || generation() !== value) return
    const assistants = assistantNodes()
    const text = latestAssistantText(assistants.at(-1))
    if (assistants.length <= baseline || !text) {
      if (text !== lastDomText) {
        lastDomText = text
        lastDomChange = Date.now()
      }
      return
    }
    if (text !== lastDomText) {
      lastDomText = text
      lastDomChange = Date.now()
      if (stableTimer) clearTimeout(stableTimer)
      stableTimer = setTimeout(() => dom(value, baseline), DOM_STABLE_MS + 250)
      return
    }
    if (Date.now() - lastDomChange < DOM_STABLE_MS || !sendSettled()) return
    send({ generation: value, type: "dom", assistantCount: assistants.length, complete: true, text })
  }
  scope[input.armKey] = (value: string, baseline: number, prompt = "") => {
    submittedPrompt = prompt.trimEnd()
    observer?.disconnect()
    if (stableTimer) {
      clearTimeout(stableTimer)
      stableTimer = undefined
    }
    lastDomText = ""
    scope[input.generationKey] = value
    for (const [reader, owner] of readers) {
      if (owner !== value) {
        readers.delete(reader)
        void reader.cancel().catch(() => undefined)
      }
    }
    if (!value) return
    observer = new MutationObserver(() => dom(value, baseline))
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled"],
    })
    dom(value, baseline)
  }

  const original = globalThis.fetch.bind(globalThis)
  let nextResponseID = 0
  const includesSubmission = (body: string, prompt: string): boolean => {
    if (!prompt) return false
    if (body === prompt) return true
    try {
      const pending: unknown[] = [JSON.parse(body)]
      while (pending.length) {
        const value = pending.pop()
        if (value === prompt) return true
        if (value && typeof value === "object") for (const child of Object.values(value)) pending.push(child)
      }
    } catch {}
    return false
  }
  const pageSameOrigin = (url: string) => {
    try {
      return new URL(url, location.href).origin === location.origin
    } catch {
      return true
    }
  }
  const streamCategory = (contentType: string): ResponseContentType =>
    contentType.includes("text/event-stream")
      ? "sse"
      : contentType.includes("ndjson")
        ? "ndjson"
        : contentType.includes("json")
          ? "json"
          : contentType.startsWith("text/")
            ? "text"
            : contentType
              ? "other"
              : "empty"
  globalThis.fetch = (async (...arguments_: Parameters<typeof fetch>) => {
    const owner = generation()
    const responseID = ++nextResponseID
    const prompt = submittedPrompt
    const [request, init] = arguments_
    let submission: boolean | Promise<boolean> = false
    if (owner && typeof init?.body === "string") submission = includesSubmission(init.body, prompt)
    else if (owner && init?.body === undefined && request instanceof Request) {
      try { submission = request.clone().text().then(body => includesSubmission(body, prompt)).catch(() => false) } catch {}
    }
    if (owner) headersPending++
    let response: Response
    try {
      response = await original(...arguments_)
    } finally {
      if (owner && headersPending > 0) headersPending--
    }
    if (!owner || generation() !== owner) return response
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
    const narrowMatched =
      (!!input.streamPattern && response.url.includes(input.streamPattern)) ||
      contentType.includes("text/event-stream") ||
      contentType.includes("ndjson")
    const same = pageSameOrigin(response.url)
    const matched = narrowMatched || (same && (contentType.includes("json") || contentType.startsWith("text/")))
    const category = streamCategory(contentType)
    if (!same && !narrowMatched) return response
    const selected = matched && await submission
    if (generation() !== owner) return response
    send({
      generation: owner,
      responseID,
      type: "response",
      matched,
      selected,
      bodyPresent: !!response.body,
      contentType: category,
    })
    const length = Number(response.headers.get("content-length") ?? "")
    note(response.url, matched, category, Number.isSafeInteger(length) ? length : -1)
    if (!matched || !response.body) return response
    const clone = response.clone()
    void (async () => {
      const reader = clone.body!.getReader()
      const decoder = new TextDecoder()
      readers.set(reader, owner)
      try {
        while (generation() === owner) {
          const part = await reader.read()
          if (part.done) break
          const chunk = decoder.decode(part.value, { stream: true })
          if (chunk) send({ generation: owner, responseID, type: "chunk", chunk })
        }
        const trailing = decoder.decode()
        if (generation() === owner) {
          if (trailing) send({ generation: owner, responseID, type: "chunk", chunk: trailing })
          send({ generation: owner, responseID, type: "finish" })
        }
      } catch (error) {
        if (generation() === owner)
          send({
            generation: owner,
            responseID,
            type: "error",
            message: error instanceof Error ? error.message : "browser stream failed",
          })
      } finally {
        readers.delete(reader)
      }
    })()
    return response
  }) as typeof fetch

  const XHR = (globalThis as Record<string, unknown>).XMLHttpRequest as
    | (new () => XMLHttpRequest & Record<string, unknown>)
    | undefined
  if (XHR && !(scope.__aipassXHRWrapped as boolean)) {
    scope.__aipassXHRWrapped = true
    const xhrURLs = new WeakMap<object, string>()
    const xhrOpen = XHR.prototype.open
    const xhrSend = XHR.prototype.send
    XHR.prototype.open = function (
      this: XMLHttpRequest & Record<string, unknown>,
      method: string,
      url: string,
      ...rest: unknown[]
    ) {
      try {
        xhrURLs.set(this, String(url))
      } catch {}
      return (xhrOpen as (...args: unknown[]) => unknown).call(this, method, url, ...rest)
    } as typeof XHR.prototype.open
    XHR.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
      const ownerAtSend = generation()
      const responseID = ++nextResponseID
      const selected = typeof args[0] === "string" && includesSubmission(args[0], submittedPrompt)
      if (ownerAtSend) headersPending++
      let settled = false
      const done = () => {
        if (ownerAtSend && !settled && headersPending > 0) {
          settled = true
          headersPending--
        }
      }
      const report = () => {
        done()
        if (!ownerAtSend || generation() !== ownerAtSend) return
        const raw = xhrURLs.get(this) ?? ""
        let absolute = raw
        try {
          absolute = new URL(raw, location.href).toString()
        } catch {}
        const contentType =
          (typeof this.getResponseHeader === "function" ? (this.getResponseHeader("content-type") ?? "") : "").toLowerCase()
        const patternHit = !!input.streamPattern && absolute.includes(input.streamPattern)
        const sseNdjson = contentType.includes("text/event-stream") || contentType.includes("ndjson")
        let same = true
        try {
          same = new URL(absolute, location.href).origin === location.origin
        } catch {}
        if (!same && !patternHit && !sseNdjson) return
        const matched =
          patternHit || sseNdjson || (same && (contentType.includes("json") || contentType.startsWith("text/")))
        send({
          generation: ownerAtSend,
          responseID,
          type: "response",
          matched,
          selected: matched && selected,
          bodyPresent: true,
          contentType: streamCategory(contentType),
        })
        note(absolute, matched, streamCategory(contentType))
      }
      this.addEventListener("load", report)
      this.addEventListener("error", done)
      this.addEventListener("abort", done)
      this.addEventListener("timeout", done)
      return (xhrSend as (...args: unknown[]) => unknown).apply(this, args)
    } as typeof XHR.prototype.send
  }
}

class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>()

  async idle() {
    while (this.tails.size) await Promise.all(this.tails.values())
  }

  async acquire(key: string) {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => (releaseGate = resolve))
    const tail = previous.then(
      () => gate,
      () => gate,
    )
    this.tails.set(key, tail)
    await previous.catch(() => undefined)
    let active = true
    return () => {
      if (!active) return
      active = false
      releaseGate()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

function promptInput(page: Page, selectors: BrowserSelectors) {
  return (selectors.promptInput ? page.locator(selectors.promptInput) : page.getByRole("textbox")).first()
}

function sendButton(page: Page, selectors: BrowserSelectors) {
  if (selectors.sendButton) return page.locator(selectors.sendButton).first()
  const verified = page.locator('button[data-testid="send-button"]').first()
  return verified.or(promptInput(page, selectors).locator("xpath=ancestor::*[.//button][1]").getByRole("button").last())
}

async function assertAuthenticated(page: Page, config: BrowserAdapterConfig, signal?: AbortSignal, onStage?: (stage: string) => void) {
  aborted(signal)
  let loginURL = false
  try {
    loginURL = /\/(?:login|signin)(?:\/|$)/i.test(new URL(page.url()).pathname)
  } catch {}
  const timeout = Math.min(config.navigationTimeoutMs ?? 90_000, 5_000)
  const loginSelector = 'input[type="password"],form[action*="login" i],form[action*="signin" i]'
  const loginVisible = loginURL || await page.locator("body").evaluate((body, selector) => {
    const form = body.querySelector(selector)
    return form?.checkVisibility({ visibilityProperty: true }) ?? false
  }, loginSelector, { timeout, signal }).catch(() => { aborted(signal); return false })
  aborted(signal)
  if (loginVisible) throw new AuthenticationRequiredError()
  try {
    onStage?.("authentication-ready")
    await promptInput(page, config.selectors ?? {}).waitFor({
      state: "visible",
      timeout,
      signal,
    })
  } catch {
    aborted(signal)
    throw new AuthenticationRequiredError()
  }
}

interface DomCompletion {
  readonly assistantCount: number
  readonly complete: boolean
  readonly text: string
  readonly settled: boolean
  readonly thinking: readonly { readonly title: string; readonly body: string }[]
  readonly attributed?: boolean
}

export function isSettledResponse(input: { complete: boolean; text: string; settled: boolean }): boolean {
  return input.complete === true && input.settled === true && input.text.trim().length > 0
}

export function extractThinkingSegments(
  input: { title: string; body: string }[] | readonly unknown[] | null | undefined,
): { title: string; body: string }[] {
  if (!input || !Array.isArray(input) || input.length === 0) return []
  const output: { title: string; body: string }[] = []
  for (const candidate of input) {
    if (output.length >= 8) break
    if (typeof candidate !== "object" || candidate === null) continue
    const record = candidate as Record<string, unknown>
    const title = typeof record.title === "string" ? record.title.trim().slice(0, 200) : ""
    const body = typeof record.body === "string" ? record.body.trim().slice(0, 2000) : ""
    if (!body) continue
    output.push({ title, body })
  }
  return output
}

export function sameThinkingSegments(
  first: readonly { readonly title: string; readonly body: string }[],
  second: readonly { readonly title: string; readonly body: string }[],
): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index++) {
    if (first[index]?.title !== second[index]?.title || first[index]?.body !== second[index]?.body) return false
  }
  return true
}

export function formatThinkingSegment(segment: { readonly title: string; readonly body: string }): string {
  return segment.title ? `${segment.title}\n${segment.body}` : segment.body
}

function readDomSnapshotValue(attribution?: { generation: string; baseline: number }) {
    const primary = [...document.querySelectorAll('[data-role="assistant"]')]
    const assistants = primary.length
      ? primary
      : [...document.querySelectorAll('[data-message-author-role="assistant"]')].length
        ? [...document.querySelectorAll('[data-message-author-role="assistant"]')]
        : [...document.querySelectorAll('[data-testid*="assistant" i], [data-testid*="bot" i]')]
    const latest = assistants.at(-1)
    const attributed = !!attribution && assistants.length === attribution.baseline + 1 &&
      (globalThis as unknown as Record<string, unknown>).__aipassStreamGeneration === attribution.generation
    if (attribution && !attributed)
      return { assistantCount: assistants.length, complete: false, text: "", settled: false, rawThinking: [], thinkingReveal: false, attributed: false }
    const thinkingRoots = (scope: ParentNode) =>
      [...scope.querySelectorAll('[data-no-copy="true"] > [data-slot="collapsible"]')].filter((root) => {
        const trigger = root.querySelector('[data-slot="collapsible-trigger"][aria-expanded]') as HTMLElement | null
        return !!trigger && /ประมวลผล|\b(?:thinking|thought|reasoning|processing|processed)\b/i.test((trigger.innerText ?? trigger.textContent ?? "").trim())
      })
    let thinkingReveal = false
    if (latest) {
      for (const root of thinkingRoots(latest)) {
        const trigger = root.querySelector('[data-slot="collapsible-trigger"][aria-expanded="false"]')
        if (!(trigger instanceof HTMLElement)) continue
        trigger.click()
        thinkingReveal = true
      }
    }
    const rawThinking: { title: string; body: string }[] = []
    const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible"
    try {
      if (latest) {
        for (const root of thinkingRoots(latest)) {
          if (rawThinking.length >= 8) break
          const panel = root.querySelector('[data-slot="collapsible-content"]')
          if (!panel || !visible(panel)) continue
          let current: { title: string; body: string } | undefined
          const append = () => {
            if (!current?.body || rawThinking.length >= 8) return
            rawThinking.push(current)
          }
          for (const paragraph of panel.querySelectorAll("p")) {
            if (rawThinking.length >= 8) break
            if (!visible(paragraph)) continue
            const children = [...paragraph.children]
            const hasBodyText = [...paragraph.childNodes].some((node) =>
              node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0,
            )
            const titleChild = !hasBodyText && children.length === 1 && children[0]?.getAttribute("data-streamdown") === "strong"
              ? children[0] as HTMLElement
              : undefined
            const title = titleChild ? (titleChild.innerText ?? titleChild.textContent ?? "").trim().slice(0, 200) : ""
            if (title) {
              append()
              current = { title, body: "" }
              continue
            }
            if (current && current.body.length >= 2000) continue
            const body = ((paragraph as HTMLElement).innerText ?? paragraph.textContent ?? "").trim().slice(0, 2000)
            if (!body) continue
            if (!current) current = { title: "", body: "" }
            current.body = `${current.body}${current.body ? "\n" : ""}${body}`.slice(0, 2000)
          }
          append()
        }
      }
    } catch {
      rawThinking.length = 0
    }
    if (attribution)
      return { assistantCount: assistants.length, complete: false, text: "", settled: false, rawThinking, thinkingReveal, attributed }
    const answer = latest?.cloneNode(true) as HTMLElement | undefined
    if (answer) for (const root of thinkingRoots(answer)) root.remove()
    let text = ""
    if (answer) {
      for (const selector of [".markdown-content", ".markdown", "[data-markdown]", 'div[class*="markdown"]']) {
        const candidate = answer.querySelector(selector) as HTMLElement | null
        const candidateText = (candidate?.innerText ?? "").trim()
        if (candidateText) {
          text = candidateText
          break
        }
      }
      if (!text) text = (answer.innerText ?? "").trim()
    }
    const candidates = [
      document.querySelector<HTMLButtonElement>('button[data-testid="send-button"]'),
      document.querySelector<HTMLButtonElement>('button[type="submit"]'),
      document.querySelector<HTMLButtonElement>('button[aria-label*="Send" i]'),
    ].filter((button): button is HTMLButtonElement => !!button)
    let complete = false
    for (const button of candidates) {
      if (button.disabled === true || button.getAttribute("aria-disabled") === "true") complete = true
    }
    if (!complete && candidates.length === 0) {
      complete = !document.querySelector(
        'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Cancel" i]',
      )
    }
    let settled = false
    if (latest) {
      const feedbackButtons = [...latest.querySelectorAll("button")]
      const matchingButtons = (prefix: string) =>
        feedbackButtons.filter((button) => {
          const path = button.querySelector('svg[viewBox="0 0 21 20"] path')
          return (path?.getAttribute("d") ?? "").startsWith(prefix)
        })
      const likes = matchingButtons("M4.75 5.75H2.75")
      const dislikes = matchingButtons("M16.1898 12.75H18.1898")
      settled = likes.some((like) => dislikes.some((dislike) => like !== dislike))
    }
    return { assistantCount: assistants.length, complete, text, settled, rawThinking, thinkingReveal, attributed }
}

function thinkingContentMounted() {
  const primary = [...document.querySelectorAll('[data-role="assistant"]')]
  const roles = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
  const latest = (primary.length ? primary : roles.length ? roles :
    [...document.querySelectorAll('[data-testid*="assistant" i], [data-testid*="bot" i]')]).at(-1)
  if (!latest) return false
  const roots = [...latest.querySelectorAll('[data-no-copy="true"] > [data-slot="collapsible"]')].filter((root) => {
    const trigger = root.querySelector('[data-slot="collapsible-trigger"][aria-expanded]') as HTMLElement | null
    return !!trigger && /ประมวลผล|\b(?:thinking|thought|reasoning|processing|processed)\b/i.test((trigger.innerText ?? trigger.textContent ?? "").trim())
  })
  return roots.length > 0 && roots.every((root) => root.querySelectorAll('[data-slot="collapsible-content"] p').length > 0)
}

export async function readDomSnapshot(
  page: Page,
  signal?: AbortSignal,
  attribution?: { generation: string; baseline: number },
): Promise<DomCompletion> {
  aborted(signal)
  let snapshot = await abortable(page.evaluate(readDomSnapshotValue, attribution), signal)
  aborted(signal)
  if (snapshot.thinkingReveal && !attribution) {
    try {
      aborted(signal)
      await abortable(page.waitForFunction(thinkingContentMounted, undefined, { timeout: THINKING_REVEAL_TIMEOUT_MS }), signal)
    } catch (error) {
      if (error instanceof BrowserTurnAbortedError) throw error
    }
    aborted(signal)
    snapshot = await abortable(page.evaluate(readDomSnapshotValue, attribution), signal)
    aborted(signal)
  }
  let thinking: { title: string; body: string }[]
  try {
    const raw = (snapshot as { rawThinking?: unknown }).rawThinking as
      | { title: string; body: string }[]
      | null
      | undefined
    thinking = extractThinkingSegments(raw)
  } catch {
    thinking = []
  }
  return {
    assistantCount: snapshot.assistantCount,
    complete: snapshot.complete,
    text: snapshot.text,
    settled: snapshot.settled,
    thinking,
    attributed: snapshot.attributed,
  }
}

/**
 * Backstop DOM read with a stability gate: a complete snapshot is returned
 * only if a second read confirms identical settled text, so transient
 * placeholder bubbles are not mistaken for the final answer.
 */
export async function readDomCompletion(page: Page, signal?: AbortSignal): Promise<DomCompletion> {
  const first = await readDomSnapshot(page, signal)
  if (first.assistantCount === 0 || !first.complete || !first.settled || !first.text.trim())
    return { ...first, complete: false }
  await abortable(new Promise<void>((resolve) => setTimeout(resolve, DOM_STABILITY_MS)), signal)
  const second = await readDomSnapshot(page, signal)
  if (
    !second.complete ||
    !second.settled ||
    !first.settled ||
    !second.text.trim() ||
    second.assistantCount !== first.assistantCount ||
    second.text !== first.text
  )
    return { ...second, complete: false }
  // Thinking segments ride along without blocking completion: the stability
  // gate is text + count + settled only, so progressive thinking expansion
  // never prevents a settled answer from terminating. Latest snapshot wins.
  return second
}

async function assistantBaseline(page: Page, signal?: AbortSignal): Promise<number> {
  aborted(signal)
  return page.locator("body").evaluate(() => {
    const primary = document.querySelectorAll('[data-role="assistant"]').length
    if (primary) return primary
    const role = document.querySelectorAll('[data-message-author-role="assistant"]').length
    if (role) return role
    return document.querySelectorAll('[data-testid*="assistant" i], [data-testid*="bot" i]').length
  }, undefined, { timeout: 5_000, signal })
}

/**
 * Failure-path only snapshot of chat markup: selector counts, role values,
 * ancestor chain shapes, and control names. Never includes message text.
 */
async function domStructure(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const describe = (element: Element | null) => {
        if (!element) return null
        const attributes: Record<string, string> = {}
        for (const name of ["data-testid", "data-role", "aria-label", "type", "role"]) {
          const value = element.getAttribute(name)
          if (value) attributes[name] = value.slice(0, 80)
        }
        return `${element.tagName.toLowerCase()}${Object.entries(attributes)
          .map(([key, value]) => `[${key}="${value}"]`)
          .join("")}`
      }
      const counts: Record<string, number> = {}
      for (const selector of [
        '[data-role="assistant"]',
        '[data-message-author-role="assistant"]',
        '[data-testid*="assistant" i]',
        '[data-testid*="bot" i]',
        ".markdown-content",
        ".markdown",
        "main",
        'button[type="submit"]',
        '[role="textbox"]',
        "form",
      ]) {
        try {
          counts[selector] = document.querySelectorAll(selector).length
        } catch {
          counts[selector] = -1
        }
      }
      const roleValues: Record<string, number> = {}
      for (const element of [...document.querySelectorAll("[data-role]")].slice(0, 500)) {
        const value = (element.getAttribute("data-role") ?? "?").slice(0, 40)
        roleValues[value] = (roleValues[value] ?? 0) + 1
      }
      const markdown = document.querySelector(".markdown-content")
      const markdownAncestors: (string | null)[] = []
      let ancestor = markdown?.parentElement ?? null
      for (let depth = 0; depth < 8 && ancestor; depth++) {
        markdownAncestors.push(describe(ancestor))
        ancestor = ancestor.parentElement
      }
      const composer: Record<string, number> = {
        textbox: document.querySelectorAll('[role="textbox"]').length,
        submit: document.querySelectorAll('button[type="submit"]').length,
        sendLabeled: document.querySelectorAll('button[aria-label*="Send" i]').length,
        forms: document.querySelectorAll("form").length,
      }
      const modelIds = [
        ...new Set(
          [...document.querySelectorAll("[data-model-id]")]
            .slice(0, 20)
            .map((element) => (element.getAttribute("data-model-id") ?? "").slice(0, 80)),
        ),
      ]
      const buttons = [...document.querySelectorAll("button")]
        .slice(0, 25)
        .map(
          (button) =>
            button.getAttribute("data-testid") ?? button.getAttribute("aria-label") ?? button.type ?? "?",
        )
      return JSON.stringify({ counts, roleValues, markdownAncestors, composer, modelIds, buttons })
    })
  } catch {
    return "unavailable"
  }
}

function promptHash(prompt: string) {
  return createHash("sha256").update(prompt).digest("hex")
}

function effectiveIdleTimeout(config: BrowserAdapterConfig) {
  return Math.min(config.streamIdleTimeoutMs ?? 120_000, 120_000)
}

export class PlaywrightBrowserAdapter<Frame extends BrowserFrame, Attempt extends AttemptPreparation = AttemptPreparation> {
  private readonly pages = new Map<string, Page>()
  private readonly captures = new WeakMap<Page, PageStreamCapture>()
  private readonly selectedModels = new WeakMap<Page, string>()
  private readonly locks = new KeyedLock()
  private readonly retirements = new Map<Page, Promise<void>>()
  private readonly pendingSetups = new Set<Promise<void>>()
  private readonly setupOperations = new WeakMap<Page, Set<Promise<unknown>>>()
  private closing: Promise<void> | undefined

  private constructor(
    private readonly context: BrowserContext,
    private readonly config: BrowserAdapterConfig,
    private readonly lifecycle: AttemptLifecycle<Attempt>,
    private readonly protocol: BrowserProtocol<Frame>,
  ) {}

  static async launch<Frame extends BrowserFrame, Attempt extends AttemptPreparation = AttemptPreparation>(
    config: BrowserAdapterConfig,
    lifecycle: AttemptLifecycle<Attempt>,
    protocol: BrowserProtocol<Frame>,
  ) {
    const context = await chromium.launchPersistentContext(config.profilePath, {
      headless: !(config.headed ?? false),
      executablePath: config.executablePath,
    })
    return new PlaywrightBrowserAdapter(context, config, lifecycle, protocol)
  }

  private async page(sessionMarker: string, signal?: AbortSignal, onStage?: (stage: string) => void, onFailure?: (error: unknown) => void) {
    aborted(signal)
    const existing = this.pages.get(sessionMarker)
    if (existing && !existing.isClosed()) return existing
    if (existing) this.pages.delete(sessionMarker)
    let page: Page | undefined
    let capture: PageStreamCapture | undefined
    let retirement: Promise<void> | undefined
    let owned = false
    const setup = (async () => {
      onStage?.("page-create")
      page = await this.context.newPage()
      aborted(signal)
      capture = await PageStreamCapture.install(page, {
        streamURLPattern: this.config.streamURLPattern, signal, onStage,
      })
      aborted(signal)
      this.pages.set(sessionMarker, page)
      this.captures.set(page, capture)
      return page
    })()
    const cleanup = () => {
      if (owned) return
      owned = true
      // These Playwright setup APIs have no native signal. Keep admission
      // closed until their late result and all of its resources are reclaimed.
      const work = setup.then(() => undefined, () => undefined).then(async () => {
        await capture?.stop()
        if (page) await (retirement ?? this.retire(sessionMarker, page))
      }).finally(() => this.pendingSetups.delete(work))
      this.pendingSetups.add(work)
      if (page) retirement = this.retire(sessionMarker, page)
    }
    signal?.addEventListener("abort", cleanup, { once: true })
    if (signal?.aborted) cleanup()
    try { return await abortable(setup, signal) }
    catch (error) { onFailure?.(error); cleanup(); throw error }
    finally { signal?.removeEventListener("abort", cleanup) }
  }

  private trackSetup<A>(page: Page, operation: Promise<A>): Promise<A> {
    const operations = this.setupOperations.get(page) ?? new Set<Promise<unknown>>()
    this.setupOperations.set(page, operations)
    const work = operation.finally(() => operations.delete(work))
    operations.add(work)
    return work
  }

  private retire(sessionMarker: string, expected: Page): Promise<void> {
    if (this.pages.get(sessionMarker) === expected) this.pages.delete(sessionMarker)
    this.selectedModels.delete(expected)
    const existing = this.retirements.get(expected)
    if (existing) return existing
    const stopped = this.captures.get(expected)?.stop()
    const closed = new Promise<void>(resolve => {
      const onClose = () => { expected.removeListener("close", onClose); resolve() }
      expected.once("close", onClose)
      if (expected.isClosed()) onClose()
    })
    // Register ownership before requesting close, which may fail or emit its
    // close event immediately. Neither settlement alone proves reclamation.
    const work = Promise.all([
      stopped,
      // Locator.evaluate's signal only covers resolution in pinned Playwright;
      // evaluation and handle disposal must remain owned until they settle.
      (async () => {
        const operations = this.setupOperations.get(expected)
        while (operations?.size) await Promise.allSettled(operations)
      })(),
      closed,
      Promise.resolve().then(() => expected.isClosed() ? undefined : expected.close({ runBeforeUnload: false }))
        .catch(() => { console.error("aipass page teardown failed; admission remains closed until the page closes") }),
    ]).then(() => {
      this.retirements.delete(expected)
    })
    this.retirements.set(expected, work)
    return work
  }

  private async evict(sessionMarker: string, expected: Page, signal?: AbortSignal) {
    await abortable(this.retire(sessionMarker, expected), signal)
  }

  private assertAvailable() {
    if (this.closing) throw new Error("AIPass browser adapter is closed")
    if (this.retirements.size || this.pendingSetups.size) throw new Error("AIPass browser cleanup is pending; retry after cleanup completes")
  }

  private async prime(page: Page, prompt: string, signal?: AbortSignal, onStage?: (stage: string) => void, onFailure?: (error: unknown) => void) {
    onStage?.("priming-ready")
    await abortable(
      promptInput(page, this.config.selectors ?? {}).waitFor({
        state: "visible",
        timeout: this.config.navigationTimeoutMs ?? 90_000,
        signal,
      }),
      signal,
    )
    onStage?.("priming-baseline")
    const baseline = await abortable(this.trackSetup(page, assistantBaseline(page, signal)), signal)
    onStage?.("priming-arm")
    const capture = await abortable(this.captures.get(page)!.activate(baseline, prompt), signal)
    try {
      onStage?.("priming-fill")
      await abortable(
        promptInput(page, this.config.selectors ?? {}).fill(prompt, {
          timeout: this.config.navigationTimeoutMs ?? 90_000,
          signal,
        }),
        signal,
      )
      onStage?.("priming-submit")
      await abortable(sendButton(page, this.config.selectors ?? {}).click({ timeout: 10_000, signal }), signal)
      onStage?.("priming-response")
      const response = new BrowserResponse(this.protocol)
      const accepted = new Set<number>()
      let terminal = false
      let streamObserved = false
      let streamChars = 0
      let responseCount = 0
      let matchedResponse = false
      let currentAssistantCount = baseline
      const submittedAt = performance.now()
      const evidenceTimeoutMs = Math.max(20_000, responseEvidenceTimeoutMs(prompt))
      let evidenceChecked = false
      let idleDeadline = performance.now() + effectiveIdleTimeout(this.config)
      const confirmed = (completion: DomCompletion) => {
        const frames = response.confirm(completion, baseline)
        terminal ||= frames.some((frame) => this.protocol.isTerminal(frame))
        if (!terminal) return undefined
        console.error(
          `aipass priming part confirmed baseline=${baseline} current=${currentAssistantCount} responses=${responseCount} matched=${matchedResponse} streamed=${streamObserved} streamChars=${streamChars} replyChars=${completion.text.length}`,
        )
        return response.outputEstimate
      }
      while (true) {
        const now = performance.now()
        const evidenceDeadline = submittedAt + evidenceTimeoutMs
        const wakeAt = evidenceChecked ? idleDeadline : Math.min(idleDeadline, evidenceDeadline)
        let event: CaptureEvent | undefined
        try {
          event = await capture.next({ signal, timeoutMs: Math.max(0, wakeAt - now) })
        } catch (error) {
          if (!(error instanceof BrowserCaptureTimeoutError)) throw error
          const completion = await readDomCompletion(page, signal)
          currentAssistantCount = completion.assistantCount
          if (completion.complete && completion.assistantCount > baseline) {
            const estimate = confirmed(completion)
            if (estimate !== undefined) return estimate
          }
          const elapsed = performance.now() - submittedAt
          if (!evidenceChecked && elapsed >= evidenceTimeoutMs) {
            evidenceChecked = true
            if (
              classifyNoResponseEvidence({
                elapsedMs: elapsed,
                responseCount,
                matchedResponse,
                baselineAssistantCount: baseline,
                currentAssistantCount,
              })
            )
              throw new NoResponseEvidenceError()
            continue
          }
          if (performance.now() >= idleDeadline) {
            console.error(
              `aipass priming timed out baseline=${baseline} current=${currentAssistantCount} responses=${responseCount} matched=${matchedResponse} streamed=${streamObserved} streamChars=${streamChars}`,
            )
            throw new Error("browser instruction priming timed out")
          }
          continue
        }
        if (!event) throw new Error("browser instruction priming ended without response evidence")
        if (event.type === "response") {
          responseCount += 1
          matchedResponse ||= event.matched
          if (event.selected && event.bodyPresent) accepted.add(event.responseID)
          continue
        }
        if (event.type !== "dom" && !accepted.has(event.responseID)) continue
        idleDeadline = performance.now() + effectiveIdleTimeout(this.config)
        if (event.type === "dom") {
          currentAssistantCount = event.assistantCount
          if (event.complete && event.assistantCount > baseline) {
            const completion = await readDomCompletion(page, signal)
            currentAssistantCount = completion.assistantCount
            if (completion.complete && completion.assistantCount > baseline) {
              const estimate = confirmed(completion)
              if (estimate !== undefined) return estimate
            }
          }
          continue
        }
        if (event.type === "error") throw new Error(event.message)
        if (event.type === "chunk") {
          streamObserved = true
          streamChars += event.chunk.length
          response.push(event.chunk, event.responseID)
          continue
        }
        const frames = response.finish(event.responseID)
        terminal ||= frames.some((frame) => this.protocol.isTerminal(frame))
        const completion = await readDomCompletion(page, signal)
        currentAssistantCount = completion.assistantCount
        if (completion.complete && completion.assistantCount > baseline) {
          const estimate = confirmed(completion)
          if (estimate !== undefined) return estimate
        }
      }
    } catch (error) {
      onFailure?.(error)
      throw error
    } finally {
      if (!signal?.aborted) onStage?.("priming-cleanup")
      await abortable(capture.cleanup(), signal)
    }
  }

  async *turn(
    input: BrowserTurnInput,
    signal?: AbortSignal,
    options: { readonly forceReload?: boolean } = {},
  ): AsyncGenerator<Frame> {
    aborted(signal)
    this.assertAvailable()
    const release = await this.locks.acquire(input.sessionMarker)
    let page: Page | undefined
    let capture: ActivePageCapture | undefined
    let attempt: Attempt | undefined
    let possiblySubmitted = false
    let completed = false
    let admitted = false
    let stage = "session-setup"
    let stageStarted = performance.now()
    let diagnosed = false
    const mark = (value: string) => { stage = value; stageStarted = performance.now() }
    const diagnose = (reason: "cancelled" | "deadline" | "failed") => {
      if (diagnosed) return
      diagnosed = true
      console.error(JSON.stringify({
        diagnostic: "browser-turn-failure", stage, reason,
        elapsedMs: Math.round(performance.now() - stageStarted),
        control: browserControlState(this.context),
      }))
    }
    const onAbort = () => diagnose("cancelled")
    const onFailure = (error: unknown) => diagnose(signal?.aborted || error instanceof BrowserTurnAbortedError ? "cancelled" : "failed")
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      aborted(signal)
      this.assertAvailable()
      admitted = true
      if (input.compactionDigest && (await this.lifecycle.rotate?.(input.sessionMarker, input.compactionDigest))) {
        const existing = this.pages.get(input.sessionMarker)
        if (existing) await this.evict(input.sessionMarker, existing, signal)
      }
      let binding = await this.lifecycle.binding(input.sessionMarker)
      let bound = binding !== undefined && sameOrigin(binding, this.config.chatURL)
      let currentVersion = await this.lifecycle.promptContractVersion?.(input.sessionMarker)
      let currentDigest = await this.lifecycle.actionEnvelopeDigest?.(input.sessionMarker)
      if (
        shouldResetActionOnlyContext(
          bound,
          input.promptContractVersion,
          input.actionEnvelopeDigest,
          currentVersion,
          currentDigest,
        )
      ) {
        const existing = this.pages.get(input.sessionMarker)
        if (existing) await this.evict(input.sessionMarker, existing, signal)
        await this.lifecycle.discard?.(input.sessionMarker)
        binding = undefined
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
      const prompt = turnPrompt(input, bound, options.forceReload === true, contractCurrent)
      const carriesEnvelope = !bound || options.forceReload === true || !contractCurrent
      console.error(
        `aipass turn session bound=${bound} contractCurrent=${contractCurrent} ephemeral=${input.ephemeral} carriesEnvelope=${carriesEnvelope} promptChars=${prompt.length}`,
      )
      mark("attempt-preparation")
      attempt = await this.lifecycle.prepare({
        sessionMarker: input.sessionMarker,
        prompt,
        promptHash: promptHash(prompt),
      })
      page = await this.page(input.sessionMarker, signal, mark, onFailure)
      const target = bound && binding ? binding : this.config.chatURL
      if (options.forceReload) this.selectedModels.delete(page)
      if (options.forceReload || page.url() !== target) {
        mark("navigation")
        await abortable(
          page.goto(target, {
            waitUntil: "domcontentloaded",
            timeout: this.config.navigationTimeoutMs ?? 90_000,
            signal,
          }),
          signal,
        )
      }
      aborted(signal)
      mark("temporary-chat")
      const setupPage = page
      const tempChat = await ensureTempChat(
        new PlaywrightTempChatSurface(page, operation => this.trackSetup(setupPage, operation)),
        { timeoutMs: 8000, signal },
      )
      if (this.setupOperations.get(page)?.size) {
        diagnose("deadline")
        throw new Error("AIPass temporary-chat setup did not settle before its deadline")
      }
      console.error(`aipass temp chat state=${tempChat}`)
      const modelSignature = `${input.model.id}:${input.reasoning}`
      const reusableSelection = page.url() === target && this.selectedModels.get(page) === modelSignature
      if (!reusableSelection) {
        mark("authentication")
        await abortable(this.trackSetup(page, assertAuthenticated(page, this.config, signal, mark)), signal)
        await abortable(
          selectModel(
            new PlaywrightModelSelectionSurface(page, this.config.selectors, this.config.modelNames),
            { ...input.model, reasoning: input.reasoning },
            { timeoutMs: 20_000, signal, onStage: stage => mark(`model-${stage.replaceAll(" ", "-")}`), onDeadline: () => diagnose("deadline") },
          ),
          signal,
        )
        this.selectedModels.set(page, modelSignature)
      }

      let primingEstimate = 0
      if (carriesEnvelope && input.primingPrompts.length) {
        for (const [index, primingPrompt] of input.primingPrompts.entries()) {
          console.error(
            `aipass instruction priming part=${index + 1}/${input.primingPrompts.length} chars=${primingPrompt.length}`,
          )
          primingEstimate +=
            estimateTokens(primingPrompt) +
            (await this.prime(page, primingPrompt, signal, mark, onFailure))
        }
      }

      mark("prompt-ready")
      await abortable(
        promptInput(page, this.config.selectors ?? {}).waitFor({
          state: "visible",
          timeout: this.config.navigationTimeoutMs ?? 90_000,
          signal,
        }),
        signal,
      )
      const fillPrompt = withTurnKey(prompt, input.promptKey)
      const fillStart = performance.now()
      mark("prompt-fill")
      await abortable(
        promptInput(page, this.config.selectors ?? {}).fill(fillPrompt, {
          timeout: this.config.navigationTimeoutMs ?? 90_000,
          signal,
        }),
        signal,
      )
      console.error(`aipass submit fillMs=${Math.round(performance.now() - fillStart)} chars=${fillPrompt.length}`)
      mark("filled-screenshot")
      await captureStepScreenshot(page, this.config.screenshotDir, "filled")
      mark("attachments")
      const staged = await stageAttachments(input.attachments ?? [])
      try {
        try {
          await uploadStagedFiles(page, staged.files)
        } catch (error) {
          console.error(
            `aipass attachments upload failed open files=${staged.files.length} ${error instanceof Error ? error.message : error}`,
          )
        }
      } finally {
        await cleanupStagedFiles(staged.dir).catch(() => undefined)
      }
      mark("baseline")
      const baseline = await abortable(this.trackSetup(page, assistantBaseline(page, signal)), signal)
      mark("capture-arm")
      capture = await abortable(this.captures.get(page)!.activate(baseline, fillPrompt), signal)
      mark("attempt-pending")
      await this.lifecycle.pending(attempt)
      possiblySubmitted = true
      const clickStart = performance.now()
      mark("submit")
      await abortable(sendButton(page, this.config.selectors ?? {}).click({ timeout: 10_000, signal }), signal)
      console.error(`aipass submit clickMs=${Math.round(performance.now() - clickStart)}`)
      mark("submitted-screenshot")
      await captureStepScreenshot(page, this.config.screenshotDir, "submitted")
      const submittedRemoteChatID = page.url()
      if (sameOrigin(submittedRemoteChatID, this.config.chatURL))
        await this.lifecycle.bind(input.sessionMarker, submittedRemoteChatID)

      mark("response")
      const response = new BrowserResponse(this.protocol)
      const accepted = new Set<number>()
      let terminal = false
      let framesObserved = false
      let responseCount = 0
      let matchedResponse = false
      const seenContentTypes: string[] = []
      let currentAssistantCount = baseline
      const submittedAt = performance.now()
      const evidenceTimeoutMs = responseEvidenceTimeoutMs(prompt, input.toolContinuation)
      let evidenceChecked = false
      let idleDeadline = performance.now() + effectiveIdleTimeout(this.config)

      const emitFallback = (completion: DomCompletion): readonly Frame[] => {
        console.error(
          `aipass dom fallback settled=${completion.settled} thinking=${completion.thinking.length} assistantCount=${completion.assistantCount}`,
        )
        const frames = response.confirm(completion, baseline)
        terminal ||= frames.some((frame) => this.protocol.isTerminal(frame))
        return frames
      }

      let nextThinkingAt = performance.now()
      let thinkingChangedAt = performance.now()
      let thinkingSnapshot: DomCompletion | undefined
      let pendingFinish: number | undefined
      let thinkingSettleDeadline = Infinity
      const readProgress = async (): Promise<readonly Frame[]> => {
        nextThinkingAt = performance.now() + 250
        if (!input.promptKey || accepted.size === 0) return []
        const snapshot = await readDomSnapshot(page!, signal, { generation: capture!.generation, baseline })
        if (!sameThinkingSegments(snapshot.thinking, thinkingSnapshot?.thinking ?? [])) thinkingChangedAt = performance.now()
        thinkingSnapshot = snapshot
        const frames = response.progress(snapshot, input.promptKey)
        if (frames.length) idleDeadline = performance.now() + effectiveIdleTimeout(this.config)
        return frames
      }

      while (true) {
        const sampled = performance.now() >= nextThinkingAt
        if (sampled) yield* await readProgress()
        const now = performance.now()
        if (pendingFinish !== undefined) {
          if (now >= thinkingSettleDeadline) throw new Error("browser thinking panel did not stabilize")
          if (!thinkingSnapshot?.attributed) throw new Error("browser thinking panel lost turn attribution")
          // Selected events must be drained before completion, but unrelated
          // traffic cannot prevent publication of a freshly sampled stable panel.
          if (sampled && response.pendingDomCompletion && now - thinkingChangedAt >= DOM_STABILITY_MS && !capture.hasPendingSelected(accepted)) {
            for (const frame of response.finish(pendingFinish)) {
              terminal ||= this.protocol.isTerminal(frame)
              yield frame
            }
            if (terminal) break
          }
        }
        const evidenceDeadline = submittedAt + evidenceTimeoutMs
        const deadline = pendingFinish !== undefined ? thinkingSettleDeadline : evidenceChecked ? idleDeadline : Math.min(idleDeadline, evidenceDeadline)
        const wakeAt = input.promptKey && accepted.size > 0 ? Math.min(deadline, nextThinkingAt) : deadline
        let event: CaptureEvent | undefined
        try {
          event = await capture.next({ signal, timeoutMs: Math.max(0, wakeAt - now) })
        } catch (error) {
          if (!(error instanceof BrowserCaptureTimeoutError)) throw error
          if (pendingFinish !== undefined) continue
          if (performance.now() < deadline) continue
          const completion = await readDomCompletion(page, signal)
          yield* await readProgress()
          currentAssistantCount = completion.assistantCount
          if (completion.complete && completion.assistantCount > baseline && completion.text) {
            yield* emitFallback(completion)
            if (terminal) break
          }
          const elapsed = performance.now() - submittedAt
          if (!evidenceChecked && elapsed >= evidenceTimeoutMs) {
            evidenceChecked = true
            if (
              classifyNoResponseEvidence({
                elapsedMs: elapsed,
                responseCount,
                matchedResponse,
                baselineAssistantCount: baseline,
                currentAssistantCount,
              })
            ) {
              console.error(
                `aipass no-response evidence matched=${matchedResponse} responses=${responseCount} types=${seenContentTypes.join(",") || "none"} baseline=${baseline} current=${currentAssistantCount} settled=${completion.settled}`,
              )
              throw new NoResponseEvidenceError()
            }
            continue
          }
          if (performance.now() >= idleDeadline) {
            const pendingKey = `${STREAM_ARM}Pending`
            const pingStart = performance.now()
            const pending = await Promise.race([
              page
                .evaluate((key: string) => {
                  const query = (globalThis as unknown as Record<string, unknown>)[key]
                  return typeof query === "function" ? (query as () => unknown)() : null
                }, pendingKey)
                .catch(() => null),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
            ])
            const pingMs = Math.round(performance.now() - pingStart)
            console.error(
              `aipass stream timeout evidence matched=${matchedResponse} responses=${responseCount} types=${seenContentTypes.join(",") || "none"} baseline=${baseline} current=${currentAssistantCount} settled=${completion.settled} frames=${framesObserved} pending=${JSON.stringify(pending)} pingMs=${pingMs} structure=${await domStructure(page)}`,
            )
            throw new Error("observed browser stream timed out")
          }
          continue
        }

        if (!event) throw new Error("observed browser capture ended without a terminal frame")
        if (event.type === "response") {
          responseCount += 1
          matchedResponse ||= event.matched
          if (event.selected && event.bodyPresent) accepted.add(event.responseID)
          if (!seenContentTypes.includes(event.contentType) && seenContentTypes.length < 8)
            seenContentTypes.push(event.contentType)
          continue
        }
        if (event.type !== "dom" && !accepted.has(event.responseID)) continue
        idleDeadline = performance.now() + effectiveIdleTimeout(this.config)
        if (event.type === "dom") {
          currentAssistantCount = event.assistantCount
          if (pendingFinish !== undefined) continue
          if (event.complete && event.assistantCount > baseline && event.text) {
            const completion = await readDomCompletion(page, signal)
            yield* await readProgress()
            currentAssistantCount = completion.assistantCount
            if (!completion.complete || completion.assistantCount <= baseline || !completion.text) continue
            yield* emitFallback(completion)
            if (terminal) break
          }
          continue
        }
        if (event.type === "error") throw new Error(event.message)
        if (event.type === "chunk") {
          framesObserved = true
          response.push(event.chunk, event.responseID)
          continue
        }
        yield* await readProgress()
        const finishedFrames = response.finish(event.responseID, true)
        if (response.pendingDomCompletion && pendingFinish === undefined) {
          // Native completion can precede the final React render. Keep
          // processing capture events and attributed DOM suffixes through
          // the bounded stability window, never copying unseen native text.
          pendingFinish = event.responseID
          thinkingChangedAt = performance.now()
          thinkingSettleDeadline = thinkingChangedAt + effectiveIdleTimeout(this.config)
        }
        for (const frame of finishedFrames) {
          terminal ||= this.protocol.isTerminal(frame)
          yield frame
        }
        if (pendingFinish !== undefined) continue
        if (!terminal) {
          const completion = await readDomCompletion(page, signal)
          yield* await readProgress()
          currentAssistantCount = completion.assistantCount
          if (completion.complete && completion.assistantCount > baseline && completion.text) {
            yield* emitFallback(completion)
          }
        }
        if (terminal) break
        // The completed response carried no decodable model stream and the
        // answer is not in the DOM yet. Keep waiting for a late answer until
        // the idle deadline instead of failing on this event.
      }

      if (!terminal) throw new Error("observed browser turn ended without a terminal frame")
      const remoteChatID = page.url()
      mark("attempt-completion")
      await this.lifecycle.complete(
        attempt,
        sameOrigin(remoteChatID, this.config.chatURL) ? remoteChatID : undefined,
        primingEstimate + estimateTokens(prompt) + response.outputEstimate,
        carriesEnvelope ? input.promptContractVersion : undefined,
        carriesEnvelope ? input.actionEnvelopeDigest : undefined,
      )
      completed = true
    } catch (error) {
      onFailure(error)
      if (page && (signal?.aborted || error instanceof BrowserTurnAbortedError)) this.retire(input.sessionMarker, page)
      try {
        if (page && !signal?.aborted) await captureStepScreenshot(page, this.config.screenshotDir, "failed")
        if (attempt && !completed)
          await this.lifecycle.fail(attempt, {
            possiblySubmitted,
            cancelled: error instanceof BrowserTurnAbortedError || signal?.aborted === true,
            definitive: error instanceof NoResponseEvidenceError,
          })
      } finally {
        if (page && !(error instanceof NoResponseEvidenceError)) this.retire(input.sessionMarker, page)
      }
      throw error
    } finally {
      try {
        try {
          if (!diagnosed) mark("capture-cleanup")
          if (capture) await abortable(capture.cleanup(), signal)
        } catch (error) {
          diagnose(signal?.aborted ? "cancelled" : "failed")
          if (page) this.retire(input.sessionMarker, page)
          throw error
        }
      } finally {
        try {
          if (input.ephemeral && admitted) {
            if (!diagnosed) mark("session-discard")
            try {
              if (page && !page.isClosed()) await this.evict(input.sessionMarker, page, signal)
            } finally {
              await this.lifecycle.discard?.(input.sessionMarker)
            }
          }
        } finally {
          signal?.removeEventListener("abort", onAbort)
          release()
        }
      }
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = (async () => {
      await this.locks.idle()
      for (const [sessionMarker, page] of this.pages) this.retire(sessionMarker, page)
      while (this.retirements.size || this.pendingSetups.size)
        await Promise.all([...this.retirements.values(), ...this.pendingSetups])
      await this.context.close()
    })()
    return this.closing
  }

  async discard(sessionMarker: string) {
    const release = await this.locks.acquire(sessionMarker)
    try {
      const page = this.pages.get(sessionMarker)
      if (page) await this.evict(sessionMarker, page)
      await this.lifecycle.discard?.(sessionMarker)
    } finally {
      release()
    }
  }
}

export async function loginWithSystemChrome(config: BrowserAdapterConfig, signal?: AbortSignal) {
  const context = await chromium.launchPersistentContext(config.profilePath, {
    headless: false,
    executablePath: config.executablePath,
  })
  try {
    aborted(signal)
    const page = context.pages()[0] ?? (await context.newPage())
    await abortable(
      page.goto(config.chatURL, {
        waitUntil: "domcontentloaded",
        timeout: config.navigationTimeoutMs ?? 90_000,
      }),
      signal,
    )
    await abortable(
      promptInput(page, config.selectors ?? {}).waitFor({
        state: "visible",
        timeout: config.navigationTimeoutMs ?? 90_000,
      }),
      signal,
    )
    if (config.loginModelName)
      await abortable(
        new PlaywrightModelSelectionSurface(page, config.selectors, config.modelNames).open(
          config.loginModelName,
          config.navigationTimeoutMs ?? 90_000,
        ),
        signal,
      )
    console.log(`Login window open using profile: ${config.profilePath}`)
    console.log(`Chat URL: ${config.chatURL}`)
    console.log(
      "Sign in in the opened Chrome window if needed, verify the chat input is visible, then close the window or press Enter here to finish.",
    )
    await new Promise<void>((resolve) => {
      let done = false
      const cleanup = () => {
        process.removeListener("SIGINT", onSigint)
        signal?.removeEventListener("abort", onAbort)
        try {
          process.stdin.pause()
        } catch {}
      }
      const finish = () => {
        if (done) return
        done = true
        cleanup()
        resolve()
      }
      const onSigint = () => finish()
      const onAbort = () => finish()
      process.once("SIGINT", onSigint)
      signal?.addEventListener("abort", onAbort, { once: true })
      ;(context as unknown as { once(event: string, listener: () => void): void }).once("close", finish)
      try {
        if (process.stdin.isTTY) {
          process.stdin.resume()
          process.stdin.once("data", finish)
        }
      } catch {}
    })
  } finally {
    await context.close()
  }
}
