import { expect, test } from "bun:test"
import { parseOpenAIChatRequest, parseOpenAIResponsesRequest } from "./http.ts"

const completeTool = {
  name: "lookup",
  description: "Lookup a synthetic record",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Exact lookup query" },
      limit: { type: "integer", minimum: 1, maximum: 9 },
    },
    required: ["query", "limit"],
    additionalProperties: false,
  },
}

for (const endpoint of ["chat", "responses"] as const) test(`${endpoint} forwards complete instructions and effective offered schemas without internal discovery`, () => {
  const instruction = "SYSTEM_COMPLETE_FIXTURE\n<available_skills>COMPLETE_SKILL_SCHEMA</available_skills>"
  const body = endpoint === "chat"
    ? {
        model: "gemini-3.1-flash-lite",
        messages: [{ role: "system", content: instruction }, { role: "user", content: "Lookup the fixture." }],
        tools: [{ type: "function", function: completeTool }],
      }
    : {
        model: "gemini-3.1-flash-lite",
        instructions: instruction,
        input: "Lookup the fixture.",
        tools: [{ type: "function", ...completeTool }],
      }
  const parsed = endpoint === "chat"
    ? parseOpenAIChatRequest(body, new Headers())
    : parseOpenAIResponsesRequest(body, new Headers())
  const startup = parsed.turn.primingPrompts.join("\n")
  expect(startup).toContain(instruction)
  expect(startup).toContain(JSON.stringify({
    name: completeTool.name,
    description: completeTool.description,
    inputSchema: completeTool.parameters,
  }))
  expect(startup).not.toContain("aipass_catalog_search")
  expect(startup).not.toContain("aipass_catalog_get")
  expect(startup).not.toContain("CATALOG DISCOVERY")
  expect(parsed.turn).not.toHaveProperty("catalog")
})

for (const endpoint of ["chat", "responses"] as const) test(`${endpoint} ignores unsupported request fields without changing instruction projection`, () => {
  const messages = [
    { role: "developer", content: "RETAIN_DEVELOPER_RULE" },
    { role: "user", content: "Initial task" },
    { role: "assistant", content: "Previous reply" },
    { role: "user", content: "<system-update>\nRETAIN_CLIENT_UPDATE\n</system-update>\nContinue" },
  ]
  const body = endpoint === "chat"
    ? { model: "gemini-3.1-flash-lite", messages: [{ role: "system", content: "RETAIN_SYSTEM_RULE" }, ...messages] }
    : { model: "gemini-3.1-flash-lite", instructions: "RETAIN_SYSTEM_RULE", input: messages }
  const parse = endpoint === "chat" ? parseOpenAIChatRequest : parseOpenAIResponsesRequest
  const headers = new Headers({ "x-session-id": "projection-fixture" })
  const baseline = parse(body, headers)
  for (const value of ["action-only", "unsupported", false, { arbitrary: true }]) {
    const projected = parse({ ...body, instruction_mode: value }, headers)
    expect(projected.turn.primingPrompts).toEqual(baseline.turn.primingPrompts)
    expect(projected.turn.primingPrompts.join("\n")).toContain("RETAIN_SYSTEM_RULE")
    expect(projected.turn.primingPrompts.join("\n")).toContain("RETAIN_DEVELOPER_RULE")
    expect(projected.turn.incrementalPrompt).toContain("RETAIN_CLIENT_UPDATE")
    expect(projected.turn.actionEnvelopeDigest).toBe(baseline.turn.actionEnvelopeDigest)
    expect(projected.promptTokens).toBe(baseline.promptTokens)
  }
})
