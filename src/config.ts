import { existsSync } from "node:fs"
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { createServer } from "node:net"
import { dirname, join } from "node:path"

import { MODELS } from "./model-catalog.ts"

export { MODELS } from "./model-catalog.ts"

export const LOOPBACK_HOST = "127.0.0.1" as const
export const DEFAULT_CHAT_URL = "https://de.aipass.net/chat?temporary-chat=true"

export type Environment = Record<string, string | undefined>
export type Reasoning = "none" | "low" | "medium" | "high" | "max"

export interface Paths {
  readonly root: string
  readonly profile: string
  readonly credential: string
  readonly bindings: string
  readonly lock: string
}

export interface Settings {
  readonly configPath: string
  readonly requestedPort?: number
  readonly paths: Paths
  readonly chatURL: string
  readonly chromeExecutable: string
  readonly navigationTimeoutMs: number
  readonly streamIdleTimeoutMs: number
  readonly streamURLPattern?: string
  readonly browserHeaded: boolean
  readonly screenshotDir?: string
}

export type Command =
  | { readonly type: "help" }
  | { readonly type: "version" }
  | { readonly type: "update"; readonly settings: Settings; readonly version?: string; readonly installDir?: string }
  | { readonly type: "serve"; readonly settings: Settings }
  | { readonly type: "stop"; readonly settings: Settings }
  | { readonly type: "endpoint"; readonly settings: Settings }
  | { readonly type: "login"; readonly settings: Settings }
  | { readonly type: "print-token"; readonly settings: Settings }

export interface RuntimeConfig {
  readonly version: 1
  readonly host: typeof LOOPBACK_HOST
  readonly port: number
}

export type SelectionAction =
  | { readonly type: "select-last" }
  | { readonly type: "expand-if-single" }
  | { readonly type: "choose-thinking"; readonly index: number }
  | { readonly type: "confirm" }

export type ThinkingLevel = Exclude<Reasoning, "none">

export function pathsFromRoot(root: string): Paths {
  return {
    root,
    profile: join(root, "browser-profile"),
    credential: join(root, "credential"),
    bindings: join(root, "bindings.json"),
    lock: join(root, "profile.lock"),
  }
}

function defaultChromeExecutable() {
  if (platform() === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if (platform() === "win32") return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  return "/usr/bin/google-chrome"
}

function xdgPath(environment: Environment, kind: "config" | "state") {
  const explicit = environment[kind === "config" ? "XDG_CONFIG_HOME" : "XDG_STATE_HOME"]?.trim()
  if (explicit) return explicit
  const home = environment.HOME?.trim() || homedir()
  if (!home) throw new Error("HOME or XDG paths are required")
  return join(home, kind === "config" ? ".config" : ".local/state")
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function port(value: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535)
    throw new Error("port must be an integer from 1 through 65535")
  return parsed
}

export function usage() {
  return "usage: aipass-browser-provider <command> [options]\n\ncommands:\n  start        run the provider server in the foreground\n  serve        alias for start\n  stop         request graceful shutdown of the active server\n  update       install the latest verified release (stop the provider first)\n  endpoint     print the configured OpenAI-compatible endpoint\n  login        open the signed-in Chrome profile to sign in and verify access (window stays open)\n  print-token  print the provider bearer token\n  version      print the release version (--version is an alias)\n  help         print this help\n\noptions:\n  --config PATH\n  --state-root PATH\n  --chrome PATH\n  --port PORT\n\nupdate options:\n  --version VERSION       select a release instead of latest\n  --install-dir DIRECTORY override the executable installation directory\n  --state-root PATH       use the same profile lock as the provider\n\nUse `aipass-browser-provider help`, `--help`, or `-h` for this text."
}

export function parseCommand(
  arguments_: readonly string[],
  environment: Environment = process.env,
  options: { readonly verifyChrome?: boolean } = {},
): Command {
  const [command, ...rest] = arguments_
  if (["version", "--version"].includes(command ?? "")) {
    if (rest.length) throw new Error(usage())
    return { type: "version" }
  }
  if (["help", "--help", "-h"].includes(command ?? "")) {
    if (rest.length) throw new Error(usage())
    return { type: "help" }
  }
  if (!command || !["start", "serve", "stop", "update", "endpoint", "login", "print-token"].includes(command))
    throw new Error(usage())

  let configPath = environment.AIPASS_CONFIG_PATH?.trim() || join(xdgPath(environment, "config"), "aipass-browser-provider/config.json")
  let stateRoot = environment.AIPASS_STATE_ROOT?.trim() || join(xdgPath(environment, "state"), "aipass-browser-provider")
  let chromeExecutable = environment.AIPASS_BROWSER_EXECUTABLE?.trim() || defaultChromeExecutable()
  let requestedPort = command !== "update" && environment.AIPASS_PORT ? port(environment.AIPASS_PORT) : undefined
  let updateVersion: string | undefined
  let installDir = environment.AIPASS_INSTALL_DIR?.trim() || undefined
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index]
    const value = rest[index + 1]
    if (!value) throw new Error(`missing value for ${option}\n${usage()}`)
    if (option === "--config") configPath = value
    else if (option === "--state-root") stateRoot = value
    else if (option === "--chrome") chromeExecutable = value
    else if (option === "--port" && ["start", "serve", "endpoint"].includes(command)) requestedPort = port(value)
    else if (option === "--version" && command === "update") {
      if (!/^v?\d+\.\d+\.\d+$/.test(value)) throw new Error("invalid release version; expected X.Y.Z or vX.Y.Z")
      updateVersion = value
    }
    else if (option === "--install-dir" && command === "update") installDir = value
    else throw new Error(`unknown option ${option}\n${usage()}`)
  }
  if (rest.length % 2 !== 0) throw new Error(`missing option value\n${usage()}`)
  if (
    options.verifyChrome !== false &&
    ["start", "serve", "login"].includes(command) &&
    !existsSync(chromeExecutable)
  )
    throw new Error(`Chrome executable does not exist: ${chromeExecutable}`)

  const settings: Settings = {
    configPath,
    requestedPort,
    paths: pathsFromRoot(stateRoot),
    chatURL: environment.AIPASS_CHAT_URL?.trim() || DEFAULT_CHAT_URL,
    chromeExecutable,
    navigationTimeoutMs: positiveInteger(environment.AIPASS_NAVIGATION_TIMEOUT_MS, 90_000),
    streamIdleTimeoutMs: positiveInteger(environment.AIPASS_STREAM_IDLE_TIMEOUT_MS, 120_000),
    streamURLPattern: environment.AIPASS_STREAM_URL_PATTERN?.trim() || undefined,
    browserHeaded: /^(1|true|yes|on)$/i.test(environment.AIPASS_BROWSER_HEADED?.trim() ?? ""),
    screenshotDir: environment.AIPASS_SCREENSHOT_DIR?.trim() || undefined,
  }
  if (command === "start" || command === "serve") return { type: "serve", settings }
  if (command === "stop") return { type: "stop", settings }
  if (command === "update") return { type: "update", settings, version: updateVersion, installDir }
  if (command === "endpoint") return { type: "endpoint", settings }
  if (command === "login") return { type: "login", settings }
  return { type: "print-token", settings }
}

export function model(id: string) {
  const value = MODELS.find((candidate) => candidate.id === id)
  if (!value) throw new Error(`AIPass model ${id} is not registered`)
  return value
}

export function selectionPlan(id: string, reasoning: Reasoning): readonly SelectionAction[] {
  const definition = model(id)
  if (reasoning === "none")
    return definition.thinking.length ? [{ type: "expand-if-single" }, { type: "select-last" }] : [{ type: "select-last" }]
  const index = definition.thinking.indexOf(reasoning)
  if (index < 0) throw new Error(`AIPass model ${id} does not support the requested thinking level`)
  return [{ type: "choose-thinking", index }, { type: "confirm" }]
}

export function endpointURL(config: RuntimeConfig) {
  return `http://${config.host}:${config.port}/v1`
}

export function validateRuntimeConfig(value: unknown): RuntimeConfig {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Partial<RuntimeConfig>).version !== 1 ||
    (value as Partial<RuntimeConfig>).host !== LOOPBACK_HOST ||
    !Number.isSafeInteger((value as Partial<RuntimeConfig>).port) ||
    Number((value as Partial<RuntimeConfig>).port) < 1 ||
    Number((value as Partial<RuntimeConfig>).port) > 65_535
  )
    throw new Error("runtime config is invalid")
  return value as RuntimeConfig
}

export async function readRuntimeConfig(path: string) {
  try {
    const value = validateRuntimeConfig(JSON.parse(await readFile(path, "utf8")))
    await chmod(path, 0o600)
    return value
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

export async function persistPrivate(path: string, content: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700)
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  const file = await open(temporary, "wx", 0o600)
  try {
    await file.writeFile(content)
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  await chmod(path, 0o600)
}

export async function persistRuntimeConfig(path: string, config: RuntimeConfig) {
  await persistPrivate(path, JSON.stringify(validateRuntimeConfig(config)))
}

async function availablePort(requested = 0) {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen({ host: LOOPBACK_HOST, port: requested, exclusive: true }, () => {
      const address = server.address()
      const selected = typeof address === "object" && address ? address.port : 0
      server.close((error) => {
        if (error) reject(error)
        else if (selected > 0) resolve(selected)
        else reject(new Error("cannot inspect selected loopback port"))
      })
    })
  })
}

export async function ensureEndpointConfig(settings: Settings) {
  const persisted = await readRuntimeConfig(settings.configPath)
  if (settings.requestedPort === undefined && persisted) return persisted
  let selected: number
  try {
    selected = await availablePort(settings.requestedPort)
  } catch (error) {
    const target = settings.requestedPort
    throw new Error(
      target
        ? `cannot bind 127.0.0.1:${target}: ${error instanceof Error ? error.message : "port unavailable"}`
        : `cannot select an available loopback port: ${error instanceof Error ? error.message : "port unavailable"}`,
    )
  }
  const config: RuntimeConfig = { version: 1, host: LOOPBACK_HOST, port: selected }
  await persistRuntimeConfig(settings.configPath, config)
  return config
}
