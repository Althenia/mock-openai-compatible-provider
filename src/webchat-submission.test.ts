import { expect, mock, test } from "bun:test"
import { withTurnKey } from "./browser.ts"
import { runSerialStartup } from "./browser-turn-flow.ts"
import { EVERY_TURN_ENVELOPE_GUARD } from "./protocol.ts"

function guardCount(text: string) {
  return text.split(EVERY_TURN_ENVELOPE_GUARD).length - 1
}

test("withTurnKey injects guard exactly once after TURN KEY line", () => {
  const submitted = withTurnKey("BODY", "k")
  expect(submitted).toBe(`TURN KEY: k\n\n${EVERY_TURN_ENVELOPE_GUARD}\n\nBODY`)
  expect(guardCount(submitted)).toBe(1)
})

test("withTurnKey does not duplicate a body that already contains the guard", () => {
  const submitted = withTurnKey(`${EVERY_TURN_ENVELOPE_GUARD}\n\nBODY`, "k")
  expect(submitted.startsWith("TURN KEY: k\n\n")).toBe(true)
  expect(guardCount(submitted)).toBe(1)
})

test("withTurnKey without a key returns the body unchanged", () => {
  expect(withTurnKey("BODY")).toBe("BODY")
  expect(guardCount(withTurnKey("BODY"))).toBe(0)
})

test("runSerialStartup prime capture carries guard exactly once with fresh keys", async () => {
  const prime = mock(async (_prompt: string) => 1)
  const commit = mock((_identity: string) => undefined)
  const options = {
    primingPrompts: ["P1", `${EVERY_TURN_ENVELOPE_GUARD}\n\nP2`],
    startupIdentity: "stable-init", primedIdentity: undefined,
    carriesEnvelope: true, reusableSelection: false, prime, reset: mock(() => undefined), commit,
  }
  await runSerialStartup(options)
  const submitted = prime.mock.calls.map(([prompt]) => prompt as string)
  expect(submitted).toHaveLength(2)
  const keys = submitted.map((prompt) => /^TURN KEY: ([^\n]+)\n\n/.exec(prompt)?.[1])
  for (const prompt of submitted) {
    expect(guardCount(prompt)).toBe(1)
  }
  expect(keys[0]).toBeDefined()
  expect(keys[1]).toBeDefined()
  expect(keys[0]).not.toBe(keys[1])
})
