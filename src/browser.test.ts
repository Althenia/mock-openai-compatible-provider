import { describe, expect, test } from "bun:test"
import {
  PageStreamCapture,
  captureStepScreenshot,
  classifyNoResponseEvidence,
  cleanupStagedFiles,
  ensureTempChat,
  extractThinkingSegments,
  formatThinkingSegment,
  interpretToggleIcon,
  isSameOrigin,
  isSettledResponse,
  isStreamMatch,
  responseEvidenceTimeoutMs,
  safeAttachmentBasename,
  sameOrigin,
  sameThinkingSegments,
  selectModel,
  shouldResetActionOnlyContext,
  stageAttachments,
  uploadStagedFiles,
  promptContractCurrent,
  readDomCompletion,
  turnPrompt,
  type CaptureTransport,
  type ModelSelectionSurface,
  type ReasoningLevel,
  type TempChatControl,
  type TempChatSurface,
} from "./browser.ts"

class FakeDomPage {
  constructor(private readonly snapshots: readonly {
    readonly assistantCount: number
    readonly complete: boolean
    readonly settled: boolean
    readonly text: string
  }[]) {}

  private index = 0

  async evaluate() {
    const snapshot = this.snapshots[this.index++]
    if (!snapshot) throw new Error("missing DOM snapshot")
    return snapshot
  }
}

describe("DOM completion stability", () => {
  test("normalizes early unsettled, empty, and absent-assistant snapshots to incomplete", async () => {
    for (const snapshot of [
      { assistantCount: 1, complete: true, settled: false, text: "answer" },
      { assistantCount: 1, complete: true, settled: true, text: "   " },
      { assistantCount: 0, complete: true, settled: true, text: "answer" },
    ]) {
      const completion = await readDomCompletion(new FakeDomPage([snapshot]) as never)
      expect(completion.complete).toBe(false)
    }
  })

  test("accepts only two equal nonempty settled snapshots", async () => {
    const snapshot = { assistantCount: 1, complete: true, settled: true, text: "answer" }
    const completion = await readDomCompletion(new FakeDomPage([snapshot, snapshot]) as never)
    expect(completion).toMatchObject({ complete: true, text: "answer", settled: true })
  }, 10_000)

  test("rejects a changed second snapshot", async () => {
    const completion = await readDomCompletion(
      new FakeDomPage([
        { assistantCount: 1, complete: true, settled: true, text: "first" },
        { assistantCount: 1, complete: true, settled: true, text: "second" },
      ]) as never,
    )
    expect(completion.complete).toBe(false)
    expect(completion.text).toBe("second")
  }, 10_000)

  test("propagates cancellation while waiting for a stable second snapshot", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      readDomCompletion(
        new FakeDomPage([{ assistantCount: 1, complete: true, settled: true, text: "answer" }]) as never,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" })
  })
})

test("turn prompt selection preserves the instruction envelope for recovery", () => {
  const input = {
    sessionMarker: "session-a",
    ephemeral: false,
    primingPrompts: [],
    model: { id: "gpt", name: "GPT", thinking: [] },
    reasoning: "none" as const,
    initialPrompt: "INITIAL_WITH_ENVELOPE",
    incrementalPrompt: "BOUND_INCREMENTAL",
    recoveryPrompt: "RECOVERY_WITH_ENVELOPE",
    promptContractVersion: 1,
    actionEnvelopeDigest: "digest-a",
    toolContinuation: false,
  }

  expect(turnPrompt(input, false, false, false)).toBe("INITIAL_WITH_ENVELOPE")
  expect(turnPrompt(input, true, false, true)).toBe("BOUND_INCREMENTAL")
  expect(turnPrompt(input, true, false, false)).toBe("RECOVERY_WITH_ENVELOPE")
  expect(turnPrompt(input, true, true, true)).toBe("RECOVERY_WITH_ENVELOPE")
})

test("response evidence safety deadline grows conservatively for large instruction envelopes", () => {
  expect(responseEvidenceTimeoutMs("short")).toBe(8_000)
  expect(responseEvidenceTimeoutMs("short", true)).toBe(45_000)
  expect(responseEvidenceTimeoutMs("x".repeat(100_000))).toBeGreaterThan(8_000)
  expect(responseEvidenceTimeoutMs("x".repeat(1_000_000))).toBeLessThanOrEqual(45_000)
})

test("action-only mode resets a preserved binding but reuses its own context", () => {
  expect(shouldResetActionOnlyContext(true, 10, "a0digest", 9, "legacy")).toBe(true)
  expect(shouldResetActionOnlyContext(true, 10, "a0digest", 10, "b0preserved")).toBe(true)
  expect(shouldResetActionOnlyContext(true, 10, "a0digest", 10, "a0previous")).toBe(false)
  expect(shouldResetActionOnlyContext(false, 10, "a0digest", 10, "b0preserved")).toBe(false)
})

test("prompt contract requires both the current version and action envelope digest", () => {
  const digestA = `b0${"1".repeat(32)}${"a".repeat(30)}`
  const digestB = `b0${"1".repeat(32)}${"b".repeat(30)}`
  expect(promptContractCurrent(1, digestA, 1, digestA, false)).toBe(true)
  expect(promptContractCurrent(1, digestA, 0, digestA, false)).toBe(false)
  expect(promptContractCurrent(1, digestA, 1, digestB, false)).toBe(false)
  expect(promptContractCurrent(1, digestA, 1, digestB, true)).toBe(true)
  expect(promptContractCurrent(1, digestA, 0, digestB, true)).toBe(false)
  expect(promptContractCurrent(1, digestA, 1, undefined, true)).toBe(false)
  expect(promptContractCurrent(1, digestA, 1, digestA.slice(0, 34), true)).toBe(false)
  expect(promptContractCurrent(1, digestA, 1, `${digestA.slice(0, 34)}${"Z".repeat(30)}`, true)).toBe(false)
})

class FakeModelSurface implements ModelSelectionSurface {
  readonly clicks: string[] = []
  readonly timeouts: number[] = []
  expanded = false
  current: ReasoningLevel = "none"
  closed = false

  async action(name: string, timeoutMs: number) {
    this.clicks.push(name)
    this.timeouts.push(timeoutMs)
  }

  async open(_modelName: string, timeoutMs: number) {
    this.timeouts.push(timeoutMs)
  }

  async expand(_modelName: string, timeoutMs: number) {
    if (!this.expanded) await this.action("settings", timeoutMs)
    this.expanded = true
  }

  async processingLevel(_modelName: string, timeoutMs: number) {
    this.timeouts.push(timeoutMs)
    return this.current
  }

  async openProcessing(_modelName: string, timeoutMs: number) { await this.action("thinking", timeoutMs) }
  async chooseProcessing(_modelName: string, level: Exclude<ReasoningLevel, "none">, timeoutMs: number) {
    await this.action(level, timeoutMs)
    this.current = this.current === level ? "none" : level
  }
  async verifyProcessing(_modelName: string, level: ReasoningLevel, timeoutMs: number) {
    this.timeouts.push(timeoutMs)
    if (this.current !== level) throw Error("fixture Processing value mismatch")
  }
  async confirm(_modelName: string, timeoutMs: number) {
    await this.action("confirm", timeoutMs)
    this.expanded = false
  }
  async select(_modelName: string, timeoutMs: number) { await this.action("select", timeoutMs) }
  async waitClosed(_modelName: string, timeoutMs: number) {
    this.timeouts.push(timeoutMs)
    this.closed = true
  }
}

describe("model selection", () => {
  test("re-resolves collapsed and expanded thinking controls under one deadline", async () => {
    const surface = new FakeModelSurface()
    let now = 1_000
    const result = selectModel(
      surface,
      { id: "gpt", name: "GPT", thinking: ["low", "medium", "high"], reasoning: "high" },
      { timeoutMs: 10_000, now: () => (now += 125) },
    )
    await result

    expect(surface.clicks).toEqual(["settings", "thinking", "high", "confirm"])
    expect(surface.current).toBe("high")
    expect(surface.closed).toBe(true)
    expect(surface.timeouts.every((timeout) => timeout > 0 && timeout <= 10_000)).toBe(true)
    expect(surface.timeouts.at(-1)).toBeLessThan(surface.timeouts[0]!)
  })

  test("clears an already-set Processing value before confirming a no-thinking turn", async () => {
    const surface = new FakeModelSurface()
    surface.expanded = true
    surface.current = "high"
    await selectModel(
      surface,
      { id: "gpt", name: "GPT", thinking: ["low", "medium", "high"], reasoning: "none" },
      { timeoutMs: 10_000 },
    )
    expect(surface.clicks).toEqual(["thinking", "high", "confirm"])
    expect(surface).toMatchObject({ current: "none", closed: true })
  })

  test("rejects unsupported levels before touching browser controls", async () => {
    const surface = new FakeModelSurface()
    await expect(
      selectModel(
        surface,
        { id: "flash", name: "Flash", thinking: [], reasoning: "high" },
        { timeoutMs: 10_000 },
      ),
    ).rejects.toThrow("does not support")
    expect(surface.timeouts).toEqual([])
  })

  test("bounds the entire selection when one Playwright operation stalls", async () => {
    const surface = new FakeModelSurface()
    surface.open = () => new Promise<void>(() => undefined)
    const started = performance.now()
    await expect(
      selectModel(
        surface,
        { id: "flash", name: "Flash", thinking: [], reasoning: "none" },
        { timeoutMs: 10 },
      ),
    ).rejects.toThrow("selector open exceeded the 20 second selection deadline")
    expect(performance.now() - started).toBeLessThan(500)
  })
})

class FakeCapturePage implements CaptureTransport {
  binding: ((source: unknown, value: unknown) => void | Promise<void>) | undefined
  initScript: unknown
  initArgument: unknown
  evaluations: unknown[] = []

  async exposeBinding(_name: string, callback: (source: unknown, value: unknown) => void | Promise<void>) {
    this.binding = callback
  }

  async addInitScript(script: unknown, argument?: unknown) {
    this.initScript = script
    this.initArgument = argument
  }

  async evaluate(_script: unknown, argument?: unknown) {
    this.evaluations.push(argument)
    return undefined
  }

  emit(value: Record<string, unknown>) {
    if (!this.binding) throw new Error("binding is not installed")
    return this.binding({}, { responseID: 1, selected: true, ...value })
  }
}

describe("fetch capture lifecycle", () => {
  test("completion waits for selected queued events, not unrelated traffic, and cannot accept a stopped capture", async () => {
    const page = new FakeCapturePage()
    const installed = await PageStreamCapture.install(page, {})
    const active = await installed.activate(0)
    const accepted = new Set<number>()
    await page.emit({ generation: active.generation, responseID: 2, type: "error", message: "unrelated" })
    expect(active.hasPendingSelected(accepted)).toBe(false)
    await page.emit({ generation: active.generation, type: "response", matched: true, bodyPresent: true, contentType: "sse" })
    expect(active.hasPendingSelected(accepted)).toBe(true)
    expect(await active.next()).toMatchObject({ responseID: 2, type: "error" })
    expect(await active.next()).toMatchObject({ responseID: 1, type: "response" })
    expect(active.hasPendingSelected(accepted)).toBe(false)
    accepted.add(1)
    await page.emit({ generation: active.generation, type: "error", message: "selected failure" })
    expect(active.hasPendingSelected(accepted)).toBe(true)
    expect(await active.next()).toMatchObject({ responseID: 1, type: "error", message: "selected failure" })
    expect(active.hasPendingSelected(accepted)).toBe(false)
    await active.cleanup()
    expect(active.hasPendingSelected(accepted)).toBe(true)
  })

  test("preserves response identity without ending the generation on a sibling error", async () => {
    const page = new FakeCapturePage()
    const installed = await PageStreamCapture.install(page, {})
    const active = await installed.activate(0)
    await page.emit({ generation: active.generation, responseID: 2, type: "error", message: "sibling failed" })
    await page.emit({ generation: active.generation, responseID: 1, type: "chunk", chunk: "model data" })
    expect(await active.next()).toEqual({ responseID: 2, type: "error", message: "sibling failed" })
    expect(await active.next()).toEqual({ responseID: 1, type: "chunk", chunk: "model data" })
    await active.cleanup()
  })

  test("routes only the active generation and cleans up page state", async () => {
    const page = new FakeCapturePage()
    const installed = await PageStreamCapture.install(page, { streamURLPattern: "/chat/stream" })
    const active = await installed.activate(3)
    expect(page.initScript).toBeFunction()

    await page.emit({ generation: "stale", type: "chunk", chunk: "ignored" })
    await page.emit({
      generation: active.generation,
      type: "response",
      matched: true,
      bodyPresent: true,
      contentType: "sse",
    })
    await page.emit({ generation: active.generation, type: "chunk", chunk: "data" })
    await page.emit({
      generation: active.generation,
      type: "dom",
      assistantCount: 4,
      complete: true,
      text: "fallback",
    })
    await page.emit({ generation: active.generation, type: "finish" })

    expect(await active.next()).toEqual({
      responseID: 1,
      type: "response",
      matched: true,
      selected: true,
      bodyPresent: true,
      contentType: "sse",
    })
    expect(await active.next()).toEqual({ responseID: 1, type: "chunk", chunk: "data" })
    expect(await active.next()).toEqual({ type: "dom", assistantCount: 4, complete: true, text: "fallback" })
    expect(await active.next()).toEqual({ responseID: 1, type: "finish" })

    await active.cleanup()
    expect(page.evaluations.at(-1)).toMatchObject({ generation: active.generation, value: "" })
    await page.emit({ generation: active.generation, type: "chunk", chunk: "late" })
    expect(await active.next()).toBeUndefined()
  })

  test("supersedes an older capture without leaking its messages", async () => {
    const page = new FakeCapturePage()
    const installed = await PageStreamCapture.install(page, {})
    const first = await installed.activate(0)
    const second = await installed.activate(0)
    await page.emit({ generation: first.generation, type: "chunk", chunk: "old" })
    await page.emit({ generation: second.generation, type: "chunk", chunk: "new" })
    expect(await first.next()).toBeUndefined()
    expect(await second.next()).toEqual({ responseID: 1, type: "chunk", chunk: "new" })
    await second.cleanup()
  })

  test("unblocks a pending capture wait when the turn is cancelled", async () => {
    const page = new FakeCapturePage()
    const installed = await PageStreamCapture.install(page, {})
    const active = await installed.activate(0)
    const controller = new AbortController()
    const pending = active.next({ signal: controller.signal, timeoutMs: 10_000 })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    await active.cleanup()
  })

  test("keeps the capture open after a finished side-channel stream", async () => {
    const page = new FakeCapturePage()
    const installed = await PageStreamCapture.install(page, {})
    const active = await installed.activate(0)
    await page.emit({
      generation: active.generation,
      type: "response",
      matched: true,
      bodyPresent: true,
      contentType: "text",
    })
    await page.emit({ generation: active.generation, type: "finish" })
    await page.emit({ generation: active.generation, type: "chunk", chunk: "late" })
    await page.emit({
      generation: active.generation,
      type: "dom",
      assistantCount: 1,
      complete: true,
      text: "late answer",
    })
    expect(await active.next()).toEqual({
      responseID: 1,
      type: "response",
      matched: true,
      selected: true,
      bodyPresent: true,
      contentType: "text",
    })
    expect(await active.next()).toEqual({ responseID: 1, type: "finish" })
    expect(await active.next()).toEqual({ responseID: 1, type: "chunk", chunk: "late" })
    expect(await active.next()).toEqual({ type: "dom", assistantCount: 1, complete: true, text: "late answer" })
    await active.cleanup()
  })
})

describe("turn safety decisions", () => {
  test("requires exact chat origin for durable bindings", () => {
    expect(sameOrigin("https://de.aipass.net/chat/remote", "https://de.aipass.net/chat")).toBe(true)
    expect(sameOrigin("http://de.aipass.net/chat/remote", "https://de.aipass.net/chat")).toBe(false)
    expect(sameOrigin("https://de.aipass.net.evil.test/chat", "https://de.aipass.net/chat")).toBe(false)
    expect(sameOrigin("not a url", "https://de.aipass.net/chat")).toBe(false)
  })

  test("classifies only verified unmatched post-submit activity after eight seconds", () => {
    expect(
      classifyNoResponseEvidence({
        elapsedMs: 8_000,
        responseCount: 2,
        matchedResponse: false,
        baselineAssistantCount: 3,
        currentAssistantCount: 3,
      }),
    ).toBe(true)
    expect(
      classifyNoResponseEvidence({
        elapsedMs: 8_000,
        responseCount: 0,
        matchedResponse: false,
        baselineAssistantCount: 3,
        currentAssistantCount: 3,
      }),
    ).toBe(false)
    expect(
      classifyNoResponseEvidence({
        elapsedMs: 8_000,
        responseCount: 2,
        matchedResponse: false,
        baselineAssistantCount: 3,
        currentAssistantCount: 4,
      }),
    ).toBe(false)
  })
})

describe("stream recognition", () => {
  test("matches explicit patterns and SSE/NDJSON regardless of origin", () => {
    expect(
      isStreamMatch({ url: "https://cdn.test/chat/stream", contentType: "application/json", streamPattern: "/chat/stream" }),
    ).toBe(true)
    expect(isStreamMatch({ url: "https://cdn.test/x", contentType: "text/event-stream" })).toBe(true)
    expect(isStreamMatch({ url: "https://cdn.test/x", contentType: "application/x-ndjson" })).toBe(true)
  })

  test("matches same-origin JSON/text streams but ignores cross-origin subresources", () => {
    const pageOrigin = "https://de.aipass.net"
    expect(
      isStreamMatch({ url: "https://de.aipass.net/api/stream", contentType: "application/json", pageOrigin }),
    ).toBe(true)
    expect(isStreamMatch({ url: "https://de.aipass.net/api/stream", contentType: "text/plain", pageOrigin })).toBe(true)
    expect(isStreamMatch({ url: "https://analytics.test/ping", contentType: "application/json", pageOrigin })).toBe(false)
    expect(isStreamMatch({ url: "https://de.aipass.net/api/stream", contentType: "application/json" })).toBe(false)
  })

  test("compares origins without throwing for relative URLs", () => {
    expect(isSameOrigin("/api/stream", "https://de.aipass.net")).toBe(true)
    expect(isSameOrigin("https://de.aipass.net/api", "https://de.aipass.net")).toBe(true)
    expect(isSameOrigin("https://other.test/api", "https://de.aipass.net")).toBe(false)
  })
})

class FakeTempChatControl implements TempChatControl {
  clicks = 0

  constructor(private readonly states: readonly ("on" | "off" | "unknown")[]) {}

  async state() {
    return this.states[Math.min(this.clicks, this.states.length - 1)]!
  }

  async click() {
    this.clicks++
  }
}

class FakeTempChatSurface implements TempChatSurface {
  constructor(
    private readonly controlValue: TempChatControl | undefined,
    private readonly throws = false,
  ) {}

  async control() {
    if (this.throws) throw new Error("surface failed")
    return this.controlValue
  }
}

describe("temporary chat mode", () => {
  test("leaves an enabled toggle untouched", async () => {
    const control = new FakeTempChatControl(["on"])
    expect(await ensureTempChat(new FakeTempChatSurface(control))).toBe("on")
    expect(control.clicks).toBe(0)
  })

  test("switches a disabled toggle on and verifies", async () => {
    const control = new FakeTempChatControl(["off", "on"])
    expect(await ensureTempChat(new FakeTempChatSurface(control))).toBe("on")
    expect(control.clicks).toBe(1)
  })

  test("reports off when the toggle does not switch", async () => {
    const control = new FakeTempChatControl(["off", "off"])
    expect(await ensureTempChat(new FakeTempChatSurface(control))).toBe("off")
    expect(control.clicks).toBe(1)
  })

  test("never clicks an unreadable toggle", async () => {
    const control = new FakeTempChatControl(["unknown"])
    expect(await ensureTempChat(new FakeTempChatSurface(control))).toBe("unavailable")
    expect(control.clicks).toBe(0)
  })

  test("stays fail-open without a toggle or on surface errors", async () => {
    expect(await ensureTempChat(new FakeTempChatSurface(undefined))).toBe("unavailable")
    expect(await ensureTempChat(new FakeTempChatSurface(new FakeTempChatControl(["off"]), true))).toBe("unavailable")
  })
})

describe("temporary chat link-toggle icon rule", () => {
  test("temporary-chat page URL is ground truth", () => {
    expect(interpretToggleIcon({ temporaryUrl: true, circles: 0, paths: 0, shapeOk: true })).toBe("on")
    expect(interpretToggleIcon({ temporaryUrl: true, circles: 1, paths: 0, shapeOk: true })).toBe("on")
    expect(interpretToggleIcon({ temporaryUrl: false, circles: 0, paths: 0, shapeOk: true })).toBe("off")
    expect(interpretToggleIcon({ temporaryUrl: false, circles: 0, paths: 1, shapeOk: true })).toBe("off")
  })

  test("explicit pressed and data-state attributes win", () => {
    expect(interpretToggleIcon({ pressed: "true", circles: 0, paths: 0, shapeOk: false })).toBe("on")
    expect(interpretToggleIcon({ pressed: "false", circles: 1, paths: 1, shapeOk: true })).toBe("off")
    expect(interpretToggleIcon({ dataState: "checked", circles: 0, paths: 0, shapeOk: false })).toBe("on")
    expect(interpretToggleIcon({ dataState: "unchecked", circles: 1, paths: 1, shapeOk: true })).toBe("off")
    expect(interpretToggleIcon({ dataState: "on", circles: 0, paths: 0, shapeOk: true })).toBe("on")
    expect(interpretToggleIcon({ dataState: "off", circles: 0, paths: 0, shapeOk: true })).toBe("off")
  })

  test("check-mark icon means on and bare circle means off", () => {
    expect(interpretToggleIcon({ circles: 1, paths: 1, shapeOk: true })).toBe("on")
    expect(interpretToggleIcon({ circles: 0, paths: 1, shapeOk: true })).toBe("on")
    expect(interpretToggleIcon({ circles: 1, paths: 0, shapeOk: true })).toBe("off")
  })

  test("stays unknown without any signal", () => {
    expect(interpretToggleIcon({ circles: 0, paths: 0, shapeOk: false })).toBe("unknown")
    expect(interpretToggleIcon({ temporaryUrl: null, circles: 0, paths: 0, shapeOk: false })).toBe("unknown")
  })
})

describe("settled response", () => {
  test("settled requires complete, settled, and non-empty text", () => {
    expect(isSettledResponse({ complete: true, settled: true, text: "answer" })).toBe(true)
    expect(isSettledResponse({ complete: false, settled: true, text: "answer" })).toBe(false)
    expect(isSettledResponse({ complete: true, settled: false, text: "answer" })).toBe(false)
    expect(isSettledResponse({ complete: true, settled: true, text: "" })).toBe(false)
    expect(isSettledResponse({ complete: true, settled: true, text: "   " })).toBe(false)
  })
})

describe("thinking segments", () => {
  test("thinking null/undefined/empty yields no segments", () => {
    expect(extractThinkingSegments(null)).toEqual([])
    expect(extractThinkingSegments(undefined)).toEqual([])
    expect(extractThinkingSegments([])).toEqual([])
  })

  test("thinking trims fields and drops segments with empty body", () => {
    expect(
      extractThinkingSegments([
        { title: "  Considering tool orchestration  ", body: "  paragraph  " },
        { title: "empty", body: "   " },
        { title: "", body: "" },
      ]),
    ).toEqual([{ title: "Considering tool orchestration", body: "paragraph" }])
  })

  test("thinking preserves order of multiple segments", () => {
    expect(
      extractThinkingSegments([
        { title: "first", body: "one" },
        { title: "second", body: "two" },
        { title: "third", body: "three" },
      ]),
    ).toEqual([
      { title: "first", body: "one" },
      { title: "second", body: "two" },
      { title: "third", body: "three" },
    ])
  })

  test("thinking caps segments and field lengths", () => {
    const input = Array.from({ length: 10 }, (_, index) => ({
      title: `t${index} ${"x".repeat(300)}`,
      body: `b${index} ${"y".repeat(3000)}`,
    }))
    const result = extractThinkingSegments(input)
    expect(result).toHaveLength(8)
    expect(result[0]!.title.length).toBeLessThanOrEqual(200)
    expect(result[0]!.body.length).toBeLessThanOrEqual(2000)
  })

  test("thinking equality compares ordered title and body", () => {
    const first = [{ title: "a", body: "one" }]
    expect(sameThinkingSegments(first, [{ title: "a", body: "one" }])).toBe(true)
    expect(sameThinkingSegments(first, [{ title: "a", body: "two" }])).toBe(false)
    expect(sameThinkingSegments(first, [])).toBe(false)
    expect(
      sameThinkingSegments(
        [
          { title: "a", body: "one" },
          { title: "b", body: "two" },
        ],
        [
          { title: "b", body: "two" },
          { title: "a", body: "one" },
        ],
      ),
    ).toBe(false)
  })

  test("thinking format prefers title plus body and falls back to body", () => {
    expect(formatThinkingSegment({ title: "Considering", body: "paragraph" })).toBe("Considering\nparagraph")
    expect(formatThinkingSegment({ title: "", body: "paragraph" })).toBe("paragraph")
  })
})

describe("attachment staged upload", () => {
  test("attachment file input uploads via plus-button without premature submit click", async () => {
    const calls: string[] = []
    const fakePage = {
      locator: (selector: string) => ({
        first: () => ({
          setInputFiles: async (paths: string | readonly string[]) =>
            void calls.push(`files:${selector}:${Array.isArray(paths) ? paths.join(",") : paths}`),
          click: async () => void calls.push(`click:${selector}`),
        }),
      }),
    }
    await uploadStagedFiles(fakePage, [{ path: "/tmp/aipass-a.txt" }])
    expect(calls.some((call) => call.startsWith("files:input"))).toBe(true)
    expect(calls.findIndex((call) => call.includes("ttach") || call.includes("lus"))).toBeGreaterThanOrEqual(0)
    expect(calls.findIndex((call) => call.includes("dropdown-menu-item"))).toBeGreaterThan(0)
    expect(calls.findIndex((call) => call.startsWith("files:"))).toBeGreaterThan(
      calls.findIndex((call) => call.includes("dropdown-menu-item")),
    )
    expect(calls.some((call) => call.includes("send"))).toBe(false)
    await uploadStagedFiles(fakePage, [])
    expect(calls).toHaveLength(3)
  })

  test("attachment upload targets dropdown-menu data-slot trigger and items", async () => {
    const calls: string[] = []
    const fakePage = {
      locator: (selector: string) => ({
        first: () => ({
          setInputFiles: async (paths: string | readonly string[]) =>
            void calls.push(`files:${selector}:${Array.isArray(paths) ? paths.join(",") : paths}`),
          click: async () => void calls.push(`click:${selector}`),
        }),
      }),
    }
    await uploadStagedFiles(fakePage, [{ path: "/tmp/aipass-a.txt" }])
    // Ordered candidates: first successful candidate wins, so the fake page
    // (which never throws) records the exact EN label first.
    expect(calls[0]).toContain('data-slot="dropdown-menu-trigger"')
    expect(calls[0]).toContain("Attach")
    expect(calls[1]).toContain('data-slot="dropdown-menu-item"')
    expect(calls[1]).toContain("Upload File or Image")
    expect(calls[2]).toContain("files:input")
  })

  test("attachment upload falls back through ordered candidates including Thai label", async () => {
    const calls: string[] = []
    const failing = new Set([
      'button[data-slot="dropdown-menu-trigger"][aria-label*="Attach" i]',
      '[data-slot="dropdown-menu-item"]:has-text("Upload File or Image")',
    ])
    const fakePage = {
      locator: (selector: string) => ({
        first: () => ({
          setInputFiles: async (paths: string | readonly string[]) =>
            void calls.push(`files:${selector}:${Array.isArray(paths) ? paths.join(",") : paths}`),
          click: async () => {
            void calls.push(`click:${selector}`)
            if (failing.has(selector)) throw new Error("not found")
          },
        }),
      }),
    }
    await uploadStagedFiles(fakePage, [{ path: "/tmp/aipass-a.txt" }])
    // Attach candidate missed, so the Upload-labeled trigger wins.
    expect(calls.some((call) => call.includes("Upload") && call.includes("dropdown-menu-trigger"))).toBe(true)
    // Exact EN menu label missed, so the Thai label wins.
    expect(calls.some((call) => call.includes("อัปโหลดไฟล์หรือรูป"))).toBe(true)
    expect(calls.some((call) => call.startsWith("files:input"))).toBe(true)
  })

  test("attachment upload polls the DOM menu until it renders", async () => {
    const calls: string[] = []
    const evaluated: string[] = []
    let menuCalls = 0
    const fakePage = {
      locator: (selector: string) => ({
        first: () => ({
          setInputFiles: async (paths: string | readonly string[]) =>
            void calls.push(`files:${selector}:${Array.isArray(paths) ? paths.join(",") : paths}`),
          click: async () => {
            void calls.push(`click:${selector}`)
            throw new Error("no locator clicks expected")
          },
        }),
      }),
      evaluate: async (fn: unknown) => {
        const name = typeof fn === "function" ? (fn as { name?: string }).name ?? "" : ""
        evaluated.push(name || "anon")
        if (name === "clickUploadTriggerDom") return true
        if (name === "clickUploadMenuItemDom") {
          menuCalls += 1
          return menuCalls >= 3
        }
        return null
      },
      waitForEvent: async () => ({
        setFiles: async (files: string | readonly string[]) =>
          void calls.push(`chooser:${Array.isArray(files) ? files.join(",") : files}`),
      }),
    }
    await uploadStagedFiles(fakePage, [{ path: "/tmp/aipass-a.txt" }])
    expect(menuCalls).toBeGreaterThanOrEqual(3)
    expect(calls.some((call) => call === "chooser:/tmp/aipass-a.txt")).toBe(true)
    expect(calls.some((call) => call.startsWith("click:"))).toBe(false)
    expect(calls.some((call) => call.startsWith("files:input"))).toBe(true)
    // Dismiss-menu Escape is dispatched on success too.
    expect(evaluated.some((name) => name === "anon")).toBe(true)
  })

  test("attachment upload falls back to direct hidden input when the menu never matches", async () => {
    const calls: string[] = []
    const errors: string[] = []
    const original = console.error
    console.error = (...values: unknown[]) => void errors.push(values.map(String).join(" "))
    try {
      const fakePage = {
        locator: (selector: string) => ({
          first: () => ({
            setInputFiles: async (paths: string | readonly string[]) =>
              void calls.push(`files:${selector}:${Array.isArray(paths) ? paths.join(",") : paths}`),
            click: async () => {
              void calls.push(`click:${selector}`)
              throw new Error("no menu")
            },
          }),
        }),
        evaluate: async (fn: unknown) => {
          const name = typeof fn === "function" ? (fn as { name?: string }).name ?? "" : ""
          if (name === "clickUploadTriggerDom") return true
          return null
        },
      }
      await uploadStagedFiles(fakePage, [{ path: "/tmp/aipass-a.txt" }])
    } finally {
      console.error = original
    }
    expect(calls.some((call) => call.startsWith("files:input"))).toBe(true)
    expect(errors.some((line) => line.includes("aipass upload direct input fallback"))).toBe(true)
  })

  test("attachment upload with filechooser falls back to direct input when menu never renders", async () => {
    const calls: string[] = []
    const fakePage = {
      locator: (selector: string) => ({
        first: () => ({
          setInputFiles: async (paths: string | readonly string[]) =>
            void calls.push(`files:${selector}:${Array.isArray(paths) ? paths.join(",") : paths}`),
          click: async () => {
            void calls.push(`click:${selector}`)
            throw new Error("no menu")
          },
        }),
      }),
      evaluate: async (fn: unknown) => {
        const name = typeof fn === "function" ? (fn as { name?: string }).name ?? "" : ""
        if (name === "clickUploadTriggerDom") return true
        return null
      },
      waitForEvent: async () => ({
        setFiles: async (files: string | readonly string[]) =>
          void calls.push(`chooser:${Array.isArray(files) ? files.join(",") : files}`),
      }),
    }
    await uploadStagedFiles(fakePage, [{ path: "/tmp/aipass-a.txt" }])
    expect(calls.some((call) => call.startsWith("files:input"))).toBe(true)
  })

  test("attachment upload throws when no candidate matches", async () => {
    const deadPage = {
      locator: () => ({
        first: () => ({
          setInputFiles: async () => {
            throw new Error("no input")
          },
          click: async () => {
            throw new Error("not found")
          },
        }),
      }),
    }
    await expect(uploadStagedFiles(deadPage, [{ path: "/tmp/aipass-a.txt" }])).rejects.toThrow()
  })

  test("attachment upload prefers DOM trigger and menu clicks with filechooser", async () => {
    const calls: string[] = []
    const evaluated: number[] = []
    const queue: Array<string | null> = ["trigger:button[attach]", "menu:Upload File or Image"]
    const fakePage = {
      locator: (selector: string) => ({
        first: () => ({
          setInputFiles: async (paths: string | readonly string[]) =>
            void calls.push(`files:${selector}:${Array.isArray(paths) ? paths.join(",") : paths}`),
          click: async () => void calls.push(`click:${selector}`),
        }),
      }),
      evaluate: async () => {
        evaluated.push(1)
        return queue.shift() ?? null
      },
      waitForEvent: async () => ({
        setFiles: async (files: string | readonly string[]) =>
          void calls.push(`chooser:${Array.isArray(files) ? files.join(",") : files}`),
      }),
    }
    await uploadStagedFiles(fakePage, [{ path: "/tmp/aipass-a.txt" }])
    expect(evaluated.length).toBeGreaterThanOrEqual(2)
    expect(calls.some((call) => call === "chooser:/tmp/aipass-a.txt")).toBe(true)
    expect(calls.some((call) => call.startsWith("click:"))).toBe(false)
  })

  test("attachment upload logs structure-only fingerprint on total failure", async () => {
    const errors: string[] = []
    const original = console.error
    console.error = (...values: unknown[]) => void errors.push(values.map(String).join(" "))
    try {
      const deadPage = {
        locator: () => ({
          first: () => ({
            setInputFiles: async () => undefined,
            click: async () => {
              throw new Error("not found")
            },
          }),
        }),
        evaluate: async () => null,
      }
      await expect(uploadStagedFiles(deadPage, [{ path: "/tmp/aipass-a.txt" }])).rejects.toThrow()
    } finally {
      console.error = original
    }
    expect(errors.some((line) => line.includes("aipass upload fingerprint"))).toBe(true)
  })

  test("attachment staging writes safe basenames and cleanup removes tmp dir", async () => {
    expect(safeAttachmentBasename("../../etc/passwd", 0)).not.toContain("/")
    const payload = Buffer.from("hello-attachment").toString("base64")
    const staged = await stageAttachments([{ kind: "file", data: payload, filename: "../../evil.txt" }])
    expect(staged.dir).toBeString()
    expect(staged.files).toHaveLength(1)
    await expect(stageAttachments([{ kind: "file", data: "A".repeat(15_000_001), filename: "big.bin" }])).rejects.toThrow(
      /too large/i,
    )
    await cleanupStagedFiles(staged.dir)
    await expect(Bun.file(`${staged.dir}`).exists()).resolves.toBe(false)
  })

  test("attachment upload failure stays fail-open with guaranteed tmp cleanup", async () => {
    const payload = Buffer.from("hello-attachment").toString("base64")
    const staged = await stageAttachments([{ kind: "file", data: payload, filename: "a.txt" }])
    const failingPage = {
      locator: () => ({
        first: () => ({
          click: async () => undefined,
          setInputFiles: async () => {
            throw new Error("upload unavailable")
          },
        }),
      }),
    }
    let failed = false
    try {
      try {
        await uploadStagedFiles(failingPage, staged.files)
      } catch {
        failed = true
      }
    } finally {
      await cleanupStagedFiles(staged.dir).catch(() => undefined)
    }
    expect(failed).toBe(true)
    await expect(Bun.file(`${staged.dir}`).exists()).resolves.toBe(false)
  })
})

describe("step screenshots", () => {
  test("screenshot with undefined dir is a no-op", async () => {
    let calls = 0
    const fakePage = {
      screenshot: async () => {
        calls++
      },
    }
    expect(await captureStepScreenshot(fakePage, undefined, "submit")).toBeUndefined()
    expect(calls).toBe(0)
  })

  test("screenshot with empty dir is a no-op", async () => {
    let calls = 0
    const fakePage = {
      screenshot: async () => {
        calls++
      },
    }
    expect(await captureStepScreenshot(fakePage, "   ", "submit")).toBeUndefined()
    expect(calls).toBe(0)
  })

  test("screenshot with dir set writes one PNG and logs step plus path", async () => {
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const parent = await mkdtemp(join(tmpdir(), "aipass-shot-"))
    try {
      const dir = join(parent, "shots")
      let screenshotOptions: unknown
      const fakePage = {
        screenshot: async (options?: { readonly path?: string }) => {
          screenshotOptions = options
          await Bun.write(options!.path!, "fake-png")
        },
      }
      const errors: string[] = []
      const original = console.error
      console.error = (...values: unknown[]) => void errors.push(values.map(String).join(" "))
      let path: string | undefined
      try {
        path = await captureStepScreenshot(fakePage, dir, "submit")
      } finally {
        console.error = original
      }
      expect(path).toBeString()
      expect(path!.endsWith(".png")).toBe(true)
      expect(path!.startsWith(dir)).toBe(true)
      expect(screenshotOptions).toMatchObject({ path })
      await expect(Bun.file(path!).exists()).resolves.toBe(true)
      expect(errors.some((line) => line === `aipass screenshot step=submit path=${path}`)).toBe(true)
    } finally {
      const { rm } = await import("node:fs/promises")
      await rm(parent, { recursive: true, force: true })
    }
  })

  test("screenshot throw stays fail-open and still logs", async () => {
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkdtemp(join(tmpdir(), "aipass-shot-"))
    try {
      const fakePage = {
        screenshot: async () => {
          throw new Error("screenshot unavailable")
        },
      }
      const errors: string[] = []
      const original = console.error
      console.error = (...values: unknown[]) => void errors.push(values.map(String).join(" "))
      let path: string | undefined
      try {
        path = await captureStepScreenshot(fakePage, dir, "submit")
      } finally {
        console.error = original
      }
      expect(path).toBeUndefined()
      expect(errors.some((line) => line.includes("aipass screenshot") && line.includes("step=submit"))).toBe(true)
    } finally {
      const { rm } = await import("node:fs/promises")
      await rm(dir, { recursive: true, force: true })
    }
  })
})
