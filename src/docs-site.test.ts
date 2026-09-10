import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDocsSiteHandler } from "../scripts/docs-site.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aipass-docs-site-"))
  temporaryDirectories.push(root)
  await mkdir(join(root, "site"), { recursive: true })
  await mkdir(join(root, "docs"), { recursive: true })
  await mkdir(join(root, "scripts"), { recursive: true })
  await mkdir(join(root, "output", "prompt-order", "actual"), { recursive: true })
  await writeFile(join(root, "site", "index.html"), "<!doctype html><a href=\"/docs/readme\"><a href=\"/docs/configuration\"><a href=\"/docs/runtime-guide\"><a href=\"/scripts/live-smoke\"><a href=\"/scripts/live-catalog-trace\"><video src=\"/review/review.webm\">")
  await writeFile(join(root, "docs", "runtime-guide.md"), "# Runtime guide\n\nSafe details.")
  await writeFile(join(root, "docs", "configuration.md"), "# Runtime configuration\n\nNo private values.")
  await writeFile(join(root, "README.md"), "# AIPass\n\nOverview.")
  await writeFile(join(root, "scripts", "live-smoke.ts"), "const safe = true\n")
  await writeFile(join(root, "scripts", "live-catalog-trace.ts"), "const catalog = true\n")
  await writeFile(join(root, "output", "prompt-order", "actual", "review.webm"), new Uint8Array([0, 1, 2, 3, 4, 5]))
  await writeFile(join(root, "output", "prompt-order", "actual", "review-summary.json"), '{"ok":true}\n')
  await writeFile(join(root, "output", "prompt-order", "actual", "startup-redacted.txt"), "ready\n")
  return { root, handler: createDocsSiteHandler(root) }
}

test("serves the review shell and allowlisted readable documentation", async () => {
  const { handler } = await fixture()
  const home = await handler(new Request("http://127.0.0.1/"))
  expect(home.status).toBe(200)
  expect(home.headers.get("content-type")).toContain("text/html")
  const shell = await home.text()
  for (const href of ["/docs/readme", "/docs/configuration", "/docs/runtime-guide", "/scripts/live-smoke", "/scripts/live-catalog-trace", "/review/review.webm"]) {
    expect(shell).toContain(href)
  }

  const guide = await handler(new Request("http://127.0.0.1/docs/runtime-guide"))
  expect(guide.status).toBe(200)
  expect(guide.headers.get("content-type")).toContain("text/html")
  expect(await guide.text()).toContain("Runtime guide")

  const configuration = await handler(new Request("http://127.0.0.1/docs/configuration"))
  expect(configuration.status).toBe(200)
  expect(await configuration.text()).toContain("Runtime configuration")

  const source = await handler(new Request("http://127.0.0.1/scripts/live-smoke"))
  expect(source.status).toBe(200)
  expect(source.headers.get("content-type")).toContain("text/html")
  expect(await source.text()).toContain("const safe = true")
})

test("rejects non-GET/HEAD requests, traversal, unknown routes, and arbitrary output access", async () => {
  const { handler } = await fixture()
  for (const request of [
    new Request("http://127.0.0.1/docs/runtime-guide", { method: "POST" }),
    new Request("http://127.0.0.1/docs/%2e%2e/README.md"),
    new Request("http://127.0.0.1/scripts/docs-site.ts"),
    new Request("http://127.0.0.1/config.json"),
    new Request("http://127.0.0.1/catalog"),
    new Request("http://127.0.0.1/output/prompt-order/actual/review.webm"),
    new Request("http://127.0.0.1/unknown"),
  ]) expect((await handler(request)).status).toBe(404)
})

test("reports absent review artifacts honestly and serves allowlisted video byte ranges", async () => {
  const { root, handler } = await fixture()
  await rm(join(root, "output", "prompt-order", "actual", "review.webm"))
  expect((await handler(new Request("http://127.0.0.1/review/review.webm"))).status).toBe(404)

  await writeFile(join(root, "output", "prompt-order", "actual", "review.webm"), new Uint8Array([0, 1, 2, 3, 4, 5]))
  const partial = await handler(new Request("http://127.0.0.1/review/review.webm", { headers: { range: "bytes=1-3" } }))
  expect(partial.status).toBe(206)
  expect(partial.headers.get("content-range")).toBe("bytes 1-3/6")
  expect(Array.from(new Uint8Array(await partial.arrayBuffer()))).toEqual([1, 2, 3])

  for (const [range, expected] of [["bytes=-2", [4, 5]], ["bytes=4-", [4, 5]], ["bytes=-20", [0, 1, 2, 3, 4, 5]]] as const) {
    const response = await handler(new Request("http://127.0.0.1/review/review.webm", { headers: { range } }))
    expect(response.status).toBe(206)
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([...expected])
  }
  for (const range of ["bytes=-0", "bytes=8-", "bytes=4-1", "bytes=0-1,3-4", "bytes=999999999999999999999-"]) {
    const response = await handler(new Request("http://127.0.0.1/review/review.webm", { headers: { range } }))
    expect(response.status).toBe(416)
    expect(response.headers.get("content-range")).toBe("bytes */6")
  }

  const head = await handler(new Request("http://127.0.0.1/review/result.json", { method: "HEAD" }))
  expect(head.status).toBe(200)
  expect(await head.text()).toBe("")
})

test("renders Markdown references as navigable HTML without running embedded content", async () => {
  const { root, handler } = await fixture()
  await writeFile(join(root, "README.md"), '# AIPass\n\n[Runtime guide](docs/runtime-guide.md)\n\n[unsafe](javascript:alert)\n\n<script>alert(1)</script>\n\n![remote](https://example.invalid/track.png)')
  const response = await handler(new Request("http://127.0.0.1/docs/readme"))
  const html = await response.text()
  expect(html).toContain('<h1 id="aipass">AIPass</h1>')
  expect(html).toContain('href="/docs/runtime-guide"')
  expect(html).not.toContain('href="javascript:')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('<img')
  expect(html).toContain('&lt;script&gt;')
  await writeFile(join(root, "scripts", "live-smoke.ts"), '<script>alert(1)</script>')
  const source = await (await handler(new Request("http://127.0.0.1/scripts/live-smoke"))).text()
  expect(source).toContain('&lt;script&gt;')
  expect(source).not.toContain('<script>')
})
