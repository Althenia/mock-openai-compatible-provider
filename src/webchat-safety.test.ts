import { expect, test } from "bun:test"
import { BrowserResponse, WebchatSafetyBlockError, type BrowserProtocol, type BrowserTurnInput } from "./browser.ts"
import { parseOpenAIChatRequest } from "./http.ts"
import { StreamFrameParser, type BrowserFrame } from "./protocol.ts"
import { StandaloneBrowserService } from "./runtime.ts"
import { createRequestHandler } from "./server.ts"

const notice = "ขออภัย! ข้อความของคุณอาจมีบางส่วนที่ขัดกับระบบความปลอดภัย (อาจเกิดจากระบบหรือโมเดล AI) รบกวนลองปรับแก้แล้วส่งใหม่อีกครั้ง หรือถ้าคุณคิดว่าระบบอาจจะเข้าใจผิด สามารถติดต่อเจ้าหน้าที่เพื่อขอความช่วยเหลือเพิ่มเติม"
const protocol: BrowserProtocol<BrowserFrame> = {
  decoder: () => new StreamFrameParser(),
  text: delta => ({ type: "text", delta }),
  reasoning: delta => ({ type: "reasoning", delta }),
  finish: reason => ({ type: "finish", reason }),
  isTerminal: frame => frame.type === "finish",
}
const wire = (delta: string) => `data: ${JSON.stringify({ type: "text-delta", delta })}\n\n`

test("split webchat guardrail notice fails during capture without finish or DOM fallback", () => {
  const response = new BrowserResponse(protocol)
  let consumed = 0
  expect(() => {
    for (const delta of notice) {
      consumed++
      response.push(wire(delta), 1)
    }
  }).toThrow(WebchatSafetyBlockError)
  expect(consumed).toBeLessThan(notice.length)
})

test("guardrail fragments from unrelated streams are not joined", () => {
  const response = new BrowserResponse(protocol)
  expect(response.push(wire("ขัดกับระบบ"), 1)).toEqual([])
  expect(response.push(wire("ความปลอดภัย"), 2)).toEqual([])
})

test("current DOM guardrail fails confirmation before settlement while stale snapshots are ignored", () => {
  const snapshot = {
    assistantCount: 2, complete: false, settled: false, text: notice,
    attributed: true, thinking: [{ title: "", body: "Working." }],
  }
  expect(() => new BrowserResponse(protocol).confirm(snapshot, 1)).toThrow(WebchatSafetyBlockError)
  expect(new BrowserResponse(protocol).confirm(snapshot, 2)).toEqual([])
  expect(new BrowserResponse(protocol).progress({ ...snapshot, attributed: false }, "current")).toEqual([])
})

for (const phase of ["initial", "wrong-key", "repair", "provision"] as const) {
  test(`${phase} guardrail stops the harness turn before retry, fallback, or more upstream reads`, async () => {
    const parsed = parseOpenAIChatRequest({
      model: "gpt-5.6-terra", session_id: `guardrail-${phase}`,
      messages: [{ role: "user", content: "Read the synthetic fixture." }],
      tools: [{ type: "function", function: {
        name: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      } }],
    }, new Headers())
    let submissions = 0
    let afterBlock = 0
    let closed = false
    const service = new StandaloneBrowserService({
      async *turn(input: BrowserTurnInput): AsyncGenerator<BrowserFrame> {
        submissions++
        if (submissions === 1 && (phase === "repair" || phase === "provision")) {
          const value = phase === "repair"
            ? { type: "chat", text: "I cannot access the file system tools here." }
            : { type: "tool", name: "read", id: "missing", input: {} }
          yield { type: "text", delta: `<aipass-envelope>${JSON.stringify({ key: input.promptKey, ...value })}</aipass-envelope>` }
          yield { type: "finish", reason: "stop" }
          return
        }
        try {
          const text = phase === "wrong-key"
            ? `<aipass-envelope>${JSON.stringify({ type: "chat", key: "stale-key", text: notice })}</aipass-envelope>`
            : notice
          for (const delta of text) yield { type: "text", delta }
          afterBlock++
          yield { type: "finish", reason: "stop" }
        } finally { closed = true }
      },
    } as never)
    const run = async () => { for await (const _ of service.turn(parsed.turn)) {} }
    await expect(run()).rejects.toBeInstanceOf(WebchatSafetyBlockError)
    expect(submissions).toBe(phase === "repair" || phase === "provision" ? 2 : 1)
    expect(afterBlock).toBe(0)
    expect(closed).toBe(true)
  })
}

for (const path of ["/v1/chat/completions", "/v1/responses"]) {
  for (const progressed of [false, true]) test(`${path} exposes a structured guardrail failure ${progressed ? "after reasoning" : "before streaming"}`, async () => {
    const token = "a".repeat(64)
    let submissions = 0
    const handler = createRequestHandler({
      token, shutdown: async () => {},
      browser: {
        async *turn(input) {
          submissions++
          if (progressed) yield { type: "reasoning", delta: "Visible reasoning.", domTurnKey: input.promptKey }
          throw new WebchatSafetyBlockError()
        },
        async login() {}, async close() {}, async discard() {},
      },
    })
    const response = await handler(new Request(`http://127.0.0.1${path}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-terra", stream: true,
        ...(path === "/v1/responses" ? { input: "Hello" } : { messages: [{ role: "user", content: "Hello" }] }),
      }),
    }))
    expect(response.status).toBe(progressed ? 200 : 422)
    const body = await response.text()
    expect(body).toContain('"code":"webchat_safety_block"')
    expect(body).not.toContain("response.completed")
    expect(body).not.toContain('"finish_reason":"stop"')
    if (progressed) expect(body).toContain("Visible reasoning.")
    if (progressed && path === "/v1/responses") expect(body).toContain('"type":"error"')
    expect(submissions).toBe(1)
  })
}
