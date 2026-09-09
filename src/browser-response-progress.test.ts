import { expect, test } from "bun:test"
import { BrowserResponse, WebchatSafetyBlockError, type BrowserProtocol } from "./browser.ts"
import { StreamFrameParser, type BrowserFrame } from "./protocol.ts"

const protocol: BrowserProtocol<BrowserFrame> = {
  decoder: () => new StreamFrameParser(), text: delta => ({ type: "text", delta }),
  reasoning: delta => ({ type: "reasoning", delta }), finish: reason => ({ type: "finish", reason }),
  isTerminal: frame => frame.type === "finish",
}
const wire = (delta: string) => `data: ${JSON.stringify({ type: "text-delta", delta })}\n\n`
const body = '<aipass-envelope>{"type":"chat","key":"fixture-key","id":"answer","text":"hello world"}</aipass-envelope>'

test("captured text can progress before native completion and is not replayed at finish", () => {
  const response = new BrowserResponse(protocol)
  response.push(wire(body.slice(0, 80)), 1)
  expect(response.drainCapturedText()).toEqual([{ type: "text", delta: body.slice(0, 80) }])
  expect(response.drainCapturedText()).toEqual([])
  response.push(wire(body.slice(80)), 1)
  expect(response.drainCapturedText()).toEqual([{ type: "text", delta: body.slice(80) }])
  expect(response.finish(1)).toEqual([{ type: "finish", reason: "stop" }])
  expect(response.drainCapturedText()).toEqual([])
})

test("buffered initialization capture remains unchanged when progressive draining is unused", () => {
  const response = new BrowserResponse(protocol)
  expect(response.push(wire(body), 1)).toEqual([])
  expect(response.finish(1)).toEqual([{ type: "text", delta: body }, { type: "finish", reason: "stop" }])
})

test("draining only exposes text, never native reasoning, calls or completion", () => {
  const response = new BrowserResponse(protocol)
  response.push('data: {"type":"reasoning-delta","delta":"native"}\n\n', 1)
  expect(response.drainCapturedText()).toEqual([])
  response.push(wire(body), 1)
  expect(response.drainCapturedText()).toEqual([{ type: "text", delta: body }])
  expect(response.finish(1)).toEqual([{ type: "reasoning", delta: "native" }, { type: "finish", reason: "stop" }])
})

test("streaming capture keeps the same estimated output accounting as buffered capture", () => {
  const streamed = new BrowserResponse(protocol), buffered = new BrowserResponse(protocol)
  for (const response of [streamed, buffered]) response.push(wire(body), 1)
  streamed.drainCapturedText()
  streamed.finish(1)
  buffered.finish(1)
  expect(streamed.outputEstimate).toBe(buffered.outputEstimate)
})

test("a divergent DOM fallback after captured output fails rather than rewriting emitted text", () => {
  const response = new BrowserResponse(protocol)
  response.push(wire(body.slice(0, 80)), 1)
  response.drainCapturedText()
  expect(() => response.confirm({ assistantCount: 1, text: "Different answer", complete: true, settled: true, thinking: [] }, 0)).toThrow("changed after progressive capture")
})

test("DOM completion may extend the emitted prefix without replaying it", () => {
  const response = new BrowserResponse(protocol)
  response.push(wire(body.slice(0, 80)), 1)
  response.drainCapturedText()
  expect(response.confirm({ assistantCount: 1, text: body, complete: true, settled: true, thinking: [] }, 0))
    .toEqual([{ type: "text", delta: body.slice(80) }, { type: "finish", reason: "stop" }])
})

test("late safety failure does not produce completion after a captured prefix", () => {
  const response = new BrowserResponse(protocol)
  response.push(wire(body.slice(0, 80)), 1)
  expect(response.drainCapturedText()).toHaveLength(1)
  expect(() => response.push(wire("ขัดกับระบบความปลอดภัย"), 1)).toThrow(WebchatSafetyBlockError)
  expect(response.drainCapturedText()).toEqual([])
})

test("safety detection still runs before a captured chunk can be drained", () => {
  const response = new BrowserResponse(protocol)
  expect(() => response.push(wire("ขัดกับระบบความปลอดภัย"), 1)).toThrow(WebchatSafetyBlockError)
  expect(response.drainCapturedText()).toEqual([])
})
