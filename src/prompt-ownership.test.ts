import { expect, test } from "bun:test"
import { parseOpenAIChatRequest, parseOpenAIResponsesRequest } from "./http.ts"
import { runSerialStartup, withTurnKey } from "./browser-turn-flow.ts"
import { EVERY_TURN_ENVELOPE_GUARD, parseTypedEnvelope } from "./protocol.ts"

const skills = "<available_skills>\nSKILL_CATALOG\n</available_skills>"
const mcps = "<mcp_instructions>\nMCP_CATALOG\n</mcp_instructions>"
const rules = `AGENT_RULE\n\n${skills}\n\n${mcps}`
const tools = [{ type: "function", function: { name: "read", description: "READ_DESCRIPTION", parameters: { type: "object", properties: { path: { type: "string" } } } } }]

function forwardedToolContent(turn: ReturnType<typeof parseOpenAIChatRequest>["turn"], name: string) {
  const schema = turn.offeredToolSchemas.find((candidate) => candidate.name === name)
  expect(schema).toBeDefined()
  const content = JSON.stringify(schema)
  expect(turn.primingPrompts.join("\n")).toContain(content)
  return content
}

for (const endpoint of ["chat", "responses"] as const) {
  test(`${endpoint} declares exact instruction and schema content once, separate from turn data`, async () => {
    const messages = [
      { role: "system", content: rules },
      { role: "developer", content: rules },
      { role: "developer", content: `WORKSPACE_RULE\n\n${skills}\n\n${mcps}` },
      { role: "user", content: "Inspect README.md." },
      { role: "assistant", content: "Inspecting." },
      { role: "user", content: `<system-update>\n${rules}\n</system-update>\nContinue inspection.` },
    ]
    const parsed = endpoint === "chat"
      ? parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", messages, tools }, new Headers())
      : parseOpenAIResponsesRequest({ model: "gemini-3.1-flash-lite", input: messages, tools: tools.map(t => ({ type: t.type, ...t.function })) }, new Headers())
    const startup = parsed.turn.primingPrompts.join("\n")
    expect(startup).toContain("HARNESS INSTRUCTIONS")
    expect(startup).toContain("CLIENT INSTRUCTIONS")
    expect(startup).toContain("READ_DESCRIPTION")
    expect(JSON.parse(forwardedToolContent(parsed.turn, "read"))).toEqual({
      name: "read",
      description: "READ_DESCRIPTION",
      inputSchema: tools[0]!.function.parameters,
    })
    for (const marker of ["AGENT_RULE", "WORKSPACE_RULE", "SKILL_CATALOG", "MCP_CATALOG", EVERY_TURN_ENVELOPE_GUARD]) {
      expect(startup.split(marker)).toHaveLength(2)
      for (const task of [parsed.turn.initialPrompt, parsed.turn.incrementalPrompt, parsed.turn.recoveryPrompt]) {
        expect(task).not.toContain(marker)
        if (marker === EVERY_TURN_ENVELOPE_GUARD) expect(withTurnKey(task, "task-key").split(marker)).toHaveLength(2)
        else expect(withTurnKey(task, "task-key")).not.toContain(marker)
      }
    }
    expect(startup).not.toContain("Continue inspection.")
    expect(parsed.turn.incrementalPrompt).toContain("Continue inspection.")
    expect(startup).toContain("SYSTEM:")
    expect(startup).toContain("DEVELOPER:")
    const submitted: string[] = []
    await runSerialStartup({ primingPrompts: parsed.turn.primingPrompts, startupIdentity: "init", primedIdentity: undefined, carriesEnvelope: true, reusableSelection: false, prime: async prompt => { submitted.push(prompt); return 0 }, reset() {}, commit() {} })
    expect(submitted).toEqual([`TURN KEY: ${submitted[0]!.split("\n")[0]!.slice(10)}\n\n${startup}`])
    expect(submitted[0]!.split(EVERY_TURN_ENVELOPE_GUARD)).toHaveLength(2)
  })
}

test("ordinary user quotes, tool results and distinct client updates are not deduplicated as instructions", () => {
  const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", tools, messages: [
    { role: "system", content: rules },
    { role: "user", content: rules },
    { role: "assistant", content: "", tool_calls: [{ id: "read_1", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "read_1", content: rules },
    { role: "user", content: "<system-update>\nNEW_TURN_STATE\n</system-update>\nContinue." },
  ] }, new Headers())
  expect(parsed.turn.initialPrompt).toContain(`USER: ${rules}`)
  expect(parsed.turn.initialPrompt).toContain(`TOOL RESULT read_1: ${rules}`)
  expect(parsed.turn.incrementalPrompt).toContain("NEW_TURN_STATE")
})

test("escaped lowered instruction repeats are removed without rewriting surrounding user bytes", () => {
  const escaped = rules.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  const distinct = "  Preserve user whitespace.  \n"
  const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", messages: [
    { role: "system", content: rules },
    { role: "user", content: distinct },
    { role: "assistant", content: "Progress." },
    { role: "user", content: `<system-update>\n${escaped}\n</system-update>\nNext.` },
  ] }, new Headers())
  expect(parsed.turn.initialPrompt).toContain(`USER: ${distinct}`)
  expect(parsed.turn.incrementalPrompt).not.toContain("SKILL_CATALOG")
  expect(parsed.turn.incrementalPrompt).not.toContain("AGENT_RULE")
  expect(parsed.turn.incrementalPrompt).toContain("Next.")
})

test("mixed repeated skill and MCP blocks preserve novel update bytes", () => {
  const progress = "\n  PROGRESS  \n"
  const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", messages: [
    { role: "system", content: skills },
    { role: "user", content: `<system-update>\n${skills}${progress}\n</system-update>` },
  ] }, new Headers())
  expect(parsed.turn.incrementalPrompt).toBe(`USER: <system-update>\n${progress}\n</system-update>`)
})

for (const offered of [[], tools]) test(`client initialization owns the type enum, response matrix and working flow (${offered.length} tools)`, () => {
  const turn = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", tools: offered, messages: [
    { role: "system", content: "CALLER_RULE" }, { role: "user", content: "Work on the task." },
  ] }, new Headers()).turn
  const startup = turn.primingPrompts[0]!
  const clientStart = startup.indexOf("CLIENT INSTRUCTIONS")
  const harnessStart = startup.indexOf("HARNESS INSTRUCTIONS")
  expect(clientStart).toBe(0)
  expect(harnessStart).toBeGreaterThan(clientStart)
  const client = startup.slice(clientStart, harnessStart)
  expect(client).toContain('type enum: ["chat","tool","plan","subagent","skill","question","permission","thinking"]')
  expect(client).toContain("Response type matrix")
  expect(client).toContain("Working flow")
  for (const type of ["chat", "tool", "plan", "subagent", "skill", "question", "permission", "thinking"]) {
    expect(client).toContain(`| ${type} |`)
  }
  expect(client).toContain("Wait for actual client results")
  expect(client).toContain('The "type" field is required')
  const examples = [...client.matchAll(/^\| (\w+) \|[^\n]*?<aipass-envelope>(.*?)<\/aipass-envelope>/gm)]
  expect(examples.map(match => match[1]).sort()).toEqual(["chat", "tool", "plan", "subagent", "skill", "question", "permission", "thinking"].sort())
  for (const [, type, json] of examples) {
    const payload = JSON.parse(json!)
    expect(payload.type).toBe(type)
    expect(parseTypedEnvelope(payload, new Set(["offered_name", "subagent", "skill", "question", "permission"]))).toEqual([
      type === "chat" ? { type: "text", delta: "..." }
        : type === "thinking" ? { type: "reasoning", delta: "..." }
        : { type: "tool-call", id: type === "tool" ? "call_unique" : "call_1", name: type === "tool" || type === "plan" ? "offered_name" : type, input: {} },
    ])
  }
  expect(startup.slice(harnessStart)).toContain("SYSTEM: CALLER_RULE")
  for (const marker of ["type enum:", "Response type matrix", "Working flow"]) {
    expect(startup.split(marker)).toHaveLength(2)
    for (const task of [turn.initialPrompt, turn.incrementalPrompt, turn.recoveryPrompt]) expect(task).not.toContain(marker)
  }
})

test("initialized schemas do not override per-turn action restrictions", () => {
  const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", tools: [
    ...tools, { type: "function", function: { name: "write", parameters: { type: "object" } } },
  ], tool_choice: { type: "function", function: { name: "read" } }, messages: [{ role: "user", content: "Inspect." }] }, new Headers())
  expect(parsed.turn.primingPrompts[0]).not.toContain('"name":"write"')
  expect(JSON.parse(forwardedToolContent(parsed.turn, "read"))).toEqual({ name: "read", description: "READ_DESCRIPTION", inputSchema: tools[0]!.function.parameters })
  expect(parsed.turn.primingPrompts[0]).toContain("Per-turn action restrictions override the initialized action set.")
  expect(parsed.turn.initialPrompt).toContain("You may request only these actions on this turn: read.")
  expect(() => parseTypedEnvelope({ type: "tool", key: "key", id: "write_1", name: "write", input: {} }, parsed.offered)).toThrow("tool write was not offered")
})

test("base projected turn owns a uuid-shaped promptKey with unset originPromptKey", () => {
  const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", messages: [
    { role: "user", content: "Inspect." },
  ] }, new Headers())
  expect(parsed.turn.promptKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  expect(parsed.turn.originPromptKey).toBeUndefined()
})

test("two independent parses yield distinct promptKeys", () => {
  const body = { model: "gemini-3.1-flash-lite", messages: [{ role: "user", content: "Inspect." }] }
  const first = parseOpenAIChatRequest(body, new Headers())
  const second = parseOpenAIChatRequest(body, new Headers())
  expect(first.turn.promptKey).toBeDefined()
  expect(second.turn.promptKey).toBeDefined()
  expect(first.turn.promptKey).not.toBe(second.turn.promptKey)
})
