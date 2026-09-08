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
  expect(turn.primingPrompts[0]).toStartWith("You are the agent backend.")
  for (const [index, instruction] of ["SYSTEM: HARNESS", "DEVELOPER: AGENT", "SYSTEM: WORKSPACE"].entries()) {
    expect(turn.primingPrompts[index + 1]).toContain(instruction)
  }
  for (const prompt of [turn.initialPrompt, turn.incrementalPrompt, turn.recoveryPrompt]) {
    expect(prompt).toContain("USER: TASK")
    for (const text of ["You are the agent backend.", "HARNESS", "AGENT", "WORKSPACE"]) expect(prompt).not.toContain(text)
  }
})

test("startup identity includes instruction message boundaries", () => {
  const one = parse([{ role: "system", content: "A\n\nSYSTEM: B" }, { role: "user", content: "TASK" }])
  const two = parse([{ role: "system", content: "A" }, { role: "system", content: "B" }, { role: "user", content: "TASK" }])
  expect(one.actionEnvelopeDigest).not.toBe(two.actionEnvelopeDigest)
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
