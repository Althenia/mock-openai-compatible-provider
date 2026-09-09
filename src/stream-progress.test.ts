import { expect, mock, test } from "bun:test"
import { streamingFrames } from "./stream-progress.ts"
import type { BrowserFrame } from "./protocol.ts"

test("defers source creation until the first frame is requested", async () => {
  const source = mock(async function* () { yield { type: "text", delta: "answer" } as BrowserFrame })
  const stream = streamingFrames(source, new AbortController().signal)
  expect(source).not.toHaveBeenCalled()
  expect(await stream.next()).toEqual({ value: { type: "text", delta: "answer" }, done: false })
  expect(source).toHaveBeenCalledTimes(1)
  expect(await stream.next()).toEqual({ value: undefined, done: true })
})

test("passes actual frames in order without waiting for the terminal frame", async () => {
  const release = Promise.withResolvers<void>()
  const source = mock(async function* () {
    yield { type: "reasoning", delta: "thinking" } as BrowserFrame
    yield { type: "text", delta: "answer" } as BrowserFrame
    await release.promise
    yield { type: "finish", reason: "stop" } as BrowserFrame
  })
  const stream = streamingFrames(source, new AbortController().signal)
  expect((await stream.next()).value).toEqual({ type: "reasoning", delta: "thinking" })
  expect((await stream.next()).value).toEqual({ type: "text", delta: "answer" })
  release.resolve()
  expect((await stream.next()).value).toEqual({ type: "finish", reason: "stop" })
  expect((await stream.next()).done).toBe(true)
})

test("propagates a source failure without a synthesized completion", async () => {
  const release = Promise.withResolvers<void>()
  const closed = mock(() => undefined)
  async function* source() {
    try {
      yield { type: "text", delta: "partial" } as BrowserFrame
      await release.promise
      throw Error("fixture source failure")
    } finally { closed() }
  }
  const stream = streamingFrames(source, new AbortController().signal)
  expect((await stream.next()).value).toEqual({ type: "text", delta: "partial" })
  const failed = stream.next()
  release.resolve()
  await expect(failed).rejects.toThrow("fixture source failure")
  expect(closed).toHaveBeenCalledTimes(1)
})

test("cancellation returns the underlying iterator after its blocked source is released", async () => {
  const release = Promise.withResolvers<void>()
  const closed = mock(() => undefined)
  async function* source() {
    try {
      yield { type: "text", delta: "partial" } as BrowserFrame
      await release.promise
      yield { type: "finish", reason: "stop" } as BrowserFrame
    } finally { closed() }
  }
  const abort = new AbortController()
  const stream = streamingFrames(source, abort.signal)
  expect((await stream.next()).value).toEqual({ type: "text", delta: "partial" })
  const blocked = stream.next()
  abort.abort()
  const cancelled = stream.return(undefined)
  release.resolve()
  await expect(blocked).rejects.toThrow()
  await cancelled
  expect(closed).toHaveBeenCalledTimes(1)
})

test("cancellation before startup does not create the source", async () => {
  const source = mock(async function* () { yield { type: "finish", reason: "stop" } as BrowserFrame })
  const abort = new AbortController()
  const stream = streamingFrames(source, abort.signal)
  abort.abort()
  await expect(stream.next()).rejects.toThrow()
  expect(source).not.toHaveBeenCalled()
})
