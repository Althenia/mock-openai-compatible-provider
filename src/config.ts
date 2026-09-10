import { existsSync } from "node:fs"
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises"
import { platform } from "node:os"
import { createServer } from "node:net"
import { dirname, isAbsolute, join } from "node:path"

import { MODELS } from "./model-catalog.ts"

export { MODELS } from "./model-catalog.ts"

export const LOOPBACK_HOST = "127.0.0.1" as const
export const DEFAULT_CHAT_URL = "https://de.aipass.net/chat?temporary-chat=true"

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
  readonly installDir?: string
  readonly defaultInstallDir: string
  readonly config: ProviderConfig
  readonly overrides?: ConfigOverrides
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

export interface ProviderConfig {
  readonly version: 1
  readonly host: typeof LOOPBACK_HOST
  readonly port?: number
  readonly stateRoot: string
  readonly chromeExecutable: string
  readonly chatURL: string
  readonly navigationTimeoutMs: number
  readonly streamIdleTimeoutMs: number
  readonly streamURLPattern?: string
  readonly browserHeaded: boolean
  readonly screenshotDir?: string
  readonly installDir?: string
}

export interface RuntimeConfig extends ProviderConfig { readonly port: number }

export interface ConfigOverrides {
  readonly port?: number
  readonly stateRoot?: string
  readonly chromeExecutable?: string
  readonly installDir?: string
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

function nativeAccountHome() {
  if (platform() !== "darwin" || typeof process.getuid !== "function")
    throw new Error("native macOS account home is unavailable")
  const result = Bun.spawnSync(["/usr/bin/dscacheutil", "-q", "user", "-a", "uid", String(process.getuid())], {
    env: {},
    stdout: "pipe",
    stderr: "pipe",
    timeout: 2_000,
  })
  if (result.exitCode !== 0) throw new Error("could not determine the native macOS account home")
  const homes = result.stdout.toString().split(/\r?\n/).flatMap((line) => line.startsWith("dir: ") ? [line.slice(5)] : [])
  if (homes.length !== 1 || !isAbsolute(homes[0]!) || homes[0]!.includes("\0"))
    throw new Error("native macOS account home is missing or invalid")
  return homes[0]!
}

function port(value: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535)
    throw new Error("port must be an integer from 1 through 65535")
  return parsed
}

function defaultProviderConfig(home: string): ProviderConfig {
  return {
    version: 1,
    host: LOOPBACK_HOST,
    stateRoot: join(home, ".local/state/aipass-browser-provider"),
    chromeExecutable: defaultChromeExecutable(),
    chatURL: DEFAULT_CHAT_URL,
    navigationTimeoutMs: 90_000,
    streamIdleTimeoutMs: 120_000,
    browserHeaded: true,
  }
}

function settingsFromConfig(configPath: string, config: ProviderConfig, defaultInstallDir: string, overrides?: ConfigOverrides): Settings {
  const effective = {
    ...config,
    ...(overrides?.port === undefined ? {} : { port: overrides.port }),
    ...(overrides?.stateRoot === undefined ? {} : { stateRoot: overrides.stateRoot }),
    ...(overrides?.chromeExecutable === undefined ? {} : { chromeExecutable: overrides.chromeExecutable }),
    ...(overrides?.installDir === undefined ? {} : { installDir: overrides.installDir }),
  }
  return {
    configPath,
    requestedPort: overrides?.port,
    paths: pathsFromRoot(effective.stateRoot),
    chatURL: effective.chatURL,
    chromeExecutable: effective.chromeExecutable,
    navigationTimeoutMs: effective.navigationTimeoutMs,
    streamIdleTimeoutMs: effective.streamIdleTimeoutMs,
    streamURLPattern: effective.streamURLPattern,
    browserHeaded: effective.browserHeaded,
    screenshotDir: effective.screenshotDir,
    installDir: effective.installDir,
    defaultInstallDir,
    config,
    overrides,
  }
}

export function usage() {
  return "usage: aipass-browser-provider <command> [options]\n\ncommands:\n  start        run the provider server in the foreground\n  serve        alias for start\n  stop         request graceful shutdown of the active server\n  update       install the latest verified release (stop the provider first)\n  endpoint     print the configured OpenAI-compatible endpoint\n  login        open the signed-in Chrome profile to sign in and verify access (window stays open)\n  print-token  print the provider bearer token\n  version      print the release version (--version is an alias)\n  help         print this help\n\noptions:\n  --config PATH\n  --state-root PATH\n  --chrome PATH\n  --port PORT\n\nupdate options:\n  --version VERSION       select a release instead of latest\n  --install-dir DIRECTORY override the executable installation directory\n  --state-root PATH       use the same profile lock as the provider\n\nUse `aipass-browser-provider help`, `--help`, or `-h` for this text."
}

export function parseCommand(
  arguments_: readonly string[],
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

  const home = nativeAccountHome()
  let configPath = join(home, ".config/aipass-browser-provider/config.json")
  let stateRoot: string | undefined
  let chromeExecutable: string | undefined
  let requestedPort: number | undefined
  let updateVersion: string | undefined
  let installDir: string | undefined
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
  const defaults = defaultProviderConfig(home)
  const overrides: ConfigOverrides = {
    ...(requestedPort === undefined ? {} : { port: requestedPort }),
    ...(stateRoot === undefined ? {} : { stateRoot }),
    ...(chromeExecutable === undefined ? {} : { chromeExecutable }),
    ...(installDir === undefined ? {} : { installDir }),
  }
  const settings = settingsFromConfig(configPath, defaults, join(home, ".local/bin"), overrides)
  if (options.verifyChrome !== false && ["start", "serve", "login"].includes(command) && !existsSync(settings.chromeExecutable))
    throw new Error(`Chrome executable does not exist: ${settings.chromeExecutable}`)
  if (command === "start" || command === "serve") return { type: "serve", settings }
  if (command === "stop") return { type: "stop", settings }
  if (command === "update") return { type: "update", settings, version: updateVersion, installDir: settings.installDir }
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

export function endpointURL(config: Pick<RuntimeConfig, "host" | "port">) {
  return `http://${config.host}:${config.port}/v1`
}

function configRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("config must be a JSON object")
  return value as Record<string, unknown>
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim()) throw new Error(`config ${field} must be a non-empty string`)
  return value
}

function positiveConfigInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`config ${field} must be a positive integer`)
  return Number(value)
}

export function validateProviderConfig(value: unknown, defaults: ProviderConfig): ProviderConfig {
  const input = configRecord(value)
  if (input.version !== 1) throw new Error("config version must be 1")
  if (input.host !== LOOPBACK_HOST) throw new Error(`config host must be ${LOOPBACK_HOST}`)
  let configuredPort: number | undefined
  if (input.port !== undefined) {
    if (!Number.isSafeInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65_535)
      throw new Error("config port must be an integer from 1 through 65535")
    configuredPort = Number(input.port)
  }
  const boolean = (field: string, fallback: boolean) => {
    const candidate = input[field]
    if (candidate === undefined) return fallback
    if (typeof candidate !== "boolean") throw new Error(`config ${field} must be a boolean`)
    return candidate
  }
  return {
    version: 1,
    host: LOOPBACK_HOST,
    ...(configuredPort === undefined ? {} : { port: configuredPort }),
    stateRoot: optionalString(input.stateRoot, "stateRoot") ?? defaults.stateRoot,
    chromeExecutable: optionalString(input.chromeExecutable, "chromeExecutable") ?? defaults.chromeExecutable,
    chatURL: optionalString(input.chatURL, "chatURL") ?? defaults.chatURL,
    navigationTimeoutMs: positiveConfigInteger(input.navigationTimeoutMs, "navigationTimeoutMs", defaults.navigationTimeoutMs),
    streamIdleTimeoutMs: positiveConfigInteger(input.streamIdleTimeoutMs, "streamIdleTimeoutMs", defaults.streamIdleTimeoutMs),
    streamURLPattern: optionalString(input.streamURLPattern, "streamURLPattern"),
    browserHeaded: boolean("browserHeaded", defaults.browserHeaded),
    screenshotDir: optionalString(input.screenshotDir, "screenshotDir"),
    installDir: optionalString(input.installDir, "installDir"),
  }
}

export async function readProviderConfig(path: string, defaults: ProviderConfig) {
  try {
    const value = validateProviderConfig(JSON.parse(await readFile(path, "utf8")), defaults)
    await chmod(path, 0o600)
    return value
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

export async function loadCommandConfiguration(
  command: Exclude<Command, { readonly type: "help" | "version" }>,
  options: { readonly verifyChrome?: boolean } = {},
): Promise<typeof command> {
  const file = await readProviderConfig(command.settings.configPath, command.settings.config)
  const config = file ?? command.settings.config
  const settings = settingsFromConfig(command.settings.configPath, config, command.settings.defaultInstallDir, command.settings.overrides)
  if (options.verifyChrome !== false && (command.type === "serve" || command.type === "login") && !existsSync(settings.chromeExecutable))
    throw new Error(`Chrome executable does not exist: ${settings.chromeExecutable}`)
  if (command.type === "update") return { ...command, settings, installDir: command.settings.overrides?.installDir ?? settings.installDir }
  return { ...command, settings }
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

export async function persistRuntimeConfig(path: string, config: ProviderConfig) {
  const validated = validateProviderConfig(config, config)
  if (validated.port === undefined) throw new Error("config port is required")
  await persistPrivate(path, JSON.stringify(validated))
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
  if (settings.requestedPort === undefined && settings.config.port !== undefined) return settings.config as RuntimeConfig
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
  const config: RuntimeConfig = { ...settings.config, version: 1, host: LOOPBACK_HOST, port: selected }
  await persistRuntimeConfig(settings.configPath, config)
  return config
}
