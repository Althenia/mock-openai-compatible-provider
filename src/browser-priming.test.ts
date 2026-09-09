import { expect, mock, test } from "bun:test"
import { runSerialStartup } from "./browser-turn-flow.ts"
import { estimateTokens } from "./context.ts"
import { parseOpenAIChatRequest } from "./http.ts"

const messages = [
  { role: "system", content: "Synthetic preserved client instruction.\n".repeat(220) },
  { role: "developer", content: "AGENT_RULE: Use supplied results. WORKSPACE_RULE: fixture-root." },
  { role: "user", content: "Earlier fixture task." },
  { role: "assistant", content: "Earlier fixture answer." },
  { role: "user", content: "Reply ready." },
]

function turn(mode: "preserve" | "action-only", nextMessages = messages) {
  return parseOpenAIChatRequest({
    model: "gemini-3.1-flash-lite", session_id: "priming-fixture", instruction_mode: mode, messages: nextMessages,
  }, new Headers()).turn
}

for (const mode of ["preserve", "action-only"] as const) test(`${mode} projects serial startup separately from full caller history`, () => {
  const input = turn(mode)
  expect(input.primingPrompts).toHaveLength(mode === "preserve" ? 3 : 1)
  expect(input.primingPrompts[0]).toStartWith("You are a text-generation assistant working only as the backend.")
  expect(input.primingPrompts.join("\n").match(/READY/g)).toHaveLength(1)
  if (mode === "preserve") {
    expect(input.primingPrompts[1]).toContain("SYSTEM: " + "Synthetic preserved client instruction.\n".repeat(220))
    expect(input.primingPrompts[2]).toContain("DEVELOPER: AGENT_RULE")
  }
  for (const prompt of [input.initialPrompt, input.recoveryPrompt]) {
    expect(prompt).toContain("USER: Earlier fixture task.\n\nASSISTANT: Earlier fixture answer.\n\nUSER: Reply ready.")
    expect(prompt).not.toContain("Synthetic preserved client instruction.")
    expect(prompt).not.toContain("DEVELOPER: AGENT_RULE")
  }
  expect(input.incrementalPrompt).toBe("USER: Reply ready.")
})

test("serial startup gates each next request and commits identity only after every internal reply", async () => {
  const input = turn("preserve")
  const first = Promise.withResolvers<number>()
  const second = Promise.withResolvers<number>()
  const third = Promise.withResolvers<number>()
  const replies = [first, second, third]
  const requests = mock((_prompt: string, index: number) => replies[index]!.promise)
  const resets = mock(() => undefined)
  const commits = mock((_identity: string) => undefined)
  const identity = "fixture:model:preserve"
  const work = runSerialStartup({
    primingPrompts: input.primingPrompts, startupIdentity: identity, primedIdentity: undefined, carriesEnvelope: true, reusableSelection: false,
    prime: requests, reset: resets, commit: commits,
  })
  expect(resets).toHaveBeenCalledTimes(1)
  await Promise.resolve()
  expect(requests).toHaveBeenCalledTimes(1)
  expect(requests).toHaveBeenLastCalledWith(input.primingPrompts[0], 0)
  expect(commits).not.toHaveBeenCalled()
  first.resolve(estimateTokens(input.primingPrompts[0]!) + estimateTokens("READY"))
  await Promise.resolve()
  expect(requests).toHaveBeenCalledTimes(2)
  expect(requests).toHaveBeenLastCalledWith(input.primingPrompts[1], 1)
  expect(commits).not.toHaveBeenCalled()
  second.resolve(estimateTokens(input.primingPrompts[1]!) + estimateTokens("READY"))
  await Promise.resolve()
  expect(requests).toHaveBeenCalledTimes(3)
  expect(requests).toHaveBeenLastCalledWith(input.primingPrompts[2], 2)
  expect(commits).not.toHaveBeenCalled()
  third.resolve(estimateTokens(input.primingPrompts[2]!) + estimateTokens("READY"))
  await expect(work).resolves.toBe(input.primingPrompts.reduce((total, prompt) => total + estimateTokens(prompt) + estimateTokens("READY"), 0))
  expect(resets).toHaveBeenCalledTimes(1)
  expect(commits).toHaveBeenCalledTimes(1)
  expect(commits).toHaveBeenCalledWith(identity)
})

test("startup failure and cancellation short-circuit without committing, then a later recovery re-primes", async () => {
  const input = turn("preserve")
  for (const error of [Error("fixture startup failed"), new DOMException("fixture cancelled", "AbortError")]) {
    const requests = mock(async (_prompt: string, _index: number) => 7)
      .mockResolvedValueOnce(5)
      .mockRejectedValueOnce(error)
    const commits = mock((_identity: string) => undefined)
    const reset = mock(() => undefined)
    const options = {
      primingPrompts: input.primingPrompts, startupIdentity: "fixture", primedIdentity: "old", carriesEnvelope: true, reusableSelection: false,
      prime: requests, reset, commit: commits,
    }
    await expect(runSerialStartup(options)).rejects.toBe(error)
    expect(requests.mock.calls).toEqual([[input.primingPrompts[0], 0], [input.primingPrompts[1], 1]])
    expect(reset).toHaveBeenCalledTimes(1)
    expect(commits).not.toHaveBeenCalled()
    requests.mockClear()
    await expect(runSerialStartup({ ...options, primedIdentity: undefined })).resolves.toBe(21)
    expect(requests.mock.calls).toEqual(input.primingPrompts.map((prompt, index) => [prompt, index]))
    expect(reset).toHaveBeenCalledTimes(2)
    expect(commits.mock.calls).toEqual([["fixture"]])
  }
})

for (const scenario of [
  { name: "bound unchanged startup", prompts: ["STARTUP"], primedIdentity: "current", carriesEnvelope: false, reusableSelection: true, expected: false },
  { name: "recovery or compaction", prompts: ["STARTUP"], primedIdentity: "current", carriesEnvelope: true, reusableSelection: true, expected: true },
  { name: "model selection invalidated", prompts: ["STARTUP"], primedIdentity: "current", carriesEnvelope: false, reusableSelection: false, expected: true },
  { name: "startup identity changed", prompts: ["STARTUP"], primedIdentity: "old", carriesEnvelope: false, reusableSelection: true, expected: true },
  { name: "new page without startup identity", prompts: ["STARTUP"], primedIdentity: undefined, carriesEnvelope: false, reusableSelection: true, expected: true },
  { name: "no startup blocks", prompts: [], primedIdentity: undefined, carriesEnvelope: true, reusableSelection: false, expected: false },
]) test(`startup decision: ${scenario.name}`, async () => {
  const prime = mock(async (_prompt: string, _index: number) => 13)
  const reset = mock(() => undefined)
  const commit = mock((_identity: string) => undefined)
  const options = { ...scenario, primingPrompts: scenario.prompts, startupIdentity: "current", prime, reset, commit }
  await expect(runSerialStartup(options)).resolves.toBe(scenario.expected ? 13 : 0)
  expect(prime.mock.calls).toEqual(scenario.expected ? [["STARTUP", 0]] : [])
  expect(reset).toHaveBeenCalledTimes(scenario.expected ? 1 : 0)
  expect(commit.mock.calls).toEqual(scenario.expected ? [["current"]] : [])
  prime.mockClear()
  reset.mockClear()
  commit.mockClear()
  await expect(runSerialStartup({ ...options, primedIdentity: "current", carriesEnvelope: false, reusableSelection: true })).resolves.toBe(0)
  expect(prime).not.toHaveBeenCalled()
  expect(reset).not.toHaveBeenCalled()
  expect(commit).not.toHaveBeenCalled()
})
