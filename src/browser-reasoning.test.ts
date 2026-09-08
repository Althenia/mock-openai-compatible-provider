import { expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrowserCaptureTimeoutError, PageStreamCapture, PlaywrightBrowserAdapter, type AttemptLifecycle, type BrowserProtocol, type CaptureEvent } from "./browser.ts"
import { parseCommand } from "./config.ts"
import { parseOpenAIChatRequest } from "./http.ts"
import { openAIChatSSEChunks, StreamFrameParser, type BrowserFrame } from "./protocol.ts"
import { StandaloneBrowserService } from "./runtime.ts"

for (const scenario of ["selected", "unselected", "cancel", "late-dom", "late-dom-cancel", "late-dom-error", "late-dom-timeout", "late-dom-traffic", "late-dom-evidence"] as const) test(`progressive DOM panel: ${scenario} submission preserves attribution and lifecycle`, async () => {
  const lateDom = scenario.startsWith("late-dom")
  let samplingOverflow = false
  let advance!: () => void, finish!: () => void, mounted!: () => void, nativeDone!: () => void, fail!: () => void
  const nextPanel = new Promise<void>(resolve => { advance = resolve })
  const finalAnswer = new Promise<void>(resolve => { finish = resolve })
  const panelMounted = new Promise<void>(resolve => { mounted = resolve })
  const nativeFinished = new Promise<void>(resolve => { nativeDone = resolve })
  const failureReady = new Promise<void>(resolve => { fail = resolve })
  let key = "", submitted = false, completed = 0
  const failures: Array<{ cancelled: boolean }> = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/submit") {
      key = /^TURN KEY: (.+)/m.exec(await request.text())?.[1] ?? ""
      submitted = true
      return Response.json({ remaining: 42 })
    }
    if (path === "/next") { mounted(); await nextPanel; return new Response("next") }
    if (path === "/native-done") { nativeDone(); await nextPanel; return new Response("next") }
    if (path === "/sampling-overflow") { samplingOverflow = true; return new Response(null, { status: 204 }) }
    if (path === "/error") {
      await request.text(); await failureReady
      return new Response('data: {"type":"error","message":"selected fixture failure"}\n\n', { headers: { "content-type": "text/event-stream" } })
    }
    if (path === "/final") {
      await finalAnswer
      const tool = `<aipass-envelope>${JSON.stringify({ type: "tool", key, id: "read_1", name: "read", input: { path: "fixture.txt" } })}</aipass-envelope>`
      return new Response(`data: ${JSON.stringify({ type: "reasoning-delta", delta: "Check\nVisible summary.\n\nNext\nSecond segment." })}\n\ndata: ${JSON.stringify({ type: "text-delta", delta: tool })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    }
    return new Response(`<!doctype html><html><body>
      <a href="/chat?temporary-chat=true">Temporary chat</a>
      <button id="model" onclick="document.querySelector('[role=dialog]').hidden=false">Fixture</button>
      <div role="dialog" data-testid="model-selector-modal" hidden><section data-testid="model-card"><span>Fixture</span><button onclick="this.closest('[role=dialog]').hidden=true">Select</button></section></div>
      <textarea id="prompt"></textarea><button id="send" type="submit">Send</button>
      <main><article data-role="assistant"><div data-no-copy="true"><div data-slot="collapsible"><button data-slot="collapsible-trigger" aria-expanded="true">Thinking</button><div data-slot="collapsible-content"><p>OLD PANEL MUST NOT LEAK</p></div></div></div></article></main>
      <script>
        document.querySelector('#send').onclick = async () => {
          const prompt = document.querySelector('#prompt').value;
          document.querySelector('#send').disabled = false;
          await (await fetch('/submit', {method:'POST', body:${scenario === "unselected" ? "'unrelated'" : "prompt"}})).text();
          const user = document.createElement('article'); user.dataset.role = 'user'; user.textContent = prompt; document.querySelector('main').append(user);
          const article = document.createElement('article'); article.dataset.role = 'assistant';
          article.innerHTML = '<div data-no-copy="true"><div data-slot="collapsible"><button data-slot="collapsible-trigger" aria-expanded="true">Processing</button><div data-slot="collapsible-content"><p><span data-streamdown="strong">Check</span></p><p id="body">Visible</p></div></div></div>';
          document.querySelector('main').append(article);
          ${scenario === "late-dom-evidence" ? `
            article.querySelector('[data-slot=collapsible-content]').id = 'panel';
            const style = window.getComputedStyle.bind(window); let reads = 0;
            window.getComputedStyle = (element, pseudo) => {
              if (element.id === 'panel' && ++reads === 80) fetch('/sampling-overflow');
              return style(element, pseudo);
            };
            const growing = setInterval(() => {
              const body = article.querySelector('#body');
              body.textContent = 'Visible summary.'.slice(0, body.textContent.length + 1);
            }, 1000);
          ` : ""}
          ${scenario === "late-dom-error" ? "fetch('/error', {method:'POST', body:prompt}).then(response => response.text());" : ""}
          ${scenario === "late-dom-timeout" ? "setInterval(() => article.querySelector('#body').textContent += '.', 100);" : ""}
          ${lateDom ? "fetch('/next'); await (await fetch('/final', {method:'POST', body:prompt})).text(); await (await fetch('/native-done')).text();" : "await (await fetch('/next')).text();"}
          ${scenario === "late-dom-evidence" ? "clearInterval(growing); article.querySelector('#body').textContent = 'Visible summary.';" : "article.querySelector('#body').textContent += ' summary.';"}
          article.querySelector('[data-slot=collapsible-content]').insertAdjacentHTML('beforeend', '<p><span data-streamdown="strong">Next</span></p><p>Second segment.</p>');
          article.querySelector('[data-slot=collapsible-trigger]').textContent = 'Processed for 3 seconds';
          ${lateDom ? "" : "await (await fetch('/final', {method:'POST', body:prompt})).text();"}
        };
      </script></body></html>`, { headers: { "content-type": "text/html" } })
  } })
  const profilePath = await mkdtemp(join(tmpdir(), "aipass-progress-test-"))
  const lifecycle: AttemptLifecycle = {
    async binding() { return undefined }, async prepare(input) { return { id: "progress", promptHash: input.promptHash } },
    async pending() {}, async bind() {}, async complete() { completed++ }, async fail(_attempt, outcome) { failures.push(outcome) },
  }
  const protocol: BrowserProtocol<BrowserFrame> = {
    decoder: () => new StreamFrameParser(), text: delta => ({ type: "text", delta }),
    reasoning: delta => ({ type: "reasoning", delta }), finish: reason => ({ type: "finish", reason }), isTerminal: frame => frame.type === "finish",
  }
  const command = parseCommand(["start"], {}, { verifyChrome: false })
  if (command.type !== "serve") throw Error("expected serve settings")
  const adapter = await PlaywrightBrowserAdapter.launch({
    profilePath, executablePath: command.settings.chromeExecutable, chatURL: `${server.url}chat?temporary-chat=true`,
    navigationTimeoutMs: 5000, streamIdleTimeoutMs: scenario === "late-dom-timeout" ? 5000 : scenario === "late-dom-evidence" ? 15000 : 10000,
    selectors: { modelLoader: "#model", promptInput: "#prompt", sendButton: "#send" },
  }, lifecycle, protocol)
  const activate = PageStreamCapture.prototype.activate
  const busyCapture = scenario === "late-dom-traffic" ? spyOn(PageStreamCapture.prototype, "activate").mockImplementation(async function(this: PageStreamCapture, baseline, prompt) {
    const capture = await activate.call(this, baseline, prompt)
    let announced = false
    return { ...capture, async next(options): Promise<CaptureEvent | undefined> {
      // Preserve real selected frames, but leave no idle gaps in unrelated traffic.
      try { return await capture.next({ ...options, timeoutMs: 0 }) }
      catch (error) {
        if (!(error instanceof BrowserCaptureTimeoutError)) throw error
        if (announced) return { type: "chunk", responseID: Number.MAX_SAFE_INTEGER, chunk: "UNRELATED" }
        announced = true
        return { type: "response", responseID: Number.MAX_SAFE_INTEGER, selected: false, matched: true, bodyPresent: true, contentType: "sse" }
      }
    } }
  }) : undefined
  const service = new StandaloneBrowserService({
    turn(input: Parameters<typeof adapter.turn>[0], signal?: AbortSignal) { return adapter.turn({ ...input, model: { id: "fixture", name: "Fixture", thinking: [] } }, signal) },
    discard: (marker: string) => adapter.discard(marker),
  } as never)
  const parsed = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", session_id: "progress-browser", messages: [{ role: "user", content: "read fixture.txt" }], tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }] }, new Headers())
  const abort = new AbortController()
  const frames: BrowserFrame[] = []
  let first!: () => void, second!: () => void
  const firstFrame = new Promise<void>(resolve => { first = resolve })
  const secondFrame = new Promise<void>(resolve => { second = resolve })
  const work = (async () => {
    for await (const frame of service.turn(parsed.turn, abort.signal)) {
      frames.push(frame)
      if (frame.type === "reasoning") {
        first()
        if (frames.filter(item => item.type === "reasoning").map(item => item.delta).join("").includes("Second segment.")) second()
      }
    }
  })().then(() => ({ ok: true }), error => ({ error }))
  const within = async (promise: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([promise.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 1500) })]) }
    finally { clearTimeout(timer) }
  }
  try {
    await panelMounted
    expect(submitted).toBe(true)
    if (scenario === "unselected") {
      expect(await within(firstFrame)).toBe(false)
      expect(frames).toEqual([])
      expect(completed).toBe(0)
      return
    }
    expect(await within(firstFrame)).toBe(true)
    expect(frames.every(frame => frame.type === "reasoning")).toBe(true)
    expect(completed).toBe(0)
    if (lateDom) {
      finish()
      await nativeFinished
      expect(await within(work.then(() => undefined))).toBe(false)
      expect(completed).toBe(0)
    }
    if (scenario === "late-dom-evidence") await new Promise(resolve => setTimeout(resolve, 4000))
    if (scenario === "late-dom-error" || scenario === "late-dom-timeout") {
      fail()
      const result = await work
      expect(result).toHaveProperty("error")
      if ("error" in result) expect(String(result.error)).toContain(scenario === "late-dom-error" ? "selected fixture failure" : "did not stabilize")
      expect(frames.every(frame => frame.type === "reasoning")).toBe(true)
      expect(completed).toBe(0)
      expect(failures).toMatchObject([{ cancelled: false }])
      return
    }
    if (scenario === "cancel" || scenario === "late-dom-cancel") {
      abort.abort()
      const result = await work
      expect(result).toHaveProperty("error")
      expect(failures).toMatchObject([{ cancelled: true }])
      expect(frames.every(frame => frame.type === "reasoning")).toBe(true)
      expect(completed).toBe(0)
      return
    }
    advance()
    expect(await within(secondFrame)).toBe(true)
    expect(frames.every(frame => frame.type === "reasoning")).toBe(true)
    finish()
    expect(await work).toEqual({ ok: true })
    expect(frames.filter(frame => frame.type === "reasoning").map(frame => frame.delta).join("")).toBe("Check\nVisible summary.\n\nNext\nSecond segment.")
    expect(frames.filter(frame => frame.type === "finish")).toHaveLength(1)
    expect(completed).toBe(1)
    expect(samplingOverflow).toBe(false)
    expect(JSON.stringify(frames)).not.toContain("OLD PANEL")
    expect(JSON.stringify(frames)).not.toContain("Processed")
    expect(JSON.stringify(frames)).toContain("fixture.txt")
  } finally {
    advance(); finish(); fail(); abort.abort(); await work
    busyCapture?.mockRestore()
    await adapter.close(); await server.stop(true); await rm(profilePath, { recursive: true, force: true })
  }
}, 25000)

test("a completed thinking-only webchat message waits for the later tool reply", async () => {
  let finalRequested = false
  const thinking = '<aipass-envelope>{"type":"thinking","key":"fixture-key","text":"Considering the read."}</aipass-envelope>'
  const tool = '<aipass-envelope>{"type":"tool","key":"fixture-key","id":"read_1","name":"read","input":{"path":"notes.txt"}}</aipass-envelope>'
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method === "POST") {
        await request.text()
        const final = new URL(request.url).pathname === "/final"
        finalRequested ||= final
        return new Response(`data: ${JSON.stringify({ type: "text-delta", delta: final ? tool : thinking })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
      }
      return new Response(`<!doctype html><html><body>
        <a href="/chat?temporary-chat=true">Temporary chat</a>
        <button id="model" onclick="document.querySelector('[role=dialog]').hidden=false">Fixture</button>
        <div role="dialog" data-testid="model-selector-modal" hidden><section data-testid="model-card"><span>Fixture</span><button onclick="this.closest('[role=dialog]').hidden=true">Select</button></section></div>
        <textarea id="prompt"></textarea><button id="send" type="submit">Send</button><main></main>
        <script>
          document.querySelector('#send').onclick = async () => {
            document.querySelector('#send').disabled = true;
            await (await fetch('/submit', {method:'POST', body:document.querySelector('#prompt').value})).text();
            const article = document.createElement('article'); article.dataset.role = 'assistant';
            const text = document.createElement('p'); text.textContent = ${JSON.stringify(thinking)}; article.append(text);
            for (const path of ['M4.75 5.75H2.75', 'M16.1898 12.75H18.1898']) {
              const button = document.createElement('button');
              button.innerHTML = '<svg viewBox="0 0 21 20"><path d="' + path + '" /></svg>'; article.append(button);
            }
            document.querySelector('main').append(article);
            setTimeout(async () => {
              await (await fetch('/final', {method:'POST', body:'continue'})).text();
              text.textContent = ${JSON.stringify(tool)};
            }, 6500);
          };
        </script></body></html>`, { headers: { "content-type": "text/html" } })
    },
  })
  const profilePath = await mkdtemp(join(tmpdir(), "aipass-thinking-test-"))
  const lifecycle: AttemptLifecycle = {
    async binding() { return undefined }, async promptContractVersion() { return 0 },
    async actionEnvelopeDigest() { return undefined },
    async prepare(input) { return { id: crypto.randomUUID(), promptHash: input.promptHash } },
    async pending() {}, async bind() {}, async complete() {}, async fail() {},
  }
  const protocol: BrowserProtocol<BrowserFrame> = {
    decoder: () => new StreamFrameParser(), text: delta => ({ type: "text", delta }),
    reasoning: delta => ({ type: "reasoning", delta }), finish: reason => ({ type: "finish", reason }),
    isTerminal: frame => frame.type === "finish",
  }
  const command = parseCommand(["start"], {}, { verifyChrome: false })
  if (command.type !== "serve") throw Error("expected serve settings")
  const adapter = await PlaywrightBrowserAdapter.launch({
    profilePath, executablePath: command.settings.chromeExecutable, chatURL: `${server.url}chat?temporary-chat=true`,
    navigationTimeoutMs: 5000, streamIdleTimeoutMs: 15000,
    selectors: { modelLoader: "#model", promptInput: "#prompt", sendButton: "#send" },
  }, lifecycle, protocol)
  try {
    const input = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", session_id: "thinking-fixture", messages: [{ role: "user", content: "Read notes.txt." }] }, new Headers()).turn
    const turn = { ...input, promptKey: "fixture-key", model: { id: "fixture", name: "Fixture", thinking: [] } }
    let stream = ""
    for await (const chunk of openAIChatSSEChunks("fixture", adapter.turn(turn, AbortSignal.timeout(25000)), new Set(["read"]))) stream += chunk
    expect(finalRequested).toBe(true)
    expect(stream).toContain('"reasoning_content":"Considering the read."')
    expect(stream).toContain('"name":"read"')
    expect(stream).toContain('"finish_reason":"tool_calls"')
    expect(stream).not.toContain('"finish_reason":"stop"')
    expect(stream).not.toContain('"content":')
    expect(stream.match(/data: \[DONE\]/g)).toHaveLength(1)
  } finally {
    await adapter.close(); await server.stop(true); await rm(profilePath, { recursive: true, force: true })
  }
}, 30000)
