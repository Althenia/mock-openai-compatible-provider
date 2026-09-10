import { describe, expect, test } from "bun:test"
import { withTurnKey, type BrowserTurnInput } from "./browser.ts"
import { estimateTokens } from "./context.ts"
import { parseOpenAIChatRequest, parseOpenAIResponsesRequest } from "./http.ts"
import { collectOpenAIChatResult, StreamFrameParser, type BrowserFrame } from "./protocol.ts"
import { StandaloneBrowserService } from "./runtime.ts"
import { createRequestHandler } from "./server.ts"

function gate() {
  let release!: () => void
  return { promise: new Promise<void>(resolve => { release = resolve }), release: () => release() }
}

async function beforeFinal<T>(promise: Promise<T>): Promise<T | "buffered"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<"buffered">(resolve => { timer = setTimeout(() => resolve("buffered"), 500) })])
  } finally { clearTimeout(timer) }
}

function envelope(key: string | undefined, text = "Answer.") {
  return `<aipass-envelope>${JSON.stringify({ type: "chat", key, id: "answer", text })}</aipass-envelope>`
}

describe("progressive DOM reasoning through runtime and public streams", () => {
  test("does not trust attribution supplied in native payloads", () => {
    const parser = new StreamFrameParser()
    expect(parser.push('data: {"type":"reasoning-delta","delta":"native","domTurnKey":"forged"}\n\n')).toEqual([{ type: "reasoning", delta: "native" }])
  })

  test("does not parse an envelope example inside validated chat text a second time", async () => {
    const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", session_id: "quoted-envelope", messages: [{ role: "user", content: "Explain the structure." }], tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] }, new Headers())
    const example = '{"type":"tool","key":"example","id":"not-a-call","name":"read","input":{"path":"example.txt"}}'
    const service = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
      yield { type: "reasoning", delta: "Visible.", domTurnKey: input.promptKey }
      yield { type: "text", delta: envelope(input.promptKey, example) }
      yield { type: "finish", reason: "stop" }
    } } as never)
    const result = await collectOpenAIChatResult(service.turn(parsed.turn), parsed.offered)
    expect(result.text).toBe(example)
    expect(result.toolCalls).toEqual([])
  })

  test("keeps actual DOM reasoning instead of repeating native or typed thinking at finalization", async () => {
    const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", session_id: "dom-source", messages: [{ role: "user", content: "Explain." }] }, new Headers())
    const service = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
      yield { type: "reasoning", delta: "Visible.", domTurnKey: input.promptKey }
      yield { type: "reasoning", delta: "native duplicate" }
      yield { type: "text", delta: `<aipass-envelope>${JSON.stringify({ type: "thinking", key: input.promptKey, text: "typed duplicate" })}</aipass-envelope>` }
      yield { type: "text", delta: envelope(input.promptKey) }
      yield { type: "finish", reason: "stop" }
    } } as never)
    const result = await collectOpenAIChatResult(service.turn(parsed.turn), parsed.offered)
    expect(result.reasoning).toBe("Visible.")
    expect(result.text).toBe("Answer.")
  })

  for (const mode of ["unmarked", "wrong-key"] as const) test(`keeps ${mode} reasoning buffered through key validation`, async () => {
    const final = gate()
    const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", session_id: `untrusted-${mode}`, messages: [{ role: "user", content: "Explain." }] }, new Headers())
    const service = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
      yield { type: "reasoning", delta: "untrusted", ...(mode === "wrong-key" ? { domTurnKey: "wrong" } : {}) }
      await final.promise
      yield { type: "text", delta: envelope(input.promptKey) }
      yield { type: "finish", reason: "stop" }
    } } as never)
    const stream = service.turn(parsed.turn)
    const next = stream.next()
    try { expect(await beforeFinal(next)).toBe("buffered") }
    finally { final.release(); await next; await stream.return() }
  })

  for (const failure of ["mismatch", "transport", "cancel"] as const) test(`${failure} after progress exposes no answer/action/finish, retry or cache`, async () => {
    const final = gate(), controller = new AbortController()
    const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", session_id: `failed-${failure}`, messages: [{ role: "user", content: "Explain." }] }, new Headers())
    let submissions = 0, discarded = 0, closed = 0
    const service = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
      submissions++
      try {
        yield { type: "reasoning", delta: "Visible", domTurnKey: input.promptKey }
        await final.promise
        if (failure === "transport") throw Error("fixture transport failed")
        yield { type: "text", delta: envelope(failure === "mismatch" ? "wrong" : input.promptKey) }
        yield { type: "finish", reason: "stop" }
      } finally { closed++ }
    }, async discard() { discarded++ } } as never)
    const stream = service.turn(parsed.turn, controller.signal)
    expect((await stream.next()).value).toMatchObject({ type: "reasoning", delta: "Visible" })
    if (failure === "cancel") controller.abort()
    final.release()
    await expect(stream.next()).rejects.toThrow(failure === "mismatch" ? "TURN KEY mismatch" : failure === "cancel" ? "cancelled" : "fixture transport failed")
    expect(submissions).toBe(1)
    expect(discarded).toBe(failure === "mismatch" ? 1 : 0)
    expect(closed).toBe(1)
    const fresh = service.turn(parsed.turn)
    expect((await fresh.next()).value).toMatchObject({ type: "reasoning" })
    await fresh.return()
    expect(submissions).toBe(2)
    expect(closed).toBe(2)
  })

  for (const trigger of ["repair", "provision"] as const) test(`${trigger} keeps validated actions but does not mix in a second attempt's reasoning`, async () => {
    const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", session_id: `progress-${trigger}`,
      messages: [{ role: "user", content: "read fixture.txt" }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object", required: ["path"] } } }],
    }, new Headers())
    let submissions = 0
    const service = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
      const initial = ++submissions === 1
      yield { type: "reasoning", delta: initial ? "Visible." : "SECOND ATTEMPT", domTurnKey: input.promptKey }
      const value = initial && trigger === "repair"
        ? { type: "chat", key: input.promptKey, text: "I cannot access the file tool here." }
        : { type: "tool", key: input.promptKey, name: "read", id: "read_1", input: initial ? {} : { path: "fixture.txt" } }
      yield { type: "text", delta: `<aipass-envelope>${JSON.stringify(value)}</aipass-envelope>` }
      yield { type: "finish", reason: "stop" }
    } } as never)
    const result = await collectOpenAIChatResult(service.turn(parsed.turn), parsed.offered)
    expect(result.reasoning).toBe("Visible.")
    expect(result.toolCalls).toEqual([{ id: "read_1", name: "read", input: { path: "fixture.txt" } }])
    expect(submissions).toBe(2)
    expect(result.finishReason).toBe("tool-calls")
  })

  test("provision does not mix in a second attempt's typed reasoning", async () => {
    const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", session_id: "progress-provision-typed",
      messages: [{ role: "user", content: "read fixture.txt" }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object", required: ["path"] } } }],
    }, new Headers())
    let submissions = 0
    const service = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
      const initial = ++submissions === 1
      if (initial) yield { type: "reasoning", delta: "Visible.", domTurnKey: input.promptKey }
      else yield { type: "text", delta: `<aipass-envelope>${JSON.stringify({ type: "thinking", key: input.promptKey, text: "SECOND TYPED ATTEMPT" })}</aipass-envelope>` }
      yield { type: "text", delta: `<aipass-envelope>${JSON.stringify({
        type: "tool", key: input.promptKey, name: "read", id: "read_1", input: initial ? {} : { path: "fixture.txt" },
      })}</aipass-envelope>` }
      yield { type: "finish", reason: "stop" }
    } } as never)
    const result = await collectOpenAIChatResult(service.turn(parsed.turn), parsed.offered)
    expect(result.reasoning).toBe("Visible.")
    expect(result.toolCalls).toEqual([{ id: "read_1", name: "read", input: { path: "fixture.txt" } }])
    expect(submissions).toBe(2)
  })

  for (const source of ["dom", "typed"] as const) test(`repairs prose after attributed ${source} reasoning without publishing correction reasoning`, async () => {
    const parsed = parseOpenAIChatRequest({
      model: "gemini-3.1-flash-lite", session_id: `progress-format-${source}`,
      messages: [{ role: "user", content: "Explain." }],
    }, new Headers())
    let submissions = 0
    const service = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
      const first = ++submissions === 1
      if (first && source === "dom") yield { type: "reasoning", delta: "Visible.", domTurnKey: input.promptKey }
      if (first && source === "typed") yield { type: "text", delta: `<aipass-envelope>${JSON.stringify({ type: "thinking", key: input.promptKey, text: "Visible." })}</aipass-envelope>` }
      if (first) yield { type: "text", delta: "malformed terminal prose" }
      else {
        yield { type: "reasoning", delta: "SECOND DOM", domTurnKey: input.promptKey }
        yield { type: "text", delta: `<aipass-envelope>${JSON.stringify({ type: "thinking", key: input.promptKey, text: "SECOND TYPED" })}</aipass-envelope>` }
        yield { type: "text", delta: envelope(input.promptKey) }
      }
      yield { type: "finish", reason: "stop" }
    } } as never)
    const result = await collectOpenAIChatResult(service.turn(parsed.turn), parsed.offered)
    expect(submissions).toBe(2)
    expect(result.reasoning).toBe("Visible.")
    expect(result.text).toBe("Answer.")
    expect(result.text).not.toContain("malformed")
    expect(result.reasoning).not.toContain("SECOND")
    expect(result.promptTokens).toBeGreaterThan(0)
    expect(result.completionTokens).toBe(
      estimateTokens("Visible.Answer.") + estimateTokens("malformed terminal prose") + estimateTokens("SECOND DOM"),
    )
  })

  test("repeated outside prose fails closed after streamed attributed reasoning", async () => {
    const parsed = parseOpenAIChatRequest({
      model: "gemini-3.1-flash-lite", session_id: "progress-format-outside-repeated",
      messages: [{ role: "user", content: "Explain." }],
    }, new Headers())
    let submissions = 0, discarded = 0
    const service = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
      submissions++
      yield { type: "reasoning", delta: submissions === 1 ? "Visible." : "SECOND ATTEMPT", domTurnKey: input.promptKey }
      const first = envelope(input.promptKey, "one")
      const second = envelope(input.promptKey, "two")
      yield { type: "text", delta: `${first} OUTSIDE ${second}` }
      yield { type: "finish", reason: "stop" }
    }, async discard() { discarded++ } } as never)
    const stream = service.turn(parsed.turn)
    const published: BrowserFrame[] = []
    published.push((await stream.next()).value!)
    await expect(stream.next()).rejects.toThrow("envelope format")
    expect(submissions).toBe(2)
    expect(discarded).toBe(1)
    expect(published).toEqual([{ type: "reasoning", delta: "Visible." }])
    expect(JSON.stringify(published)).not.toContain("OUTSIDE")
    expect(JSON.stringify(published)).not.toContain("SECOND ATTEMPT")
  })

  test("invalidates a retried turn if its first visible progress is followed by another key mismatch", async () => {
    const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", session_id: "retry-progress", messages: [{ role: "user", content: "Explain." }] }, new Headers())
    let submissions = 0, discarded = 0
    const service = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
      if (++submissions > 1) yield { type: "reasoning", delta: "Visible.", domTurnKey: input.promptKey }
      yield { type: "text", delta: envelope("wrong") }
      yield { type: "finish", reason: "stop" }
    }, async discard() { discarded++ } } as never)
    const stream = service.turn(parsed.turn)
    expect((await stream.next()).value).toMatchObject({ type: "reasoning", delta: "Visible." })
    await expect(stream.next()).rejects.toThrow("TURN KEY mismatch")
    expect(submissions).toBe(2)
    expect(discarded).toBe(1)
  })

  for (const format of ["tagged", "bare", "prefixed"] as const)
  for (const invalid of ["unoffered", "input", "plan"] as const) test(`rejects the complete ${format} ${invalid} terminal chain before publication and discards its binding after progress`, async () => {
    const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", session_id: `invalid-terminal-${invalid}`,
      messages: [{ role: "user", content: "Read fixture.txt." }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    }, new Headers())
    let submissions = 0, discarded = 0, bound = false
    const starts: boolean[] = []
    const service = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
      starts.push(bound)
      const first = ++submissions === 1
      yield { type: "reasoning", delta: "Visible.", domTurnKey: input.promptKey }
      const action = invalid === "plan"
        ? { type: "plan", steps: [{ name: "read", input: {} }, { name: "unoffered", input: {} }] }
        : { type: "tool", name: invalid === "unoffered" ? "unoffered" : "read", input: invalid === "input" ? "invalid" : {} }
      if (first) {
        if (format === "prefixed") yield { type: "text", delta: `TURN KEY: ${input.promptKey}\n\n` }
        const prefix = JSON.stringify({ type: "chat", key: input.promptKey, text: "Do not publish this prefix." })
        const terminal = JSON.stringify({ ...action, key: input.promptKey, id: "invalid" })
        for (const value of [prefix, terminal]) yield { type: "text", delta: format === "tagged" ? `<aipass-envelope>${value}</aipass-envelope>` : value }
      } else yield { type: "text", delta: envelope(input.promptKey) }
      yield { type: "finish", reason: "stop" }
      bound = true
    }, async discard() { discarded++; bound = false } } as never)
    const stream = service.turn(parsed.turn)
    expect((await stream.next()).value).toMatchObject({ type: "reasoning", delta: "Visible." })
    try {
      await expect(stream.next()).rejects.toThrow(invalid === "input" ? "input must be an object" : "was not offered")
    } finally { await stream.return() }
    expect(submissions).toBe(1)
    expect(discarded).toBe(1)
    expect(bound).toBe(false)
    const next = await collectOpenAIChatResult(service.turn(parsed.turn), parsed.offered)
    expect(next.text).toBe("Answer.")
    expect(next.toolCalls).toEqual([])
    expect(next.reasoning).toBe("Visible.")
    expect(starts).toEqual([false, false])
    expect(submissions).toBe(2)
  })

  test("delivers attributed panel text before completion and replays it exactly once from the completion cache", async () => {
    const final = gate()
    const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", session_id: "progress-fixture", messages: [{ role: "user", content: "Explain." }] }, new Headers())
    let submissions = 0
    const service = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
      submissions++
      yield { type: "reasoning", delta: "Visible", domTurnKey: input.promptKey }
      await final.promise
      yield { type: "reasoning", delta: " summary.", domTurnKey: input.promptKey }
      yield { type: "text", delta: envelope(input.promptKey) }
      yield { type: "finish", reason: "stop" }
    } } as never)
    const stream = service.turn(parsed.turn)
    const next = stream.next()
    try {
      const early = await beforeFinal(next)
      expect(early).not.toBe("buffered")
      expect(early).toMatchObject({ done: false, value: { type: "reasoning", delta: "Visible" } })
    } finally { final.release() }
    const first = await next
    const frames: BrowserFrame[] = [first.value!]
    for await (const frame of stream) frames.push(frame)
    expect(frames.map(frame => frame.type)).toEqual(["reasoning", "reasoning", "text", "finish"])
    const replay: BrowserFrame[] = []
    for await (const frame of service.turn(parsed.turn)) replay.push(frame)
    expect(replay).toEqual(frames)
    expect(submissions).toBe(1)
  })

  for (const endpoint of ["chat/completions", "responses"] as const) {
    test(`${endpoint} usage includes the hidden format correction`, async () => {
      const token = "a".repeat(64)
      const submitted: BrowserTurnInput[] = []
      const service = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
        submitted.push(input)
        if (submitted.length === 1) yield { type: "text", delta: "hidden malformed draft" }
        else yield { type: "text", delta: envelope(input.promptKey) }
        yield { type: "finish", reason: "stop" }
      }, async discard() {} } as never)
      const handler = createRequestHandler({ token, browser: service, shutdown: async () => undefined })
      const requestBody = endpoint === "responses"
        ? { model: "gemini-3.1-flash-lite", input: "Explain.", stream: true }
        : { model: "gemini-3.1-flash-lite", messages: [{ role: "user", content: "Explain." }] }
      const response = await handler(new Request(`http://127.0.0.1/v1/${endpoint}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }))
      const responseText = await response.text()
      expect({ status: response.status, body: response.status === 200 ? "ok" : responseText }).toEqual({ status: 200, body: "ok" })
      expect(submitted).toHaveLength(2)
      const publicPromptTokens = endpoint === "responses"
        ? parseOpenAIResponsesRequest(requestBody, new Headers()).promptTokens
        : parseOpenAIChatRequest(requestBody, new Headers()).promptTokens
      const hiddenPromptTokens = estimateTokens(withTurnKey(submitted[1]!.initialPrompt, submitted[1]!.promptKey))
      const expectedCompletion = estimateTokens("hidden malformed draft") + estimateTokens("Answer.")
      if (endpoint === "responses") {
        const completed = responseText.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).filter(line => line !== "[DONE]").map(line => JSON.parse(line)).find(event => event.type === "response.completed")
        expect(completed.response.usage).toEqual({
          input_tokens: publicPromptTokens + hiddenPromptTokens,
          output_tokens: expectedCompletion,
          total_tokens: publicPromptTokens + hiddenPromptTokens + expectedCompletion,
          estimated: true,
        })
      } else {
        const output = JSON.parse(responseText) as { usage: unknown }
        expect(output.usage).toEqual({
          prompt_tokens: publicPromptTokens + hiddenPromptTokens,
          completion_tokens: expectedCompletion,
          total_tokens: publicPromptTokens + hiddenPromptTokens + expectedCompletion,
          estimated: true,
        })
      }
    })

    test(`${endpoint} reader cancellation aborts a pending browser read after visible progress`, async () => {
      const waiting = gate(), requestAbort = new AbortController()
      let closed = 0
      const service = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput, signal: AbortSignal) {
        try {
          yield { type: "reasoning", delta: "Visible", domTurnKey: input.promptKey }
          waiting.release()
          await new Promise<void>(resolve => {
            if (signal.aborted) resolve()
            else signal.addEventListener("abort", () => resolve(), { once: true })
          })
          throw Error("fixture cancelled")
        } finally { closed++ }
      }, async discard() {} } as never)
      const token = "a".repeat(64)
      const handler = createRequestHandler({ token, browser: service, shutdown: async () => undefined })
      const response = await handler(new Request(`http://127.0.0.1/v1/${endpoint}`, {
        method: "POST", signal: requestAbort.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gemini-3.1-flash-lite", stream: true,
          ...(endpoint === "responses" ? { input: "Explain." } : { messages: [{ role: "user", content: "Explain." }] }),
        }),
      }))
      const reader = response.body!.getReader(), decoder = new TextDecoder()
      let output = ""
      while (!output.includes("Visible")) output += decoder.decode((await reader.read()).value)
      await waiting.promise
      const cancelled = reader.cancel()
      try {
        expect(await beforeFinal(cancelled)).not.toBe("buffered")
        expect(closed).toBe(1)
        expect(output).not.toContain("[DONE]")
        expect(output).not.toContain("response.completed")
      } finally {
        requestAbort.abort()
        await cancelled
        reader.releaseLock()
      }
    })

    test(`${endpoint} exposes two early reasoning deltas before any answer or terminal event`, async () => {
      const second = gate(), final = gate()
      const token = "a".repeat(64)
      const service = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
        yield { type: "reasoning", delta: "Visible", domTurnKey: input.promptKey }
        await second.promise
        yield { type: "reasoning", delta: " summary.", domTurnKey: input.promptKey }
        await final.promise
        yield { type: "reasoning", delta: "native duplicate" }
        yield { type: "text", delta: `<aipass-envelope>${JSON.stringify({ type: "thinking", key: input.promptKey, text: "typed duplicate" })}</aipass-envelope>` }
        yield { type: "text", delta: envelope(input.promptKey) }
        yield { type: "finish", reason: "stop" }
      }, async discard() {} } as never)
      const handler = createRequestHandler({ token, browser: service, shutdown: async () => undefined })
      const pending = handler(new Request(`http://127.0.0.1/v1/${endpoint}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gemini-3.1-flash-lite", stream: true,
          ...(endpoint === "responses" ? { input: "Explain." } : { messages: [{ role: "user", content: "Explain." }], stream_options: { include_usage: true } }),
        }),
      }))
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let output = ""
      const decoder = new TextDecoder()
      try {
        const early = await beforeFinal(pending)
        expect(early).not.toBe("buffered")
        const response = await pending
        expect(response.status).toBe(200)
        reader = response.body!.getReader()
        const readUntil = async (text: string) => {
          while (!output.includes(text)) {
            const part = await reader!.read()
            if (part.done) throw Error("stream ended before expected delta")
            output += decoder.decode(part.value, { stream: true })
          }
        }
        expect(await beforeFinal(readUntil("Visible"))).not.toBe("buffered")
        expect(output).not.toContain("Answer.")
        expect(output).not.toContain("response.completed")
        expect(output).not.toContain("[DONE]")
        second.release()
        expect(await beforeFinal(readUntil(" summary."))).not.toBe("buffered")
        expect(output).not.toContain("Answer.")
        final.release()
        while (true) {
          const part = await reader.read()
          if (part.done) break
          output += decoder.decode(part.value, { stream: true })
        }
        expect(output).toContain("Answer.")
        expect(output).toContain('"usage":')
        expect(output).not.toContain("duplicate")
        const events = output.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)))
        const completionTokens = estimateTokens("Visible summary.Answer.")
        if (endpoint === "responses") {
          expect(output.match(/event: response.reasoning_summary_text.delta\n/g)).toHaveLength(2)
          expect(output.match(/event: response.completed\n/g)).toHaveLength(1)
          expect(output).toContain('"text":"Visible summary."')
          expect(events.at(-1).type).toBe("response.completed")
          expect(events.at(-1).response.usage.output_tokens).toBe(completionTokens)
          expect(events.at(-1).response.usage.total_tokens).toBe(events.at(-1).response.usage.input_tokens + completionTokens)
        } else {
          expect(output.match(/"reasoning_content":/g)).toHaveLength(2)
          expect(output.match(/data: \[DONE\]/g)).toHaveLength(1)
          expect(output).not.toContain('"content":"Visible')
          expect(events.at(-1).usage.completion_tokens).toBe(completionTokens)
          expect(events.at(-1).usage.total_tokens).toBe(events.at(-1).usage.prompt_tokens + completionTokens)
          expect(output.trimEnd().endsWith("data: [DONE]")).toBe(true)
        }
        expect(output).not.toContain("domTurnKey")
      } finally {
        second.release(); final.release()
        const response = await pending
        if (reader) { await reader.cancel(); reader.releaseLock() }
        else await response.body?.cancel()
      }
    })
  }

  for (const issue of ["outside-prose", "invalid-chat-payload"] as const) test(`chat/completions corrects ${issue} before publishing`, async () => {
    const token = "a".repeat(64)
    const submitted: BrowserTurnInput[] = []
    const service = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
      submitted.push(input)
      if (submitted.length === 1) {
        const value = issue === "outside-prose"
          ? `${envelope(input.promptKey, "one")} OUTSIDE ${envelope(input.promptKey, "two")}`
          : `<aipass-envelope>${JSON.stringify({ type: "chat", key: input.promptKey, id: "answer", text: 42 })}</aipass-envelope>`
        yield { type: "text", delta: value }
      } else yield { type: "text", delta: envelope(input.promptKey) }
      yield { type: "finish", reason: "stop" }
    }, async discard() {} } as never)
    const handler = createRequestHandler({ token, browser: service, shutdown: async () => undefined })
    const response = await handler(new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini-3.1-flash-lite", messages: [{ role: "user", content: "Explain." }] }),
    }))
    const output = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
    expect(response.status).toBe(200)
    expect(submitted).toHaveLength(2)
    expect(output.choices?.[0]?.message?.content).toBe("Answer.")
    expect(JSON.stringify(output)).not.toContain("OUTSIDE")
    expect(output.error).toBeUndefined()
  })
})
