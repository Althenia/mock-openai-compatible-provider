import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PlaywrightBrowserAdapter, type AttemptLifecycle, type BrowserProtocol } from "./browser.ts"
import { parseCommand } from "./config.ts"
import { estimateTokens } from "./context.ts"
import { parseOpenAIChatRequest } from "./http.ts"
import { StreamFrameParser, type BrowserFrame } from "./protocol.ts"

for (const mode of ["preserve", "action-only"] as const) test(`${mode} serial startup lifecycle, internal replies, failure and cancellation`, async () => {
  const transportPulse = setInterval(() => {}, 10).unref()
  const submitted: string[] = []
  const completedEstimates: number[] = []
  let navigations = 0
  let failStartup = false
  let onSubmit: (() => void) | undefined
  let responding = false
  let overlap = false
  const answer = '<aipass-envelope>{"type":"chat","text":"ready"}</aipass-envelope>'
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/side") return new Response(JSON.stringify({ type: "error", message: "unrelated source failure" }), {
        headers: { "content-type": "application/json" },
      })
      if (request.method === "POST") {
        const prompt = await request.text()
        submitted.push(prompt)
        overlap ||= responding
        responding = true
        onSubmit?.()
        await new Promise(resolve => setTimeout(resolve, 50))
        responding = false
        const event = failStartup && !prompt.startsWith("TURN KEY:")
          ? { type: "error", message: "fixture startup failed" }
          : { type: "text", delta: prompt.startsWith("TURN KEY:") ? answer : "READY" }
        return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      }
      if (new URL(request.url).pathname === "/chat") navigations++
      return new Response(`<!doctype html><html><body>
        <a href="/chat?temporary-chat=true">Temporary chat</a>
        <button id="model" onclick="document.querySelector('[role=dialog]').hidden=false">Fixture</button>
        <div role="dialog" data-testid="model-selector-modal" hidden>${["Fixture", "Alternate"].map(name => `<section data-testid="model-card"><span>${name}</span><button onclick="document.querySelector('#model').textContent='${name}';this.closest('[role=dialog]').hidden=true">Select</button></section>`).join("")}</div>
        <textarea id="prompt"></textarea><button id="send">Send</button><main></main>
        <script>
          document.querySelector('#send').onclick = async () => {
            await (await fetch('/side')).text();
            const reply = await (await fetch('/submit', {method: 'POST', body: document.querySelector('#prompt').value.trimEnd()})).text();
            const event = JSON.parse(reply.split('\\n')[0].slice(6));
            const article = document.createElement('article');
            article.dataset.role = 'assistant';
            const text = document.createElement('p');
            text.textContent = event.delta ?? event.message;
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
  let checkpointDigest: string | undefined
  const lifecycle: AttemptLifecycle = {
    async binding() { return binding },
    async promptContractVersion() { return version ?? 0 },
    async actionEnvelopeDigest() { return digest },
    async rotate(_, nextDigest) {
      if (checkpointDigest === nextDigest) return false
      checkpointDigest = nextDigest
      binding = undefined
      version = undefined
      digest = undefined
      return true
    },
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
  const launch = () => PlaywrightBrowserAdapter.launch({
    profilePath,
    executablePath: command.settings.chromeExecutable,
    chatURL: `${server.url}chat?temporary-chat=true`,
    streamURLPattern: "/submit",
    navigationTimeoutMs: 5_000,
    streamIdleTimeoutMs: 5_000,
    selectors: { modelLoader: "#model", promptInput: "#prompt", sendButton: "#send" },
  }, lifecycle, protocol)
  let adapter = await launch()
  try {
    const input = parseOpenAIChatRequest({
      model: "gemini-3.1-flash-lite",
      session_id: "priming-recovery-fixture",
      instruction_mode: mode,
      messages: [
        { role: "system", content: "Synthetic preserved client instruction.\n".repeat(220) },
        { role: "developer", content: "AGENT_RULE: Use supplied results. WORKSPACE_RULE: fixture-root." },
        { role: "user", content: "Earlier fixture task." },
        { role: "assistant", content: "Earlier fixture answer." },
        { role: "user", content: "Reply ready." },
      ],
    }, new Headers()).turn
    const turn = { ...input, promptKey: "priming-fixture-key", model: { id: "fixture", name: "Fixture", thinking: [] } }
    const keyed = (prompt: string) => `TURN KEY: priming-fixture-key\n\n${prompt}`
    expect(input.primingPrompts).toHaveLength(mode === "preserve" ? 3 : 1)
    expect(input.primingPrompts[0]).toStartWith("You are the agent backend.")
    if (mode === "preserve") {
      expect(input.primingPrompts[1]).toContain("SYSTEM: " + "Synthetic preserved client instruction.\n".repeat(220))
      expect(input.primingPrompts[2]).toContain("DEVELOPER: AGENT_RULE")
    }
    for (const prompt of [input.initialPrompt, input.incrementalPrompt, input.recoveryPrompt]) {
      expect(prompt).not.toContain("You are the agent backend.")
      expect(prompt).not.toContain("Synthetic preserved client instruction.")
      expect(prompt).not.toContain("DEVELOPER: AGENT_RULE")
      if (mode === "preserve") expect(prompt).toContain("USER: Earlier fixture task.\n\nASSISTANT: Earlier fixture answer.")
      expect(prompt).toContain("USER: Reply ready.")
      expect(prompt).toEndWith("USER: Reply ready.")
    }
    const run = async (forceReload = false, next = turn) => {
      const frames: BrowserFrame[] = []
      for await (const frame of adapter.turn(next, AbortSignal.timeout(45_000), { forceReload })) frames.push(frame)
      expect(frames).toContainEqual({ type: "text", delta: answer })
      expect(frames.filter(frame => frame.type === "text")).toEqual([{ type: "text", delta: answer }])
      expect(frames.filter((frame) => frame.type === "finish")).toEqual([{ type: "finish", reason: "stop" }])
    }
    failStartup = true
    await expect(run()).rejects.toThrow("fixture startup failed")
    expect(submitted.splice(0)).toEqual([turn.primingPrompts[0]!])
    expect(completedEstimates).toEqual([])
    failStartup = false
    await adapter.close()
    adapter = await launch()
    await run()
    expect(submitted.splice(0)).toEqual([...turn.primingPrompts, keyed(turn.initialPrompt)])

    await run()
    expect(submitted.splice(0)).toEqual([keyed(turn.incrementalPrompt)])

    await run(true)
    expect(submitted).toEqual([...turn.primingPrompts, keyed(turn.recoveryPrompt)])
    expect(completedEstimates).toHaveLength(3)
    expect(completedEstimates[2]!).toBeGreaterThan(completedEstimates[1]!)
    const primingEstimate = turn.primingPrompts.reduce((total, part) => total + estimateTokens(part) + estimateTokens("READY"), 0)
    expect(completedEstimates).toEqual([
      primingEstimate + estimateTokens(turn.initialPrompt) + estimateTokens(answer),
      estimateTokens(turn.incrementalPrompt) + estimateTokens(answer),
      primingEstimate + estimateTokens(turn.recoveryPrompt) + estimateTokens(answer),
    ])
    {
      submitted.length = 0
      const checkpoint = "<conversation-checkpoint>\n<summary>\nEarlier fixture task is complete.\n</summary>\n</conversation-checkpoint>"
      const compacted = { ...turn, ...parseOpenAIChatRequest({
        model: "gemini-3.1-flash-lite", session_id: "priming-recovery-fixture", instruction_mode: mode,
        messages: [
          { role: "system", content: "CURRENT_USER_RULE" },
          { role: "developer", content: "CURRENT_AGENT_AND_WORKSPACE_RULE" },
          { role: "user", content: checkpoint },
          { role: "user", content: "Continue after compaction." },
        ],
      }, new Headers()).turn, promptKey: turn.promptKey }
      const before = navigations
      await run(false, compacted)
      expect(navigations).toBe(before + 1)
      expect(checkpointDigest).toBe(compacted.compactionDigest)
      expect(submitted.splice(0)).toEqual([...compacted.primingPrompts, keyed(compacted.initialPrompt)])
      expect(compacted.initialPrompt).toContain(`USER: ${checkpoint}\n\nUSER: Continue after compaction.`)
      expect(compacted.initialPrompt).not.toContain("SYSTEM: CURRENT_USER_RULE")
      expect(compacted.initialPrompt).not.toContain("Synthetic preserved client instruction.")
      await run(false, compacted)
      expect(navigations).toBe(before + 1)
      expect(submitted.splice(0)).toEqual([keyed(compacted.incrementalPrompt)])

      const switched = { ...compacted, model: { id: "alternate", name: "Alternate", thinking: [] } }
      await run(false, switched)
      expect(submitted.splice(0)).toEqual([...switched.primingPrompts, keyed(switched.incrementalPrompt)])
      await run(false, switched)
      expect(submitted.splice(0)).toEqual([keyed(switched.incrementalPrompt)])
      const variant = switched
      expect(overlap).toBe(false)

      const completedBeforeFailure = completedEstimates.length
      failStartup = true
      await expect(run(true, variant)).rejects.toThrow("fixture startup failed")
      expect(submitted.splice(0)).toEqual([variant.primingPrompts[0]!])
      expect(completedEstimates).toHaveLength(completedBeforeFailure)
      failStartup = false
      await adapter.close()
      adapter = await launch()
      await run(false, variant)
      expect(submitted.splice(0)).toEqual([...variant.primingPrompts, keyed(variant.incrementalPrompt)])

      const controller = new AbortController()
      onSubmit = () => controller.abort()
      const cancelled = async () => { for await (const _ of adapter.turn(variant, controller.signal, { forceReload: true })) {} }
      await expect(cancelled()).rejects.toThrow()
      onSubmit = undefined
      expect(submitted.splice(0)).toEqual([variant.primingPrompts[0]!])
      expect(completedEstimates).toHaveLength(completedBeforeFailure + 1)
      await adapter.close()
      adapter = await launch()
      await run(false, variant)
      expect(submitted.splice(0)).toEqual([...variant.primingPrompts, keyed(variant.incrementalPrompt)])
    }
  } finally {
    await adapter.close()
    clearInterval(transportPulse)
    await server.stop(true)
    await rm(profilePath, { recursive: true, force: true })
  }
}, 240_000)
