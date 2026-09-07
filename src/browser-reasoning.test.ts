import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PlaywrightBrowserAdapter, type AttemptLifecycle, type BrowserProtocol } from "./browser.ts"
import { parseCommand } from "./config.ts"
import { parseOpenAIChatRequest } from "./http.ts"
import { openAIChatSSEChunks, StreamFrameParser, type BrowserFrame } from "./protocol.ts"

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
        <div role="dialog" hidden><span>Fixture</span><button onclick="this.parentElement.hidden=true">Select</button></div>
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
