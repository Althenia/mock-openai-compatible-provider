import { randomBytes, randomUUID } from "node:crypto"
import { chmod, mkdir, open, readFile, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { persistPrivate, type Paths } from "./config.ts"

export type AttemptStatus = "pending" | "complete" | "cancelled" | "failed"

export interface Attempt {
  readonly id: string
  readonly promptHash: string
  readonly status: AttemptStatus
  readonly updatedAt: number
}

export interface Binding {
  readonly remoteChatID?: string
  readonly attempt?: Attempt
  readonly context?: RemoteContextState
  readonly updatedAt: number
}

export interface RemoteContextState {
  readonly epoch: number
  readonly estimatedTokens: number
  readonly compactionDigest?: string
  readonly accountedAttemptID?: string
  readonly promptContractVersion?: number
  readonly actionEnvelopeDigest?: string
}

interface BindingFile {
  readonly version: 1
  readonly sessions: Readonly<Record<string, Binding>>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function attempt(value: unknown): Attempt | undefined {
  const item = record(value)
  if (
    !item ||
    typeof item.id !== "string" ||
    typeof item.promptHash !== "string" ||
    typeof item.updatedAt !== "number" ||
    !["pending", "complete", "cancelled", "failed"].includes(String(item.status))
  )
    return undefined
  return item as unknown as Attempt
}

function context(value: unknown): RemoteContextState | undefined {
  const item = record(value)
  if (
    !item ||
    !Number.isSafeInteger(item.epoch) ||
    Number(item.epoch) < 0 ||
    !Number.isSafeInteger(item.estimatedTokens) ||
    Number(item.estimatedTokens) < 0
  )
    return undefined
  return {
    epoch: Number(item.epoch),
    estimatedTokens: Number(item.estimatedTokens),
    ...(typeof item.compactionDigest === "string" ? { compactionDigest: item.compactionDigest } : {}),
    ...(typeof item.accountedAttemptID === "string" ? { accountedAttemptID: item.accountedAttemptID } : {}),
    ...(Number.isSafeInteger(item.promptContractVersion) && Number(item.promptContractVersion) >= 0
      ? { promptContractVersion: Number(item.promptContractVersion) }
      : {}),
    ...(typeof item.actionEnvelopeDigest === "string" ? { actionEnvelopeDigest: item.actionEnvelopeDigest } : {}),
  }
}

function decode(value: unknown): BindingFile {
  const root = record(value)
  if (!root || root.version !== 1 || !record(root.sessions)) throw new Error("binding state is invalid")
  const sessions: Record<string, Binding> = {}
  for (const [session, candidate] of Object.entries(root.sessions as Record<string, unknown>)) {
    const item = record(candidate)
    if (!item || typeof item.updatedAt !== "number") continue
    const remoteChatID = typeof item.remoteChatID === "string" ? item.remoteChatID : undefined
    const currentAttempt = attempt(item.attempt)
    const currentContext = context(item.context)
    sessions[session] = {
      updatedAt: item.updatedAt,
      ...(remoteChatID ? { remoteChatID } : {}),
      ...(currentAttempt ? { attempt: currentAttempt } : {}),
      ...(currentContext ? { context: currentContext } : {}),
    }
  }
  return { version: 1, sessions }
}

export type PendingDecision = "proceed" | "fail-closed" | "recover"

export function pendingDecision(current: Attempt | undefined, incomingHash: string): PendingDecision {
  if (current?.status !== "pending") return "proceed"
  return current.promptHash === incomingHash ? "fail-closed" : "recover"
}

export class BindingStore {
  private cache: BindingFile | undefined
  private tail = Promise.resolve()
  private readonly sessions = new Map<string, Promise<void>>()

  constructor(readonly path: string) {}

  private async exclusive<A>(operation: () => Promise<A>): Promise<A> {
    const previous = this.tail
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    this.tail = previous.then(
      () => gate,
      () => gate,
    )
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async load() {
    if (this.cache) return this.cache
    try {
      this.cache = decode(JSON.parse(await readFile(this.path, "utf8")))
      await chmod(this.path, 0o600)
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
      this.cache = { version: 1, sessions: {} }
    }
    return this.cache
  }

  private async persist(state: BindingFile) {
    await persistPrivate(this.path, `${JSON.stringify(state)}\n`)
    this.cache = state
  }

  async get(session: string) {
    return this.exclusive(async () => (await this.load()).sessions[session])
  }

  async bind(session: string, remoteChatID: string) {
    await this.exclusive(async () => {
      const current = await this.load()
      await this.persist({
        version: 1,
        sessions: {
          ...current.sessions,
          [session]: { ...current.sessions[session], remoteChatID, updatedAt: Date.now() },
        },
      })
    })
  }

  async attempt(session: string, value: Attempt) {
    await this.exclusive(async () => {
      const current = await this.load()
      await this.persist({
        version: 1,
        sessions: {
          ...current.sessions,
          [session]: { ...current.sessions[session], attempt: value, updatedAt: Date.now() },
        },
      })
    })
  }

  async rotate(session: string, digest: string) {
    return this.exclusive(async () => {
      const current = await this.load()
      const existing = current.sessions[session]
      if (existing?.context?.compactionDigest === digest) return false
      await this.persist({
        version: 1,
        sessions: {
          ...current.sessions,
          [session]: {
            updatedAt: Date.now(),
            context: {
              epoch: (existing?.context?.epoch ?? 0) + 1,
              estimatedTokens: 0,
              compactionDigest: digest,
              promptContractVersion: 0,
            },
          },
        },
      })
      return true
    })
  }

  async complete(
    session: string,
    value: Attempt,
    remoteChatID: string | undefined,
    estimatedTokens: number,
    promptContractVersion?: number,
    actionEnvelopeDigest?: string,
  ) {
    await this.exclusive(async () => {
      const current = await this.load()
      const existing = current.sessions[session]
      const previous = existing?.context
      const alreadyAccounted = previous?.accountedAttemptID === value.id
      await this.persist({
        version: 1,
        sessions: {
          ...current.sessions,
          [session]: {
            ...existing,
            ...(remoteChatID ? { remoteChatID } : {}),
            attempt: value,
            context: {
              epoch: previous?.epoch ?? 0,
              estimatedTokens: (previous?.estimatedTokens ?? 0) + (alreadyAccounted ? 0 : estimatedTokens),
              ...(previous?.compactionDigest ? { compactionDigest: previous.compactionDigest } : {}),
              accountedAttemptID: value.id,
              ...(promptContractVersion === undefined
                ? previous?.promptContractVersion === undefined
                  ? {}
                  : { promptContractVersion: previous.promptContractVersion }
                : { promptContractVersion }),
              ...(actionEnvelopeDigest === undefined
                ? previous?.actionEnvelopeDigest === undefined
                  ? {}
                  : { actionEnvelopeDigest: previous.actionEnvelopeDigest }
                : { actionEnvelopeDigest }),
            },
            updatedAt: Date.now(),
          },
        },
      })
    })
  }

  async remove(session: string) {
    await this.exclusive(async () => {
      const current = await this.load()
      if (!(session in current.sessions)) return
      const sessions = { ...current.sessions }
      delete sessions[session]
      await this.persist({ version: 1, sessions })
    })
  }

  async acquireSession(session: string): Promise<() => void> {
    const previous = this.sessions.get(session) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const tail = previous.then(() => gate)
    this.sessions.set(session, tail)
    await previous
    let active = true
    return () => {
      if (!active) return
      active = false
      release()
      if (this.sessions.get(session) === tail) this.sessions.delete(session)
    }
  }
}

function validToken(value: string) {
  return value.length >= 64 && value.length % 2 === 0 && /^[a-f0-9]+$/i.test(value)
}

export async function readExistingToken(paths: Paths) {
  const value = (await readFile(paths.credential, "utf8")).trim()
  if (!validToken(value)) throw new Error("credential file is invalid")
  await chmod(paths.credential, 0o600)
  return value
}

export async function readOrCreateToken(paths: Paths) {
  await mkdir(paths.root, { recursive: true, mode: 0o700 })
  await chmod(paths.root, 0o700)
  try {
    return await readExistingToken(paths)
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
  }
  const token = randomBytes(32).toString("hex")
  try {
    const file = await open(paths.credential, "wx", 0o600)
    try {
      await file.writeFile(`${token}\n`, "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
    await chmod(paths.credential, 0o600)
    return token
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
    return readExistingToken(paths)
  }
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

export class ProfileLock {
  private released = false

  private constructor(
    private readonly path: string,
    private readonly identity: string,
  ) {}

  static async acquire(paths: Paths) {
    await mkdir(paths.root, { recursive: true, mode: 0o700 })
    await chmod(paths.root, 0o700)
    const identity = `${process.pid}:${randomUUID()}`
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const file = await open(paths.lock, "wx", 0o600)
        try {
          await file.writeFile(`${identity}\n`, "utf8")
          await file.sync()
        } finally {
          await file.close()
        }
        await chmod(paths.lock, 0o600)
        return new ProfileLock(paths.lock, identity)
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
        const existing = await readFile(paths.lock, "utf8").catch(() => "")
        const pid = Number(existing.trim().split(":", 1)[0])
        if (Number.isSafeInteger(pid) && pid > 0 && processAlive(pid))
          throw new Error("browser profile is already owned by another provider process")
        await rm(paths.lock, { force: true })
      }
    }
    throw new Error("browser profile lock could not be acquired")
  }

  async release() {
    if (this.released) return
    this.released = true
    const current = await readFile(this.path, "utf8").catch(() => "")
    if (current.trim() === this.identity) await rm(this.path, { force: true })
  }
}
