import { expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright-core"
import { PlaywrightBrowserAdapter, PlaywrightModelSelectionSurface, PlaywrightTempChatSurface, selectModel, type BrowserProtocol } from "./browser.ts"
import { browserControlState } from "./browser-diagnostics.ts"
import { parseCommand } from "./config.ts"
import { parseOpenAIChatRequest } from "./http.ts"
import { StreamFrameParser, type BrowserFrame } from "./protocol.ts"

function executable() {
  const command = parseCommand(["start"], {}, { verifyChrome: false })
  if (command.type !== "serve") throw Error("expected fixture browser settings")
  return command.settings.chromeExecutable
}

test("native model probes select named settings on collapsed/expanded cards and every thinking level", async () => {
  const browser = await chromium.launch({ executablePath: executable(), headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()
  const signal = AbortSignal.timeout(15_000)
  const model = { id: "fixture", name: "Fixture", thinking: ["low", "medium", "high", "max"] as const }
  const surface = new PlaywrightModelSelectionSurface(page, { modelLoader: "#model" })
  try {
    for (const reasoning of ["none", ...model.thinking] as const) {
      await page.setContent(String.raw`<!doctype html><body>
        <button id="model" onclick="document.querySelector('#picker').hidden=false">Fixture</button>
        <div id="picker" role="dialog" data-testid="model-selector-modal" hidden><section data-testid="model-card"><header></header><div id="details" hidden></div></section></div>
        <div id="levels" role="dialog" data-slot="popover-content" hidden>${model.thinking.map(level => `<button onclick="document.body.dataset.level='${level}';document.querySelector('#value').textContent=this.textContent;this.parentElement.hidden=true;this.parentElement.removeAttribute('data-open')">${level[0].toUpperCase() + level.slice(1)}</button>`).join("")}</div>
        <script>
          var header = document.querySelector('header'), details = document.querySelector('#details');
          function collapse() {
            details.hidden = true; details.innerHTML = '';
            header.innerHTML = '<span>Fixture</span><button onclick="expand()">More settings</button><button onclick="document.body.dataset.wrong=1">Unrelated</button><button onclick="document.body.dataset.selected=\'none\';document.querySelector(\'#picker\').hidden=true">Select</button>';
          }
          function expand() {
            header.innerHTML = '<span>Fixture</span><button onclick="document.body.dataset.selected=document.body.dataset.level||\'none\';document.querySelector(\'#picker\').hidden=true">Confirm</button>';
            details.innerHTML = '<button data-testid="thinking-level-trigger" aria-controls="levels" aria-expanded="false" onclick="document.querySelector(\'#levels\').hidden=false;document.querySelector(\'#levels\').setAttribute(\'data-open\',\'\');this.setAttribute(\'aria-expanded\',\'true\')"><span>Processing</span><span id="value"></span></button><button>Other</button><button>Format</button>';
            details.hidden = false;
          }
          collapse();
        </script>
      </body>`)
      // Exercise already-expanded settings as well as a collapsed card.
      if (reasoning === "none") await page.evaluate(() => (globalThis as unknown as { expand(): void }).expand())
      await selectModel(surface, { ...model, reasoning }, { timeoutMs: 4000, signal })
      expect(await page.locator("body").getAttribute("data-selected", { signal })).toBe(reasoning)
      expect(await page.locator("body").getAttribute("data-wrong", { signal })).toBeNull()
      expect(await page.locator("#picker").isVisible()).toBe(false)
    }
    expect(browserControlState(context)).toMatchObject({ available: true })
  } finally { await browser.close() }
}, 20_000)

test("a disabled native model control cannot select after its selection deadline", async () => {
  const browser = await chromium.launch({ executablePath: executable(), headless: true })
  const page = await browser.newPage()
  try {
    await page.setContent(`<!doctype html><body>
      <button id="model">Fixture</button>
      <div role="dialog" data-testid="model-selector-modal"><section data-testid="model-card"><span>Fixture</span><button id="select" disabled onclick="document.body.dataset.selected='yes'">Select</button></section></div>
    </body>`)
    await expect(selectModel(new PlaywrightModelSelectionSurface(page, { modelLoader: "#model" }),
      { id: "fixture", name: "Fixture", thinking: [], reasoning: "none" }, { timeoutMs: 750 })).rejects.toThrow()
    await page.locator("#select").evaluate(element => element.removeAttribute("disabled"))
    expect(await page.locator("body").getAttribute("data-selected")).toBeNull()
  } finally { await browser.close() }
}, 5000)

for (const locale of ["th", "en"] as const) test(`native ${locale} Terra confirmation survives a mounted closing thinking popover`, async () => {
  const browser = await chromium.launch({ executablePath: executable(), headless: true })
  const page = await browser.newPage()
  const confirm = locale === "th" ? "ยืนยัน" : "Confirm"
  const levels = locale === "th" ? ["ต่ำ", "ปกติ", "สูง"] : ["Low", "Medium", "High"]
  try {
    await page.setContent(`<!doctype html><html lang="${locale}"><body>
      <button data-testid="model-selector-trigger" onclick="document.querySelector('#picker').hidden=false"><img alt="GPT-5.6 Terra"> <span>GPT-5.6 Terra</span></button>
      <div id="picker" data-testid="model-selector-modal" role="dialog" hidden>
        <div data-testid="model-card" role="button" tabindex="0">
          <div><span>GPT-5.6 Terra</span><button onclick="document.body.dataset.selected=document.body.dataset.level;document.querySelector('#picker').hidden=true">${confirm}</button></div>
          <div><button data-testid="thinking-level-trigger" aria-label="${locale === "th" ? "คิดวิเคราะห์" : "Thinking"}" aria-controls="levels" aria-expanded="false" onclick="document.querySelector('#levels').hidden=false;document.querySelector('#levels').setAttribute('data-open','');this.setAttribute('aria-expanded','true')"><span>${locale === "th" ? "การประมวลผล" : "Processing"}</span><span id="value"></span></button><button>Style</button><button>Format</button></div>
        </div>
      </div>
      <div id="levels" role="dialog" data-slot="popover-content" hidden>${levels.map((name, index) => `<button onclick="document.body.dataset.level='${index}';document.querySelector('#value').textContent=this.textContent;this.parentElement.removeAttribute('data-open');this.parentElement.setAttribute('data-closed','');this.parentElement.setAttribute('data-ending-style','')">${name}</button>`).join("")}</div>
    </body></html>`)
    await selectModel(new PlaywrightModelSelectionSurface(page), {
      id: "gpt-5.6-terra", name: "GPT-5.6 Terra", thinking: ["low", "medium", "high"], reasoning: "low",
    }, { timeoutMs: 3000 })
    expect(await page.locator("body").getAttribute("data-selected")).toBe("0")
    expect(await page.locator("#picker").isVisible()).toBe(false)
    expect(await page.locator("#levels").getAttribute("data-closed")).toBe("")
  } finally { await browser.close() }
}, 6000)

test("unreadable temporary-chat diagnostics expose structure, not attribute values or accessible text", async () => {
  const browser = await chromium.launch({ executablePath: executable(), headless: true })
  const page = await browser.newPage()
  const sensitive = "synthetic-private-marker"
  const records: string[] = []
  const log = spyOn(console, "error").mockImplementation(value => { records.push(String(value)) })
  try {
    await page.setContent(`<body><main aria-label="${sensitive}"><div aria-label="${sensitive}">
      <button aria-label="Temporary chat ${sensitive}" data-testid="${sensitive}" class="${sensitive}">
        <svg class="${sensitive}"><path d="${sensitive}"></path></svg>${sensitive}
      </button><span aria-label="${sensitive}" class="${sensitive}">${sensitive}</span>
    </div></main></body>`)
    const signal = AbortSignal.timeout(4000)
    const control = await new PlaywrightTempChatSurface(page).control(3000, signal)
    expect(control).toBeDefined()
    expect(await control!.state(1000, signal)).toBe("unknown")
    expect(records).toHaveLength(1)
    expect(records[0]).toContain("aipass temp chat unreadable kind=button")
    expect(records[0]).toContain('"svg":1')
    expect(records[0]).not.toContain(sensitive)
    expect(records[0]!.length).toBeLessThan(1500)
  } finally { log.mockRestore(); await browser.close() }
}, 8000)

test("native authentication rejects visible login or a missing composer but accepts hidden login markup", async () => {
  let mode: "visible" | "hidden" | "missing" = "visible"
  const submissions: { mode: string; prompt: string }[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "POST") {
      const body = await request.json() as { messages: { content: string }[] }
      submissions.push({ mode, prompt: body.messages[0]!.content })
      return new Response(`data: ${JSON.stringify({ type: "text", delta: '<aipass-envelope>{"type":"chat","text":"ready"}</aipass-envelope>' })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    }
    return new Response(`<!doctype html><body>
      <input type="checkbox" aria-label="Temporary chat" checked>
      <input type="password" ${mode === "visible" ? "" : "style='display:none'"}>
      <button id="model" onclick="document.querySelector('[role=dialog]').hidden=false">Fixture</button>
      <div role="dialog" data-testid="model-selector-modal" hidden><section data-testid="model-card"><span>Fixture</span><button onclick="this.closest('[role=dialog]').hidden=true">Select</button></section></div>
      ${mode === "missing" ? "" : '<textarea id="prompt"></textarea>'}<button id="send">Send</button>
      <script>document.querySelector('#send').onclick = async () => {
        const response = await fetch('/submit', { method: 'POST', body: JSON.stringify({ messages: [{ content: document.querySelector('#prompt').value }] }) });
        await response.text();
        const article = document.createElement('article'); article.dataset.role = 'assistant';
        article.innerHTML = '<p>ready</p><button aria-label="Like"><svg viewBox="0 0 21 20"><path d="M4.75 5.75H2.75" /></svg></button><button aria-label="Dislike"><svg viewBox="0 0 21 20"><path d="M16.1898 12.75H18.1898" /></svg></button>';
        document.body.append(article);
      };</script>
    </body>`, { headers: { "content-type": "text/html" } })
  } })
  const protocol: BrowserProtocol<BrowserFrame> = {
    decoder: () => new StreamFrameParser(), text: delta => ({ type: "text", delta }),
    finish: reason => ({ type: "finish", reason }), isTerminal: frame => frame.type === "finish",
  }
  // Bun 1.4.0's test runner can stall Playwright pipe callbacks until a timer
  // wakes it; plain `bun` does not. Remove after the unchanged test passes
  // without the pulse on a newer runner, not by extending its deadlines.
  const transportPulse = setInterval(() => {}, 10).unref()
  try {
    for (const candidate of ["visible", "hidden", "missing"] as const) {
      mode = candidate
      const profilePath = await mkdtemp(join(tmpdir(), "aipass-auth-fixture-"))
      const adapter = await PlaywrightBrowserAdapter.launch({
        profilePath, executablePath: executable(), chatURL: `${server.url}chat`, navigationTimeoutMs: 1000,
        selectors: { modelLoader: "#model", promptInput: "#prompt", sendButton: "#send" },
      }, {
        async binding() { return undefined }, async prepare(input) { return { id: "fixture", promptHash: input.promptHash } },
        async pending() {}, async bind() {}, async complete() {}, async fail() {},
      }, protocol)
      try {
        const input = parseOpenAIChatRequest({ model: "gemini-3.1-flash-lite", messages: [{ role: "user", content: "Reply ready." }] }, new Headers()).turn
        expect(input.primingPrompts[0]).toStartWith("You are the agent backend.")
        const work = (async () => {
          const frames: BrowserFrame[] = []
          // Startup ordering is covered by browser-priming.test.ts; this deadline covers authentication.
          for await (const frame of adapter.turn({ ...input, primingPrompts: [], model: { id: "fixture", name: "Fixture", thinking: [] } }, AbortSignal.timeout(5000))) frames.push(frame)
          return frames
        })()
        if (candidate === "hidden") expect(await work).toContainEqual({ type: "finish", reason: "stop" })
        else await expect(work).rejects.toMatchObject({ name: "AuthenticationRequiredError" })
      } finally { await adapter.close(); await rm(profilePath, { recursive: true, force: true }) }
    }
    expect(submissions.map(item => item.mode)).toEqual(["hidden"])
    expect(submissions[0]!.prompt).toContain("USER: Reply ready.")
  } finally { clearInterval(transportPulse); await server.stop(true) }
}, 20_000)
