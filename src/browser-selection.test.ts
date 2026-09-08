import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PlaywrightBrowserAdapter, type BrowserProtocol } from "./browser.ts"
import { parseCommand } from "./config.ts"
import { parseOpenAIChatRequest } from "./http.ts"
import { StreamFrameParser, type BrowserFrame } from "./protocol.ts"

for (const sibling of ["terminal", "error"] as const) test(`ignores an unrelated matching ${sibling} response during a selected turn`, async () => {
  const transportPulse = setInterval(() => {}, 10).unref()
  let startups = 0
  const wire = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const tool = '<aipass-envelope>{"type":"tool","key":"fixture-key","id":"read_1","name":"read","input":{}}</aipass-envelope>'
  const thinking = wire({ type: "reasoning-delta", delta: "selected thought" })
  const split = thinking.indexOf("selected") + 3
  let release!: () => void
  const remainder = new Promise<void>(resolve => { release = resolve })
  let binding: string | undefined
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/submit") {
      const body = await request.json() as { messages: { parts: { text: string }[] }[] }
      if (!body.messages[0]!.parts[0]!.text.startsWith("TURN KEY:")) {
        startups++
        return new Response(wire({ type: "text", delta: "READY" }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
      }
    }
    if (path === "/submit") return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(Buffer.from(thinking.slice(0, split)))
        await remainder
        controller.enqueue(Buffer.from(thinking.slice(split) + wire({ type: "text-delta", delta: tool }) + "data: [DONE]\n\n"))
        controller.close()
      },
    }), { headers: { "content-type": "text/event-stream" } })
    if (path === "/side") return new Response(JSON.stringify(sibling === "error"
      ? { type: "error", message: "unrelated source failure" }
      : { type: "text", delta: '<aipass-envelope>{"type":"chat","key":"fixture-key","text":"unrelated answer"}</aipass-envelope>' }),
    { headers: { "content-type": "application/json" } })
    if (path === "/release") { release(); return new Response("released") }
    return new Response(`<!doctype html><html><body>
      <a href="/chat?temporary-chat=true">Temporary chat</a>
      <button id="model" onclick="document.querySelector('[role=dialog]').hidden=false">Fixture</button>
      <div role="dialog" data-testid="model-selector-modal" hidden><section data-testid="model-card"><span>Fixture</span><button onclick="this.closest('[role=dialog]').hidden=true">Select</button></section></div>
      <textarea id="prompt"></textarea><button id="send">Send</button><main></main>
      <script>
        document.querySelector('#send').onclick = async () => {
          const response = await fetch(new Request('/submit', { method: 'POST', body: JSON.stringify({ messages: [{ parts: [{ type: 'text', text: document.querySelector('#prompt').value }] }] }) }));
          if (!document.querySelector('#prompt').value.startsWith('TURN KEY:')) {
            await response.text();
            const article = document.createElement('article'); article.dataset.role = 'assistant';
            article.innerHTML = '<p>READY</p><button aria-label="Like"><svg viewBox="0 0 21 20"><path d="M4.75 5.75H2.75" /></svg></button><button aria-label="Dislike"><svg viewBox="0 0 21 20"><path d="M16.1898 12.75H18.1898" /></svg></button>';
            document.querySelector('main').append(article);
            return;
          }
          const reader = response.body.getReader();
          await reader.read();
          await (await fetch('/side')).text();
          await (await fetch('/release')).text();
          while (!(await reader.read()).done) {}
          const article = document.createElement('article');
          article.dataset.role = 'assistant';
          article.textContent = 'Model completed';
          document.querySelector('main').append(article);
        };
      </script></body></html>`, { headers: { "content-type": "text/html" } })
  } })
  const profilePath = await mkdtemp(join(tmpdir(), "aipass-selection-test-"))
  const command = parseCommand(["start"], {}, { verifyChrome: false })
  if (command.type !== "serve") throw Error("expected serve settings")
  const protocol: BrowserProtocol<BrowserFrame> = {
    decoder: () => new StreamFrameParser(), text: delta => ({ type: "text", delta }),
    reasoning: delta => ({ type: "reasoning", delta }), finish: reason => ({ type: "finish", reason }),
    isTerminal: frame => frame.type === "finish",
  }
  const adapter = await PlaywrightBrowserAdapter.launch({
    profilePath, executablePath: command.settings.chromeExecutable,
    chatURL: `${server.url}chat?temporary-chat=true`, navigationTimeoutMs: 5_000, streamIdleTimeoutMs: 5_000,
    selectors: { modelLoader: "#model", promptInput: "#prompt", sendButton: "#send" },
  }, {
    async binding() { return binding }, async promptContractVersion() { return 0 },
    async prepare(input) { return { id: crypto.randomUUID(), promptHash: input.promptHash } },
    async pending() {}, async bind(_, remote) { binding = remote }, async complete() {}, async fail() {},
  }, protocol)
  try {
    const input = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", messages: [{ role: "user", content: "Read the fixture." }] }, new Headers()).turn
    const frames: BrowserFrame[] = []
    for await (const frame of adapter.turn({ ...input, promptKey: "fixture-key", model: { id: "fixture", name: "Fixture", thinking: [] } }, AbortSignal.timeout(15_000))) frames.push(frame)
    expect(frames).toEqual([
      { type: "reasoning", delta: "selected thought" }, { type: "text", delta: tool }, { type: "finish", reason: "stop" },
    ])
    expect(startups).toBe(input.primingPrompts.length)
  } finally { release(); await adapter.close(); clearInterval(transportPulse); await server.stop(true); await rm(profilePath, { recursive: true, force: true }) }
}, 20_000)
