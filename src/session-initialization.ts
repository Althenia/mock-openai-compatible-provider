export const SESSION_INITIALIZATION_MAX_ENTRIES = 1_000
export const SESSION_INITIALIZATION_MAX_BYTES = 16 * 1024 * 1024

export interface SessionInitialization {
  readonly instructions?: readonly unknown[] | string
  readonly tools?: readonly unknown[]
  readonly instructionMode?: "preserve" | "action-only"
}

export class SessionInitializationCapacityError extends Error {
  constructor() {
    super("session initialization capacity is exhausted")
    this.name = "SessionInitializationCapacityError"
  }
}

export function sessionInitializationBytes(value: SessionInitialization): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

export class SessionInitializationStore {
  private readonly entries = new Map<string, { readonly value: SessionInitialization; readonly bytes: number }>()
  private retainedBytes = 0

  constructor(
    private readonly maxEntries = SESSION_INITIALIZATION_MAX_ENTRIES,
    private readonly maxBytes = SESSION_INITIALIZATION_MAX_BYTES,
  ) {}

  get(key: string): SessionInitialization | undefined {
    return this.entries.get(key)?.value
  }

  set(key: string, value: SessionInitialization): void {
    const previous = this.entries.get(key)
    const bytes = sessionInitializationBytes(value)
    const nextEntries = this.entries.size + (previous ? 0 : 1)
    const nextBytes = this.retainedBytes - (previous?.bytes ?? 0) + bytes
    if (nextEntries > this.maxEntries || nextBytes > this.maxBytes)
      throw new SessionInitializationCapacityError()
    this.entries.set(key, { value, bytes })
    this.retainedBytes = nextBytes
  }
}
