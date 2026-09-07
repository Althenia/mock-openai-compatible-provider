import { expect, test } from "bun:test"
import { chromium } from "playwright-core"
import { BrowserResponse, PageStreamCapture, type BrowserProtocol } from "./browser.ts"
import { parseCommand } from "./config.ts"
import { StreamFrameParser, openAIChatSSEChunks, type BrowserFrame } from "./protocol.ts"

test("interleaved fetch readers retain each UTF-8 body and the native reasoning/tool response", async () => {
  const wire = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const tool = '<aipass-envelope>{"type":"tool","key":"fixture","id":"call_1","name":"read","input":{}}</aipass-envelope>'
  const body = wire({ type: "reasoning-delta", delta: "native ไทย" }) + wire({ type: "text-delta", delta: tool }) + "data: [DONE]\n\n"
  const bytes = Buffer.from(body)
  const split = bytes.indexOf(Buffer.from("ไ")) + 1
  const quota = '{"remaining":42}'
  let release!: () => void
  const remainder = new Promise<void>(resolve => { release = resolve })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/model") return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(bytes.subarray(0, split))
        await remainder
        controller.enqueue(bytes.subarray(split))
        controller.close()
      },
    }), { headers: { "content-type": "text/event-stream" } })
    if (path === "/quota") return new Response(quota, { headers: { "content-type": "application/json" } })
    return new Response("<!doctype html><html><body>Local capture fixture</body></html>", { headers: { "content-type": "text/html" } })
  } })
  const command = parseCommand(["start"], {}, { verifyChrome: false })
  if (command.type !== "serve") throw Error("expected serve settings")
  const browser = await chromium.launch({ executablePath: command.settings.chromeExecutable, headless: true })
  try {
    const page = await browser.newPage()
    const installed = await PageStreamCapture.install(page, {})
    await page.goto(server.url.toString())
    const active = await installed.activate(0)
    const protocol: BrowserProtocol<BrowserFrame> = {
      decoder: () => new StreamFrameParser(), text: delta => ({ type: "text", delta }),
      reasoning: delta => ({ type: "reasoning", delta }), finish: reason => ({ type: "finish", reason }),
      isTerminal: frame => frame.type === "finish",
    }
    const response = new BrowserResponse(protocol)
    const captured = new Map<number, string>()
    let aggregate = ""
    const next = async () => {
      const event = await active.next({ timeoutMs: 5_000 })
      if (!event) throw Error("capture ended early")
      if (event.type === "error") throw Error(event.message)
      if (event.type === "chunk") {
        aggregate += event.chunk
        captured.set(event.responseID, (captured.get(event.responseID) ?? "") + event.chunk)
        response.push(event.chunk, event.responseID)
      }
      return event
    }
    try {
      const nativeRead = page.evaluate(() => fetch("/model").then(response => response.text()))
        .then(text => ({ text }), () => ({ failed: true }))
      const model = await next()
      expect(model.type).toBe("response")
      if (model.type !== "response") throw Error("model headers missing")
      expect(model.contentType).toBe("sse")
      expect((await next()).type).toBe("chunk")
      expect(await page.evaluate(() => fetch("/quota").then(response => response.text()))).toBe(quota)
      let siblingID: number | undefined
      while (true) {
        const event = await next()
        if (event.type === "response") siblingID = event.responseID
        if (event.type === "finish") {
          if (siblingID === undefined) throw Error("quota response headers missing")
          expect(event.responseID).toBe(siblingID)
          expect(response.finish(event.responseID)).toEqual([])
          break
        }
      }
      expect(siblingID).not.toBe(model.responseID)
      release()
      expect(await nativeRead).toEqual({ text: body })
      const frames: BrowserFrame[] = []
      while (true) {
        const event = await next()
        if (event.type !== "finish") continue
        expect(event.responseID).toBe(model.responseID)
        frames.push(...response.finish(event.responseID))
        break
      }
      expect(captured.size).toBe(2)
      expect(captured.get(model.responseID)).toBe(body)
      expect(captured.get(siblingID!)).toBe(quota)
      expect(aggregate.includes(body)).toBe(false)
      let output = ""
      for await (const chunk of openAIChatSSEChunks("fixture", frames, new Set(["read"]))) output += chunk
      expect(output).toContain('"reasoning_content":"native ไทย"')
      expect(output).toContain('"name":"read"')
      expect(output).toContain('"finish_reason":"tool_calls"')
      expect(output).not.toContain('"content":')
      expect(output.match(/data: \[DONE\]/g)).toHaveLength(1)
    } finally { release(); await active.cleanup() }
  } finally { release(); await browser.close(); await server.stop(true) }
}, 20_000)
