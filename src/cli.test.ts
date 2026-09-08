import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCLI } from "./cli.ts"

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function environment() {
  const home = await mkdtemp(join(tmpdir(), "aipass-cli-"))
  temporary.push(home)
  return { HOME: home }
}

describe("compiled CLI execution", () => {
  test("reports the release version without Chrome or state initialization", async () => {
    const output: string[] = []
    const errors: string[] = []
    const env = { ...await environment(), AIPASS_PORT: "invalid", AIPASS_BROWSER_EXECUTABLE: "/missing-chrome" }
    const io = { out: (value: string) => output.push(value), error: (value: string) => errors.push(value) }
    for (const command of ["version", "--version"]) {
      expect(await runCLI([command], env, io)).toBe(0)
      expect(output.pop()).toBe("0.1.3")
    }
    expect(errors).toEqual([])
    expect(await readdir(env.HOME)).toEqual([])
    expect(await runCLI(["--version", "extra"], env, io)).toBe(1)
    expect(output).toEqual([])
    expect(errors).toHaveLength(1)
  })

  test("prints help, endpoint, and a stable token without opening Chrome", async () => {
    const output: string[] = []
    const error: string[] = []
    const io = { out: (value: string) => output.push(value), error: (value: string) => error.push(value) }
    const env = await environment()
    expect(await runCLI(["help"], env, io)).toBe(0)
    expect(output.pop()).toContain("run the provider server")
    expect(await runCLI(["endpoint"], env, io)).toBe(0)
    expect(output.at(-1)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    expect(await runCLI(["print-token"], env, io)).toBe(0)
    const first = output.at(-1)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(await runCLI(["print-token"], env, io)).toBe(0)
    expect(output.at(-1)).toBe(first)
    expect(error).toEqual([])
  })

  test("returns failure and writes one safe error for invalid input", async () => {
    const output: string[] = []
    const error: string[] = []
    const io = { out: (value: string) => output.push(value), error: (value: string) => error.push(value) }
    expect(await runCLI(["unknown"], await environment(), io)).toBe(1)
    expect(output).toEqual([])
    expect(error).toHaveLength(1)
    expect(error[0]).toContain("usage:")
  })
})
