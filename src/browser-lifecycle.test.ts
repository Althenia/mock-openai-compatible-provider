import { expect, spyOn, test } from "bun:test"
import { EventEmitter } from "node:events"
import { chromium, errors, type BrowserContext, type Page } from "playwright-core"
import {
  ensureTempChat, selectModel, PlaywrightBrowserAdapter, PlaywrightTempChatSurface,
  type AttemptLifecycle, type BrowserProtocol, type BrowserTurnInput, type ModelSelectionSurface, type TempChatControl, type TempChatSurface,
} from "./browser.ts"
import { StreamFrameParser, type BrowserFrame } from "./protocol.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

const pending = Symbol("pending")
async function within<T>(work: Promise<T>, timeoutMs = 200) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<typeof pending>(resolve => { timer = setTimeout(() => resolve(pending), timeoutMs) })])
  } finally { clearTimeout(timer) }
}

for (const stage of ["lookup", "state", "click", "verify"] as const) {
  test(`temporary chat cancellation stops at ${stage} without starting later actions`, async () => {
    const entered = deferred<void>(), resume = deferred<void>()
    const calls: string[] = []
    const visit = async (name: string) => {
      calls.push(name)
      if (name === stage) { entered.resolve(); await resume.promise }
    }
    let reads = 0
    const control: TempChatControl = {
      async state() { const first = reads++ === 0; await visit(first ? "state" : "verify"); return first ? "off" : "on" },
      async click() { await visit("click") },
    }
    const surface: TempChatSurface = { async control() { await visit("lookup"); return control } }
    const abort = new AbortController()
    const options = { timeoutMs: 1000, signal: abort.signal }
    const work = ensureTempChat(surface, options).then(value => ({ value }), error => ({ name: error.name }))
    try {
      await entered.promise
      abort.abort()
      expect(await within(work)).toEqual({ name: "AbortError" })
      const before = [...calls]
      resume.resolve()
      await work
      await Promise.resolve()
      expect(calls).toEqual(before)
    } finally { resume.resolve(); await work }
  })
}

test("temporary chat does not start discovery for an already cancelled turn", async () => {
  let lookups = 0
  const abort = new AbortController()
  abort.abort()
  const options = { timeoutMs: 1000, signal: abort.signal }
  await expect(ensureTempChat({ async control() { lookups++; return undefined } }, options)).rejects.toMatchObject({ name: "AbortError" })
  expect(lookups).toBe(0)
})

test("temporary chat keeps its deadline and fail-open result when discovery never settles", async () => {
  const lookup = deferred<TempChatControl | undefined>()
  const work = ensureTempChat({ control: () => lookup.promise }, { timeoutMs: 10 })
  try { expect(await within(work)).toBe("unavailable") }
  finally { lookup.resolve(undefined); await work }
})

test("missing temporary-chat controls do not trigger timeout-free diagnostic counts", async () => {
  let counts = 0
  const locator = {
    first() { return this },
    async waitFor() { throw Error("fixture control absent") },
    async count() { counts++; return 0 },
  }
  const page = { getByRole: () => locator } as unknown as Page
  expect(await new PlaywrightTempChatSurface(page).control(100)).toBeUndefined()
  expect(counts).toBe(0)
})

const idleModelSurface: ModelSelectionSurface = {
  async open() {}, async expand() {}, async processingLevel() { return "none" },
  async openProcessing() {}, async chooseProcessing() {}, async verifyProcessing() {},
  async confirm() {}, async select() {}, async waitClosed() {},
}

for (const stage of ["open", "expand", "value", "dialog", "level", "verification", "confirm", "select", "closed"] as const) {
  test(`model selection cancellation reaches native ${stage} work and never starts a later action`, async () => {
    const entered = deferred<void>(), resume = deferred<void>()
    const calls: string[] = []
    let nativeSignal: AbortSignal | undefined
    const visit = async (name: string, signal?: AbortSignal) => {
      calls.push(name)
      if (name === stage) { nativeSignal = signal; entered.resolve(); await resume.promise }
      if (signal?.aborted) throw new DOMException("fixture cancelled", "AbortError")
    }
    const surface: ModelSelectionSurface = {
      async open(_name, _timeout, signal?: AbortSignal) { await visit("open", signal) },
      async expand(_name, _timeout, signal?: AbortSignal) { await visit("expand", signal) },
      async processingLevel(_name, _timeout, signal?: AbortSignal) { await visit("value", signal); return "none" },
      async openProcessing(_name, _timeout, signal?: AbortSignal) { await visit("dialog", signal) },
      async chooseProcessing(_name, _level, _timeout, signal?: AbortSignal) { await visit("level", signal) },
      async verifyProcessing(_name, _level, _timeout, signal?: AbortSignal) { await visit("verification", signal) },
      async confirm(_name, _timeout, signal?: AbortSignal) { await visit("confirm", signal) },
      async select(_name, _timeout, signal?: AbortSignal) { await visit("select", signal) },
      async waitClosed(_name, _timeout, signal?: AbortSignal) { await visit("closed", signal) },
    }
    const abort = new AbortController()
    const options = { timeoutMs: 1000, signal: abort.signal }
    const work = selectModel(surface, { id: "fixture", name: "Fixture", thinking: stage === "select" ? [] : ["low"], reasoning: stage === "select" ? "none" : "low" }, options)
      .then(() => ({ done: true }), error => ({ name: error.name }))
    try {
      await entered.promise
      abort.abort()
      expect(await within(work)).toEqual({ name: "AbortError" })
      expect(nativeSignal?.aborted).toBe(true)
      const before = [...calls]
      resume.resolve()
      await work
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(calls).toEqual(before)
    } finally { abort.abort(); resume.resolve(); await work }
  })
}

test("model selection does not open controls for a pre-cancelled turn", async () => {
  let opens = 0
  const surface: ModelSelectionSurface = {
    ...idleModelSurface, async open() { opens++ },
  }
  const options = { signal: AbortSignal.abort() }
  await expect(selectModel(surface, { id: "fixture", name: "Fixture", thinking: [], reasoning: "none" }, options))
    .rejects.toMatchObject({ name: "AbortError" })
  expect(opens).toBe(0)
})

test("model selection deadline aborts the underlying operation and prevents late selection", async () => {
  const resume = deferred<void>()
  let nativeSignal: AbortSignal | undefined, later = 0
  const surface: ModelSelectionSurface = {
    ...idleModelSurface,
    async open(_name, _timeout, signal?: AbortSignal) { nativeSignal = signal; await resume.promise },
    async select() { later++ },
  }
  const work = selectModel(surface, { id: "fixture", name: "Fixture", thinking: [], reasoning: "none" }, { timeoutMs: 20 })
    .then(() => ({ done: true }), error => ({ message: error.message }))
  try {
    expect(await within(work)).toMatchObject({ message: expect.stringContaining("selection deadline") })
    expect(nativeSignal?.aborted).toBe(true)
    resume.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(later).toBe(0)
  } finally { resume.resolve(); await work }
})

test("synchronous cancellation at model-operation admission still observes its rejection", async () => {
  const abort = new AbortController()
  const unhandled: unknown[] = []
  const record = (error: unknown) => { unhandled.push(error) }
  process.on("unhandledRejection", record)
  const surface: ModelSelectionSurface = {
    ...idleModelSurface,
    async open() { abort.abort(); throw Error("fixture operation rejected after cancellation") },
  }
  try {
    await expect(selectModel(surface, { id: "fixture", name: "Fixture", thinking: [], reasoning: "none" }, { signal: abort.signal }))
      .rejects.toMatchObject({ name: "AbortError" })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(unhandled).toEqual([])
  } finally { process.removeListener("unhandledRejection", record) }
})

const answer = '<aipass-envelope>{"type":"chat","text":"ready"}</aipass-envelope>'
type Stage = "lookup" | "arm" | "click" | "capture" | "priming" | "cleanup" | "complete" |
  "new-page" | "binding" | "init-script" | "navigation" | "authentication" | "auth-ready" |
  "temp-geometry" | "temp-shape" | "temp-fingerprint" | "temp-url" |
  "model-open" | "model-controls" | "model-click" | "prompt-ready" | "prompt-fill" | "baseline"

class FixturePage extends EventEmitter {
  readonly setupStarted = deferred<void>()
  readonly setupReady = deferred<void>()
  readonly setupSettled = deferred<void>()
  nativeSetupAborted = false
  evaluationUncancellable = false
  lateMutations = 0
  initCalls = 0
  authWaits = 0
  readonly lookupStarted = deferred<void>()
  readonly lookup = deferred<void>()
  readonly armStarted = deferred<void>()
  readonly arm = deferred<void>()
  readonly clickStarted = deferred<void>()
  readonly clickReady = deferred<void>()
  readonly submitted = deferred<void>()
  readonly cleanupStarted = deferred<void>()
  readonly cleanup = deferred<void>()
  readonly closeStarted = deferred<void>()
  readonly closure = deferred<void>()
  closeCalls = 0
  sendCalls = 0
  clickAborted = false
  closed = false
  private address = "about:blank"
  private generation = ""
  private binding?: (source: unknown, value: unknown) => void | Promise<void>

  constructor(readonly stage: Stage, readonly closeMode: "pending" | "reject" | "complete" = "pending") { super() }
  url() { return this.address }
  async hold(stage: Stage, signal?: AbortSignal) {
    if (this.stage !== stage) return
    this.setupStarted.resolve()
    try {
      await this.setupReady.promise
      if (signal?.aborted) { this.nativeSetupAborted = true; throw new DOMException("fixture native setup cancelled", "AbortError") }
      this.lateMutations++
    } finally { this.setupSettled.resolve() }
  }
  async goto(address: string, options?: { signal?: AbortSignal }) { await this.hold("navigation", options?.signal); this.address = address }
  isClosed() { return this.closed }
  getByRole(role: string) {
    if (this.stage.startsWith("temp-")) {
      if (role === "checkbox" || role === "switch") return new FixtureLocator(this, "absent")
      if (role === "button") return new FixtureLocator(this, this.stage === "temp-fingerprint" ? "temp-button" : "absent")
      if (role === "link") return new FixtureLocator(this, "new-link")
    }
    return new FixtureLocator(this, role === "checkbox" ? "temp" : role === "dialog" ? "dialog" : "model")
  }
  getByTestId() { return new FixtureLocator(this, "dialog") }
  getByText() { return new FixtureLocator(this, "model") }
  locator(selector: string) { return new FixtureLocator(this, selector) }
  async exposeBinding(_name: string, binding: (source: unknown, value: unknown) => void | Promise<void>) { await this.hold("binding"); this.binding = binding }
  async addInitScript() { this.initCalls++; await this.hold("init-script") }
  async evaluate(_script: unknown, value?: unknown) {
    if (typeof value === "object" && value !== null && "armKey" in value) {
      if ("value" in value) {
        this.cleanupStarted.resolve()
        if (this.stage === "cleanup" || this.stage === "priming" || this.stage === "arm") await this.cleanup.promise
      } else if ("generation" in value) {
        this.armStarted.resolve()
        if (this.stage === "arm") await this.arm.promise
        this.generation = String(value.generation)
      }
      return undefined
    }
    await this.hold("baseline")
    return 0
  }
  async send() {
    this.sendCalls++
    this.submitted.resolve()
    if (this.stage === "cleanup" || this.stage === "complete") await this.reply()
  }
  async reply() {
    const source = { generation: this.generation, responseID: 1 }
    await this.binding?.({}, { ...source, type: "response", selected: true, matched: true, bodyPresent: true, contentType: "sse" })
    await this.binding?.({}, { ...source, type: "chunk", chunk: `data: ${JSON.stringify({ type: "text", delta: answer })}\n\ndata: [DONE]\n\n` })
    await this.binding?.({}, { ...source, type: "finish" })
  }
  observeClose() {
    if (!this.closed) { this.closed = true; this.emit("close") }
  }
  finishClose() {
    this.observeClose()
    this.closure.resolve()
  }
  async close() {
    this.closeCalls++
    this.closeStarted.resolve()
    if (this.closeMode === "reject") throw Error("fixture close failure")
    if (this.closeMode === "complete") this.finishClose()
    await this.closure.promise
  }
}

class FixtureLocator {
  private evaluations = 0
  constructor(private readonly page: FixturePage, private readonly kind: string, private readonly index = 0) {}
  first() { return this }
  last() { return new FixtureLocator(this.page, this.kind) }
  nth(index: number) { return new FixtureLocator(this.page, this.kind, index) }
  filter() { return this }
  locator() { return this.kind === "new-link" ? new FixtureLocator(this.page, "toggle-link") : this }
  getByRole() { return this.kind === "dialog" ? new FixtureLocator(this.page, "model") : this }
  getByText() { return new FixtureLocator(this.page, "model") }
  async count() { await this.page.hold("model-controls"); return 1 }
  async isChecked() { return true }
  async getAttribute() { return null }
  async boundingBox() {
    if (this.kind === "toggle-link") await this.page.hold("temp-geometry")
    return { x: 0, y: 0, width: 20, height: 20 }
  }
  async isVisible() { await this.page.hold("authentication"); return false }
  async fill(_value: string, options?: { signal?: AbortSignal }) { await this.page.hold("prompt-fill", options?.signal) }
  async evaluate(_script: unknown, argument?: unknown, options?: { signal?: AbortSignal }) {
    if (this.kind === "temp-button") { await this.page.hold("temp-fingerprint"); return null }
    if (this.kind === "toggle-link") {
      const shape = this.evaluations++ === 0
      await this.page.hold(shape ? "temp-shape" : "temp-url")
      return shape ? { temporaryUrl: false, circles: 1, paths: 0 } : false
    }
    if (this.kind === "body") {
      await this.page.hold(typeof argument === "string" ? "authentication" : "baseline", this.page.evaluationUncancellable ? undefined : options?.signal)
      return typeof argument === "string" ? false : 0
    }
    // Playwright's JSHandle evaluation ignores signal after locator resolution.
    await this.page.hold(argument === undefined ? "model-click" : "model-controls")
    return 1
  }
  async waitFor(options?: { signal?: AbortSignal }) {
    if (this.kind === "absent") throw new errors.TimeoutError("fixture optional control absent")
    if (this.kind === "model") {
      await this.page.hold("model-controls", options?.signal)
      if (this.index > 0) throw new errors.TimeoutError("fixture optional control absent")
    }
    if (this.kind === "#prompt") await this.page.hold(this.page.authWaits++ === 0 ? "auth-ready" : "prompt-ready", options?.signal)
    if (this.kind === "temp" && this.page.stage === "lookup") {
      this.page.lookupStarted.resolve()
      await this.page.lookup.promise
    }
  }
  async click(options?: { signal?: AbortSignal }) {
    if (this.kind === "model") {
      await this.page.hold("model-controls", options?.signal)
      await this.page.hold("model-click", options?.signal)
    }
    if (this.kind === "#model") await this.page.hold("model-open", options?.signal)
    if (this.kind !== "#send") return
    if (this.page.stage === "click") {
      this.page.clickStarted.resolve()
      await this.page.clickReady.promise
      if (options?.signal?.aborted) {
        this.page.clickAborted = true
        throw new DOMException("fixture native click cancelled", "AbortError")
      }
    }
    await this.page.send()
  }
}

const protocol: BrowserProtocol<BrowserFrame> = {
  decoder: () => new StreamFrameParser(), text: delta => ({ type: "text", delta }),
  finish: reason => ({ type: "finish", reason }), isTerminal: frame => frame.type === "finish",
}
const turn: BrowserTurnInput = {
  sessionMarker: "lifecycle-fixture", ephemeral: false, primingPrompts: [],
  model: { id: "fixture", name: "Fixture", thinking: [] }, reasoning: "none",
  initialPrompt: "Reply ready.", incrementalPrompt: "Reply ready.", recoveryPrompt: "Reply ready.",
  promptContractVersion: 0, actionEnvelopeDigest: "fixture", toolContinuation: false,
}

for (const stage of ["lookup", "arm", "capture", "priming", "cleanup"] as const) {
  for (const closeMode of ["pending", "reject"] as const) {
    test(`cancelled ${stage} owns ${closeMode} teardown and fails closed until it fully settles`, async () => {
      const failed = new FixturePage(stage, closeMode)
      const fresh = new FixturePage("complete", "complete")
      const created: FixturePage[] = []
      let completed = 0, discarded = 0
      const failures: Array<Parameters<AttemptLifecycle["fail"]>[1]> = []
      const lifecycle: AttemptLifecycle = {
        async binding() { return undefined }, async prepare(input) { return { id: "fixture", promptHash: input.promptHash } },
        async pending() {}, async bind() {}, async complete() { completed++ }, async discard() { discarded++ },
        async fail(_attempt, outcome) { failures.push(outcome) },
      }
      const context = {
        async newPage() { const page = created.length ? fresh : failed; created.push(page); return page },
        async close() { for (const page of created) { page.lookup.resolve(); page.arm.resolve(); page.cleanup.resolve(); page.finishClose() } },
      }
      const launch = spyOn(chromium, "launchPersistentContext").mockResolvedValue(context as unknown as BrowserContext)
      const adapter = await PlaywrightBrowserAdapter.launch({
        profilePath: "unused-fixture-profile", executablePath: "unused-fixture-browser", chatURL: "https://fixture.test/chat",
        navigationTimeoutMs: 1000, streamIdleTimeoutMs: 1000,
        selectors: { promptInput: "#prompt", sendButton: "#send", modelLoader: "#model" },
      }, lifecycle, protocol)
      const abort = new AbortController()
      const frames: BrowserFrame[] = []
      const input = { ...turn, ephemeral: true, primingPrompts: stage === "priming" ? ["Fixture context."] : [] }
      const work = (async () => { for await (const frame of adapter.turn(input, abort.signal)) frames.push(frame) })()
        .then(() => ({ done: true }), error => ({ name: error.name }))
      const collect = async (signal?: AbortSignal) => {
        const result: BrowserFrame[] = []
        for await (const frame of adapter.turn(turn, signal)) result.push(frame)
        return result
      }
      try {
        await (stage === "lookup" ? failed.lookupStarted.promise : stage === "arm" ? failed.armStarted.promise : stage === "cleanup" ? failed.cleanupStarted.promise : failed.submitted.promise)
        if (stage === "capture" || stage === "priming") await new Promise<void>(resolve => setImmediate(resolve))
        abort.abort()
        expect(await within(work)).toEqual({ name: "AbortError" })
        expect(discarded).toBe(1)
        expect(failed.closeCalls).toBe(1)
        expect(failures).toEqual(stage === "cleanup" ? [] : [{ possiblySubmitted: stage === "capture", cancelled: true, definitive: false }])
        const before = [...frames]
        failed.lookup.resolve()
        await failed.reply()
        expect(frames).toEqual(before)
        expect(failed.sendCalls).toBe(stage === "lookup" || stage === "arm" ? 0 : 1)
        const cancelled = new AbortController(); cancelled.abort()
        await expect(collect(cancelled.signal)).rejects.toMatchObject({ name: "AbortError" })
        await expect(collect()).rejects.toThrow("cleanup")
        expect(created).toEqual([failed])
        failed.observeClose()
        if (closeMode === "pending") await expect(collect()).rejects.toThrow("cleanup")
        failed.finishClose()
        if (stage === "cleanup" || stage === "priming" || stage === "arm") {
          await expect(collect()).rejects.toThrow("cleanup")
          failed.arm.resolve()
          expect(await within(failed.cleanupStarted.promise)).toBeUndefined()
          await expect(collect()).rejects.toThrow("cleanup")
          failed.cleanup.resolve()
        }
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(await collect()).toEqual([{ type: "text", delta: answer }, { type: "finish", reason: "stop" }])
        expect(created).toEqual([failed, fresh])
        expect(completed).toBe(stage === "cleanup" ? 2 : 1)
        expect(failed.closeCalls).toBe(1)
      } finally {
        abort.abort(); failed.lookup.resolve(); failed.arm.resolve(); failed.cleanup.resolve(); failed.finishClose()
        await work
        await adapter.close()
        launch.mockRestore()
      }
    })
  }
}

async function launchFixture(pages: FixturePage[], overrides: Partial<AttemptLifecycle> = {}, connection?: unknown) {
  const created: FixturePage[] = []
  let contextCloses = 0
  const context = {
    _connection: connection,
    async newPage() {
      const page = pages[created.length]
      if (!page) throw Error("unexpected fixture page creation")
      created.push(page)
      await page.hold("new-page")
      return page
    },
    async close() { contextCloses++; for (const page of created) page.finishClose() },
  }
  const lifecycle: AttemptLifecycle = {
    async binding() { return undefined }, async prepare(input) { return { id: "fixture", promptHash: input.promptHash } },
    async pending() {}, async bind() {}, async complete() {}, async fail() {}, async discard() {}, ...overrides,
  }
  const launch = spyOn(chromium, "launchPersistentContext").mockResolvedValue(context as unknown as BrowserContext)
  const adapter = await PlaywrightBrowserAdapter.launch({
    profilePath: "unused-fixture-profile", executablePath: "unused-fixture-browser", chatURL: "https://fixture.test/chat",
    navigationTimeoutMs: 1000, streamIdleTimeoutMs: 1000,
    selectors: { promptInput: "#prompt", sendButton: "#send", modelLoader: "#model" },
  }, lifecycle, protocol)
  const collect = async (input = turn, signal?: AbortSignal) => {
    const frames: BrowserFrame[] = []
    for await (const frame of adapter.turn(input, signal)) frames.push(frame)
    return frames
  }
  return { adapter, collect, created, contextCloses: () => contextCloses, restore: () => launch.mockRestore() }
}

test("failure diagnostics capture bounded API/CDP metadata at cancellation before teardown", async () => {
  const sensitive = "fixture-sensitive-marker"
  const callbacks = new Map(Array.from({ length: 40 }, (_, id) => [id, {
    type: "Frame", method: "evaluateExpression", params: sensitive, error: { method: "Runtime.callFunctionOn", message: sensitive },
  }]))
  const progress = new Map([["fixture", {
    metadata: { type: "Frame", method: "evaluateExpression", timeout: 1000, startTime: 1, params: sensitive },
    _state: "running", _controller: new AbortController(),
  }]])
  const browser = { _connection: {
    _closed: false, _sessions: new Map([["fixture", { _closed: false, _crashed: false, _callbacks: callbacks }]]),
    _transport: { _pendingBuffers: [new Uint8Array(3)], _pipeRead: { readable: true, readableLength: 2, destroyed: false }, _pipeWrite: { writable: true, writableLength: 1, destroyed: false } },
  } }
  const connection = {
    _callbacks: callbacks,
    toImpl(value: unknown) { return value === connection ? { _activeProgressControllers: progress } : { _browser: browser } },
  }
  const page = new FixturePage("authentication")
  const fixture = await launchFixture([page], {}, connection)
  const records: Array<{ value: Record<string, unknown>; closeCalls: number }> = []
  const log = spyOn(console, "error").mockImplementation(value => {
    if (typeof value === "string" && value.startsWith("{")) records.push({ value: JSON.parse(value), closeCalls: page.closeCalls })
  })
  const abort = new AbortController()
  const work = fixture.collect({ ...turn, initialPrompt: sensitive, sessionMarker: sensitive }, abort.signal).catch(error => ({ name: error.name }))
  try {
    await page.setupStarted.promise
    abort.abort()
    expect(await within(work)).toEqual({ name: "AbortError" })
    expect(records).toHaveLength(1)
    expect(records[0]?.closeCalls).toBe(0)
    expect(records[0]?.value).toMatchObject({
      diagnostic: "browser-turn-failure", stage: "authentication", reason: "cancelled",
      control: { available: true, client: { count: 40, truncated: true }, server: { count: 1 }, browser: {
        pipe: { bufferedBytes: 3, readLength: 2, writeLength: 1 },
        sessions: { count: 1, entries: [{ pending: { count: 40, truncated: true } }] },
      } },
    })
    const serialized = JSON.stringify(records)
    expect(serialized).toContain("Runtime.callFunctionOn")
    expect(serialized).not.toContain(sensitive)
    expect(serialized.length).toBeLessThan(12_000)
  } finally {
    abort.abort(); page.setupReady.resolve(); page.finishClose()
    await work; await fixture.adapter.close(); fixture.restore(); log.mockRestore()
  }
})

test("setup failure diagnostics survive unavailable internals without logging the error payload", async () => {
  const records: unknown[] = []
  const log = spyOn(console, "error").mockImplementation(value => {
    if (typeof value === "string" && value.startsWith("{")) records.push(JSON.parse(value))
  })
  const fixture = await launchFixture([], { async prepare() { throw Error("fixture-sensitive-error") } })
  try {
    await expect(fixture.collect()).rejects.toThrow("fixture-sensitive-error")
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ diagnostic: "browser-turn-failure", stage: "attempt-preparation", reason: "failed", control: { available: false } })
    expect(JSON.stringify(records)).not.toContain("fixture-sensitive-error")
  } finally { await fixture.adapter.close(); fixture.restore(); log.mockRestore() }
})

for (const stage of ["capture-binding", "priming-fill"] as const) test(`reports ${stage} failure before nested cleanup can replace its stage`, async () => {
  const page = new FixturePage("complete", "complete")
  const failure = stage === "capture-binding"
    ? spyOn(page, "exposeBinding").mockRejectedValue(Error("fixture setup failure"))
    : spyOn(page, "hold").mockImplementation(async visited => { if (visited === "prompt-fill") throw Error("fixture setup failure") })
  const records: Array<{ value: unknown; closeCalls: number }> = []
  const log = spyOn(console, "error").mockImplementation(value => {
    if (typeof value === "string" && value.startsWith("{")) records.push({ value: JSON.parse(value), closeCalls: page.closeCalls })
  })
  const fixture = await launchFixture([page])
  try {
    await expect(fixture.collect({ ...turn, primingPrompts: stage === "priming-fill" ? ["Fixture context."] : [] })).rejects.toThrow("fixture setup failure")
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ closeCalls: 0, value: { diagnostic: "browser-turn-failure", stage, reason: "failed" } })
  } finally { await fixture.adapter.close(); fixture.restore(); failure.mockRestore(); log.mockRestore() }
})

for (const stage of ["new-page", "binding", "init-script"] as const) test(`cancelled ${stage} setup owns its late page and blocks new admission until drained`, async () => {
  const page = new FixturePage(stage)
  const fresh = new FixturePage("complete", "complete")
  const fixture = await launchFixture([page, fresh])
  const abort = new AbortController()
  const work = fixture.collect(turn, abort.signal).catch(error => ({ name: error.name }))
  try {
    await page.setupStarted.promise
    abort.abort()
    expect(await within(work)).toEqual({ name: "AbortError" })
    await expect(fixture.collect({ ...turn, sessionMarker: "new-key" })).rejects.toThrow("cleanup")
    expect(fixture.created).toEqual([page])
    page.setupReady.resolve()
    await page.closeStarted.promise
    expect(page.sendCalls).toBe(0)
    expect(page.initCalls).toBe(stage === "init-script" ? 1 : 0)
    await expect(fixture.collect()).rejects.toThrow("cleanup")
    page.finishClose()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(await fixture.collect()).toEqual([{ type: "text", delta: answer }, { type: "finish", reason: "stop" }])
    expect(page.closeCalls).toBe(1)
  } finally {
    abort.abort(); page.setupReady.resolve(); page.finishClose()
    await work; await fixture.adapter.close(); fixture.restore()
  }
})

for (const stage of ["navigation", "authentication", "auth-ready", "model-open", "model-controls", "model-click", "prompt-ready", "prompt-fill", "baseline"] as const) {
  for (const priming of stage === "prompt-ready" || stage === "prompt-fill" || stage === "baseline" ? [false, true] : [false]) {
    test(`cancelled ${priming ? "priming " : ""}${stage} setup cancels native work before a late mutation`, async () => {
      const page = new FixturePage(stage)
      const fixture = await launchFixture([page])
      const abort = new AbortController()
      const work = fixture.collect({ ...turn, primingPrompts: priming ? ["Fixture context."] : [] }, abort.signal)
        .catch(error => ({ name: error.name }))
      try {
        await page.setupStarted.promise
        abort.abort()
        expect(await within(work)).toEqual({ name: "AbortError" })
        page.setupReady.resolve()
        await page.setupSettled.promise
        expect(page.nativeSetupAborted).toBe(true)
        expect(page.lateMutations).toBe(0)
        expect(page.sendCalls).toBe(0)
      } finally {
        abort.abort(); page.setupReady.resolve(); page.finishClose()
        await work; await fixture.adapter.close(); fixture.restore()
      }
    })
  }
}

for (const stage of ["authentication", "baseline", "temp-geometry", "temp-shape", "temp-fingerprint", "temp-url"] as const)
for (const priming of stage === "baseline" ? [false, true] : [false]) test(`retirement owns ${priming ? "priming " : ""}${stage} evaluation even after the page close settles`, async () => {
  const page = new FixturePage(stage)
  page.evaluationUncancellable = true
  const fixture = await launchFixture([page, new FixturePage("complete", "complete")])
  const abort = new AbortController()
  const work = fixture.collect({ ...turn, primingPrompts: priming ? ["Fixture context."] : [] }, abort.signal).catch(error => ({ name: error.name }))
  try {
    await page.setupStarted.promise
    abort.abort()
    expect(await within(work)).toEqual({ name: "AbortError" })
    page.finishClose()
    await new Promise<void>(resolve => setImmediate(resolve))
    await expect(fixture.collect({ ...turn, sessionMarker: "new-key" })).rejects.toThrow("cleanup")
    expect(fixture.created).toEqual([page])
    page.setupReady.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(page.sendCalls).toBe(0)
    expect(await fixture.collect()).toEqual([{ type: "text", delta: answer }, { type: "finish", reason: "stop" }])
  } finally {
    abort.abort(); page.setupReady.resolve(); page.finishClose()
    await work; await fixture.adapter.close(); fixture.restore()
  }
})

test("temporary-chat deadline retires an unresolved read instead of submitting on that page", async () => {
  const page = new FixturePage("temp-shape")
  const fixture = await launchFixture([page, new FixturePage("complete", "complete")])
  const abort = new AbortController()
  const work = fixture.collect(turn, abort.signal).catch(error => ({ message: error.message }))
  try {
    await page.setupStarted.promise
    const outcome = await within(Promise.race([work, page.submitted.promise.then(() => ({ submitted: true }))]), 8500)
    expect(outcome).toMatchObject({ message: expect.stringContaining("temporary-chat setup") })
    expect(page.sendCalls).toBe(0)
    expect(page.closeCalls).toBe(1)
    page.finishClose()
    await new Promise<void>(resolve => setImmediate(resolve))
    await expect(fixture.collect({ ...turn, sessionMarker: "new-key" })).rejects.toThrow("cleanup")
    page.setupReady.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(await fixture.collect()).toEqual([{ type: "text", delta: answer }, { type: "finish", reason: "stop" }])
  } finally {
    abort.abort(); page.setupReady.resolve(); page.finishClose()
    await work; await fixture.adapter.close(); fixture.restore()
  }
}, 10_000)

test("a turn queued on the same session is not admitted when its predecessor starts retirement", async () => {
  const page = new FixturePage("lookup")
  let discarded = 0
  const fixture = await launchFixture([page], { async discard() { discarded++ } })
  const abort = new AbortController()
  const work = fixture.collect(turn, abort.signal).catch(error => ({ name: error.name }))
  let queued: Promise<unknown> | undefined
  try {
    await page.lookupStarted.promise
    queued = fixture.collect({ ...turn, ephemeral: true }).catch(error => ({ message: error.message }))
    abort.abort()
    expect(await within(work)).toEqual({ name: "AbortError" })
    expect(await within(queued)).toMatchObject({ message: expect.stringContaining("cleanup") })
    expect(fixture.created).toEqual([page])
    expect(discarded).toBe(0)
  } finally {
    abort.abort(); page.lookup.resolve(); page.finishClose()
    await work; await queued; await fixture.adapter.close(); fixture.restore()
  }
})

test("close drains already admitted turns and their later retirements without interrupting them", async () => {
  const first = new FixturePage("lookup")
  const second = new FixturePage("complete")
  const preparing = deferred<void>(), prepared = deferred<void>()
  const fixture = await launchFixture([first, second], {
    async prepare(input) {
      if (input.sessionMarker === "already-admitted") { preparing.resolve(); await prepared.promise }
      return { id: "fixture", promptHash: input.promptHash }
    },
  })
  const abort = new AbortController()
  const firstWork = fixture.collect(turn, abort.signal).catch(error => ({ name: error.name }))
  let secondWork: Promise<unknown> | undefined, closing: Promise<void> | undefined
  try {
    await first.lookupStarted.promise
    secondWork = fixture.collect({ ...turn, sessionMarker: "already-admitted", ephemeral: true })
      .catch(error => ({ name: error.name }))
    await preparing.promise
    closing = fixture.adapter.close()
    expect(await within(closing)).toBe(pending)
    expect(await within(fixture.adapter.close())).toBe(pending)
    expect(fixture.contextCloses()).toBe(0)
    await expect(fixture.collect()).rejects.toThrow("closed")
    abort.abort()
    expect(await within(firstWork)).toEqual({ name: "AbortError" })
    prepared.resolve()
    expect(await within(second.closeStarted.promise)).toBeUndefined()
    first.lookup.resolve(); first.finishClose()
    expect(await within(closing)).toBe(pending)
    expect(fixture.contextCloses()).toBe(0)
    second.finishClose()
    expect(await within(secondWork)).toEqual([{ type: "text", delta: answer }, { type: "finish", reason: "stop" }])
    await closing
    expect(fixture.contextCloses()).toBe(1)
  } finally {
    abort.abort(); prepared.resolve(); first.lookup.resolve(); first.finishClose(); second.finishClose()
    await firstWork; await secondWork; await closing; await fixture.adapter.close(); fixture.restore()
  }
})

for (const priming of [false, true]) test(`cancels the native ${priming ? "priming" : "turn"} click before it can submit late`, async () => {
  const page = new FixturePage("click")
  const fixture = await launchFixture([page])
  const abort = new AbortController()
  const work = fixture.collect({ ...turn, primingPrompts: priming ? ["Fixture context."] : [] }, abort.signal)
    .catch(error => ({ name: error.name }))
  try {
    await page.clickStarted.promise
    abort.abort()
    expect(await within(work)).toEqual({ name: "AbortError" })
    page.clickReady.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(page.clickAborted).toBe(true)
    expect(page.sendCalls).toBe(0)
  } finally {
    abort.abort(); page.clickReady.resolve(); page.finishClose()
    await work; await fixture.adapter.close(); fixture.restore()
  }
})

test("cancellation closes cross-session admission before waiting for failure persistence", async () => {
  const page = new FixturePage("lookup")
  const failing = deferred<void>(), persisted = deferred<void>()
  const fixture = await launchFixture([page, new FixturePage("complete", "complete")], {
    async fail() { failing.resolve(); await persisted.promise },
  })
  const abort = new AbortController()
  const work = fixture.collect(turn, abort.signal).catch(error => ({ name: error.name }))
  try {
    await page.lookupStarted.promise
    abort.abort()
    await failing.promise
    const foreign = fixture.collect({ ...turn, sessionMarker: "different-session" }).catch(error => ({ message: error.message }))
    expect(await within(foreign)).toMatchObject({ message: expect.stringContaining("cleanup") })
    expect(fixture.created).toEqual([page])
    expect(page.closeCalls).toBe(1)
    persisted.resolve()
    expect(await within(work)).toEqual({ name: "AbortError" })
  } finally {
    abort.abort(); persisted.resolve(); page.lookup.resolve(); page.finishClose()
    await work; await fixture.adapter.close(); fixture.restore()
  }
})
