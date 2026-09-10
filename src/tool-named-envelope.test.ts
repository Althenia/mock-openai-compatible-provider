import { expect, test } from "bun:test"
import { BrowserResponse, type BrowserProtocol, type BrowserTurnInput } from "./browser.ts"
import { parseOpenAIChatRequest } from "./http.ts"
import { collectOpenAIChatResult, envelopeKeys, envelopesMatchTurnKey, hasTerminalEnvelope, parseTypedEnvelope, StreamFrameParser, TypedEnvelopeShim, type BrowserFrame } from "./protocol.ts"
import { StandaloneBrowserService } from "./runtime.ts"
import { createRequestHandler } from "./server.ts"

const key = "synthetic-turn"
const edit = { filePath: "fixture.md", oldString: "before", newString: "after" }
const todos = { todos: [{ content: "Edit requested; awaiting result", status: "in_progress", priority: "medium" }] }
const names = ["edit", "todowrite", "mcp__fixture__lookup", "custom.action:V2"]
const offered = new Set(names)
const chain = [
  { type: "thinking", key, id: "reason_1", text: "Preparing changes." },
  { type: "edit", key, id: "edit_1", ...edit },
  { type: "todowrite", key, id: "todo_1", ...todos },
]
const protocol: BrowserProtocol<BrowserFrame> = {
  decoder: () => new StreamFrameParser(), text: delta => ({ type: "text", delta }),
  finish: reason => ({ type: "finish", reason }), isTerminal: frame => frame.type === "finish",
}

for (const name of names) for (const nested of [false, true]) test(`normalizes exact offered name ${name}, nested=${nested}`, () => {
  const input = { note: 'quoted "text"', metadata: { type: "record", key: "argument-key", id: "argument-id" } }
  const value = { type: name, key, id: "call_1", ...(nested ? { input } : input) }
  expect(parseTypedEnvelope(value, offered)).toEqual([{ type: "tool-call", id: "call_1", name, input }])
  expect(parseTypedEnvelope({ type: "tool", key, id: "call_1", name, input }, offered)).toEqual([
    { type: "tool-call", id: "call_1", name, input },
  ])
})

for (const tagged of [false, true]) test(`thinking and tool-named chain survives character streaming, tagged=${tagged}`, async () => {
  const text = chain.map(value => tagged ? `<aipass-envelope>${JSON.stringify(value)}</aipass-envelope>` : JSON.stringify(value)).join("")
  const source = `TURN KEY: ${key}\n\n${text}`
  const shim = new TypedEnvelopeShim(offered, true)
  const frames = [...source].flatMap(chunk => shim.push(chunk))
  frames.push(...shim.finish())
  expect(frames).toEqual([
    { type: "reasoning", delta: "Preparing changes." },
    { type: "tool-call", id: "edit_1", name: "edit", input: edit },
    { type: "tool-call", id: "todo_1", name: "todowrite", input: todos },
  ])
  expect(envelopeKeys(text)).toEqual([key, key, key])
  expect(envelopesMatchTurnKey(source, key)).toBe(true)
  expect(envelopesMatchTurnKey(source.replace(`TURN KEY: ${key}`, "TURN KEY: other"), key)).toBe(false)
  expect(hasTerminalEnvelope(source)).toBe(true)
  const result = await collectOpenAIChatResult([{ type: "text", delta: source }, { type: "finish", reason: "stop" }], offered)
  expect(result).toMatchObject({ text: "", reasoning: "Preparing changes.", finishReason: "tool-calls" })
  expect(result.toolCalls).toHaveLength(2)
})

test("tool-named actions finish captured browser output without waiting for DOM fallback", () => {
  const text = chain.map(value => JSON.stringify(value)).join("")
  const response = new BrowserResponse(protocol)
  response.push(`data: ${JSON.stringify({ type: "text", delta: text })}\n\ndata: [DONE]\n\n`)
  expect(response.finish()).toEqual([{ type: "text", delta: text }, { type: "finish", reason: "stop" }])
  expect(response.finish()).toEqual([])
})

test("rejects ambiguous arguments and invalid transport fields without guessing", () => {
  for (const extra of [
    { input: edit, filePath: "conflict.md" }, { input: [] }, { input: null }, { input: "text" },
    { key: undefined }, { key: "" }, { id: undefined }, { id: "invalid id" },
  ]) expect(() => parseTypedEnvelope({ type: "edit", key, id: "call_1", ...extra }, offered)).toThrow()
  expect(parseTypedEnvelope({ type: "edit", key, id: "call_1", input: { name: "argument-name", type: "argument-type" } }, offered)).toEqual([
    { type: "tool-call", id: "call_1", name: "edit", input: { name: "argument-name", type: "argument-type" } },
  ])
})

test("unoffered names, case changes, and ordinary JSON cannot dispatch", async () => {
  for (const name of ["Edit", "not_offered"]) {
    await expect(collectOpenAIChatResult([{ type: "text", delta: JSON.stringify({ type: name, key, id: "call_1", ...edit }) }, { type: "finish", reason: "stop" }], offered)).rejects.toThrow("not offered")
  }
  expect(parseTypedEnvelope({ type: "record", value: 1 }, offered)).toBeUndefined()
  expect(hasTerminalEnvelope('{"type":"record","value":1}')).toBe(false)
  expect(() => parseTypedEnvelope({ type: "edit", key, id: "call_1", ...edit }, new Set())).toThrow("not offered")
})

test("attribution rejects stale, missing, and truncated tool-named keys", () => {
  for (const value of [{ type: "edit", id: "call_1", key: "old", ...edit }, { type: "edit", id: "call_1", ...edit }]) {
    expect(envelopesMatchTurnKey(JSON.stringify(value), key)).toBe(false)
  }
  const truncated = '{"type":"edit","key":"synthetic-turn","id":"call_1","filePath":'
  expect(hasTerminalEnvelope(truncated)).toBe(false)
  expect(envelopesMatchTurnKey(truncated, key)).toBe(false)
})

test("a conflicting later action cannot leak an earlier action through runtime", async () => {
  const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", session_id: "atomic-tools",
    messages: [{ role: "user", content: "Edit fixture." }],
    tools: [{ type: "function", function: { name: "edit", parameters: { type: "object" } } }],
  }, new Headers())
  const exposed: BrowserFrame[] = []
  let submissions = 0
  const service = new StandaloneBrowserService({ async *turn(turn: BrowserTurnInput) {
    submissions++
    yield { type: "text", delta: JSON.stringify({ type: "edit", key: turn.promptKey, id: "first", ...edit }) }
    yield { type: "text", delta: JSON.stringify({ type: "edit", key: turn.promptKey, id: "second", input: edit, filePath: "conflict.md" }) }
    yield { type: "finish", reason: "stop" }
  } } as never)
  await expect(async () => { for await (const frame of service.turn(parsed.turn)) exposed.push(frame) }).toThrow("conflicting")
  expect(exposed).toEqual([])
  expect(submissions).toBe(1)
})

test("runtime forwards tool-named arguments unchanged for harness validation without provisioning or repair", async () => {
  const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", session_id: "dynamic-tools",
    messages: [{ role: "user", content: "Inspect the synthetic fixture." }],
    tools: [{ type: "function", function: { name: "edit", parameters: { type: "object", required: ["filePath"] } } }],
  }, new Headers())
  let submissions = 0
  const input = { note: "I cannot access files here.", metadata: { id: "nested", name: "read", input: {} } }
  const service = new StandaloneBrowserService({ async *turn(turn: BrowserTurnInput) {
    submissions++
    yield { type: "text", delta: JSON.stringify({ type: "edit", key: turn.promptKey, id: "call_1", ...input }) }
    yield { type: "finish", reason: "stop" }
  } } as never)
  const result = await collectOpenAIChatResult(service.turn(parsed.turn), parsed.offered)
  expect(submissions).toBe(1)
  expect(result.toolCalls).toEqual([{ id: "call_1", name: "edit", input }])
})

for (const endpoint of ["chat/completions", "responses"]) test(`${endpoint} returns normalized tool calls, not raw JSON text`, async () => {
  const browser = new StandaloneBrowserService({ async *turn(turn: BrowserTurnInput) {
    yield { type: "text", delta: JSON.stringify({ type: "edit", key: turn.promptKey, id: "call_1", ...edit }) }
    yield { type: "finish", reason: "stop" }
  } } as never)
  const handler = createRequestHandler({ token: "synthetic", browser, shutdown: async () => {} })
  const definition = { name: "edit", parameters: { type: "object" } }
  const body = endpoint === "responses"
    ? { input: "Edit fixture.", tools: [{ type: "function", ...definition }] }
    : { messages: [{ role: "user", content: "Edit fixture." }], tools: [{ type: "function", function: definition }] }
  const response = await handler(new Request(`http://localhost/v1/${endpoint}`, { method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json" }, body: JSON.stringify({ model: "gemini-3.1-flash-lite", session_id: "fixture", ...body }) }))
  expect(response.status).toBe(200)
  const result = await response.json()
  if (endpoint === "responses") expect(result.output).toContainEqual({ type: "function_call", id: expect.any(String), call_id: "call_1", name: "edit", arguments: JSON.stringify(edit), status: "completed" })
  else expect(result.choices[0].message.tool_calls).toEqual([{ id: "call_1", type: "function", function: { name: "edit", arguments: JSON.stringify(edit) } }])
})
