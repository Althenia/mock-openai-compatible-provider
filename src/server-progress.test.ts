import { expect, mock, test } from "bun:test"
import { WebchatSafetyBlockError } from "./browser.ts"
import type { ProjectedTurn } from "./http.ts"
import { createRequestHandler, type BrowserService } from "./server.ts"

const token = "p".repeat(64)
const pending = Symbol("response pending")

function expectCompatibleRecords(endpoint: string, text: string) {
  expect(text).not.toContain("event: aipass.stage")
  for (const record of text.split("\n\n").filter(Boolean)) {
    const payload = record.split("\n").find(line => line.startsWith("data: "))?.slice(6)
    expect(payload).toBeDefined()
    if (payload === "[DONE]") continue
    const value = JSON.parse(payload!)
    expect(value).not.toHaveProperty("stage")
    if (endpoint === "/v1/chat/completions") {
      if (value.error !== undefined) {
        expect(typeof value.error.message).toBe("string")
        expect(typeof value.error.type).toBe("string")
      } else {
        expect(Array.isArray(value.choices)).toBe(true)
        expect(value.object).toBe("chat.completion.chunk")
      }
    } else {
      expect(typeof value.type).toBe("string")
      expect(Number.isInteger(value.sequence_number)).toBe(true)
      expect(record).toStartWith(`event: ${value.type}\n`)
      if (value.type === "error") {
        expect(typeof value.message).toBe("string")
        expect(typeof value.code).toBe("string")
        expect(value.param).toBeNull()
      } else expect(value.type).toStartWith("response.")
    }
  }
}

function request(path: string, body: Record<string, unknown>) {
  return {
    method: "POST", url: `http://127.0.0.1${path}`,
    headers: new Headers({ authorization: `Bearer ${token}`, "content-type": "application/json" }),
    signal: new AbortController().signal,
    json: mock(async () => body),
  } as unknown as Request
}

async function beforeBackend<T>(work: Promise<T>): Promise<T | typeof pending> {
  const gate = (async (): Promise<typeof pending> => { await Promise.resolve(); await Promise.resolve(); return pending })()
  return Promise.race([work, gate])
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, text: string) {
  const decoder = new TextDecoder()
  let output = ""
  while (!output.includes(text)) {
    const part = await reader.read()
    if (part.done) throw Error(`stream ended before ${text}`)
    output += decoder.decode(part.value, { stream: true })
  }
  return output
}

for (const endpoint of ["/v1/chat/completions", "/v1/responses"] as const) test(`${endpoint} starts standard SSE before backend frames without custom data records`, async () => {
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const turn = mock((_input: ProjectedTurn, _signal?: AbortSignal) => (async function* () {
    entered.resolve()
    await release.promise
    yield { type: "text" as const, delta: "ANSWER" }
    yield { type: "finish" as const, reason: "stop" as const }
  })())
  const handler = createRequestHandler({ token, shutdown: async () => {}, browser: { turn, async login() {}, async close() {} } as BrowserService })
  const work = handler(request(endpoint, { model: "gemini-3.1-flash-lite", stream: true,
    ...(endpoint === "/v1/responses" ? { input: "hello" } : { messages: [{ role: "user", content: "hello" }] }),
  }))
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await beforeBackend(work)
    expect(response).not.toBe(pending)
    if (response === pending) return
    expect(response.status).toBe(200)
    reader = response.body!.getReader()
    const standard = await readUntil(reader, endpoint === "/v1/responses" ? "response.in_progress" : '"role":"assistant"')
    expect(standard).not.toContain("ANSWER")
    expect(standard).not.toContain(endpoint === "/v1/responses" ? "response.completed" : "[DONE]")
    expect(await entered.promise).toBeUndefined()
    release.resolve()
    const completed = await readUntil(reader, endpoint === "/v1/responses" ? "response.completed" : "[DONE]")
    expect(completed).toContain("ANSWER")
    expectCompatibleRecords(endpoint, standard + completed)
  } finally {
    release.resolve()
    if (reader) { await reader.cancel(); reader.releaseLock() }
    else await work.then(response => response.body?.cancel())
  }
})

for (const endpoint of ["/v1/chat/completions", "/v1/responses"] as const) for (const [name, failure, code] of [
  ["safety", new WebchatSafetyBlockError(), "webchat_safety_block"],
  ["authentication", { type: "auth-required" as const }, "browser authentication is required"],
  ["transport", Error("fixture transport failed"), "fixture transport failed"],
] as const) test(`${endpoint} streaming ${name} failure becomes a terminal SSE error after HTTP 200`, async () => {
  const release = Promise.withResolvers<void>()
  const turn = mock((_input: ProjectedTurn, _signal?: AbortSignal) => (async function* () {
    await release.promise
    if (failure instanceof Error) throw failure
    yield failure
  })())
  const handler = createRequestHandler({ token, shutdown: async () => {}, browser: { turn, async login() {}, async close() {} } as BrowserService })
  const work = handler(request(endpoint, { model: "gemini-3.1-flash-lite", stream: true,
    ...(endpoint === "/v1/responses" ? { input: "hello" } : { messages: [{ role: "user", content: "hello" }] }),
  }))
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await beforeBackend(work)
    expect(response).not.toBe(pending)
    if (response === pending) return
    expect(response.status).toBe(200)
    reader = response.body!.getReader()
    expect(await readUntil(reader, endpoint === "/v1/responses" ? "response.in_progress" : '"role":"assistant"')).not.toContain("response.completed")
    release.resolve()
    const terminal = await readUntil(reader, code)
    expect(terminal).toContain(endpoint === "/v1/responses" ? "event: error" : '"error":{')
    expect(terminal).not.toContain("response.completed")
    expect(terminal).not.toContain("[DONE]")
    expectCompatibleRecords(endpoint, terminal)
  } finally {
    release.resolve()
    if (reader) { await reader.cancel(); reader.releaseLock() }
    else await work.then(response => response.body?.cancel())
  }
})

test("non-stream failures retain HTTP 422, 428, and 502 status contracts", async () => {
  for (const [failure, status] of [[new WebchatSafetyBlockError(), 422], [{ type: "auth-required" as const }, 428], [Error("fixture transport failed"), 502]] as const) {
    const handler = createRequestHandler({ token, shutdown: async () => {}, browser: {
      async *turn() { if (failure instanceof Error) throw failure; yield failure }, async login() {}, async close() {},
    } as BrowserService })
    expect((await handler(request("/v1/responses", { model: "gemini-3.1-flash-lite", input: "hello" }))).status).toBe(status)
  }
})

for (const endpoint of ["/v1/chat/completions", "/v1/responses"] as const) test(`${endpoint} keeps late errors compatible after actual reasoning`, async () => {
  const handler = createRequestHandler({ token, shutdown: async () => {}, browser: {
    turn: mock(async function* () {
      yield { type: "reasoning" as const, delta: "BACKEND_REASONING" }
      throw new Error("late fixture failure")
    }), async login() {}, async close() {},
  } })
  const response = await handler(request(endpoint, { model: "gemini-3.1-flash-lite", stream: true,
    ...(endpoint === "/v1/responses" ? { input: "hello" } : { messages: [{ role: "user", content: "hello" }] }),
  }))
  const text = await response.text()
  expectCompatibleRecords(endpoint, text)
  expect(text).toContain("BACKEND_REASONING")
  expect(text).toContain("late fixture failure")
  expect(text).not.toContain("[DONE]")
  expect(text).not.toContain("response.completed")
  if (endpoint === "/v1/responses") {
    const events = text.split("\n\n").filter(Boolean).map(record => JSON.parse(record.split("\ndata: ")[1]!))
    expect(events.map(event => event.sequence_number)).toEqual(events.map((_, index) => index))
  }
})

test("Responses startup cancellation aborts the backend and consumes its reserved predecessor without completion", async () => {
  const release = Promise.withResolvers<void>()
  let calls = 0
  let aborted = false
  const turn = mock((_input: ProjectedTurn, signal?: AbortSignal) => (async function* () {
    if (++calls === 1) {
      yield { type: "text" as const, delta: "ROOT" }
      yield { type: "finish" as const, reason: "stop" as const }
      return
    }
    await release.promise
    aborted = signal?.aborted === true
    throw Error("fixture cancelled")
  })())
  const discarded = mock(async () => undefined)
  const handler = createRequestHandler({ token, shutdown: async () => {}, browser: { turn, discard: discarded, async login() {}, async close() {} } as BrowserService })
  const root = await handler(request("/v1/responses", { model: "gemini-3.1-flash-lite", input: "root" }))
  const rootID = (await root.json() as { id: string }).id
  const work = handler(request("/v1/responses", { model: "gemini-3.1-flash-lite", previous_response_id: rootID, input: "continue", stream: true }))
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await beforeBackend(work)
    expect(response).not.toBe(pending)
    if (response === pending) return
    reader = response.body!.getReader()
    const initial = await readUntil(reader, "response.in_progress")
    expect(initial).not.toContain("response.completed")
    const cancelling = reader.cancel()
    release.resolve()
    await cancelling
    await Promise.resolve()
    expect(aborted).toBe(true)
    expect(discarded).toHaveBeenCalledTimes(1)
    expect((await handler(request("/v1/responses", { model: "gemini-3.1-flash-lite", previous_response_id: rootID, input: "retry" }))).status).toBe(400)
  } finally {
    release.resolve()
    if (reader) reader.releaseLock()
    else await work.then(response => response.body?.cancel())
  }
})
