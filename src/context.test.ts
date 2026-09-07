import { describe, expect, test } from "bun:test"
import { compactionDigest, estimateTokens } from "./context.ts"

describe("remote context estimation", () => {
  test("uses a deterministic conservative UTF-8 estimate", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("abc")).toBe(1)
    expect(estimateTokens("ก")).toBe(1)
    expect(estimateTokens("😀")).toBe(2)
    expect(estimateTokens("repeatable")).toBe(estimateTokens("repeatable"))
  })

  test("recognizes only exact conversation checkpoints", () => {
    const checkpoint = `<conversation-checkpoint>\nThe following is a summary of earlier conversation.\n<summary>\nstate: compacted\n</summary>\n</conversation-checkpoint>`
    expect(compactionDigest([{ role: "user", content: checkpoint }])).toMatch(/^[a-f0-9]{64}$/)
    expect(compactionDigest([{ role: "user", content: `prefix ${checkpoint}` }])).toBeUndefined()
    expect(compactionDigest([{ role: "user", content: checkpoint.replace("compacted", "changed") }])).not.toBe(
      compactionDigest([{ role: "user", content: checkpoint }]),
    )
    expect(
      compactionDigest([
        { role: "user", content: checkpoint },
        { role: "user", content: checkpoint.replace("compacted", "latest") },
      ]),
    ).toBe(compactionDigest([{ role: "user", content: checkpoint.replace("compacted", "latest") }]))
  })
})
