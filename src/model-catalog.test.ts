import { describe, expect, test } from "bun:test"
import { MODELS as configModels } from "./config.ts"
import { MODELS as catalogModels, THINKING_LABELS } from "./model-catalog.ts"

function matrixRows(document: string) {
  const header = "| Model ID | Model name | Configured Processing variants | Live UI verification |"
  const headerIndex = document.indexOf(header)
  expect(headerIndex).toBeGreaterThanOrEqual(0)

  return document
    .slice(headerIndex + header.length)
    .split("\n## ", 1)[0]!
    .split("\n")
    .filter((line) => /^\| `[^`]+` \|/.test(line))
    .map((line) => {
      const [, id, name, variants] = line.split("|").map((cell) => cell.trim())
      return { id: id.slice(1, -1), name, variants }
    })
}

describe("model catalog", () => {
  test("config re-exports the canonical catalog identity", () => {
    expect(configModels).toBe(catalogModels)
  })

  test("has unique model IDs and names", () => {
    expect(new Set(catalogModels.map((model) => model.id)).size).toBe(catalogModels.length)
    expect(new Set(catalogModels.map((model) => model.name)).size).toBe(catalogModels.length)
  })

  test("matches every model-matrix row", async () => {
    const document = await Bun.file("docs/model-matrix.md").text()
    expect(matrixRows(document)).toEqual(
      catalogModels.map((model) => ({
        id: model.id,
        name: model.name,
        variants: model.thinking.length ? model.thinking.join(", ") : "—",
      })),
    )
  })

  test("matches the documented English and Thai Processing labels", async () => {
    const document = await Bun.file("docs/model-matrix.md").text()
    for (const [level, labels] of Object.entries(THINKING_LABELS)) {
      const row = document.split("\n").find(line => line.startsWith(`| \`${level}\` |`))
      expect(row?.split("|").slice(2, 4).map(cell => cell.trim())).toEqual([...labels])
    }
  })
})
