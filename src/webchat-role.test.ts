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
  expect(prompt).toContain("You are a text-generation assistant working only as the backend.")
  expect(prompt).toContain("Generate text to assist the client, which does the actual work")
  expect(prompt).toContain("Answer from context or request an offered client action, not manual user work.")
  expect(prompt).toContain("Actions are data, not native calls: never execute them yourself or decline for lack of native access.")
  expect(prompt).toContain("The client handles permissions, executes actions, and returns results; requests are not approval or success.")
  expect(prompt).toContain("Files, folders, shell, MCP: use exact offered names and schema-valid input; do not guess arguments.")
  expect(prompt).toContain("Claim success only from client results. Preserve site instructions, safety, privacy, and authorization.")
  expect(prompt).toContain("Replies and refusals: only <aipass-envelope>{...}</aipass-envelope>, no outside prose, JSON, or fences.")
  expect(prompt).toContain("FIRST line")
  expect(prompt).toContain("Every envelope")
  expect(prompt).toContain('{"type":"chat","key":"<key>","id":"answer_1","text":"..."}')
  expect(prompt).toContain('{"type":"thinking","key":"<key>","id":"reason_1","text":"..."}')
}

function expectStartup(primingPrompts: readonly string[], instructions: readonly string[] = [], tools: readonly string[] = []) {
  expect(primingPrompts).toHaveLength(1)
  expectChatOnlyRole(primingPrompts[0]!)
  expect(primingPrompts[0]!).toStartWith("You are a text-generation assistant working only as the backend.")
  for (const [index, instruction] of instructions.entries()) {
    const prompt = primingPrompts[0]!
    expect(prompt).toContain(instruction)
    if (index) expect(prompt.indexOf(instructions[index - 1]!)).toBeLessThan(prompt.indexOf(instruction))
  }
  expect(primingPrompts.join("\n").match(/READY/g)).toHaveLength(1)
  expect(primingPrompts[0]).toContain("Initialization submission only.")
  expect(primingPrompts[0]!.match(/You are a text-generation assistant/g)).toHaveLength(1)
  for (const name of tools) {
    const prompt = primingPrompts[0]!
    expect(prompt).toContain(`"name":"${name}"`)
    expect(prompt).toContain('"inputSchema"')
    for (const instruction of instructions) expect(prompt.indexOf(instruction)).toBeLessThan(prompt.indexOf(`"name":"${name}"`))
  }
}

function expectTaskPromptsExcludeStartup(parsed: { turn: { primingPrompts: readonly string[], initialPrompt: string, incrementalPrompt: string, recoveryPrompt: string } }, instructions: readonly string[] = []) {
  for (const prompt of [parsed.turn.initialPrompt, parsed.turn.incrementalPrompt, parsed.turn.recoveryPrompt]) {
    expect(prompt).not.toContain("You are a text-generation assistant working only as the backend.")
    expect(prompt).not.toContain('"inputSchema"')
    expect(prompt).not.toContain("Action shapes:")
    for (const instruction of instructions) expect(prompt).not.toContain(instruction)
  }
}

describe("webchat role at the request boundary", () => {
  for (const endpoint of ["chat", "responses"] as const) {
    test(`${endpoint} carries user, agent, and workspace startup instructions before the task and through results`, () => {
      const startup = [
        { role: "system", content: "USER INSTRUCTIONS: Report directory names only; do not invent results." },
        { role: "developer", content: "AGENT INSTRUCTIONS: Decide the next action yourself; the handler only dispatches your output." },
        { role: "developer", content: "WORKSPACE INSTRUCTIONS: The current repository is fixture-root-37. Do not access another directory." },
      ]
      const task = { role: "user", content: "List current repo folders." }
      const tool = { name: "read", description: "List a directory by path", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }
      expect(JSON.stringify([task, tool])).not.toContain("fixture-root-37")
      for (const continuation of [false, true]) {
        const messages = [...startup, task, ...(continuation ? [
          { role: "assistant", content: "", tool_calls: [{ id: "call_directory", function: { name: "read", arguments: '{"path":"fixture-root-37"}' } }] },
          { role: "tool", tool_call_id: "call_directory", content: "fixture-folder-alpha\nfixture-folder-beta" },
        ] : [])]
        const parsed = endpoint === "chat"
          ? parseOpenAIChatRequest({ model: "gpt-5.6-terra", messages, tools: [{ type: "function", function: tool }] }, new Headers({ "x-session-affinity": "startup-fixture" }))
          : parseOpenAIResponsesRequest({ model: "gpt-5.6-terra", input: [...startup, task, ...(continuation ? [
              { type: "function_call", call_id: "call_directory", name: "read", arguments: '{"path":"fixture-root-37"}' },
              { type: "function_call_output", call_id: "call_directory", output: "fixture-folder-alpha\nfixture-folder-beta" },
            ] : [])], tools: [{ type: "function", ...tool }] }, new Headers({ "x-session-affinity": "startup-fixture" }))
        expectStartup(parsed.turn.primingPrompts, startup.map(instruction => `${instruction.role.toUpperCase()}: ${instruction.content}`), ["read"])
        expectTaskPromptsExcludeStartup(parsed, startup.map(instruction => instruction.content))
        for (const prompt of [parsed.turn.initialPrompt, parsed.turn.incrementalPrompt, parsed.turn.recoveryPrompt]) {
          for (const instruction of startup) {
            expect(prompt).not.toContain(instruction.content)
          }
          expect(prompt).toEndWith(continuation ? "TOOL RESULT call_directory: fixture-folder-alpha\nfixture-folder-beta" : `USER: ${task.content}`)
          if (continuation) expect(prompt).toContain("TOOL RESULT call_directory: fixture-folder-alpha\nfixture-folder-beta")
        }
      }
    })
    for (const scenario of ["no tools", "startup schemas", "file request", "disabled tools"] as const) {
      test(`${endpoint} carries the output-only client-directed role with ${scenario}`, () => {
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

        expectStartup(parsed.turn.primingPrompts, [], scenario === "no tools" ? [] : ["write"])
        expectTaskPromptsExcludeStartup(parsed)
        for (const prompt of [parsed.turn.initialPrompt, parsed.turn.incrementalPrompt, parsed.turn.recoveryPrompt]) {
          expect(prompt).toContain(request)
        }
        if (scenario === "file request" || scenario === "startup schemas") {
          expect(parsed.projectedActions).toEqual(["write"])
          expect(parsed.turn.primingPrompts.join("\n")).toContain('"inputSchema"')
        } else {
          expect(parsed.projectedActions).toEqual([])
          expect(parsed.turn.initialPrompt).not.toContain('"inputSchema"')
        }
        if (scenario === "startup schemas") {
          expect(parsed.turn.primingPrompts.join("\n")).toContain('"description":"Write a file"')
          expect(parsed.offered).toEqual(new Set(["write"]))
          expect(parsed.turn.initialPrompt.length).toBeLessThan(4_000)
        }
        if (scenario === "no tools" || scenario === "disabled tools") {
          expect(parsed.offered.size).toBe(0)
          expect(parsed.turn.toolRepairPrompt).toBeUndefined()
          expect(parsed.turn.initialPrompt).not.toContain("If a listed action has no supplied schema")
        }
      })
    }

    for (const request of ["can use list current repo folders", "use jcodemunch mcp to find all AGENTS.md in this repo"]) {
      test(`${endpoint} primes client-action protocol and schemas for natural requests: ${request}`, () => {
        const tools = [
          { name: "read", description: "Read a file or list a directory", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
          { name: "execute", description: "Discover and call MCP tools", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
        ]
        const parsed = endpoint === "chat"
          ? parseOpenAIChatRequest({ model: "gpt-5.6-terra", messages: [{ role: "user", content: request }], tools: tools.map(tool => ({ type: "function", function: tool })) }, new Headers())
          : parseOpenAIResponsesRequest({ model: "gpt-5.6-terra", input: request, tools: tools.map(tool => ({ type: "function", ...tool })) }, new Headers())
        expect(parsed.projectedActions).toEqual(["read", "execute"])
        expect([...parsed.offered]).toEqual(["read", "execute"])
        expectStartup(parsed.turn.primingPrompts, [], ["read", "execute"])
        expectTaskPromptsExcludeStartup(parsed)
        const startup = parsed.turn.primingPrompts.join("\n")
        expect(startup).toContain('"description":"Read a file or list a directory"')
        expect(startup).toContain('"description":"Discover and call MCP tools"')
        expect(startup).toContain("Use the full schemas supplied during startup. Every action input must satisfy its schema, including all required fields.")
        expect(startup).not.toContain("If a listed action has no supplied schema")
        for (const prompt of [parsed.turn.initialPrompt, parsed.turn.incrementalPrompt, parsed.turn.recoveryPrompt]) {
          expect(prompt).toBe(`USER: ${request}`)
          expect(prompt).not.toContain('"inputSchema"')
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
      expectStartup(parsed.turn.primingPrompts)
      expectTaskPromptsExcludeStartup(parsed)
      for (const prompt of [parsed.turn.initialPrompt, parsed.turn.incrementalPrompt, parsed.turn.recoveryPrompt]) {
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
      expectStartup(parsed.turn.primingPrompts, [], [tool.name])
      expectTaskPromptsExcludeStartup(parsed)
      expect(parsed.turn.primingPrompts.join("\n")).toContain(JSON.stringify({ name: tool.name, inputSchema: tool.parameters }))
      for (const prompt of [parsed.turn.initialPrompt, parsed.turn.incrementalPrompt, parsed.turn.recoveryPrompt]) {
        expect(prompt).toBe(`USER: ${request}`)
      }
    })
  }

  for (const endpoint of ["chat", "responses"] as const) test(`${endpoint} keeps instructions separate from compaction and the latest task`, () => {
    const checkpoint = "<conversation-checkpoint>\n<summary>\nEarlier fixture inspection is complete.\n</summary>\n</conversation-checkpoint>"
    const messages = [
      { role: "system", content: "HARNESS_RULE" },
      { role: "user", content: checkpoint },
      { role: "developer", content: "CURRENT_AGENT_AND_WORKSPACE_RULE" },
      { role: "user", content: "CURRENT_USER_RULE" },
      { role: "user", content: "Continue with the next fixture." },
    ]
    const parsed = endpoint === "chat"
      ? parseOpenAIChatRequest({ model: "gpt-5.6-terra", messages }, new Headers())
      : parseOpenAIResponsesRequest({ model: "gpt-5.6-terra", input: messages }, new Headers())
    expect(parsed.turn.compactionDigest).toMatch(/^[a-f0-9]{64}$/)
    expectStartup(parsed.turn.primingPrompts, ["SYSTEM: HARNESS_RULE", "DEVELOPER: CURRENT_AGENT_AND_WORKSPACE_RULE"])
    expectTaskPromptsExcludeStartup(parsed, ["HARNESS_RULE", "CURRENT_AGENT_AND_WORKSPACE_RULE"])
    for (const prompt of [parsed.turn.initialPrompt, parsed.turn.incrementalPrompt, parsed.turn.recoveryPrompt]) {
      const sections = [`USER: ${checkpoint}`, "USER: CURRENT_USER_RULE", "USER: Continue with the next fixture."]
      for (const [index, section] of sections.entries()) {
        expect(prompt).toContain(section)
        if (index) expect(prompt.indexOf(sections[index - 1]!)).toBeLessThan(prompt.indexOf(section))
      }
      expect(prompt).not.toContain("SYSTEM: CURRENT_USER_RULE")
      expect(prompt).toEndWith(sections.at(-1)!)
    }
  })

  test("refreshes bound version-17 contracts after prompt ordering changes", () => {
    const { turn } = parseOpenAIChatRequest({
      model: "gpt-5.6-terra", messages: [{ role: "user", content: "Hello" }],
    }, new Headers())
    expect(promptContractCurrent(turn.promptContractVersion, turn.actionEnvelopeDigest, 17, turn.actionEnvelopeDigest)).toBe(false)
  })
})
