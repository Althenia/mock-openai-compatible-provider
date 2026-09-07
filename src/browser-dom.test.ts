import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright-core"

import { ensureTempChat, PlaywrightTempChatSurface, readDomSnapshot } from "./browser.ts"
import { parseCommand } from "./config.ts"

const like = '<svg viewBox="0 0 21 20"><path d="M4.75 5.75H2.75L3 12.75H5.5" /></svg>'
const dislike = '<svg viewBox="0 0 21 20"><path d="M16.1898 12.75H18.1898L17.9 5.75H15.4" /></svg>'
const copy = '<svg viewBox="0 0 21 20"><path d="M1 1" /></svg>'

let browser: Browser
let page: Page

beforeAll(async () => {
  const command = parseCommand(["start"], {}, { verifyChrome: false })
  if (command.type !== "serve") throw new Error("expected serve command settings")
  browser = await chromium.launch({ headless: true, executablePath: command.settings.chromeExecutable })
  page = await browser.newPage()
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
})

function controls(...icons: string[]) {
  return icons.map((icon) => `<button>${icon}</button>`).join("")
}

function assistant(content: string, controlsMarkup = controls(like, dislike)) {
  return `<article data-role="assistant">${content}<div class="controls">${controlsMarkup}</div></article>`
}

describe("DOM completion browser fixtures", () => {
  test("enables temporary chat instead of treating an ordinary link SVG path as enabled", async () => {
    await page.route("https://temp-chat.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: '<a href="/chat">New chat</a><a href="/chat?temporary-chat=true"><svg><path d="M1 1L2 2" /></svg></a>',
    }))
    try {
      await page.goto("https://temp-chat.test/chat")
      expect(await ensureTempChat(new PlaywrightTempChatSurface(page))).toBe("on")
      expect(new URL(page.url()).searchParams.get("temporary-chat")).toBe("true")
    } finally {
      await page.goto("about:blank")
      await page.unroute("https://temp-chat.test/**")
    }
  }, 15_000)

  test("requires distinct unlabeled Like and Dislike SVG controls on the latest assistant", async () => {
    await page.setContent(assistant('<div class="markdown-content">answer</div>'))
    expect((await readDomSnapshot(page)).settled).toBe(true)

    await page.setContent(assistant('<div class="markdown-content">answer</div>', controls(like)))
    expect((await readDomSnapshot(page)).settled).toBe(false)

    await page.setContent(assistant('<div class="markdown-content">answer</div>', controls(dislike)))
    expect((await readDomSnapshot(page)).settled).toBe(false)

    await page.setContent(assistant('<div class="markdown-content">answer</div>', controls(copy, like)))
    expect((await readDomSnapshot(page)).settled).toBe(false)

    await page.setContent(
      `${assistant('<div class="markdown-content">older</div>')}${assistant('<div class="markdown-content">latest</div>', controls(copy))}`,
    )
    expect((await readDomSnapshot(page)).settled).toBe(false)
  })

  test("expands only the recognized lazy thinking panel, preserves answer expanders, and returns ordered segments", async () => {
    await page.setContent(
      assistant(`
        <div data-no-copy="true">
          <div data-slot="collapsible">
            <button data-slot="collapsible-trigger" aria-expanded="false" onclick="this.setAttribute('aria-expanded', 'true'); document.querySelector('[data-slot=collapsible-content]').innerHTML = '<p>untitled lead</p><p><span data-streamdown=strong>First</span></p><p>one</p><p>two</p><p><span data-streamdown=strong>Second</span></p><p>three</p>'">กำลังประมวลผล</button>
            <div data-slot="collapsible-content"></div>
          </div>
        </div>
        <div class="markdown-content"><p>Answer</p><button aria-expanded="false" onclick="window.unrelatedClicks = (window.unrelatedClicks || 0) + 1">thinking options</button><p>Unrelated details</p></div>
      `),
    )

    const snapshot = await readDomSnapshot(page)
    expect(snapshot.thinking).toEqual([
      { title: "", body: "untitled lead" },
      { title: "First", body: "one\ntwo" },
      { title: "Second", body: "three" },
    ])
    expect(snapshot.text).toContain("Answer")
    expect(snapshot.text).toContain("thinking options")
    expect(snapshot.text).toContain("Unrelated details")
    expect(snapshot.text).not.toContain("untitled lead")
    expect((await page.evaluate(() => (window as typeof window & { unrelatedClicks?: number }).unrelatedClicks)) ?? 0).toBe(0)
  })

  test("fails open within the reveal timeout when a recognized thinking panel has no mounted content", async () => {
    await page.setContent(
      assistant(`
        <div data-no-copy="true"><div data-slot="collapsible">
          <button data-slot="collapsible-trigger" aria-expanded="false">กำลังประมวลผล</button>
        </div></div>
        <div class="markdown-content">answer remains available</div>
      `),
    )
    const started = performance.now()
    const snapshot = await readDomSnapshot(page)
    expect(performance.now() - started).toBeLessThan(3_000)
    expect(snapshot.thinking).toEqual([])
    expect(snapshot.text).toBe("answer remains available")
  }, 5_000)

  test("waits for latest thinking content rather than an older assistant panel", async () => {
    await page.setContent(
      assistant('<div data-no-copy="true"><div data-slot="collapsible"><button data-slot="collapsible-trigger" aria-expanded="true">thinking</button><div data-slot="collapsible-content"><p>old reasoning</p></div></div></div>') +
      assistant(`<div data-no-copy="true"><div data-slot="collapsible">
        <button data-slot="collapsible-trigger" aria-expanded="false" onclick="this.setAttribute('aria-expanded', 'true'); setTimeout(() => this.parentElement.insertAdjacentHTML('beforeend', '<div data-slot=collapsible-content><p>latest reasoning</p></div>'), 100)">thinking</button>
      </div></div><div class="markdown-content">latest answer</div>`),
    )
    const snapshot = await readDomSnapshot(page)
    expect(snapshot.thinking).toEqual([{ title: "", body: "latest reasoning" }])
    expect(snapshot.text).toBe("latest answer")
  })

  test("keeps mixed bold paragraphs in thinking bodies", async () => {
    await page.setContent(assistant(`<div data-no-copy="true"><div data-slot="collapsible">
      <button data-slot="collapsible-trigger" aria-expanded="true">thinking</button>
      <div data-slot="collapsible-content"><p><span data-streamdown="strong">Label</span> explanation</p></div>
    </div></div><div class="markdown-content">answer</div>`))
    expect((await readDomSnapshot(page)).thinking).toEqual([{ title: "", body: "Label explanation" }])
  })

  test("does not click thinking after cancellation", async () => {
    await page.setContent(assistant(`<div data-no-copy="true"><div data-slot="collapsible">
      <button data-slot="collapsible-trigger" aria-expanded="false" onclick="this.dataset.clicked = 'true'">thinking</button>
    </div></div><div class="markdown-content">answer</div>`))
    await expect(readDomSnapshot(page, AbortSignal.abort())).rejects.toThrow("cancelled")
    expect(await page.locator('[data-slot="collapsible-trigger"]').getAttribute("data-clicked")).toBeNull()
  })
})
