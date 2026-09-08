import { expect, test } from "bun:test"
import { chromium, type Page } from "playwright-core"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PlaywrightBrowserAdapter, PlaywrightModelSelectionSurface, selectModel, type BrowserProtocol, type BrowserTurnInput } from "./browser.ts"
import { model, parseCommand } from "./config.ts"
import { StreamFrameParser, type BrowserFrame } from "./protocol.ts"

const models = [model("gpt-5.6-terra"), model("claude-opus-5@azure"), model("Llama-4-Scout-17B-16E-Instruct-1")]

function fixtureHTML(locale: "en" | "th", failure = "") {
  const labels = locale === "en" ? ["Low", "Medium", "High", "Max"] : ["ต่ำ", "ปกติ", "สูง", "สูงที่สุด"]
  return `<!doctype html><html lang="${locale}"><body>
    <button id="model" data-testid="model-selector-trigger" onclick="picker.hidden=false">GPT-5.6 Terra</button>
    <div id="picker" role="dialog" data-testid="model-selector-modal" hidden>
      <button onclick="document.body.dataset.wrong='close';picker.hidden=true">Close</button>
      ${models.map((definition, index) => `<section data-testid="model-card" id="card${index}">
        <header><span>${definition.name}</span><button onclick="confirmModel(${index})">${locale === "en" ? "Confirm" : "ยืนยัน"}</button></header>
        <button onclick="document.body.dataset.wrong='style'">Style</button>
        ${definition.thinking.length && failure !== "missing-control" ? `<button data-testid="thinking-level-trigger" aria-label="${locale === "en" ? "Thinking" : "คิดวิเคราะห์"}" ${failure === "missing-link" ? "" : `aria-controls="${failure === "wrong-link" ? "unrelated-popup" : `levels${index}`}"`} aria-expanded="false" onclick="openLevels(${index})"><span>${locale === "en" ? "Processing" : "การประมวลผล"}</span><span class="value">${failure === "unknown-value" ? "Unsupported" : ""}</span></button>` : ""}
        <button>Format</button>
      </section>`).join("")}
    </div>
    ${models.filter(definition => definition.thinking.length).map((definition, index) => `<div id="levels${index}" role="dialog" data-slot="popover-content" data-closed hidden>
      ${[...definition.thinking].reverse().filter(level => failure !== "missing-option" || level !== "low").map(level => `<button ${failure === "disabled-option" ? "disabled" : ""} onclick="choose(${index},'${level}')">${labels[["low", "medium", "high", "max"].indexOf(level)]}</button>`).join("")}
    </div>`).join("")}
    <div role="dialog" data-slot="popover-content" data-closed><button onclick="document.body.dataset.wrong='stale'">${labels[0]}</button></div>
    <textarea></textarea><div id="history">Existing conversation</div>
    <script>
      const labels = ${JSON.stringify(labels)}, names = ${JSON.stringify(models.map(definition => definition.name))}, failure = ${JSON.stringify(failure)};
      window.actions = [];
      function openLevels(index) {
        actions.push('processing:' + index);
        if (failure === 'missing') return;
        setTimeout(() => {
          const popup = document.getElementById('levels' + index);
          popup.hidden = false; popup.removeAttribute('data-closed'); popup.setAttribute('data-open','');
          document.querySelector('#card' + index + ' [data-testid="thinking-level-trigger"]').setAttribute('aria-expanded','true');
        }, 350);
      }
      function choose(index, level) {
        actions.push('level:' + level);
        const popup = document.getElementById('levels' + index);
        popup.removeAttribute('data-open'); popup.setAttribute('data-closed','');
        const trigger = document.querySelector('#card' + index + ' [data-testid="thinking-level-trigger"]');
        trigger.setAttribute('aria-expanded','false');
        if (failure !== 'wrong-value') setTimeout(() => {
          const next = trigger.dataset.level === level ? 'none' : level;
          trigger.querySelector('.value').textContent = labels[['low','medium','high','max'].indexOf(next)] || '';
          trigger.dataset.level = next;
        }, 100);
      }
      function confirmModel(index) {
        const trigger = document.querySelector('#card' + index + ' [data-testid="thinking-level-trigger"]');
        const value = trigger?.dataset.level || 'none';
        actions.push('confirm:' + index + ':' + value);
        document.body.dataset.selected = index + ':' + value;
        if (failure !== 'stuck') setTimeout(() => {
          picker.hidden = true;
          if (failure !== 'wrong-model') document.querySelector('#model').textContent = names[index];
          actions.push('closed');
        }, 150);
      }
    </script>
  </body></html>`
}

async function fixture(page: Page, locale: "en" | "th", failure = "") {
  await page.setContent(fixtureHTML(locale, failure))
}

async function browser() {
  const command = parseCommand(["start"], {}, { verifyChrome: false })
  if (command.type !== "serve") throw Error("expected browser settings")
  return chromium.launch({ executablePath: command.settings.chromeExecutable, headless: true })
}

for (const locale of ["en", "th"] as const) test(`Processing ${locale}: named variants, verification and closure across same-session changes`, async () => {
  // Keep Bun's Playwright transport awake during short-deadline fixture operations.
  const transportPulse = setInterval(() => {}, 10).unref()
  const chrome = await browser()
  const page = await chrome.newPage()
  try {
    await fixture(page, locale)
    const surface = new PlaywrightModelSelectionSurface(page, { modelLoader: "#model" })
    for (const [index, reasoning] of [[0, "low"], [0, "low"], [0, "high"], [0, "none"], [1, "max"], [1, "medium"], [2, "none"], [0, "low"]] as const) {
      const previous = await page.locator("body").getAttribute("data-selected")
      await page.evaluate(() => { (window as unknown as { actions: string[] }).actions = [] })
      await selectModel(surface, { ...models[index]!, reasoning }, { timeoutMs: 3000 })
      expect(await page.locator("body").getAttribute("data-selected")).toBe(`${index}:${reasoning}`)
      expect(await page.locator("#picker").isVisible()).toBe(false)
      expect(await page.locator("body").getAttribute("data-wrong")).toBeNull()
      expect(await page.locator("#model").innerText()).toBe(models[index]!.name)
      expect(await page.locator("#history").textContent()).toBe("Existing conversation")
      const actions = await page.evaluate(() => (window as unknown as { actions: string[] }).actions)
      const choice = reasoning === "none" ? "high" : reasoning
      expect(actions).toEqual(index === 2 || previous === `${index}:${reasoning}`
        ? [`confirm:${index}:${reasoning}`, "closed"]
        : [`processing:${index}`, `level:${choice}`, `confirm:${index}:${reasoning}`, "closed"])
    }
  } finally { clearInterval(transportPulse); await chrome.close() }
}, 25_000)

test("Processing opens only after scrolling its full trigger into view", async () => {
  const transportPulse = setInterval(() => {}, 10).unref()
  const chrome = await browser()
  const page = await chrome.newPage()
  try {
    await fixture(page, "en")
    await page.addStyleTag({ content: '#picker { position:fixed; top:40px; height:300px; overflow:auto; width:600px } #card0 { margin-top:500px; padding-bottom:200px } [data-testid="thinking-level-trigger"] { display:flex; height:60px; width:500px; align-items:start } [data-slot="popover-content"][data-open] { position:fixed; top:100px; right:10px }' })
    await page.evaluate(() => {
      const picker = document.querySelector<HTMLElement>("#picker")!
      const trigger = document.querySelector<HTMLElement>('#card0 [data-testid="thinking-level-trigger"]')!
      document.querySelector<HTMLElement>("#model")!.onclick = () => {
        picker.hidden = false
        picker.scrollTop = trigger.offsetTop - 275
      }
      // The real picker dismisses its popup on outside scroll. A clipped row needs scrolling first.
      trigger.addEventListener("click", () => {
        const rect = trigger.getBoundingClientRect(), viewport = picker.getBoundingClientRect()
        if (rect.bottom > viewport.bottom) setTimeout(() => {
          const popup = document.querySelector<HTMLElement>("#levels0")!
          popup.hidden = true; popup.removeAttribute("data-open"); popup.setAttribute("data-closed", "")
          trigger.setAttribute("aria-expanded", "false")
        }, 350)
      })
    })
    await selectModel(new PlaywrightModelSelectionSurface(page, { modelLoader: "#model" }), { ...models[0]!, reasoning: "low" }, { timeoutMs: 2500 })
    expect(await page.locator("body").getAttribute("data-selected")).toBe("0:low")
    expect(await page.locator("#picker").isVisible()).toBe(false)
  } finally { clearInterval(transportPulse); await chrome.close() }
}, 6000)

test("Processing selects a named option without pointer-induced popup dismissal", async () => {
  const transportPulse = setInterval(() => {}, 10).unref()
  const chrome = await browser()
  const page = await chrome.newPage()
  try {
    await fixture(page, "en")
    await page.evaluate(() => {
      const popup = document.querySelector<HTMLElement>("#levels0")!
      popup.addEventListener("pointerdown", () => {
        popup.hidden = true; popup.removeAttribute("data-open"); popup.setAttribute("data-closed", "")
        document.body.dataset.pointerDismissed = "true"
      }, true)
      popup.addEventListener("keydown", event => event.preventDefault())
    })
    await selectModel(new PlaywrightModelSelectionSurface(page, { modelLoader: "#model" }), { ...models[0]!, reasoning: "low" }, { timeoutMs: 3000 })
    expect(await page.locator("body").getAttribute("data-pointer-dismissed")).toBeNull()
    expect(await page.locator("body").getAttribute("data-selected")).toBe("0:low")
  } finally { clearInterval(transportPulse); await chrome.close() }
}, 6000)

for (const failure of ["missing", "missing-control", "missing-option", "disabled-option", "missing-link", "wrong-link", "unknown-value", "wrong-value", "stuck", "wrong-model"]) test(`Processing fails closed when ${failure}`, async () => {
  const transportPulse = setInterval(() => {}, 10).unref()
  const chrome = await browser()
  const page = await chrome.newPage()
  try {
    await fixture(page, "en", failure)
    await expect(selectModel(new PlaywrightModelSelectionSurface(page, { modelLoader: "#model" }),
      { ...models[1]!, reasoning: "low" }, { timeoutMs: 1800 })).rejects.toThrow()
    expect(await page.locator("body").getAttribute("data-wrong")).toBeNull()
    expect(await page.locator("#picker").isVisible()).toBe(failure !== "wrong-model")
    expect(await page.locator("textarea").inputValue()).toBe("")
    if (failure === "stuck" || failure === "wrong-model") expect(await page.locator("body").getAttribute("data-selected")).toBe("1:low")
    else expect(await page.locator("body").getAttribute("data-selected")).toBeNull()
  } finally { clearInterval(transportPulse); await chrome.close() }
}, 6000)

for (const failure of ["", "stuck"]) test(`adapter sends only after model/variant verification and closure${failure ? " (stuck picker)" : " across a retained session"}`, async () => {
  const transportPulse = setInterval(() => {}, 10).unref()
  const submissions: { selected: string; pickerClosed: boolean; filledWhileOpen: boolean; actions: string[] }[] = []
  let navigations = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/submit") {
      const body = await request.json() as { observation: (typeof submissions)[number] }
      submissions.push(body.observation)
      return new Response(`data: ${JSON.stringify({ type: "text", delta: '<aipass-envelope>{"type":"chat","text":"ready"}</aipass-envelope>' })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    }
    if (path !== "/chat") return new Response("not found", { status: 404 })
    navigations++
    return new Response(fixtureHTML("en", failure).replace("</body>", `<input type="checkbox" aria-label="Temporary chat" checked><button id="send">Send</button>
      <script>
        let filledWhileOpen = false;
        document.querySelector('textarea').addEventListener('input', () => {
          filledWhileOpen ||= !picker.hidden;
          actions.push('fill');
        });
        document.querySelector('#send').onclick = async () => {
          actions.push('send');
          const response = await fetch('/submit', {method:'POST',body:JSON.stringify({
            messages:[{content:document.querySelector('textarea').value}],
            observation:{selected:document.body.dataset.selected,pickerClosed:picker.hidden,filledWhileOpen,actions:actions.splice(0)}
          })});
          await response.text();
        };
      </script></body>`), { headers: { "content-type": "text/html" } })
  } })
  const command = parseCommand(["start"], {}, { verifyChrome: false })
  if (command.type !== "serve") throw Error("expected browser settings")
  const profilePath = await mkdtemp(join(tmpdir(), "aipass-processing-fixture-"))
  const protocol: BrowserProtocol<BrowserFrame> = {
    decoder: () => new StreamFrameParser(), text: delta => ({ type: "text", delta }),
    finish: reason => ({ type: "finish", reason }), isTerminal: frame => frame.type === "finish",
  }
  const adapter = await PlaywrightBrowserAdapter.launch({
    profilePath, executablePath: command.settings.chromeExecutable, chatURL: `${server.url}chat`,
    selectors: { modelLoader: "#model", promptInput: "textarea", sendButton: "#send" },
  }, {
    async binding() { return undefined }, async prepare(input) { return { id: "fixture", promptHash: input.promptHash } },
    async pending() {}, async bind() {}, async complete() {}, async fail() {},
  }, protocol)
  try {
    const cases = [[0, "low"], [0, "high"], [0, "high"], [2, "none"], [1, "max"], [1, "none"]] as const
    for (const [index, reasoning] of failure ? cases.slice(0, 1) : cases) {
      const input: BrowserTurnInput = {
        sessionMarker: "processing-fixture", ephemeral: false, primingPrompts: [],
        model: models[index]!, reasoning, initialPrompt: "Reply ready.", incrementalPrompt: "Reply ready.", recoveryPrompt: "Reply ready.",
        promptContractVersion: 0, actionEnvelopeDigest: "fixture", toolContinuation: false,
      }
      const work = (async () => {
        const frames: BrowserFrame[] = []
        for await (const frame of adapter.turn(input, AbortSignal.timeout(failure ? 2500 : 8000))) frames.push(frame)
        return frames
      })()
      if (failure) await expect(work).rejects.toThrow()
      else expect(await work).toContainEqual({ type: "finish", reason: "stop" })
    }
    expect(navigations).toBe(1)
    if (failure) expect(submissions).toEqual([])
    else {
      expect(submissions.map(({ selected }) => selected)).toEqual(cases.map(([index, reasoning]) => `${index}:${reasoning}`))
      for (const observation of submissions) {
        expect(observation.pickerClosed).toBe(true)
        expect(observation.filledWhileOpen).toBe(false)
      }
      expect(submissions[2]!.actions).toEqual(["fill", "send"])
      for (const index of [0, 1, 3, 4, 5]) expect(submissions[index]!.actions.slice(-3)).toEqual(["closed", "fill", "send"])
    }
  } finally {
    await adapter.close(); await server.stop(true); clearInterval(transportPulse)
    await rm(profilePath, { recursive: true, force: true })
  }
}, 30_000)
