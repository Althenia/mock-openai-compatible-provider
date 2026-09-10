import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildStaticDocsSite } from "../scripts/build-docs-site.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aipass-static-docs-"))
  const output = join(root, "pages")
  temporaryDirectories.push(root)
  await Promise.all([
    mkdir(join(root, "docs", "releases"), { recursive: true }),
    mkdir(join(root, "scripts"), { recursive: true }),
    mkdir(join(root, "site"), { recursive: true }),
    mkdir(join(root, "output", "private"), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(root, "site", "public.html"), "<!doctype html><title>AIPass docs</title><nav>{{NAV}}</nav><main>{{CONTENT}}</main>"),
    writeFile(join(root, "README.md"), "# AIPass\n\n[Guide](docs/runtime-guide.md#runtime)\n\n<script>alert(1)</script>"),
    writeFile(join(root, "site", "install.sh"), "#!/bin/sh\necho fixture\n"),
    writeFile(join(root, "LICENSE"), "License text\n"),
    writeFile(join(root, "THIRD_PARTY_NOTICES"), "Notices\n"),
    writeFile(join(root, "docs", "runtime-guide.md"), "# Runtime\n\n[Operations](operations.md)\n\n<script>alert(1)</script>"),
    writeFile(join(root, "docs", "configuration.md"), "# Configuration\n\nFile-owned settings."),
    writeFile(join(root, "docs", "operations.md"), "# Operations\n\nSafe operations."),
    writeFile(join(root, "docs", "model-matrix.md"), "# Models\n\nSafe models."),
    writeFile(join(root, "docs", "releases", "v0.1.2.md"), "# 0.1.2\n"),
    writeFile(join(root, "docs", "releases", "v0.1.3.md"), "# 0.1.3\n"),
    writeFile(join(root, "scripts", "live-smoke.ts"), "const safe = '<script>';\n"),
    writeFile(join(root, "scripts", "live-catalog-trace.ts"), "const trace = true\n"),
    writeFile(join(root, "scripts", "build.sh"), "#!/bin/sh\n"),
    writeFile(join(root, "scripts", "test-install.sh"), "#!/bin/sh\n"),
    writeFile(join(root, "scripts", "test-release.sh"), "#!/bin/sh\n"),
    writeFile(join(root, "output", "private", "recording.webm"), "private"),
  ])
  return { root, output }
}

test("builds a safe static site with project-subpath navigation and readable script references", async () => {
  const { root, output } = await fixture()
  await buildStaticDocsSite({ root, output, basePath: "/AIPass/" })

  const index = await readFile(join(output, "index.html"), "utf8")
  expect(index).toContain('href="/AIPass/docs/runtime-guide/"')
  expect(index).toContain('href="/AIPass/docs/configuration/"')
  expect(index).toContain('href="/AIPass/docs/releases/v0.1.3/"')
  expect(index).toContain('href="/AIPass/scripts/live-smoke/"')
  expect(index).not.toContain("/review/")
  expect(index).not.toContain("localhost")

  const guide = await readFile(join(output, "docs", "runtime-guide", "index.html"), "utf8")
  expect(guide).toContain('href="/AIPass/docs/operations/"')
  expect(guide).toContain("&lt;script&gt;")
  expect(guide).not.toContain("<script>alert")
  expect(await readFile(join(output, "docs", "configuration", "index.html"), "utf8")).toContain("File-owned settings")

  const script = await readFile(join(output, "scripts", "live-smoke", "index.html"), "utf8")
  expect(script).toContain("const safe = &#39;&lt;script&gt;&#39;")
  expect(script).not.toContain("<script>")
  expect(await Bun.file(join(output, "output", "private", "recording.webm")).exists()).toBe(false)
  expect(await readFile(join(output, "site", "install.sh"), "utf8").catch(() => "")).toBe("")
  expect(await readFile(join(output, "install.sh"), "utf8")).toBe("#!/bin/sh\necho fixture\n")
  const readme = await readFile(join(output, "docs", "readme", "index.html"), "utf8")
  expect(readme).toContain('href="/AIPass/docs/runtime-guide/#runtime"')
})

test("refuses to overwrite an existing output or accept an unsafe project path", async () => {
  const { root, output } = await fixture()
  await mkdir(output)
  await writeFile(join(output, "keep.txt"), "KEEP")
  await expect(buildStaticDocsSite({ root, output })).rejects.toThrow()
  expect(await readFile(join(output, "keep.txt"), "utf8")).toBe("KEEP")
  for (const basePath of ['/<script>/', '/../../', '/a?b/', '/a"b/']) {
    await expect(buildStaticDocsSite({ root, output: join(root, "unsafe"), basePath })).rejects.toThrow("invalid base path")
  }
})
