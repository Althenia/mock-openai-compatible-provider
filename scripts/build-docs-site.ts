import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { createDocsSiteHandler } from "./docs-site.ts"

type StaticPage = { readonly route: string; readonly file: string; readonly label: string }

async function staticPages(root: string): Promise<readonly StaticPage[]> {
  // New docs/releases/v*.md files publish without code changes.
  let releases: string[] = []
  try {
    releases = (await readdir(join(root, "docs", "releases")))
      .filter((name) => /^v\d+\.\d+\.\d+\.md$/.test(name))
      .sort()
  } catch {
    releases = []
  }
  return [
    { route: "/docs/readme", file: "README.md", label: "README" },
    { route: "/docs/runtime-guide", file: "docs/runtime-guide.md", label: "Runtime guide" },
    { route: "/docs/operations", file: "docs/operations.md", label: "Operations" },
    { route: "/docs/model-matrix", file: "docs/model-matrix.md", label: "Model matrix" },
    ...releases.map((name): StaticPage => {
      const version = name.slice(0, -".md".length)
      return { route: `/docs/releases/${version}`, file: `docs/releases/${name}`, label: `Release ${version}` }
    }),
    { route: "/docs/source", file: "SOURCE.md", label: "Source" },
    { route: "/docs/license", file: "LICENSE", label: "License" },
    { route: "/docs/notices", file: "THIRD_PARTY_NOTICES", label: "Third-party notices" },
    { route: "/scripts/live-smoke", file: "scripts/live-smoke.ts", label: "Live smoke script" },
    { route: "/scripts/live-catalog-trace", file: "scripts/live-catalog-trace.ts", label: "Catalog trace script" },
    { route: "/scripts/build", file: "scripts/build.sh", label: "Build script" },
    { route: "/scripts/test-install", file: "scripts/test-install.sh", label: "Install test script" },
    { route: "/scripts/test-release", file: "scripts/test-release.sh", label: "Release test script" },
  ]
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!)
}

function normalizeBasePath(value: string) {
  const path = `/${value.replace(/^\/+|\/+$/g, "")}`.replace(/\/+/g, "/")
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(path)) throw new Error("invalid base path")
  return path === "/" ? path : `${path}/`
}

function publicUrl(basePath: string, route: string) {
  return `${basePath}${route.replace(/^\//, "")}/`
}

function outputFile(output: string, route: string) {
  return join(output, route.replace(/^\//, ""), "index.html")
}

function rebaseHtml(html: string, basePath: string, pages: readonly StaticPage[]) {
  const rebased = html.replace(/\b(href|src)="\/(?!\/)/g, `$1="${basePath}`)
  return pages.reduce((result, page) => result
    .replaceAll(`href="${basePath}${page.route.slice(1)}"`, `href="${publicUrl(basePath, page.route)}"`)
    .replaceAll(`href="${basePath}${page.route.slice(1)}#`, `href="${publicUrl(basePath, page.route)}#`), rebased)
}

export async function buildStaticDocsSite({ root = process.cwd(), output = join(process.cwd(), "output", "pages"), basePath = "/" }: { root?: string; output?: string; basePath?: string } = {}) {
  const normalizedBasePath = normalizeBasePath(basePath)
  const pages = await staticPages(root)
  const available = [] as StaticPage[]
  for (const page of pages) if (await Bun.file(join(root, page.file)).exists()) available.push(page)

  // Never erase an arbitrary --out destination or mix old/private output into
  // a publication candidate. Rebuild into a fresh directory.
  await mkdir(dirname(output), { recursive: true })
  await mkdir(output)
  const handler = createDocsSiteHandler(root)
  for (const page of available) {
    const response = await handler(new Request(`https://docs.invalid${page.route}`))
    const html = response.ok ? await response.text() : undefined
    if (!html) throw new Error(`could not render ${page.file}: ${response.status}`)
    const target = outputFile(output, page.route)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, rebaseHtml(html, normalizedBasePath, pages))
  }
  await copyFile(join(root, "site", "install.sh"), join(output, "install.sh"))

  const template = await readFile(join(root, "site", "public.html"), "utf8")
  const nav = available.map(page => `<a href="${publicUrl(normalizedBasePath, page.route)}">${escapeHtml(page.label)}</a>`).join("")
  const links = available.map(page => `<a href="${publicUrl(normalizedBasePath, page.route)}">${escapeHtml(page.label)}</a>`).join("")
  const content = `<p class="eyebrow">AIPass documentation</p><h1>Read the runtime.</h1><p class="lede">Public reference material and script sources for the browser provider.</p><div class="rule"></div><section class="panel"><h2>Documentation</h2><p>Named public references only.</p><div class="links">${links}</div></section>`
  await writeFile(join(output, "index.html"), template.replaceAll("{{ROOT}}", normalizedBasePath).replace("{{NAV}}", nav).replace("{{CONTENT}}", content))
}

function argumentsFrom(args: readonly string[]) {
  let output = join(process.cwd(), "output", "pages")
  let basePath = "/"
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1]
    if (!value || !["--out", "--base-path"].includes(args[index]!)) throw new Error("usage: bun scripts/build-docs-site.ts [--out DIRECTORY] [--base-path /PROJECT/]")
    if (args[index] === "--out") output = resolve(value)
    else basePath = value
  }
  return { output, basePath }
}

if (import.meta.main) await buildStaticDocsSite(argumentsFrom(process.argv.slice(2)))
