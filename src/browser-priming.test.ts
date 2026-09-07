import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PlaywrightBrowserAdapter, type AttemptLifecycle, type BrowserProtocol } from "./browser.ts"
import { parseCommand } from "./config.ts"
import { estimateTokens } from "./context.ts"
import { parseOpenAIChatRequest } from "./http.ts"
import { StreamFrameParser, type BrowserFrame } from "./protocol.ts"

for (const explicitPriming of [false, true]) test(explicitPriming
  ? "replays explicitly supplied priming parts only on initial and recovery submissions"
  : "submits preserved instructions inline on initial, bound, and recovery submissions", async () => {
  const submitted: string[] = []
  const completedEstimates: number[] = []
  const answer = '<aipass-envelope>{"type":"chat","text":"ready"}</aipass-envelope>'
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/side") return new Response(JSON.stringify({ type: "error", message: "unrelated source failure" }), {
        headers: { "content-type": "application/json" },
      })
      if (request.method === "POST") {
        submitted.push(await request.text())
        return new Response(`data: ${JSON.stringify({ type: "text", delta: answer })}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      }
      return new Response(`<!doctype html><html><body>
        <a href="/chat?temporary-chat=true">Temporary chat</a>
        <button id="model" onclick="document.querySelector('[role=dialog]').hidden=false">Fixture</button>
        <div role="dialog" hidden><span>Fixture</span><button onclick="this.parentElement.hidden=true">Select</button></div>
        <textarea id="prompt"></textarea><button id="send">Send</button><main></main>
        <script>
          document.querySelector('#send').onclick = async () => {
            await (await fetch('/side')).text();
            await (await fetch('/submit', {method: 'POST', body: document.querySelector('#prompt').value.trimEnd()})).text();
            const article = document.createElement('article');
            article.dataset.role = 'assistant';
            const text = document.createElement('p');
            text.textContent = ${JSON.stringify(answer)};
            article.append(text);
            for (const [label, path] of [['Like', 'M4.75 5.75H2.75'], ['Dislike', 'M16.1898 12.75H18.1898']]) {
              const button = document.createElement('button');
              button.setAttribute('aria-label', label);
              button.innerHTML = '<svg viewBox="0 0 21 20"><path d="' + path + '" /></svg>';
              article.append(button);
            }
            document.querySelector('main').append(article);
          };
        </script></body></html>`, { headers: { "content-type": "text/html" } })
    },
  })
  const profilePath = await mkdtemp(join(tmpdir(), "aipass-priming-test-"))
  let binding: string | undefined
  let version: number | undefined
  let digest: string | undefined
  const lifecycle: AttemptLifecycle = {
    async binding() { return binding },
    async promptContractVersion() { return version ?? 0 },
    async actionEnvelopeDigest() { return digest },
    async prepare(input) { return { id: crypto.randomUUID(), promptHash: input.promptHash } },
    async pending() {},
    async bind(_, remote) { binding = remote },
    async complete(_, remote, estimate, nextVersion, nextDigest) {
      binding = remote
      if (nextVersion !== undefined) version = nextVersion
      if (nextDigest !== undefined) digest = nextDigest
      completedEstimates.push(estimate)
    },
    async fail() {},
  }
  const protocol: BrowserProtocol<BrowserFrame> = {
    decoder: () => new StreamFrameParser(),
    text: (delta) => ({ type: "text", delta }),
    finish: (reason) => ({ type: "finish", reason }),
    isTerminal: (frame) => frame.type === "finish" || frame.type === "error",
  }
  const command = parseCommand(["start"], {}, { verifyChrome: false })
  if (command.type !== "serve") throw new Error("expected serve settings")
  const adapter = await PlaywrightBrowserAdapter.launch({
    profilePath,
    executablePath: command.settings.chromeExecutable,
    chatURL: `${server.url}chat?temporary-chat=true`,
    streamURLPattern: "/submit",
    navigationTimeoutMs: 5_000,
    streamIdleTimeoutMs: 5_000,
    selectors: { modelLoader: "#model", promptInput: "#prompt", sendButton: "#send" },
  }, lifecycle, protocol)
  try {
    const input = parseOpenAIChatRequest({
      model: "gemini-3.1-flash-lite",
      session_id: "priming-recovery-fixture",
      instruction_mode: "preserve",
      messages: [
        { role: "system", content: "Synthetic preserved client instruction.\n".repeat(220) },
        { role: "user", content: "Reply ready." },
      ],
    }, new Headers()).turn
    const turn = { ...input, promptKey: "priming-fixture-key", model: { id: "fixture", name: "Fixture", thinking: [] },
      ...(explicitPriming ? { primingPrompts: ["CONTEXT PART 1/2\n\nSynthetic part one.", "CONTEXT PART 2/2\n\nSynthetic part two."] } : {}),
    }
    const keyed = (prompt: string) => `TURN KEY: priming-fixture-key\n\n${prompt}`
    expect(input.primingPrompts).toEqual([])
    for (const prompt of [input.initialPrompt, input.incrementalPrompt, input.recoveryPrompt]) {
      expect(prompt).toContain("SYSTEM: " + "Synthetic preserved client instruction.\n".repeat(220))
      expect(prompt).toContain("USER: Reply ready.")
    }
    const run = async (forceReload = false) => {
      const frames: BrowserFrame[] = []
      for await (const frame of adapter.turn(turn, AbortSignal.timeout(45_000), { forceReload })) frames.push(frame)
      expect(frames).toContainEqual({ type: "text", delta: answer })
      expect(frames.filter((frame) => frame.type === "finish")).toEqual([{ type: "finish", reason: "stop" }])
    }
    await run()
    expect(submitted.splice(0)).toEqual([...turn.primingPrompts, keyed(turn.initialPrompt)])

    await run()
    expect(submitted.splice(0)).toEqual([keyed(turn.incrementalPrompt)])

    await run(true)
    expect(submitted).toEqual([...turn.primingPrompts, keyed(turn.recoveryPrompt)])
    expect(completedEstimates).toHaveLength(3)
    if (explicitPriming) expect(completedEstimates[2]!).toBeGreaterThan(completedEstimates[1]!)
    else expect(completedEstimates[2]).toBe(completedEstimates[1])
    const primingEstimate = turn.primingPrompts.reduce((total, part) => total + estimateTokens(part) + estimateTokens(answer), 0)
    expect(completedEstimates).toEqual([
      primingEstimate + estimateTokens(turn.initialPrompt) + estimateTokens(answer),
      estimateTokens(turn.incrementalPrompt) + estimateTokens(answer),
      primingEstimate + estimateTokens(turn.recoveryPrompt) + estimateTokens(answer),
    ])
  } finally {
    await adapter.close()
    await server.stop(true)
    await rm(profilePath, { recursive: true, force: true })
  }
}, 120_000)
