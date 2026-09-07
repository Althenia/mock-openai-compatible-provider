import { describe, expect, test } from "bun:test"
import { BrowserResponse, type BrowserProtocol } from "./browser.ts"
import { estimateTokens } from "./context.ts"
import { StreamFrameParser, type BrowserFrame } from "./protocol.ts"

const protocol: BrowserProtocol<BrowserFrame> = {
  decoder: () => new StreamFrameParser(),
  text: (delta) => ({ type: "text", delta }),
  reasoning: (delta) => ({ type: "reasoning", delta }),
  finish: (reason) => ({ type: "finish", reason }),
  isTerminal: (frame) => frame.type === "finish",
}

function wire(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`
}

const completed: Parameters<BrowserResponse<BrowserFrame>["confirm"]>[0] = {
  assistantCount: 2, complete: true, settled: true, text: "confirmed answer", thinking: [],
}

describe("browser response completion", () => {
  test("does not mix partial native records with a sibling JSON response", () => {
    const response = new BrowserResponse(protocol)
    const native = wire({ type: "reasoning-delta", delta: "native reasoning ไทย" })
    const split = native.indexOf("native") + 3
    response.push(native.slice(0, split), 1)
    response.push('{"remaining":42}', 2)
    expect(response.finish(2)).toEqual([])
    response.push(native.slice(split), 1)
    expect(response.finish(1)).toEqual([])
    expect(response.confirm(completed, 1)).toEqual([
      { type: "reasoning", delta: "native reasoning ไทย" },
      { type: "text", delta: "confirmed answer" },
      { type: "finish", reason: "stop" },
    ])
  })

  test("a sibling finish cannot publish a model stream that has not finished", () => {
    const response = new BrowserResponse(protocol)
    const tool = '<aipass-envelope>{"type":"tool","key":"turn","id":"read_1","name":"read","input":{}}</aipass-envelope>'
    response.push(wire({ type: "text-delta", delta: tool }), 1)
    response.push('{"remaining":42}', 2)
    expect(response.finish(2)).toEqual([])
    expect(response.finish(1)).toEqual([
      { type: "text", delta: tool }, { type: "finish", reason: "stop" },
    ])
    expect(response.finish(1)).toEqual([])
  })

  test("preserves a thinking-to-tool continuation across separate responses", () => {
    const response = new BrowserResponse(protocol)
    const thinking = '<aipass-envelope>{"type":"thinking","key":"turn","text":"considering"}</aipass-envelope>'
    const tool = '<aipass-envelope>{"type":"tool","key":"turn","id":"read_1","name":"read","input":{}}</aipass-envelope>'
    response.push(wire({ type: "text-delta", delta: thinking }), 1)
    expect(response.finish(1)).toEqual([])
    response.push(wire({ type: "text-delta", delta: tool }), 2)
    expect(response.finish(2)).toEqual([
      { type: "text", delta: thinking }, { type: "text", delta: tool }, { type: "finish", reason: "stop" },
    ])
  })

  test("does not publish free text or transport finish before DOM confirmation", () => {
    const response = new BrowserResponse(protocol)
    expect(response.push(wire({ type: "text", delta: "unconfirmed answer" }))).toEqual([])
    expect(response.push("data: [DONE]\n\n")).toEqual([])
    expect(response.finish()).toEqual([])
  })

  test("does not terminate a reasoning-only stream before its DOM answer", () => {
    const response = new BrowserResponse(protocol)
    expect(response.push(wire({ type: "reasoning", delta: "native thought" }))).toEqual([])
    expect(response.push(wire({ type: "finish", reason: "stop" }))).toEqual([])
    expect(response.finish()).toEqual([])
  })

  test("does not mistake an empty transport completion for a model answer", () => {
    const response = new BrowserResponse(protocol)
    expect(response.push("data: [DONE]\n\n")).toEqual([])
    expect(response.finish()).toEqual([])
  })

  test("requires current, nonempty settled DOM text, then publishes it exactly once", () => {
    const response = new BrowserResponse(protocol)
    response.push(wire({ type: "text", delta: "untrusted thought mixed with text" }))
    response.push("data: [DONE]\n\n")
    response.finish()
    for (const candidate of [
      { ...completed, complete: false },
      { ...completed, settled: false },
      { ...completed, assistantCount: 1 },
      { ...completed, text: "  " },
    ]) expect(response.confirm(candidate, 1)).toEqual([])
    expect(response.confirm(completed, 1)).toEqual([
      { type: "text", delta: "confirmed answer" }, { type: "finish", reason: "stop" },
    ])
    expect(response.outputEstimate).toBe(estimateTokens(completed.text))
    expect(response.confirm(completed, 1)).toEqual([])
    expect(response.finish()).toEqual([])
    expect(response.push(wire({ type: "text", delta: "late text" }))).toEqual([])
  })

  test("preserves native reasoning without replacing the DOM answer", () => {
    const response = new BrowserResponse(protocol)
    response.push(wire({ type: "reasoning", delta: "native thought" }))
    response.push("data: [DONE]\n\n")
    response.finish()
    expect(response.confirm(completed, 1)).toEqual([
      { type: "reasoning", delta: "native thought" },
      { type: "text", delta: "confirmed answer" },
      { type: "finish", reason: "stop" },
    ])
    expect(response.outputEstimate).toBe(estimateTokens("native thought") + estimateTokens(completed.text))
  })

  test("uses revealed DOM reasoning once rather than duplicating native fragments", () => {
    const response = new BrowserResponse(protocol)
    response.push(wire({ type: "reasoning", delta: "partial thought" }))
    expect(response.confirm({ ...completed, thinking: [{ title: "Summary", body: "complete thought" }] }, 1)).toEqual([
      { type: "reasoning", delta: "Summary\ncomplete thought" },
      { type: "text", delta: "confirmed answer" },
      { type: "finish", reason: "stop" },
    ])
  })

  test("releases a keyed envelope chain on stream completion without DOM feedback", () => {
    const response = new BrowserResponse(protocol)
    const chain = '{"type":"thinking","key":"turn","text":"summary"}\n{"type":"chat","key":"turn","text":"answer"}'
    expect(response.push(wire({ type: "text", delta: chain.slice(0, 50) }))).toEqual([])
    expect(response.push(wire({ type: "text", delta: chain.slice(50) }))).toEqual([])
    response.push(wire({ type: "finish", reason: "length" }) + "data: [DONE]\n\n")
    const frames = response.finish()
    expect(frames.filter((frame) => frame.type === "text").map((frame) => frame.delta).join("")).toBe(chain)
    expect(frames.filter((frame) => frame.type === "finish")).toEqual([{ type: "finish", reason: "length" }])
    expect(response.confirm(completed, 1)).toEqual([])
  })

  test("does not treat a thinking-only envelope as the final answer", () => {
    const response = new BrowserResponse(protocol)
    response.push(wire({ type: "text", delta: '{"type":"thinking","key":"turn","text":"summary"}' }))
    response.push("data: [DONE]\n\n")
    expect(response.finish()).toEqual([])
  })

  for (const tagged of [false, true]) {
    test(`does not finish on a settled ${tagged ? "tagged" : "bare"} thinking-only DOM envelope`, () => {
      const response = new BrowserResponse(protocol)
      const thinking = '{"type":"thinking","key":"turn","text":"still considering"}'
      const text = tagged ? `<aipass-envelope>${thinking}</aipass-envelope>` : thinking
      response.push(wire({ type: "reasoning-delta", delta: "native reasoning" }))
      expect(response.confirm({ ...completed, text }, 1)).toEqual([])
      expect(response.finish()).toEqual([])
      expect(response.confirm(completed, 1)).toEqual([
        { type: "reasoning", delta: "native reasoning" },
        { type: "text", delta: "confirmed answer" },
        { type: "finish", reason: "stop" },
      ])
    })
  }

  test("preserves a captured thinking envelope when the DOM supplies the later tool call", () => {
    const response = new BrowserResponse(protocol)
    const thinking = '<aipass-envelope>{"type":"thinking","key":"turn","text":"still considering"}</aipass-envelope>'
    const tool = '<aipass-envelope>{"type":"tool","key":"turn","id":"call_1","name":"read","input":{}}</aipass-envelope>'
    response.push(wire({ type: "text-delta", delta: thinking }))
    expect(response.confirm({ ...completed, text: tool }, 1)).toEqual([
      { type: "text", delta: thinking },
      { type: "text", delta: tool },
      { type: "finish", reason: "stop" },
    ])
  })

  test("does not duplicate thinking already included in the complete DOM chain", () => {
    const response = new BrowserResponse(protocol)
    const thinking = '<aipass-envelope>{"type":"thinking","key":"turn","text":"still considering"}</aipass-envelope>'
    const answer = '<aipass-envelope>{"type":"chat","key":"turn","text":"answer"}</aipass-envelope>'
    response.push(wire({ type: "text-delta", delta: thinking }))
    expect(response.confirm({ ...completed, text: `${thinking}\n${answer}` }, 1)).toEqual([
      { type: "text", delta: `${thinking}\n${answer}` }, { type: "finish", reason: "stop" },
    ])
  })

  test("keeps captured native and envelope reasoning in their original order", () => {
    const response = new BrowserResponse(protocol)
    const thinking = '<aipass-envelope>{"type":"thinking","key":"turn","text":"first segment"}</aipass-envelope>'
    response.push(wire({ type: "text-delta", delta: thinking }))
    response.push(wire({ type: "reasoning-delta", delta: "second segment" }))
    expect(response.confirm(completed, 1)).toEqual([
      { type: "text", delta: thinking },
      { type: "reasoning", delta: "second segment" },
      { type: "text", delta: "confirmed answer" },
      { type: "finish", reason: "stop" },
    ])
  })

  test("preserves ordinary prose that discusses a thinking envelope", () => {
    const response = new BrowserResponse(protocol)
    const text = 'This is an example: {"type":"thinking","text":"summary"}'
    expect(response.confirm({ ...completed, text }, 1)).toEqual([
      { type: "text", delta: text }, { type: "finish", reason: "stop" },
    ])
  })

  test("preserves a native length limit when DOM confirms a free-text answer", () => {
    const response = new BrowserResponse(protocol)
    response.push(wire({ type: "finish", reason: "length" }) + "data: [DONE]\n\n")
    expect(response.confirm(completed, 1).at(-1)).toEqual({ type: "finish", reason: "length" })
  })

  test("retains wrong-key envelopes for runtime rejection instead of converting them to free text", () => {
    const response = new BrowserResponse(protocol)
    const raw = '<aipass-envelope>{"type":"tool","key":"wrong","name":"read","input":{}}</aipass-envelope>'
    response.push(wire({ type: "text", delta: raw }))
    expect(response.finish()).toEqual([
      { type: "text", delta: raw }, { type: "finish", reason: "stop" },
    ])
  })

  test("preserves a completed captured envelope when DOM confirmation wins the race", () => {
    const response = new BrowserResponse(protocol)
    const raw = '<aipass-envelope>{"type":"tool","key":"wrong","id":"call_1","name":"read","input":{}}</aipass-envelope>'
    response.push(wire({ type: "text", delta: raw }))
    expect(response.confirm(completed, 1)).toEqual([
      { type: "text", delta: raw }, { type: "finish", reason: "stop" },
    ])
  })

  test("uses a complete DOM envelope chain that extends the captured envelope prefix", () => {
    const response = new BrowserResponse(protocol)
    const first = '<aipass-envelope>{"type":"tool","key":"wrong","id":"call_1","name":"read","input":{}}</aipass-envelope>'
    const second = '<aipass-envelope>{"type":"tool","key":"wrong","id":"call_2","name":"glob","input":{}}</aipass-envelope>'
    response.push(wire({ type: "text", delta: first }))
    expect(response.confirm({ ...completed, text: `${first}\n${second}` }, 1)).toEqual([
      { type: "text", delta: `${first}\n${second}` }, { type: "finish", reason: "stop" },
    ])
  })

  test("keeps DOM terminal-envelope output when captured text is only partial", () => {
    const response = new BrowserResponse(protocol)
    response.push(wire({ type: "text", delta: '<aipass-envelope>{"type":"tool","key":"k"' }))
    const domEnvelope = '<aipass-envelope>{"type":"chat","key":"k","id":"answer","text":"DOM answer"}</aipass-envelope>'
    expect(response.confirm({ ...completed, text: domEnvelope }, 1)).toEqual([
      { type: "text", delta: domEnvelope }, { type: "finish", reason: "stop" },
    ])
  })

  test("propagates explicit stream failure instead of accepting DOM text", () => {
    expect(() => new BrowserResponse(protocol).push(wire({ type: "error", message: "provider failed" }))).toThrow("provider failed")
    expect(() => new BrowserResponse(protocol).push(wire({ type: "auth-required" }))).toThrow("authentication is required")
  })
})
