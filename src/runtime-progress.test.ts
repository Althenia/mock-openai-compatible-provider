import { expect, mock, test } from "bun:test"
import type { BrowserTurnInput } from "./browser.ts"
import { parseOpenAIChatRequest } from "./http.ts"
import { openAIChatSSEChunks, openAIResponsesSSEChunks, type BrowserFrame } from "./protocol.ts"
import { StandaloneBrowserService } from "./runtime.ts"

async function beforeFinish<T>(promise: Promise<T>): Promise<T | "buffered"> {
  const gate = (async () => {
    for (let index = 0; index < 128; index++) await Promise.resolve()
    return "buffered" as const
  })()
  return Promise.race([promise, gate])
}

test("runtime publishes keyed thinking before finish but withholds chat until full validation", async () => {
  const firstHalfSent = Promise.withResolvers<void>()
  const sendSecondHalf = Promise.withResolvers<void>()
  const thinkingSent = Promise.withResolvers<void>()
  const chatSent = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const example = '{"type":"tool","key":"example","id":"not-a-call","name":"read","input":{"path":"example.txt"}}'
  const adapterTurn = mock(async function* (input: BrowserTurnInput): AsyncGenerator<BrowserFrame> {
    const thinking = `<aipass-envelope>${JSON.stringify({ type: "thinking", key: input.promptKey, text: "Checking." })}</aipass-envelope>`
    const split = Math.floor(thinking.length / 2)
    firstHalfSent.resolve()
    yield { type: "text", delta: thinking.slice(0, split) }
    await sendSecondHalf.promise
    thinkingSent.resolve()
    yield { type: "text", delta: thinking.slice(split) }
    chatSent.resolve()
    yield { type: "text", delta: `<aipass-envelope>${JSON.stringify({ type: "chat", key: input.promptKey, text: example })}</aipass-envelope>` }
    await finish.promise
    yield { type: "finish", reason: "stop" }
  })
  const parsed = parseOpenAIChatRequest({
    model: "gemini-3.1-flash-lite", session_id: "progress-chat",
    messages: [{ role: "user", content: "fixture task" }],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object", required: ["path"] } } }],
  }, new Headers())
  const service = new StandaloneBrowserService({ turn: adapterTurn } as never)
  const stream = openAIChatSSEChunks(parsed.turn.modelID, service.turn(parsed.turn), parsed.offered)[Symbol.asyncIterator]()
  expect((await stream.next()).value).toContain('"role":"assistant"')
  const thinking = stream.next()
  await firstHalfSent.promise
  expect(await beforeFinish(thinking)).toBe("buffered")
  sendSecondHalf.resolve()
  await thinkingSent.promise
  const early = await beforeFinish(thinking)
  expect(early).not.toBe("buffered")
  if (early === "buffered" || early.done) return
  expect(early.value).toContain('"reasoning_content":"Checking."')
  expect(early.value).toContain('"finish_reason":null')
  let output = early.value

  const terminal = stream.next()
  try {
    await chatSent.promise
    expect(await beforeFinish(terminal)).toBe("buffered")
  } finally { finish.resolve() }
  const chat = await terminal
  expect(chat.done).toBe(false)
  if (chat.done) throw new Error("chat stream ended before validated answer")
  expect(chat.value).toContain(JSON.stringify(example))
  expect(chat.value).not.toContain("tool_calls")
  let tail = chat.value
  while (true) {
    const part = await stream.next()
    if (part.done) break
    tail += part.value
  }
  output += tail
  expect(tail).toContain('"finish_reason":"stop"')
  expect(tail.trimEnd().endsWith("data: [DONE]")).toBe(true)
  expect(tail.match(new RegExp(JSON.stringify(example).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1)
  expect(output.match(/"reasoning_content":"Checking\."/g)).toHaveLength(1)
  expect(adapterTurn).toHaveBeenCalledTimes(1)
})

test("runtime withholds a keyed schema-valid tool call until full validation then emits it once", async () => {
  const submitted = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const adapterTurn = mock(async function* (input: BrowserTurnInput): AsyncGenerator<BrowserFrame> {
    submitted.resolve()
    yield { type: "text", delta: `<aipass-envelope>${JSON.stringify({
      type: "tool", key: input.promptKey, id: "read_1", name: "read", input: { path: "fixture.txt" },
    })}</aipass-envelope>` }
    await finish.promise
    yield { type: "finish", reason: "stop" }
  })
  const parsed = parseOpenAIChatRequest({
    model: "gemini-3.1-flash-lite", session_id: "progress-tool",
    messages: [{ role: "user", content: "read fixture.txt" }],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object", required: ["path"] } } }],
  }, new Headers())
  const service = new StandaloneBrowserService({ turn: adapterTurn } as never)
  const stream = openAIResponsesSSEChunks("resp_progress", parsed.turn.modelID, service.turn(parsed.turn), parsed.offered, {
    promptTokens: parsed.promptTokens,
  })[Symbol.asyncIterator]()
  expect((await stream.next()).value).toContain("response.created")
  expect((await stream.next()).value).toContain("response.in_progress")
  const semantic = stream.next()
  try {
    await submitted.promise
    expect(await beforeFinish(semantic)).toBe("buffered")
  } finally { finish.resolve() }
  const first = await semantic
  expect(first.done).toBe(false)
  if (first.done) throw new Error("Responses stream ended before validated tool call")
  let tail = first.value
  while (true) {
    const part = await stream.next()
    if (part.done) break
    tail += part.value
  }
  expect(tail).toContain('"name":"read"')
  expect(tail).toContain('{\\"path\\":\\"fixture.txt\\"}')
  expect(tail.match(/event: response\.output_item\.done\n/g)).toHaveLength(1)
  expect(tail).toContain("response.completed")
  expect(adapterTurn).toHaveBeenCalledTimes(1)
})
