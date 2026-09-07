import { endpointURL, ensureEndpointConfig, parseCommand, readRuntimeConfig, usage, type Environment, type Settings } from "./config.ts"
import { readExistingToken, readOrCreateToken } from "./state.ts"
import { version } from "../package.json"

export interface CLIIO {
  readonly out: (value: string) => void
  readonly error: (value: string) => void
}

export interface CLIDependencies {
  readonly serve?: (settings: Settings) => Promise<void>
  readonly login?: (settings: Settings) => Promise<void>
}

async function requestStop(settings: Settings) {
  const config = await readRuntimeConfig(settings.configPath)
  if (!config) throw new Error("runtime config does not exist; no provider server can be stopped")
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

export async function runCLI(
  arguments_: readonly string[],
  environment: Environment = process.env,
  io: CLIIO = { out: console.log, error: console.error },
  dependencies: CLIDependencies = {},
) {
  try {
    const command = parseCommand(arguments_, environment)
    if (command.type === "help") io.out(usage())
    else if (command.type === "version") io.out(version)
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
