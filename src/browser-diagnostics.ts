// Failure-only metadata from the pinned in-process Playwright implementation.
// Never send browser commands or include parameters, URLs, text, or errors.
type Pending = { type: string; method: string }
type Progress = {
  metadata: Pending & { timeout: number; startTime: number }
  _state: string
  _controller: AbortController
}
type Browser = {
  _connection: {
    _closed: boolean
    _transport: {
      _pendingBuffers: Uint8Array[]
      _pipeRead: { readable: boolean; readableLength: number; destroyed: boolean }
      _pipeWrite: { writable: boolean; writableLength: number; destroyed: boolean }
    }
    _sessions: Map<string, {
      _closed: boolean
      _crashed: boolean
      _callbacks: Map<number, { error: { method?: string } }>
    }>
  }
}
type Connection = {
  _callbacks: Map<number, Pending>
  toImpl(value: Connection): { _activeProgressControllers: Map<string, Progress> }
  toImpl(value: unknown): { _browser: Browser }
}

function identifier(value: unknown) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(value) ? value : "unknown"
}

function sample<K, V, R>(map: Map<K, V>, project: (value: V) => R, limit = 32) {
  const entries: R[] = []
  for (const value of map.values()) {
    if (entries.length === limit) break
    entries.push(project(value))
  }
  return { count: map.size, entries, truncated: map.size > entries.length }
}

export function browserControlState(context: unknown) {
  try {
    const connection = (context as { _connection: Connection })._connection
    const server = connection.toImpl(connection)
    const browser = connection.toImpl(context)._browser._connection
    const transport = browser._transport
    return {
      available: true,
      client: sample(connection._callbacks, pending => ({ type: identifier(pending.type), method: identifier(pending.method) })),
      server: sample(server._activeProgressControllers, progress => ({
        type: identifier(progress.metadata.type), method: identifier(progress.metadata.method),
        timeout: progress.metadata.timeout, started: progress.metadata.startTime,
        state: identifier(progress._state), aborted: progress._controller.signal.aborted,
      })),
      browser: {
        closed: browser._closed,
        pipe: {
          bufferedBytes: transport._pendingBuffers.slice(0, 32).reduce((total, buffer) => total + buffer.byteLength, 0),
          buffersTruncated: transport._pendingBuffers.length > 32,
          readable: transport._pipeRead.readable, readLength: transport._pipeRead.readableLength,
          readDestroyed: transport._pipeRead.destroyed,
          writable: transport._pipeWrite.writable, writeLength: transport._pipeWrite.writableLength,
          writeDestroyed: transport._pipeWrite.destroyed,
        },
        sessions: sample(browser._sessions, session => ({
          closed: session._closed, crashed: session._crashed,
          pending: sample(session._callbacks, callback => ({ method: identifier(callback.error.method) })),
        }), 8),
      },
    }
  } catch {
    // Diagnostics must not mask the original failure if private internals drift.
    return { available: false }
  }
}
