import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runCLI } from "./cli.ts"

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "aipass-config-file-"))
  temporary.push(home)
  const configPath = join(home, "provider.json")
  return { home, configPath }
}

function io() {
  const output: string[] = []
  const errors: string[] = []
  return { output, errors, value: { out: (text: string) => output.push(text), error: (text: string) => errors.push(text) } }
}

describe("file-owned provider configuration", () => {
  test("loads runtime settings from the selected file", async () => {
    const { home, configPath } = await fixture()
    const chromeExecutable = join(home, "chrome")
    await writeFile(chromeExecutable, "synthetic")
    await writeFile(configPath, JSON.stringify({
      version: 1,
      host: "127.0.0.1",
      port: 43_201,
      stateRoot: join(home, "file-state"),
      chromeExecutable,
      chatURL: "https://file.example/chat",
      navigationTimeoutMs: 12_345,
      streamIdleTimeoutMs: 23_456,
      streamURLPattern: "/file/stream",
      browserHeaded: false,
      screenshotDir: join(home, "file-shots"),
      installDir: join(home, "file-bin"),
    }))
    const captured: unknown[] = []
    const console = io()
    const code = await runCLI(["start", "--config", configPath], console.value, {
      serve: async (settings) => { captured.push(settings) },
    })
    expect(code).toBe(0)
    expect(console.errors).toEqual([])
    expect(captured).toEqual([expect.objectContaining({
      configPath,
      chatURL: "https://file.example/chat",
      chromeExecutable,
      navigationTimeoutMs: 12_345,
      streamIdleTimeoutMs: 23_456,
      streamURLPattern: "/file/stream",
      browserHeaded: false,
      screenshotDir: join(home, "file-shots"),
      installDir: join(home, "file-bin"),
      config: expect.objectContaining({ port: 43_201 }),
    })])
    expect((captured[0] as { paths: { root: string } }).paths.root).toBe(join(home, "file-state"))
  })

  test("rejects malformed known fields with a clear field name", async () => {
    const { home, configPath } = await fixture()
    await writeFile(configPath, JSON.stringify({
      version: 1,
      host: "127.0.0.1",
      port: 43_201,
      navigationTimeoutMs: 0,
    }))
    const console = io()
    expect(await runCLI(["endpoint", "--config", configPath], console.value)).toBe(1)
    expect(console.output).toEqual([])
    expect(console.errors).toEqual(["config navigationTimeoutMs must be a positive integer"])
  })

  test("persists a selected port without replacing other validated file settings", async () => {
    const { home, configPath } = await fixture()
    const initial = {
      version: 1,
      host: "127.0.0.1",
      port: 43_202,
      stateRoot: join(home, "state"),
    }
    await writeFile(configPath, JSON.stringify(initial))
    const console = io()
    expect(await runCLI(["endpoint", "--config", configPath, "--port", "43203"], console.value)).toBe(0)
    expect(console.output).toEqual(["http://127.0.0.1:43203/v1"])
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      ...initial,
      port: 43_203,
    })
  })

  test("help and version do not read or initialize provider configuration", async () => {
    const { home } = await fixture()
    const console = io()
    expect(await runCLI(["help"], console.value)).toBe(0)
    expect(await runCLI(["version"], console.value)).toBe(0)
    expect(await readdir(home)).toEqual([])
  })
})
