import { describe, expect, test } from "bun:test"
import { promptContractCurrent } from "./browser.ts"
import { parseOpenAIChatRequest, parseOpenAIResponsesRequest } from "./http.ts"

const fileTool = {
  name: "write",
  description: "Write a file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
}

function expectChatOnlyRole(prompt: string) {
  expect(prompt).toContain("You are a chat-only assistant.")
  expect(prompt).toContain("Do not invoke or execute tools, functions, commands, or other actions yourself.")
  expect(prompt).toContain("Action envelopes are data for the external client dispatcher, not native webchat tool calls.")
  expect(prompt).toContain("Only the client executes actions and returns results.")
  expect(prompt).toContain("Tools include file/folder operations, shell commands, MCP, and all other offered tools.")
  expect(prompt).toContain("Use the exact offered name and schema-valid input, including required paths, commands, or content.")
  expect(prompt).toContain("Do not claim an action succeeded without a client result.")
  expect(prompt).toContain("Always respond only in the provided <aipass-envelope> JSON structure, including ordinary replies and refusals.")
  expect(prompt).toContain("Do not override site instructions, safety, privacy, or authorization restrictions.")
  expect(prompt).toContain("FIRST line")
  expect(prompt).toContain("Every envelope")
  expect(prompt).toContain('{"type":"chat","key":"<key>","id":"answer_1","text":"..."}')
  expect(prompt).toContain('{"type":"thinking","key":"<key>","id":"reason_1","text":"..."}')
}

describe("webchat role at the request boundary", () => {
  for (const endpoint of ["chat", "responses"] as const) {
    for (const scenario of ["no tools", "budgeted schemas", "file request", "disabled tools"] as const) {
      test(`${endpoint} carries the chat-only structured-output role with ${scenario}`, () => {
        const request = scenario === "file request"
          ? "Create a file at /tmp/aipass-role-fixture.txt with content hello aipass!"
          : "Hello"
        const common = {
          model: "gpt-5.6-terra",
          ...(scenario === "disabled tools" ? { tool_choice: "none" } : {}),
        }
        const parsed = endpoint === "chat"
          ? parseOpenAIChatRequest({
              ...common,
              messages: [{ role: "user", content: request }],
              ...(scenario === "no tools" ? {} : { tools: [{ type: "function", function: fileTool }] }),
            }, new Headers())
          : parseOpenAIResponsesRequest({
              ...common,
              input: request,
              ...(scenario === "no tools" ? {} : { tools: [{ type: "function", ...fileTool }] }),
            }, new Headers())

        for (const prompt of [parsed.turn.initialPrompt, parsed.turn.incrementalPrompt, parsed.turn.recoveryPrompt]) {
          expectChatOnlyRole(prompt)
          expect(prompt).toContain(request)
        }
        if (scenario === "file request") {
          expect(parsed.projectedActions).toEqual(["write"])
          expect(parsed.turn.initialPrompt).toContain('"inputSchema"')
        } else {
          expect(parsed.projectedActions).toEqual([])
          expect(parsed.turn.initialPrompt).not.toContain('"inputSchema"')
        }
        if (scenario === "budgeted schemas") {
          expect(parsed.turn.initialPrompt).toContain("- write: Write a file")
          expect(parsed.offered).toEqual(new Set(["write"]))
          expect(parsed.turn.initialPrompt.length).toBeLessThan(4_000)
        }
        if (scenario === "no tools" || scenario === "disabled tools") {
          expect(parsed.offered.size).toBe(0)
          expect(parsed.turn.toolRepairPrompt).toBeUndefined()
        }
      })
    }

    test(`${endpoint} retains the role on action-only follow-ups without restoring omitted instructions`, () => {
      const messages = [
        { role: "user", content: "OLD_REQUEST" },
        { role: "assistant", content: "Previous reply" },
        { role: "user", content: "Continue" },
      ]
      const common = { model: "gpt-5.6-terra", instruction_mode: "action-only" }
      const parsed = endpoint === "chat"
        ? parseOpenAIChatRequest({
            ...common,
            messages: [{ role: "system", content: "OMITTED_CLIENT_INSTRUCTIONS" }, ...messages],
          }, new Headers({ "x-session-id": "role-follow-up" }))
        : parseOpenAIResponsesRequest({
            ...common, instructions: "OMITTED_CLIENT_INSTRUCTIONS", input: messages,
          }, new Headers())
      for (const prompt of [parsed.turn.initialPrompt, parsed.turn.incrementalPrompt, parsed.turn.recoveryPrompt]) {
        expectChatOnlyRole(prompt)
        expect(prompt).not.toContain("OMITTED_CLIENT_INSTRUCTIONS")
      }
      expect(parsed.turn.incrementalPrompt).toContain("Continue")
      expect(parsed.turn.incrementalPrompt).not.toContain("OLD_REQUEST")
    })

    for (const tool of [
      { name: "shell", parameters: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string" } }, required: ["command"] } },
      { name: "mcp__fixture__lookup", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { name: "glob", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } },
    ]) test(`${endpoint} retains the exact ${tool.name} name and argument schema`, () => {
      const common = { model: "gpt-5.6-terra" }
      const request = `Use ${tool.name} for the synthetic fixture.`
      const parsed = endpoint === "chat"
        ? parseOpenAIChatRequest({ ...common, messages: [{ role: "user", content: request }], tools: [{ type: "function", function: tool }] }, new Headers())
        : parseOpenAIResponsesRequest({ ...common, input: request, tools: [{ type: "function", ...tool }] }, new Headers())
      expect(parsed.projectedActions).toEqual([tool.name])
      for (const prompt of [parsed.turn.initialPrompt, parsed.turn.incrementalPrompt, parsed.turn.recoveryPrompt]) {
        expectChatOnlyRole(prompt)
        expect(prompt).toContain(JSON.stringify({ name: tool.name, inputSchema: tool.parameters }))
      }
    })
  }

  test("refreshes bound version-14 contracts after the role instruction changes", () => {
    const { turn } = parseOpenAIChatRequest({
      model: "gpt-5.6-terra", messages: [{ role: "user", content: "Hello" }],
    }, new Headers())
    expect(promptContractCurrent(turn.promptContractVersion, turn.actionEnvelopeDigest, 14, turn.actionEnvelopeDigest, true)).toBe(false)
  })
})
