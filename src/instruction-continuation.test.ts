import { describe, expect, test } from "bun:test"
import { promptContractCurrent, turnPrompt, type BrowserTurnInput } from "./browser.ts"
import { MODELS } from "./config.ts"
import { estimateTokens } from "./context.ts"
import { parseOpenAIChatRequest, parseOpenAIResponsesRequest, type ProjectedTurn } from "./http.ts"

const originalRequest = "Use the installed skill to summarize fixture-alpha.txt."
const toolResult = "<skill_content name=\"fixture\">SKILL_RESULT_BODY</skill_content>"

const skill = (extraProperty = false) => ({
  type: "function" as const,
  function: {
    name: "skill",
    description: "Load an installed skill",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        ...(extraProperty ? { revision: { type: "string" } } : {}),
      },
      required: ["id"],
    },
  },
})

const read = () => ({
  type: "function" as const,
  function: {
    name: "read",
    description: "Read a fixture",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
})

function chatTurn(instructions: string, options: {
  readonly tools?: readonly ReturnType<typeof skill | typeof read>[]
  readonly request?: string
  readonly declaredRead?: boolean
} = {}) {
  return parseOpenAIChatRequest(
    {
      model: "gemini-3.1-flash-lite",
      messages: [
        { role: "system", content: instructions },
        { role: "developer", content: "Use only installed skill IDs." },
        { role: "user", content: options.request ?? originalRequest },
        ...(options.declaredRead
          ? [
              { role: "assistant", content: "", tool_calls: [{ id: "call_read", function: { name: "read", arguments: '{"path":"fixture-alpha.txt"}' } }] },
              { role: "tool", tool_call_id: "call_read", content: "fixture alpha" },
            ]
          : []),
        { role: "assistant", content: "", tool_calls: [{ id: "call_skill", function: { name: "skill", arguments: '{"id":"fixture"}' } }] },
        { role: "tool", tool_call_id: "call_skill", content: toolResult },
      ],
      tools: options.tools ?? [skill()],
    },
    new Headers({ "x-session-id": "instruction-continuation" }),
  ).turn
}

function responsesTurn(instructions: string, continuationSession: string) {
  return parseOpenAIResponsesRequest(
    {
      model: "gemini-3.1-flash-lite",
      instructions,
      previous_response_id: "resp_previous",
      input: [
        { role: "user", content: originalRequest },
        { type: "function_call", call_id: "call_skill", name: "skill", arguments: '{"id":"fixture"}' },
        { type: "function_call_output", call_id: "call_skill", output: toolResult },
      ],
      tools: [
        { type: "function", name: "skill", description: "Load an installed skill", parameters: skill().function.parameters },
      ],
    },
    new Headers(),
    continuationSession,
  ).turn
}

function selectedPrompt(turn: ProjectedTurn, currentDigest: string, currentVersion = turn.promptContractVersion) {
  const current = promptContractCurrent(
    turn.promptContractVersion,
    turn.actionEnvelopeDigest,
    currentVersion,
    currentDigest,
  )
  const model = MODELS.find((candidate) => candidate.id === turn.modelID)
  if (!model) throw new Error("test model is missing")
  const input: BrowserTurnInput = {
    sessionMarker: turn.sessionMarker,
    ephemeral: turn.ephemeral,
    primingPrompts: turn.primingPrompts,
    model,
    reasoning: turn.reasoning,
    initialPrompt: turn.initialPrompt,
    incrementalPrompt: turn.incrementalPrompt,
    recoveryPrompt: turn.recoveryPrompt,
    compactionDigest: turn.compactionDigest,
    promptContractVersion: turn.promptContractVersion,
    actionEnvelopeDigest: turn.actionEnvelopeDigest,
    toolContinuation: turn.toolContinuation,
    attachments: turn.attachments,
    promptKey: turn.promptKey,
  }
  return { current, prompt: turnPrompt(input, true, false, current) }
}

function expectStartupInstructions(turn: ProjectedTurn, instructions: readonly string[]) {
  expect(turn.primingPrompts).toHaveLength(1)
  const startup = turn.primingPrompts[0]!
  expect(startup).toContain("You are a text-generation assistant working only as the backend.")
  expect(startup.match(/READY/g)).toHaveLength(1)
  let previous = startup.indexOf("You are a text-generation assistant working only as the backend.")
  for (const instruction of instructions) {
    const index = startup.indexOf(instruction)
    expect(index).toBeGreaterThan(previous)
    previous = index
  }
  expect(startup).toContain("Use the full schemas supplied during startup")
  expect(forwardedToolNames(turn)).toEqual([...turn.offeredActions])
}

function forwardedToolNames(turn: ProjectedTurn) {
  for (const schema of turn.offeredToolSchemas) expect(turn.primingPrompts.join("\n")).toContain(JSON.stringify(schema))
  return turn.offeredToolSchemas.map((schema) => schema.name)
}

function forwardedToolContent(turn: ProjectedTurn, name: string) {
  const schema = turn.offeredToolSchemas.find((candidate) => candidate.name === name)
  expect(schema).toBeDefined()
  const content = JSON.stringify(schema)
  expect(turn.primingPrompts.join("\n")).toContain(content)
  return content
}

describe("instruction fidelity is independent of session affinity", () => {
  for (const endpoint of ["chat", "responses"] as const) {
    const parse = (instructions: string, affinity: boolean) => {
      const headers = new Headers(affinity ? { "x-session-affinity": "fidelity-session" } : {})
      const messages = [
        { role: "user", content: "Inspect the synthetic fixture." },
        { role: "assistant", content: "Checking the fixture." },
        { role: "user", content: "<system-update>\nKEEP_CLIENT_UPDATE\n</system-update>\nReturn the result." },
      ]
      const common = { model: "gemini-3.1-flash-lite" }
      return endpoint === "chat"
        ? parseOpenAIChatRequest({
            ...common,
            messages: [
              { role: "system", content: instructions },
              { role: "developer", content: "KEEP_DEVELOPER_RULE" },
              ...messages,
            ],
          }, headers)
        : parseOpenAIResponsesRequest({
            ...common, instructions,
            input: [{ role: "developer", content: "KEEP_DEVELOPER_RULE" }, ...messages],
          }, headers)
    }

    for (const length of [1, 800]) {
      test(`${endpoint} preserves default instruction projection with affinity (${length === 1 ? "short" : "long"} instructions)`, () => {
        const instructions = "KEEP_SYSTEM_RULE ".repeat(length)
        const plain = parse(instructions, false)
        const affinity = parse(instructions, true)
        expect(affinity.turn.initialPrompt).toBe(plain.turn.initialPrompt)
        expect(affinity.turn.incrementalPrompt).toBe(plain.turn.incrementalPrompt)
        expect(affinity.turn.recoveryPrompt).toBe(plain.turn.recoveryPrompt)
        expect(affinity.turn.primingPrompts).toEqual(plain.turn.primingPrompts)
        expect(affinity.turn.actionEnvelopeDigest).toBe(plain.turn.actionEnvelopeDigest)
        expect(affinity.promptTokens).toBe(plain.promptTokens)
        expectStartupInstructions(affinity.turn, ["KEEP_SYSTEM_RULE", "KEEP_DEVELOPER_RULE"])
        expect(affinity.turn.initialPrompt).not.toContain("KEEP_SYSTEM_RULE")
        expect(affinity.turn.initialPrompt).not.toContain("KEEP_DEVELOPER_RULE")
        expect(affinity.turn.incrementalPrompt).toContain("KEEP_CLIENT_UPDATE")
      })
    }

  }
})

describe("instruction changes during tool continuations", () => {
  for (const endpoint of ["chat", "responses"] as const) {
    for (const length of [8_000, 8_001, 44_771]) {
      test(`${endpoint} keeps only the tool delta on a current bound continuation (${length} instruction characters)`, () => {
        const head = "INSTRUCTION_HEAD\n"
        const middle = "\n<available_skills>EXACT_CATALOG_MIDDLE</available_skills>\n"
        const tail = "\nINSTRUCTION_TAIL"
        const firstHalf = head + "context ".repeat(Math.ceil(length / 8)).slice(0, Math.floor(length / 2) - head.length)
        const instructions = firstHalf + middle
          + "tail ".repeat(Math.ceil(length / 5)).slice(0, length - firstHalf.length - middle.length - tail.length) + tail
        const turn = endpoint === "chat"
          ? chatTurn(instructions)
          : responsesTurn(instructions, "self-contained-responses")
        const routed = selectedPrompt(turn, turn.actionEnvelopeDigest)
        expect(routed.current).toBe(true)
        expectStartupInstructions(turn, endpoint === "chat" ? [instructions, "Use only installed skill IDs."] : [instructions])
        // First-turn shape still carries the full request inline.
        for (const prompt of [turn.initialPrompt, turn.recoveryPrompt]) {
          expect(prompt).not.toContain(instructions)
          expect(prompt).not.toContain("Use only installed skill IDs.")
          expect(prompt).toContain(originalRequest)
          expect(prompt).toContain('TOOL CALL call_skill skill: {"id":"fixture"}')
          expect(prompt).toContain(`TOOL RESULT call_skill: ${toolResult}`)
          expect(prompt.indexOf(originalRequest)).toBeLessThan(prompt.indexOf("TOOL CALL call_skill"))
          expect(prompt.indexOf("TOOL CALL call_skill")).toBeLessThan(prompt.indexOf("TOOL RESULT call_skill"))
          expect(prompt).not.toContain('"inputSchema"')
          expect(prompt).not.toContain("Apply every stored CLIENT INSTRUCTIONS part")
        }
        // Bound routing is delta-only: the latest result, with
        // the full chain living in the remote chat history instead.
        expect(routed.prompt).not.toContain(instructions)
        expect(routed.prompt).not.toContain("Use only installed skill IDs.")
        expect(routed.prompt).not.toContain(originalRequest)
        expect(routed.prompt).not.toContain('TOOL CALL call_skill skill: {"id":"fixture"}')
        expect(routed.prompt).toContain(`TOOL RESULT call_skill: ${toolResult}`)
        expect(routed.prompt).not.toContain('"inputSchema"')
        expect(forwardedToolNames(turn)).toContain("skill")
        expect(routed.prompt).not.toContain("Apply every stored CLIENT INSTRUCTIONS part")
      })
    }

    test(`${endpoint} refreshes a bound tool continuation when preserved skill instructions change`, () => {
      const before = endpoint === "chat"
        ? chatTurn("<available_skills>CATALOG_OLD</available_skills>")
        : responsesTurn("<available_skills>CATALOG_OLD</available_skills>", "responses-instruction-continuation")
      const after = endpoint === "chat"
        ? chatTurn("<available_skills>CATALOG_NEW</available_skills>")
        : responsesTurn("<available_skills>CATALOG_NEW</available_skills>", "responses-instruction-continuation")
      expect(after.toolContinuation).toBe(true)
      expect(after.actionEnvelopeDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(after.actionEnvelopeDigest).not.toBe(before.actionEnvelopeDigest)
      const routed = selectedPrompt(after, before.actionEnvelopeDigest)
      expect(routed.current).toBe(false)
      expectStartupInstructions(after, endpoint === "chat" ? ["<available_skills>CATALOG_NEW</available_skills>", "Use only installed skill IDs."] : ["<available_skills>CATALOG_NEW</available_skills>"])
      expect(routed.prompt).not.toContain("CATALOG_NEW")
      expect(routed.prompt).toContain(originalRequest)
      expect(routed.prompt).toContain(toolResult)
    })
  }

  test("declaring another primed tool retains startup identity and delta-only routing", () => {
    const request = "Use the installed skill fixture."
    const before = chatTurn("<available_skills>CATALOG</available_skills>", { tools: [skill(), read()], request })
    const provisionGrowth = chatTurn("<available_skills>CATALOG</available_skills>", {
      tools: [skill(), read()], request, declaredRead: true,
    })
    expect(provisionGrowth.actionEnvelopeDigest).toBe(before.actionEnvelopeDigest)
    const provisionRoute = selectedPrompt(provisionGrowth, before.actionEnvelopeDigest)
    expect(provisionRoute.current).toBe(true)
    expect(provisionRoute.prompt).toBe(provisionGrowth.incrementalPrompt)
    expectStartupInstructions(provisionGrowth, ["<available_skills>CATALOG</available_skills>", "Use only installed skill IDs."])
    // Delta-only: latest result; both schemas and the earlier
    // call/result chain stays in remote history instead of being replayed.
    expect(provisionRoute.prompt).toContain(`TOOL RESULT call_skill: ${toolResult}`)
    for (const tool of [read(), skill()]) expect(JSON.parse(forwardedToolContent(provisionGrowth, tool.function.name))).toEqual({
      name: tool.function.name,
      description: tool.function.description,
      inputSchema: tool.function.parameters,
    })
    expect(provisionRoute.prompt).not.toContain('"inputSchema"')
    expect(provisionRoute.prompt).not.toContain(request)
    expect(provisionRoute.prompt).not.toContain('TOOL CALL call_read read: {"path":"fixture-alpha.txt"}')
    expect(provisionRoute.prompt).not.toContain('TOOL CALL call_skill skill: {"id":"fixture"}')
  })

  test("ordinary changed offered schemas invalidate", () => {
    const before = parseOpenAIChatRequest(
      { model: "gemini-3.1-flash-lite", messages: [{ role: "user", content: "Use skill fixture." }], tools: [skill()] },
      new Headers({ "x-session-id": "ordinary-schema-change" }),
    ).turn
    const after = parseOpenAIChatRequest(
      { model: "gemini-3.1-flash-lite", messages: [{ role: "user", content: "Use skill fixture." }], tools: [skill(true)] },
      new Headers({ "x-session-id": "ordinary-schema-change" }),
    ).turn
    expect(after.toolContinuation).toBe(false)
    expect(after.actionEnvelopeDigest).not.toBe(before.actionEnvelopeDigest)
    const routed = selectedPrompt(after, before.actionEnvelopeDigest)
    expect(routed.current).toBe(false)
    expect(routed.prompt).toContain("Use skill fixture.")
  })

  test("changed schemas refresh a tool continuation with current schemas", () => {
    const before = chatTurn("CLIENT_RULE", { tools: [skill()] })
    const after = chatTurn("CLIENT_RULE", { tools: [skill(true)] })
    expect(after.toolContinuation).toBe(true)
    expectStartupInstructions(after, ["CLIENT_RULE", "Use only installed skill IDs."])
    expect(after.actionEnvelopeDigest).not.toBe(before.actionEnvelopeDigest)
    expect(forwardedToolContent(after, "skill")).toContain('"revision":{"type":"string"}')
    expect(after.incrementalPrompt).not.toContain('"inputSchema"')
    const routed = selectedPrompt(after, before.actionEnvelopeDigest)
    expect(routed.current).toBe(false)
    expect(routed.prompt).toBe(after.recoveryPrompt)
    expect(routed.prompt).not.toContain('"inputSchema"')
    expect(routed.prompt).toContain(toolResult)
  })

  test("version mismatch refreshes a bound tool continuation", () => {
    const turn = chatTurn("<available_skills>CATALOG</available_skills>")
    const routed = selectedPrompt(turn, turn.actionEnvelopeDigest, turn.promptContractVersion - 1)
    expect(routed.current).toBe(false)
    expect(routed.prompt).toContain(originalRequest)
    expect(routed.prompt).toContain(toolResult)
  })
})

test("estimated prompt usage accounts for startup instructions and task projection", () => {
  const parsed = parseOpenAIChatRequest({
    model: "gemini-3.1-flash-lite",
    messages: [{ role: "system", content: "RULE ".repeat(3_000) }, { role: "user", content: "Reply ready." }],
  }, new Headers())
  expect(parsed.promptTokens).toBe(
    estimateTokens(parsed.turn.initialPrompt) + parsed.turn.primingPrompts.reduce((total, prompt) => total + estimateTokens(prompt), 0),
  )
})
