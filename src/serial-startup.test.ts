import { expect, test } from "bun:test"
import { parseOpenAIChatRequest } from "./http.ts"
import { StandaloneBrowserService } from "./runtime.ts"
import type { BrowserTurnInput } from "./browser.ts"

const parse = (messages: unknown[]) => parseOpenAIChatRequest({
  model: "gemini-3.1-flash-lite", session_id: "serial-startup", messages,
}, new Headers()).turn

test("startup preserves ordered instruction boundaries separately from the task", () => {
  const turn = parse([
    { role: "system", content: "HARNESS" },
    { role: "developer", content: "AGENT" },
    { role: "system", content: "WORKSPACE" },
    { role: "user", content: "TASK" },
  ])
  expect(turn.primingPrompts).toHaveLength(4)
  expect(turn.primingPrompts[0]).toStartWith("You are a text-generation assistant working only as the backend.")
  for (const [index, instruction] of ["SYSTEM: HARNESS", "DEVELOPER: AGENT", "SYSTEM: WORKSPACE"].entries()) {
    expect(turn.primingPrompts[index + 1]).toContain(instruction)
  }
  for (const prompt of [turn.initialPrompt, turn.incrementalPrompt, turn.recoveryPrompt]) {
    expect(prompt).toContain("USER: TASK")
    for (const text of ["You are a text-generation assistant working only as the backend.", "HARNESS", "AGENT", "WORKSPACE"]) expect(prompt).not.toContain(text)
  }
})

test("startup identity includes instruction message boundaries", () => {
  const one = parse([{ role: "system", content: "A\n\nSYSTEM: B" }, { role: "user", content: "TASK" }])
  const two = parse([{ role: "system", content: "A" }, { role: "system", content: "B" }, { role: "user", content: "TASK" }])
  expect(one.actionEnvelopeDigest).not.toBe(two.actionEnvelopeDigest)
})

test("startup alone carries all schemas and one acknowledgement instruction", () => {
  const tools = ["read", "question"].map(name => ({ type: "function", function: {
    name, description: `SCHEMA ${name}`, parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  } }))
  const project = (task: string, nextTools = tools) => parseOpenAIChatRequest({
    model: "gemini-3.1-flash-lite", tools: nextTools,
    messages: [{ role: "system", content: "HARNESS" }, { role: "developer", content: "WORKSPACE" }, { role: "user", content: task }],
  }, new Headers()).turn
  const turn = project("read the file")
  const startup = turn.primingPrompts.join("\n")
  expect(startup.match(/READY/g)).toHaveLength(1)
  expect(startup.match(/You are a text-generation assistant/g)).toHaveLength(1)
  expect(startup.match(/Action shapes:/g)).toHaveLength(1)
  for (const name of ["read", "question"]) expect(startup).toContain(`"name":"${name}"`)
  expect(turn.primingPrompts).toHaveLength(5)
  expect(turn.provisionedActions).toEqual(["read", "question"])
  for (const prompt of [turn.initialPrompt, turn.incrementalPrompt, turn.recoveryPrompt]) expect(prompt).toBe("USER: read the file")
  expect(project("ask a question").actionEnvelopeDigest).toBe(turn.actionEnvelopeDigest)
  expect(project("read the file", tools.map(tool => ({ ...tool, function: { ...tool.function, description: "CHANGED" } }))).actionEnvelopeDigest).not.toBe(turn.actionEnvelopeDigest)
})

test("ordinary preserve-mode bound user turns send only the new task", () => {
  const turn = parse([
    { role: "system", content: "HARNESS" }, { role: "user", content: "OLD TASK" },
    { role: "assistant", content: "OLD ANSWER" }, { role: "user", content: "NEW TASK" },
  ])
  expect(turn.incrementalPrompt).toBe("USER: NEW TASK")
  expect(turn.initialPrompt).toBe("USER: OLD TASK\n\nASSISTANT: OLD ANSWER\n\nUSER: NEW TASK")
  expect(turn.recoveryPrompt).toBe(turn.initialPrompt)
})

test("startup replaces the active offered set when tools are removed or disabled", () => {
  const tool = (name: string) => ({ type: "function", function: { name, parameters: { type: "object" } } })
  const project = (tools: unknown[], tool_choice?: string) => parseOpenAIChatRequest({
    model: "gemini-3.1-flash-lite", tools, tool_choice, messages: [{ role: "user", content: "Continue" }],
  }, new Headers()).turn
  const initial = project([tool("read"), tool("question")])
  const removed = project([tool("question")])
  const disabled = project([tool("question")], "none")
  for (const [turn, names] of [[initial, ["read", "question"]], [removed, ["question"]], [disabled, []]] as const) {
    expect(turn.primingPrompts[0]).toContain(`Active offered actions (complete; replaces every previous offered set): ${JSON.stringify(names)}`)
    expect(turn.primingPrompts[0]).toContain("Request only names in this list.")
    expect(turn.initialPrompt).toBe("USER: Continue")
  }
  expect(removed.primingPrompts.join("\n")).not.toContain('"name":"read"')
  expect(disabled.primingPrompts).toHaveLength(1)
  expect(removed.actionEnvelopeDigest).not.toBe(initial.actionEnvelopeDigest)
  expect(disabled.actionEnvelopeDigest).not.toBe(removed.actionEnvelopeDigest)
})

test("single-flight identity includes startup, model, variant, and compaction", async () => {
  const turn = parse([{ role: "system", content: "HARNESS" }, { role: "user", content: "TASK" }])
  let calls = 0
  const service = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
    calls++
    yield { type: "text", delta: `<aipass-envelope>${JSON.stringify({ type: "chat", key: input.promptKey, text: "ready" })}</aipass-envelope>` }
    yield { type: "finish", reason: "stop" }
  } } as never)
  const run = async (next = turn) => { for await (const _ of service.turn(next)) {} }
  await run()
  await run()
  expect(calls).toBe(1)
  await run({ ...turn, primingPrompts: [...turn.primingPrompts, "CHANGED"] })
  expect(calls).toBe(2)
  await run({ ...turn, modelID: "gpt-5.6-terra" })
  expect(calls).toBe(3)
  await run({ ...turn, reasoning: "high" })
  expect(calls).toBe(4)
  await run({ ...turn, compactionDigest: "new-checkpoint" })
  expect(calls).toBe(5)
})
