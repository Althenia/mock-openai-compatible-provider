import { describe, expect, test } from "bun:test"
import { BrowserResponse, type BrowserProtocol, type BrowserTurnInput } from "./browser.ts"
import { estimateTokens } from "./context.ts"
import { parseOpenAIChatRequest } from "./http.ts"
import { collectOpenAIChatResult, envelopesMatchTurnKey, hasTerminalEnvelope, hasThinkingOnlyEnvelope, repairMalformedTextEnvelope, StreamFrameParser, TypedEnvelopeShim, validateStrictEnvelopeResponse, type BrowserFrame } from "./protocol.ts"
import { StandaloneBrowserService } from "./runtime.ts"
import { createRequestHandler } from "./server.ts"

const key = "fixture-turn"
const write = { id: "write_1", name: "write", input: { path: "hello.txt", content: "aipass\nไทย" } }
const mcp = { id: "mcp_1", name: "mcp__fixture__lookup", input: { query: 'quoted "text" {braces}', filters: { kinds: ["file", "folder"] }, limit: 2 } }
const question = { questions: [{ header: "Choose", question: "Which file?", options: [{ label: "First", description: "First file" }] }] }
const cases: Array<{ name: string; value: Record<string, unknown>; expected: BrowserFrame[] }> = [
  { name: "chat", value: { type: "chat", text: "Test received!" }, expected: [{ type: "text", delta: "Test received!" }] },
  { name: "thinking", value: { type: "thinking", text: "Visible reasoning." }, expected: [{ type: "reasoning", delta: "Visible reasoning." }] },
  { name: "write", value: { type: "tool", ...write }, expected: [{ type: "tool-call", ...write }] },
  { name: "MCP", value: { type: "tool", ...mcp }, expected: [{ type: "tool-call", ...mcp }] },
  { name: "plan", value: { type: "plan", steps: [write, mcp] }, expected: [{ type: "tool-call", ...write }, { type: "tool-call", ...mcp }] },
  ...["subagent", "skill", "question", "permission"].map(type => ({
    name: type, value: { type, input: type === "question" ? question : { id: "fixture" } },
    expected: [{ type: "tool-call" as const, id: "envelope_1", name: type, input: type === "question" ? question : { id: "fixture" } }],
  })),
]
const offered = new Set(["write", mcp.name, "subagent", "skill", "question", "permission"])
const wrap = (value: object, tagged: boolean) => tagged ? `<aipass-envelope>${JSON.stringify(value)}</aipass-envelope>` : JSON.stringify(value)
const prefixed = (value: object, tagged = false) => `TURN KEY: ${key}\n\n${wrap({ key, id: "envelope_1", ...value }, tagged)}`

describe("echoed turn-key response routing", () => {
  test("whole-response coverage is strict only for keyed runtime validation", () => {
    const first = wrap({ type: "chat", key, id: "one", text: "one" }, true)
    const second = wrap({ type: "chat", key, id: "two", text: "two" }, true)
    const source = `${first} OUTSIDE ${second}`
    const permissive = new TypedEnvelopeShim(offered)
    expect([...permissive.push(source), ...permissive.finish()]).toEqual([
      { type: "text", delta: "one" },
      { type: "text", delta: " OUTSIDE " },
      { type: "text", delta: "two" },
    ])
    expect(() => validateStrictEnvelopeResponse(source, offered)).toThrow("outside envelopes")
  })

  for (const tagged of [false, true])
  for (const split of [false, true])
  for (const fixture of cases) test(`${tagged ? "tagged" : "bare"} ${fixture.name}, ${split ? "split at every character" : "one chunk"}`, () => {
    const source = prefixed(fixture.value, tagged)
    const shim = new TypedEnvelopeShim(offered)
    const frames = (split ? [...source] : [source]).flatMap(chunk => shim.push(chunk))
    frames.push(...shim.finish())
    expect(frames).toEqual(fixture.expected)
    expect(hasTerminalEnvelope(source)).toBe(fixture.name !== "thinking")
    expect(hasThinkingOnlyEnvelope(source)).toBe(fixture.name === "thinking")
  })

  test("preserves an ordered bare thinking/action chain and exact MCP namespace", async () => {
    const raw = prefixed({ type: "thinking", text: "Checking." }) + "\n" + JSON.stringify({ type: "tool", key, ...mcp })
    const result = await collectOpenAIChatResult([{ type: "text", delta: raw }, { type: "finish", reason: "stop" }], offered)
    expect(result).toMatchObject({ text: "", reasoning: "Checking.", toolCalls: [mcp], finishReason: "tool-calls" })
  })

  for (const source of [
    "TURN", "TURN KEY:", "TURN KEY: notes\n\nordinary explanation",
    'TURN KEY: notes\n\n{"type":"record","value":"ordinary data"}',
    'TURN KEY: notes\n\n{"type":"chat","text":',
    'TURN KEY: notes\n\n{"type":"chat","key":"notes","text":"example"} is an example',
  ]) test(`preserves non-envelope or incomplete text: ${source.slice(0, 36)}`, () => {
    const shim = new TypedEnvelopeShim(offered)
    const frames = [...source].flatMap(chunk => shim.push(chunk))
    frames.push(...shim.finish())
    expect(frames.filter(frame => frame.type === "text").map(frame => frame.delta).join("")).toBe(source)
    expect(frames.every(frame => frame.type === "text")).toBe(true)
  })

  for (const tagged of [false, true]) test(`validates echoed and embedded keys before ${tagged ? "tagged" : "bare"} conversion`, () => {
    const valid = prefixed({ type: "tool", ...mcp }, tagged)
    expect(envelopesMatchTurnKey(valid, key)).toBe(true)
    expect(envelopesMatchTurnKey(valid.replace(`TURN KEY: ${key}`, "TURN KEY: wrong-turn"), key)).toBe(false)
    const wrong = prefixed({ type: "tool", ...mcp, key: "wrong-turn" }, tagged)
    expect(envelopesMatchTurnKey(wrong, key)).toBe(false)
    const shim = new TypedEnvelopeShim(offered)
    expect(() => [...shim.push(wrong), ...shim.finish()]).toThrow("TURN KEY mismatch")
  })

  for (const invalid of [
    { type: "tool", ...mcp, name: "mcp__unoffered__lookup" },
    { type: "tool", ...mcp, input: "invalid" },
    { type: "plan", steps: [mcp, { ...write, name: "unoffered" }] },
  ]) test(`rejects invalid ${invalid.type} before dispatch`, () => {
    const shim = new TypedEnvelopeShim(offered)
    expect(() => [...shim.push(prefixed(invalid)), ...shim.finish()]).toThrow()
  })

  test("no offered tools cannot become a client action", async () => {
    const result = await collectOpenAIChatResult([{ type: "text", delta: prefixed({ type: "tool", ...mcp }) }, { type: "finish", reason: "stop" }], new Set())
    expect(result.toolCalls).toEqual([])
    const chat = await collectOpenAIChatResult([{ type: "text", delta: prefixed({ type: "chat", text: "Hello." }) }, { type: "finish", reason: "stop" }], new Set())
    expect(chat.text).toBe("Hello.")
  })

  test("bounds buffering of a possible echoed preamble", () => {
    const shim = new TypedEnvelopeShim(offered)
    expect(() => { shim.push(`TURN KEY: ${"x".repeat(64 * 1024)}`) }).toThrow("size limit")
  })

  for (const separator of ["\n", "\r\n", "\r\n\r\n"]) test(`accepts line-break whitespace ${JSON.stringify(separator)} without changing MCP attribution`, () => {
    const shim = new TypedEnvelopeShim(offered)
    const source = `TURN KEY: ${key}${separator}${JSON.stringify({ type: "tool", key, ...mcp })}`
    expect([...shim.push(source), ...shim.finish()]).toEqual([{ type: "tool-call", ...mcp }])
    expect(envelopesMatchTurnKey(source, key)).toBe(true)
  })

  for (const type of ["chat", "MCP"])
  for (const format of ["bare", "split-bare", "tagged"])
  test(`preserves existing large ${format} ${type} payload support`, () => {
    const payload = "x".repeat(70 * 1024)
    const value = type === "chat" ? { type: "chat", text: payload } : { type: "tool", ...mcp, input: { query: payload } }
    const source = prefixed(value, format === "tagged")
    const shim = new TypedEnvelopeShim(offered)
    const frames: BrowserFrame[] = []
    const size = format === "split-bare" ? 1024 : source.length
    for (let offset = 0; offset < source.length; offset += size) frames.push(...shim.push(source.slice(offset, offset + size)))
    frames.push(...shim.finish())
    expect(frames).toEqual(type === "chat" ? [{ type: "text", delta: payload }] : [{ type: "tool-call", ...mcp, input: { query: payload } }])
  })

  test("retains the existing incomplete tagged-frame limit after an echoed key", () => {
    const shim = new TypedEnvelopeShim(offered)
    expect(() => { shim.push(`TURN KEY: ${key}\n\n<aipass-envelope>{"type":"chat","text":"${"x".repeat(64 * 1024)}`) }).toThrow("size limit")
  })

  test("does not buffer ordinary prose after a complete echoed-looking header", () => {
    const source = `TURN KEY: notes\n\nAn ordinary explanation. ${"x".repeat(70 * 1024)}`
    const shim = new TypedEnvelopeShim(offered)
    const frames = shim.push(source)
    expect(frames).toEqual([{ type: "text", delta: source }])
    expect(shim.finish()).toEqual([])
  })

  test("native completion and DOM accounting recognize the same prefixed envelopes", () => {
    const protocol: BrowserProtocol<BrowserFrame> = {
      decoder: () => new StreamFrameParser(), text: delta => ({ type: "text", delta }),
      reasoning: delta => ({ type: "reasoning", delta }), finish: reason => ({ type: "finish", reason }), isTerminal: frame => frame.type === "finish",
    }
    const response = new BrowserResponse(protocol)
    response.progress({ assistantCount: 1, complete: false, settled: false, text: "", attributed: true, thinking: [{ title: "", body: "Visible." }] }, key)
    const raw = prefixed({ type: "thinking", text: "Visible." }) + "\n" + JSON.stringify({ type: "tool", key, ...mcp })
    response.push(`data: ${JSON.stringify({ type: "text", delta: raw })}\n\n`)
    expect(response.finish()).toEqual([{ type: "text", delta: raw }, { type: "finish", reason: "stop" }])
    expect(response.outputEstimate).toBe(estimateTokens("Visible.") + estimateTokens(mcp.name + JSON.stringify(mcp.input)))
  })

  for (const endpoint of ["chat/completions", "responses"] as const)
  for (const stream of [false, true]) test(`${endpoint} ${stream ? "SSE" : "JSON"} routes prefixed write and MCP calls, then literal chat text`, async () => {
    const example = prefixed({ type: "tool", ...mcp })
    let submissions = 0
    const browser = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
      submissions++
      const values = [
        { type: "thinking", key: input.promptKey, id: "reason", text: "Visible reasoning." },
        { type: "plan", key: input.promptKey, id: "plan", steps: [write, mcp] },
        { type: "chat", key: input.promptKey, id: "answer", text: example },
      ]
      const raw = `TURN KEY: ${input.promptKey}\n\n${values.map(value => JSON.stringify(value)).join("\n")}`
      for (const delta of raw) yield { type: "text", delta }
      yield { type: "finish", reason: "stop" }
    }, async discard() {} } as never)
    const handler = createRequestHandler({ token: "fixture-token", browser, shutdown: async () => {} })
    const tools = [write.name, mcp.name].map(name => ({ name, parameters: { type: "object" } }))
    const body = endpoint === "chat/completions"
      ? { model: "gemini-3.1-flash-lite", stream, messages: [{ role: "user", content: "Use the write and lookup tools." }], tools: tools.map(tool => ({ type: "function", function: tool })) }
      : { model: "gemini-3.1-flash-lite", stream, input: "Use the write and lookup tools.", tools: tools.map(tool => ({ type: "function", ...tool })) }
    const response = await handler(new Request(`http://localhost/v1/${endpoint}`, { method: "POST", headers: { authorization: "Bearer fixture-token", "content-type": "application/json" }, body: JSON.stringify(body) }))
    expect(response.status).toBe(200)
    if (!stream) {
      const result = await response.json()
      if (endpoint === "chat/completions") {
        expect(result.choices[0].message).toMatchObject({ content: example, reasoning_content: "Visible reasoning.", tool_calls: [write, mcp].map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } })) })
        expect(result.choices[0].finish_reason).toBe("tool_calls")
      } else {
        expect(result.output.filter((item: { type: string }) => item.type === "function_call")).toMatchObject([write, mcp].map(call => ({ call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) })))
        expect(result.output.find((item: { type: string }) => item.type === "message").content[0].text).toBe(example)
        expect(result.output.find((item: { type: string }) => item.type === "reasoning").summary[0].text).toBe("Visible reasoning.")
      }
    } else {
      const raw = await response.text()
      const events = raw.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)))
      if (endpoint === "chat/completions") {
        const deltas = events.flatMap(event => event.choices ?? []).map(choice => choice.delta)
        expect(deltas.map(delta => delta.content ?? "").join("")).toBe(example)
        expect(deltas.map(delta => delta.reasoning_content ?? "").join("")).toBe("Visible reasoning.")
        expect(deltas.flatMap(delta => delta.tool_calls ?? [])).toMatchObject([write, mcp].map(call => ({ id: call.id, function: { name: call.name, arguments: JSON.stringify(call.input) } })))
        expect(raw.match(/data: \[DONE\]/g)).toHaveLength(1)
      } else {
        expect(events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join("")).toBe(example)
        expect(events.filter(event => event.type === "response.reasoning_summary_text.delta").map(event => event.delta).join("")).toBe("Visible reasoning.")
        expect(events.filter(event => event.type === "response.output_item.done" && event.item.type === "function_call").map(event => event.item)).toMatchObject([write, mcp].map(call => ({ call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) })))
        expect(events.filter(event => event.type === "response.completed")).toHaveLength(1)
      }
    }
    expect(submissions).toBe(1)
  })

  test("salvages a chat envelope whose text contains unescaped quotes", async () => {
    // Live evidence: a rating answer containing "Version 1" broke JSON.parse,
    // so the raw envelope leaked to the client as chat text.
    const malformed = `{"type":"chat","key":"${key}","id":"answer_1","text":"Rating: 9/10. Notes "Version 1" limits."}`
    expect(() => JSON.parse(malformed)).toThrow()
    const repaired = repairMalformedTextEnvelope(malformed)
    expect(repaired).toBeDefined()
    expect(JSON.parse(repaired!).text).toBe('Rating: 9/10. Notes "Version 1" limits.')
    const shim = new TypedEnvelopeShim(offered)
    const frames = [...malformed].flatMap(chunk => shim.push(chunk))
    frames.push(...shim.finish())
    expect(frames).toEqual([{ type: "text", delta: 'Rating: 9/10. Notes "Version 1" limits.' }])
    const result = await collectOpenAIChatResult([{ type: "text", delta: malformed }, { type: "finish", reason: "stop" }], offered)
    expect(result.text).toBe('Rating: 9/10. Notes "Version 1" limits.')
  })

  for (const prefixed of [false, true]) test(`valid chat followed by an action is not salvaged as chat (${prefixed ? "prefixed" : "bare"})`, async () => {
    const chain = [
      { type: "chat", key, text: "Reading the fixture." },
      { type: "tool", key, ...mcp },
    ].map(value => JSON.stringify(value)).join("\n")
    const result = await collectOpenAIChatResult([
      { type: "text", delta: `${prefixed ? `TURN KEY: ${key}\n\n` : ""}${chain}` },
      { type: "finish", reason: "stop" },
    ], offered)
    expect(result.text).toBe("Reading the fixture.")
    expect(result.toolCalls).toMatchObject([{ id: mcp.id, name: mcp.name, input: mcp.input }])
  })

  test("malformed-envelope repair stays narrow", () => {
    // Valid envelopes bypass repair (undefined); tool envelopes never repair.
    expect(repairMalformedTextEnvelope(JSON.stringify({ type: "chat", key, id: "a", text: "plain ok" }))).toBeUndefined()
    expect(repairMalformedTextEnvelope(JSON.stringify({ type: "tool", name: "read", input: {} }))).toBeUndefined()
    expect(repairMalformedTextEnvelope("not json")).toBeUndefined()
    expect(repairMalformedTextEnvelope(JSON.stringify({ type: "chat", key, id: "a", text: "" }))).toBeUndefined()
    const thinking = `{"type":"thinking","key":"${key}","id":"t","text":"Thought "quoted" here"}`
    expect(JSON.parse(repairMalformedTextEnvelope(thinking)!).text).toBe('Thought "quoted" here')
  })

  test("runtime rejects a mismatched echoed key without exposing a tool call", async () => {
    const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", messages: [{ role: "user", content: "lookup fixture" }], tools: [{ type: "function", function: { name: mcp.name, parameters: { type: "object" } } }] }, new Headers())
    let submissions = 0
    const browser = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
      submissions++
      yield { type: "text", delta: `TURN KEY: wrong-turn\n\n${JSON.stringify({ type: "tool", key: input.promptKey, ...mcp })}` }
      yield { type: "finish", reason: "stop" }
    }, async discard() {} } as never)
    await expect(collectOpenAIChatResult(browser.turn(parsed.turn), parsed.offered)).rejects.toThrow("TURN KEY mismatch")
    expect(submissions).toBe(2)
  })

  for (const endpoint of ["chat/completions", "responses"] as const) test(`${endpoint} returns a client's MCP result to the next typed chat turn`, async () => {
    const resultText = `fixture-result-${crypto.randomUUID()}`
    let submissions = 0
    const browser = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
      const first = ++submissions === 1
      if (!first) {
        expect(input.incrementalPrompt).toContain(resultText)
        expect(input.incrementalPrompt).toContain(mcp.id)
        expect(input.toolContinuation).toBe(true)
      }
      const value = first ? { type: "tool", ...mcp } : { type: "chat", id: "answer", text: resultText }
      yield { type: "text", delta: `TURN KEY: ${input.promptKey}\n\n${JSON.stringify({ ...value, key: input.promptKey })}` }
      yield { type: "finish", reason: "stop" }
    }, async discard() {} } as never)
    const handler = createRequestHandler({ token: "fixture-token", browser, shutdown: async () => {} })
    const fn = { name: mcp.name, parameters: { type: "object" } }
    const tools = [endpoint === "chat/completions" ? { type: "function", function: fn } : { type: "function", ...fn }]
    const request = (body: object) => handler(new Request(`http://localhost/v1/${endpoint}`, {
      method: "POST", headers: { authorization: "Bearer fixture-token", "content-type": "application/json", "x-session-id": "mcp-continuation" },
      body: JSON.stringify({ model: "gemini-3.1-flash-lite", tools, ...body }),
    }))
    const user = { role: "user", content: "Use the offered lookup tool." }
    const initial = await request(endpoint === "chat/completions" ? { messages: [user] } : { input: user.content })
    expect(initial.status).toBe(200)
    const value = await initial.json()
    const call = endpoint === "chat/completions" ? value.choices[0].message.tool_calls[0].function : value.output.find((item: { type: string }) => item.type === "function_call")
    expect(call.name).toBe(mcp.name)
    expect(JSON.parse(call.arguments)).toEqual(mcp.input)
    const followup = await request(endpoint === "chat/completions"
      ? { messages: [user, value.choices[0].message, { role: "tool", tool_call_id: mcp.id, content: resultText }] }
      : { previous_response_id: value.id, input: [{ type: "function_call_output", call_id: mcp.id, output: resultText }] })
    expect(followup.status).toBe(200)
    const final = await followup.json()
    expect(endpoint === "chat/completions" ? final.choices[0].message.content : final.output.find((item: { type: string }) => item.type === "message").content[0].text).toBe(resultText)
    expect(submissions).toBe(2)
  })
})
