import { join } from "node:path"

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" }

type Resource = {
  readonly file: string
  readonly type: string
  readonly readable?: boolean
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!)
}

function readablePage(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · AIPass</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#10233f;font:16px/1.65 ui-sans-serif,system-ui,sans-serif}main{max-width:920px;margin:auto;padding:3rem 1.25rem;overflow-wrap:anywhere}a{color:#1265b0}a:focus-visible{outline:3px solid #176db6;outline-offset:3px}h1,h2,h3{line-height:1.2;scroll-margin-top:1rem}h2{margin-top:2.5rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;border:1px solid #d8e2ee;border-radius:.6rem;padding:1.5rem}code{font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border:1px solid #d8e2ee;padding:.6rem;text-align:left}blockquote{border-left:3px solid #176db6;margin-left:0;padding-left:1rem}</style></head><body><main><p><a href="/">← Documentation console</a></p>${body}</main></body></html>`
}

function response(status: number, body: BodyInit | null = null, headers?: HeadersInit) {
  return new Response(body, { status, headers })
}

function safePath(url: URL) {
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return undefined
  }
  return pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").includes("..") ? undefined : pathname
}

function rangeFor(header: string | null, size: number) {
  if (!header) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match) return null
  const start = match[1] ? Number(match[1]) : undefined
  const end = match[2] ? Number(match[2]) : undefined
  if ((start === undefined && end === undefined) || (start !== undefined && !Number.isSafeInteger(start)) || (end !== undefined && !Number.isSafeInteger(end))) return null
  const first = start ?? Math.max(0, size - end!)
  const last = start === undefined ? size - 1 : Math.min(end ?? size - 1, size - 1)
  return first < 0 || first >= size || last < first ? null : { first, last }
}

export function createDocsSiteHandler(root = process.cwd()) {
  const resources: Readonly<Record<string, Resource>> = {
    "/": { file: "site/index.html", type: "text/html; charset=utf-8" },
    "/docs/runtime-guide": { file: "docs/runtime-guide.md", type: "text/markdown", readable: true },
    "/docs/operations": { file: "docs/operations.md", type: "text/markdown", readable: true },
    "/docs/model-matrix": { file: "docs/model-matrix.md", type: "text/markdown", readable: true },
    "/docs/releases/v0.1.0": { file: "docs/releases/v0.1.0.md", type: "text/markdown", readable: true },
    "/docs/releases/v0.1.1": { file: "docs/releases/v0.1.1.md", type: "text/markdown", readable: true },
    "/docs/releases/v0.1.2": { file: "docs/releases/v0.1.2.md", type: "text/markdown", readable: true },
    "/docs/releases/v0.1.3": { file: "docs/releases/v0.1.3.md", type: "text/markdown", readable: true },
    "/docs/source": { file: "SOURCE.md", type: "text/markdown", readable: true },
    "/docs/license": { file: "LICENSE", type: "text/plain", readable: true },
    "/docs/notices": { file: "THIRD_PARTY_NOTICES", type: "text/plain", readable: true },
    "/docs/readme": { file: "README.md", type: "text/markdown", readable: true },
    "/scripts/live-smoke": { file: "scripts/live-smoke.ts", type: "text/plain", readable: true },
    "/scripts/live-catalog-trace": { file: "scripts/live-catalog-trace.ts", type: "text/plain", readable: true },
    "/scripts/build": { file: "scripts/build.sh", type: "text/plain", readable: true },
    "/scripts/test-install": { file: "scripts/test-install.sh", type: "text/plain", readable: true },
    "/scripts/test-release": { file: "scripts/test-release.sh", type: "text/plain", readable: true },
    "/review/review.webm": { file: "output/prompt-order/actual/review.webm", type: "video/webm" },
    "/review/result.json": { file: "output/prompt-order/actual/review-summary.json", type: "application/json; charset=utf-8" },
    "/review/startup.txt": { file: "output/prompt-order/actual/startup-redacted.txt", type: "text/plain; charset=utf-8" },
  }

  return async function docsSiteHandler(request: Request) {
    if (request.method !== "GET" && request.method !== "HEAD") return response(404)
    const pathname = safePath(new URL(request.url))
    const resource = pathname === undefined ? undefined : resources[pathname]
    if (!resource) return response(404)

    const file = Bun.file(join(root, resource.file))
    if (!(await file.exists())) return response(404)
    if (resource.readable) {
      const content = await file.text()
      const body = resource.type === "text/markdown" ? Bun.markdown.render(content.replace(/<a id="[a-z0-9-]+"><\/a>/g, ""), {
        text: escapeHtml, html: text => text,
        heading: (text, meta) => `<h${meta.level} id="${escapeHtml(meta.id ?? "")}">${text}</h${meta.level}>`,
        paragraph: text => `<p>${text}</p>`,
        code: text => `<pre><code>${text}</code></pre>`,
        codespan: text => `<code>${text}</code>`,
        strong: text => `<strong>${text}</strong>`, emphasis: text => `<em>${text}</em>`,
        list: (text, meta) => meta.ordered ? `<ol start="${meta.start ?? 1}">${text}</ol>` : `<ul>${text}</ul>`,
        listItem: text => `<li>${text}</li>`, hr: () => "<hr>", blockquote: text => `<blockquote>${text}</blockquote>`,
        table: text => `<table>${text}</table>`, thead: text => `<thead>${text}</thead>`, tbody: text => `<tbody>${text}</tbody>`,
        tr: text => `<tr>${text}</tr>`, th: text => `<th>${text}</th>`, td: text => `<td>${text}</td>`,
        image: text => text,
        link: (text, meta) => {
          if (meta.href.startsWith("#")) return `<a href="${escapeHtml(meta.href)}">${text}</a>`
          let url: URL
          try { url = new URL(meta.href, `https://docs.invalid/${resource.file}`) } catch { return text }
          if (url.protocol !== "https:") return text
          const route = Object.entries(resources).find(([, item]) => `/${item.file}` === url.pathname)?.[0]
          const href = url.origin === "https://docs.invalid" ? route ? route + url.hash : undefined : url.href
          return href ? `<a href="${escapeHtml(href)}" rel="noreferrer">${text}</a>` : text
        },
      }, { headings: { ids: true } }) : `<pre><code>${escapeHtml(content)}</code></pre>`
      return response(200, request.method === "HEAD" ? null : readablePage(resource.file, body), HTML_HEADERS)
    }

    const headers = new Headers({ "content-type": resource.type, "content-length": String(file.size), "x-content-type-options": "nosniff" })
    const range = rangeFor(request.headers.get("range"), file.size)
    if (range === null) return response(416, null, { "content-range": `bytes */${file.size}` })
    if (range) {
      headers.set("content-range", `bytes ${range.first}-${range.last}/${file.size}`)
      headers.set("content-length", String(range.last - range.first + 1))
      headers.set("accept-ranges", "bytes")
      return response(206, request.method === "HEAD" ? null : file.slice(range.first, range.last + 1), headers)
    }
    headers.set("accept-ranges", "bytes")
    return response(200, request.method === "HEAD" ? null : file, headers)
  }
}

function portFromArgs(args: readonly string[]) {
  if (!args.length) return 8787
  if (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1]!)) throw new Error("usage: bun scripts/docs-site.ts [--port PORT]")
  const port = Number(args[1])
  if (port < 1 || port > 65_535) throw new Error("--port must be between 1 and 65535")
  return port
}

if (import.meta.main) {
  const port = portFromArgs(process.argv.slice(2))
  Bun.serve({ hostname: "127.0.0.1", port, fetch: createDocsSiteHandler() })
  console.log(`Documentation review available at http://127.0.0.1:${port}`)
}
