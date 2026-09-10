import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCLI } from "./cli.ts"

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aipass-cli-"))
  temporary.push(root)
  return { root, config: join(root, "config.json"), state: join(root, "state") }
}

describe("compiled CLI execution", () => {
  test("reports the release version without Chrome or state initialization", async () => {
    const output: string[] = []
    const errors: string[] = []
    const { root } = await fixture()
    const io = { out: (value: string) => output.push(value), error: (value: string) => errors.push(value) }
    for (const command of ["version", "--version"]) {
      expect(await runCLI([command], io)).toBe(0)
      expect(output.pop()).toBe("0.1.6")
    }
    expect(errors).toEqual([])
    expect(await readdir(root)).toEqual([])
    expect(await runCLI(["--version", "extra"], io)).toBe(1)
    expect(output).toEqual([])
    expect(errors).toHaveLength(1)
  })

  test("prints help, endpoint, and a stable token without opening Chrome", async () => {
    const output: string[] = []
    const error: string[] = []
    const io = { out: (value: string) => output.push(value), error: (value: string) => error.push(value) }
    const { config, state } = await fixture()
    const selected = ["--config", config, "--state-root", state]
    expect(await runCLI(["help"], io)).toBe(0)
    expect(output.pop()).toContain("run the provider server")
    expect(await runCLI(["endpoint", ...selected], io)).toBe(0)
    expect(output.at(-1)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    expect(await runCLI(["print-token", ...selected], io)).toBe(0)
    const first = output.at(-1)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(await runCLI(["print-token", ...selected], io)).toBe(0)
    expect(output.at(-1)).toBe(first)
    expect(error).toEqual([])
  })

  test("returns failure and writes one safe error for invalid input", async () => {
    const output: string[] = []
    const error: string[] = []
    const io = { out: (value: string) => output.push(value), error: (value: string) => error.push(value) }
    await fixture()
    expect(await runCLI(["unknown"], io)).toBe(1)
    expect(output).toEqual([])
    expect(error).toHaveLength(1)
    expect(error[0]).toContain("usage:")
  })
})
