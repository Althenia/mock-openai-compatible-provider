import { expect, mock, test } from "bun:test"
import { withTurnKey } from "./browser.ts"
import { runSerialStartup } from "./browser-turn-flow.ts"
import { EVERY_TURN_ENVELOPE_GUARD } from "./protocol.ts"

test("initialization submissions have a fresh key and the same guard as every task submission", async () => {
  const prime = mock(async (_prompt: string) => 1)
  const commit = mock((_identity: string) => undefined)
  const options = {
    primingPrompts: ["INITIALIZATION"], startupIdentity: "stable-init", primedIdentity: undefined,
    carriesEnvelope: true, reusableSelection: false, prime, reset: mock(() => undefined), commit,
  }
  await runSerialStartup(options)
  await runSerialStartup(options)
  const submitted = prime.mock.calls.map(([prompt]) => prompt)
  const keys = submitted.map(prompt => /^TURN KEY: ([^\n]+)\n\n/.exec(prompt)?.[1])
  for (const [index, prompt] of submitted.entries()) {
    expect(keys[index]).toBeDefined()
    expect(prompt).toBe(withTurnKey("INITIALIZATION", keys[index]))
    expect(prompt.split(EVERY_TURN_ENVELOPE_GUARD)).toHaveLength(2)
  }
  expect(keys[0]).not.toBe(keys[1])
  expect(commit.mock.calls).toEqual([["stable-init"], ["stable-init"]])
})

for (const prompt of ["USER: task", "TOOL RESULT call_1: result", "Correct the previous action request.", "RECOVERY TRANSCRIPT"]) {
  test(`submission wrapper preserves the supplied delta: ${prompt.split(":")[0]}`, () => {
    const submitted = withTurnKey(prompt, "current-key")
    expect(submitted).toBe(`TURN KEY: current-key\n\n${EVERY_TURN_ENVELOPE_GUARD}\n\n${prompt}`)
    expect(submitted).not.toContain("Offered actions:")
  })
}
