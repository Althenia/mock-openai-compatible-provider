import type { BrowserFrame } from "./protocol.ts"

/** Defer backend startup until the serializer has emitted its standard start record. */
export async function* streamingFrames(source: () => AsyncIterable<BrowserFrame>, signal: AbortSignal) {
  signal.throwIfAborted()
  for await (const frame of source()) {
    signal.throwIfAborted()
    yield frame
  }
}
