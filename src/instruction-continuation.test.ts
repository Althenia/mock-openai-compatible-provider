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
  readonly mode?: "preserve" | "action-only"
  readonly tools?: readonly ReturnType<typeof skill | typeof read>[]
  readonly request?: string
  readonly declaredRead?: boolean
} = {}) {
  return parseOpenAIChatRequest(
    {
      model: "gemini-3.1-flash-lite",
      ...(options.mode ? { instruction_mode: options.mode } : {}),
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
    turn.toolContinuation,
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
  expect(turn.primingPrompts).toHaveLength(instructions.length + 1)
  expect(turn.primingPrompts[0]).toContain("You are a text-generation assistant working only as the backend.")
  for (const [index, instruction] of instructions.entries()) {
    expect(turn.primingPrompts[index + 1]).toContain(instruction)
    expect(turn.primingPrompts[index + 1]).toContain("Acknowledge briefly with READY")
  }
}

describe("instruction fidelity is independent of session affinity", () => {
  for (const endpoint of ["chat", "responses"] as const) {
    const parse = (instructions: string, affinity: boolean, mode?: "preserve" | "action-only") => {
      const headers = new Headers(affinity ? { "x-session-affinity": "fidelity-session" } : {})
      const messages = [
        { role: "user", content: "Inspect the synthetic fixture." },
        { role: "assistant", content: "Checking the fixture." },
        { role: "user", content: "<system-update>\nKEEP_CLIENT_UPDATE\n</system-update>\nReturn the result." },
      ]
      const common = { model: "gemini-3.1-flash-lite", ...(mode ? { instruction_mode: mode } : {}) }
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

    test(`${endpoint} keeps explicit action-only behavior with or without affinity`, () => {
      for (const affinity of [false, true]) {
        const explicit = parse("KEEP_SYSTEM_RULE", affinity, "action-only")
        expectStartupInstructions(explicit.turn, [])
        expect(explicit.turn.initialPrompt).not.toContain("KEEP_SYSTEM_RULE")
        expect(explicit.turn.initialPrompt).not.toContain("KEEP_DEVELOPER_RULE")
        expect(explicit.turn.initialPrompt).not.toContain("KEEP_CLIENT_UPDATE")
        expect(explicit.turn.incrementalPrompt).toContain("Return the result.")
        expect(explicit.turn.incrementalPrompt).not.toContain("KEEP_CLIENT_UPDATE")
        const preserved = parse("KEEP_SYSTEM_RULE", affinity, "preserve")
        expectStartupInstructions(preserved.turn, ["KEEP_SYSTEM_RULE", "KEEP_DEVELOPER_RULE"])
        expect(preserved.turn.initialPrompt).not.toContain("KEEP_SYSTEM_RULE")
        expect(preserved.turn.initialPrompt).not.toContain("KEEP_DEVELOPER_RULE")
        expect(preserved.turn.incrementalPrompt).toContain("KEEP_CLIENT_UPDATE")
      }
    })
  }
})

describe("instruction changes during tool continuations", () => {
  for (const endpoint of ["chat", "responses"] as const) {
    for (const length of [8_000, 8_001, 44_771]) {
      test(`${endpoint} keeps the tool delta plus schemas on a current bound continuation (${length} instruction characters)`, () => {
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
          expect(prompt).toContain('"name":"skill"')
          expect(prompt).not.toContain("Apply every stored CLIENT INSTRUCTIONS part")
        }
        // Bound routing is delta-only: schemas plus the latest result, with
        // the full chain living in the remote chat history instead.
        expect(routed.prompt).not.toContain(instructions)
        expect(routed.prompt).not.toContain("Use only installed skill IDs.")
        expect(routed.prompt).not.toContain(originalRequest)
        expect(routed.prompt).not.toContain('TOOL CALL call_skill skill: {"id":"fixture"}')
        expect(routed.prompt).toContain(`TOOL RESULT call_skill: ${toolResult}`)
        expect(routed.prompt).toContain('"name":"skill"')
        expect(routed.prompt).not.toContain("Apply every stored CLIENT INSTRUCTIONS part")
      })
    }

    test(`${endpoint} refreshes a bound tool continuation when preserved catalog instructions change`, () => {
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

  test("action-only to preserve refreshes the omitted catalog on a tool continuation", () => {
    const before = chatTurn("<available_skills>CATALOG_OLD</available_skills>", { mode: "action-only" })
    const after = chatTurn("<available_skills>CATALOG_NEW</available_skills>", { mode: "preserve" })
    expect(before.initialPrompt).not.toContain("CATALOG_OLD")
    expectStartupInstructions(after, ["<available_skills>CATALOG_NEW</available_skills>", "Use only installed skill IDs."])
    expect(after.recoveryPrompt).not.toContain("CATALOG_NEW")
    const routed = selectedPrompt(after, before.actionEnvelopeDigest)
    expect(routed.current).toBe(false)
    expect(routed.prompt).not.toContain("CATALOG_NEW")
    expect(routed.prompt).toContain(originalRequest)
    expect(routed.prompt).toContain(toolResult)
  })

  test("action-only catalog changes remain omitted and retain incremental tool-result routing", () => {
    const before = chatTurn("<available_skills>CATALOG_OLD</available_skills>", { mode: "action-only" })
    const after = chatTurn("<available_skills>CATALOG_NEW</available_skills>", { mode: "action-only" })
    expect(after.initialPrompt).not.toContain("CATALOG_NEW")
    expect(after.recoveryPrompt).not.toContain("CATALOG_NEW")
    expect(after.actionEnvelopeDigest).toBe(before.actionEnvelopeDigest)
    const routed = selectedPrompt(after, before.actionEnvelopeDigest)
    expect(routed.current).toBe(true)
    expect(routed.prompt).toBe(after.incrementalPrompt)
    expect(routed.prompt).toContain(toolResult)
  })

  test("schema-only provision growth retains routing with delta plus both schemas", () => {
    const request = "Use the installed skill fixture."
    const before = chatTurn("<available_skills>CATALOG</available_skills>", { tools: [skill(), read()], request })
    const provisionGrowth = chatTurn("<available_skills>CATALOG</available_skills>", {
      tools: [skill(), read()], request, declaredRead: true,
    })
    expect(provisionGrowth.actionEnvelopeDigest).not.toBe(before.actionEnvelopeDigest)
    const provisionRoute = selectedPrompt(provisionGrowth, before.actionEnvelopeDigest)
    expect(provisionRoute.current).toBe(true)
    expect(provisionRoute.prompt).toBe(provisionGrowth.incrementalPrompt)
    expectStartupInstructions(provisionGrowth, ["<available_skills>CATALOG</available_skills>", "Use only installed skill IDs."])
    // Delta-only: latest result plus both current schemas; the earlier
    // call/result chain stays in remote history instead of being replayed.
    for (const text of [`TOOL RESULT call_skill: ${toolResult}`,
      '"name":"read"', '"name":"skill"']) expect(provisionRoute.prompt).toContain(text)
    expect(provisionRoute.prompt).not.toContain(request)
    expect(provisionRoute.prompt).not.toContain('TOOL CALL call_read read: {"path":"fixture-alpha.txt"}')
    expect(provisionRoute.prompt).not.toContain('TOOL CALL call_skill skill: {"id":"fixture"}')
  })

  test("ordinary changed selected schemas invalidate", () => {
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

  test("action-only changed schemas refresh a tool continuation with current schemas", () => {
    const before = chatTurn("OMITTED", { mode: "action-only", tools: [skill()] })
    const after = chatTurn("OMITTED_CHANGED", { mode: "action-only", tools: [skill(true)] })
    expect(after.toolContinuation).toBe(true)
    expectStartupInstructions(after, [])
    expect(after.actionEnvelopeDigest).not.toBe(before.actionEnvelopeDigest)
    expect(after.incrementalPrompt).toContain('"revision":{"type":"string"}')
    const routed = selectedPrompt(after, before.actionEnvelopeDigest)
    expect(routed.current).toBe(true)
    expect(routed.prompt).toBe(after.incrementalPrompt)
    expect(routed.prompt).toContain('"revision":{"type":"string"}')
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

test("estimated prompt usage describes the exposed projection without charging omitted action-only instructions", () => {
  for (const mode of ["preserve", "action-only"] as const) {
    const parsed = parseOpenAIChatRequest({
      model: "gemini-3.1-flash-lite", instruction_mode: mode,
      messages: [{ role: "system", content: "RULE ".repeat(3_000) }, { role: "user", content: "Reply ready." }],
    }, new Headers())
    expect(parsed.promptTokens).toBe(
      estimateTokens(parsed.turn.initialPrompt) + parsed.turn.primingPrompts.reduce((total, prompt) => total + estimateTokens(prompt), 0),
    )
  }
})
