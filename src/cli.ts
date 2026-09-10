import { endpointURL, ensureEndpointConfig, loadCommandConfiguration, parseCommand, usage, type Command, type Settings } from "./config.ts"
import { ProfileLock, readExistingToken, readOrCreateToken } from "./state.ts"
import { version } from "../package.json"
import { basename, dirname } from "node:path"
import installer from "../site/install.sh" with { type: "text" }

export interface CLIIO {
  readonly out: (value: string) => void
  readonly error: (value: string) => void
}

export interface CLIDependencies {
  readonly serve?: (settings: Settings) => Promise<void>
  readonly login?: (settings: Settings) => Promise<void>
  readonly installerEnvironment?: Record<string, string | undefined>
  readonly spawnInstaller?: (
    arguments_: readonly string[],
    options: { readonly env?: Record<string, string | undefined>; readonly stdin: "ignore"; readonly stdout: "pipe"; readonly stderr: "pipe" },
  ) => { readonly exited: Promise<number>; readonly stdout: ReadableStream<Uint8Array>; readonly stderr: ReadableStream<Uint8Array> }
}

async function requestStop(settings: Settings) {
  const config = settings.config.port === undefined ? undefined : { ...settings.config, port: settings.config.port }
  if (!config) throw new Error("runtime config does not contain a port; no provider server can be stopped")
  const token = await readExistingToken(settings.paths)
  const response = await fetch(new URL("/shutdown", endpointURL(config).replace(/\/v1$/, "")), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  }).catch((error) => {
    throw new Error(`provider server is not reachable at 127.0.0.1:${config.port}`, { cause: error })
  })
  if (!response.ok) throw new Error("provider server rejected the authenticated stop request")
}

async function update(command: Extract<Command, { type: "update" }>, io: CLIIO, dependencies: CLIDependencies) {
  let installDir = command.installDir
  // Bun's compiled entrypoint lives in its virtual filesystem. Never use the
  // Bun executable's directory when this CLI is invoked from source.
  if (!installDir && import.meta.path.startsWith("/$bunfs/")) {
    if (basename(process.execPath) !== "aipass-browser-provider")
      throw new Error("renamed executable: use update --install-dir DIRECTORY to select the installation")
    installDir = dirname(process.execPath)
  }
  installDir ??= command.settings.defaultInstallDir
  const lock = await ProfileLock.acquire(command.settings.paths).catch(error => {
    if (!(error instanceof Error) || error.message !== "browser profile is already owned by another provider process") throw error
    throw new Error("cannot update: stop the provider and close login for this state root first", { cause: error })
  })
  try {
    const args = ["/bin/sh", "-c", installer, "aipass-installer"]
    if (command.version) args.push("--version", command.version)
    if (installDir) args.push("--install-dir", installDir)
    const child = (dependencies.spawnInstaller ?? Bun.spawn)(args, {
      ...(dependencies.installerEnvironment === undefined ? {} : { env: dependencies.installerEnvironment }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    if (stdout.trim()) io.out(stdout.trimEnd())
    if (code !== 0) throw new Error(stderr.trim() || `update installer failed (exit ${code})`)
    if (stderr.trim()) io.error(stderr.trimEnd())
  } finally { await lock.release() }
}

export async function runCLI(
  arguments_: readonly string[],
  io: CLIIO = { out: console.log, error: console.error },
  dependencies: CLIDependencies = {},
) {
  try {
    const parsed = parseCommand(arguments_, { verifyChrome: false })
    const command = parsed.type === "help" || parsed.type === "version"
      ? parsed
      : await loadCommandConfiguration(parsed)
    if (command.type === "help") io.out(usage())
    else if (command.type === "version") io.out(version)
    else if (command.type === "update") await update(command, io, dependencies)
    else if (command.type === "endpoint") io.out(endpointURL(await ensureEndpointConfig(command.settings)))
    else if (command.type === "print-token") io.out(await readOrCreateToken(command.settings.paths))
    else if (command.type === "stop") {
      await requestStop(command.settings)
      io.out("provider server stopped")
    } else if (command.type === "serve") {
      if (!dependencies.serve) throw new Error("provider server runtime is unavailable")
      await dependencies.serve(command.settings)
    } else {
      if (!dependencies.login) throw new Error("browser login runtime is unavailable")
      await dependencies.login(command.settings)
    }
    return 0
  } catch (error) {
    io.error(error instanceof Error ? error.message : "AIPass provider command failed")
    return 1
  }
}
