import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { rustNotices } from "../scripts/rust-notices.ts"

type CrateFixture = {
  name: string
  version: string
  license?: string
  metadataName?: string
  documents?: Record<string, string>
}

type LockPackage = { name: string; version: string; source?: string; checksum?: string }

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex")
}

async function makeTar(archive: string, parent: string, member: string) {
  const result = Bun.spawnSync(["tar", "-czf", archive, "-C", parent, "--", member])
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

async function createCrate(project: string, fixture: CrateFixture) {
  const staging = await mkdtemp(join(tmpdir(), "rust-notices-crate-"))
  temporaryDirectories.push(staging)
  const rootName = `${fixture.name}-${fixture.version}`
  const root = join(staging, rootName)
  await mkdir(root, { recursive: true })
  const license = fixture.license === undefined ? "" : `license = ${JSON.stringify(fixture.license)}\n`
  await writeFile(join(root, "Cargo.toml"), `[package]\nname = ${JSON.stringify(fixture.metadataName ?? fixture.name)}\nversion = ${JSON.stringify(fixture.version)}\n${license}`)
  for (const [path, text] of Object.entries(fixture.documents ?? { LICENSE: `${fixture.name} license text` })) {
    const target = join(root, path)
    await mkdir(join(target, ".."), { recursive: true })
    await writeFile(target, text)
  }
  const archive = join(staging, `${rootName}.crate`)
  await makeTar(archive, staging, rootName)
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer())
  const checksum = sha256(bytes)
  await writeFile(join(project, "output/rust-notices-cache", `${checksum}.crate`), bytes)
  return { checksum, bytes }
}

async function createProject(packages: LockPackage[], workspacePackages = ["bun_internal"], manifestHash?: string, rootName = "bun-fixture") {
  const project = await mkdtemp(join(tmpdir(), "rust-notices-project-"))
  temporaryDirectories.push(project)
  await mkdir(join(project, "third-party"), { recursive: true })
  await writeFile(join(project, "third-party/rust-notice-supplements.json"), "{}\n")
  await mkdir(join(project, "output/rust-notices-cache"), { recursive: true })
  const source = join(project, "source")
  const archiveRoot = join(source, rootName)
  await mkdir(archiveRoot, { recursive: true })
  const members: string[] = []
  for (const [index, name] of workspacePackages.entries()) {
    const member = `src/member-${index}`
    members.push(member)
    await mkdir(join(archiveRoot, member), { recursive: true })
    await writeFile(join(archiveRoot, member, "Cargo.toml"), `[package]\nname = ${JSON.stringify(name)}\nversion = "0.0.0"\n`)
  }
  await writeFile(join(archiveRoot, "Cargo.toml"), `[workspace]\nmembers = ${JSON.stringify(members)}\n\n[workspace.package]\nversion = "0.0.0"\n`)
  const lock = ["version = 4", ...packages.map(pkg => {
    const fields = [`name = ${JSON.stringify(pkg.name)}`, `version = ${JSON.stringify(pkg.version)}`]
    if (pkg.source !== undefined) fields.push(`source = ${JSON.stringify(pkg.source)}`)
    if (pkg.checksum !== undefined) fields.push(`checksum = ${JSON.stringify(pkg.checksum)}`)
    return `[[package]]\n${fields.join("\n")}`
  })].join("\n\n") + "\n"
  await writeFile(join(archiveRoot, "Cargo.lock"), lock)
  const archive = join(project, "bun-fixture-source.tar.gz")
  await makeTar(archive, source, basename(archiveRoot))
  const archiveBytes = new Uint8Array(await Bun.file(archive).arrayBuffer())
  await writeFile(
    join(project, "third-party/sources.sha256"),
    `${manifestHash ?? sha256(archiveBytes)}  ${basename(archive)}\n`,
  )
  return { project, archive }
}

async function inProject<T>(project: string, operation: () => Promise<T>) {
  const previous = process.cwd()
  process.chdir(project)
  try {
    return await operation()
  } finally {
    process.chdir(previous)
  }
}

const registry = "registry+https://github.com/rust-lang/crates.io-index"

test("inventories every registry name/version deterministically and accepts only known path packages", async () => {
  const bootstrap = await createProject([])
  const alpha2 = await createCrate(bootstrap.project, {
    name: "alpha", version: "2.0.0", license: "MIT OR Apache-2.0",
    documents: { "LICENSE-MIT": "alpha MIT text", "licenses/APACHE.txt": "alpha nested Apache text" },
  })
  const alpha1 = await createCrate(bootstrap.project, { name: "alpha", version: "1.0.0", license: "MIT" })
  const zeta = await createCrate(bootstrap.project, { name: "zeta", version: "3.0.0", license: "BSD-3-Clause", documents: { LICENSE: "zeta license text", NOTICE: "zeta notice" } })
  const fixture = await createProject([
    { name: "zeta", version: "3.0.0", source: registry, checksum: zeta.checksum },
    { name: "alpha", version: "2.0.0", source: registry, checksum: alpha2.checksum },
    { name: "alpha", version: "1.0.0", source: registry, checksum: alpha1.checksum },
    { name: "bun_internal", version: "0.0.0" },
    { name: "lol_html", version: "2.7.2" },
    { name: "rust-argon2", version: "3.0.0" },
  ])
  for (const checksum of [alpha1.checksum, alpha2.checksum, zeta.checksum]) {
    const bytes = new Uint8Array(await Bun.file(join(bootstrap.project, "output/rust-notices-cache", `${checksum}.crate`)).arrayBuffer())
    await writeFile(join(fixture.project, "output/rust-notices-cache", `${checksum}.crate`), bytes)
  }

  const first = await inProject(fixture.project, () => rustNotices(fixture.archive))
  const second = await inProject(fixture.project, () => rustNotices(fixture.archive))

  expect(second).toEqual(first)
  expect(first.crateCount).toBe(3)
  expect(first.sections).toHaveLength(3)
  expect(first.sections.map(section => section.match(/\n(alpha|zeta) ([^ ]+)/)?.slice(1))).toEqual([
    ["alpha", "1.0.0"], ["alpha", "2.0.0"], ["zeta", "3.0.0"],
  ])
  expect(first.sections[1]).toContain("MIT OR Apache-2.0")
  expect(first.sections[1]).toContain("https://static.crates.io/crates/alpha/alpha-2.0.0.crate")
  expect(first.sections[1]).toContain(`Cargo.lock SHA-256: ${alpha2.checksum}`)
  expect(first.sections[1]).toContain(`Archive SHA-256: ${alpha2.checksum}`)
  expect(first.sections[1]).toContain("licenses/APACHE.txt")
  expect(first.sections[1]).toContain("alpha nested Apache text")
  expect(first.sections[2]).toContain("zeta notice")
})

test("fails closed for a Bun source archive checksum mismatch", async () => {
  const fixture = await createProject([], [], "0".repeat(64))
  await expect(inProject(fixture.project, () => rustNotices(fixture.archive))).rejects.toThrow("Bun source checksum mismatch")
})

test("reads exact archive members whose root begins with a dash without treating them as tar options", async () => {
  const fixture = await createProject([{ name: "bun_internal", version: "0.0.0" }], ["bun_internal"], undefined, "-bun-fixture")
  const result = await inProject(fixture.project, () => rustNotices(fixture.archive))
  expect(result).toEqual({ sections: [], crateCount: 0 })
})

test("fails closed for a Cargo.lock crate checksum mismatch", async () => {
  const fixture = await createProject([])
  const crate = await createCrate(fixture.project, { name: "wrong-hash", version: "1.0.0", license: "MIT" })
  const declared = "1".repeat(64)
  await writeFile(join(fixture.project, "output/rust-notices-cache", `${declared}.crate`), crate.bytes)
  const source = await createProject([{ name: "wrong-hash", version: "1.0.0", source: registry, checksum: declared }])
  await writeFile(join(source.project, "output/rust-notices-cache", `${declared}.crate`), crate.bytes)
  await expect(inProject(source.project, () => rustNotices(source.archive))).rejects.toThrow("crate checksum mismatch")
})

test("validates crate metadata and rejects unknown path packages", async () => {
  const metadataFixture = await createProject([])
  const crate = await createCrate(metadataFixture.project, { name: "expected", metadataName: "different", version: "1.0.0", license: "MIT" })
  const metadataSource = await createProject([{ name: "expected", version: "1.0.0", source: registry, checksum: crate.checksum }])
  await writeFile(join(metadataSource.project, "output/rust-notices-cache", `${crate.checksum}.crate`), crate.bytes)
  await expect(inProject(metadataSource.project, () => rustNotices(metadataSource.archive))).rejects.toThrow("crate metadata mismatch")

  const pathSource = await createProject([{ name: "unreviewed-vendored-fork", version: "1.0.0" }])
  await expect(inProject(pathSource.project, () => rustNotices(pathSource.archive))).rejects.toThrow("unknown path package")

  const unknownSource = await createProject([{ name: "git-dependency", version: "1.0.0", source: "git+https://example.invalid/repository" }])
  await expect(inProject(unknownSource.project, () => rustNotices(unknownSource.archive))).rejects.toThrow("unknown Cargo.lock source")
})

test("fails closed when SPDX metadata or license documents are missing", async () => {
  const fixture = await createProject([])
  const noMetadata = await createCrate(fixture.project, { name: "no-metadata", version: "1.0.0", documents: { LICENSE: "text" } })
  const metadataSource = await createProject([{ name: "no-metadata", version: "1.0.0", source: registry, checksum: noMetadata.checksum }])
  await writeFile(join(metadataSource.project, "output/rust-notices-cache", `${noMetadata.checksum}.crate`), noMetadata.bytes)
  await expect(inProject(metadataSource.project, () => rustNotices(metadataSource.archive))).rejects.toThrow("missing SPDX license expression")

  const noDocument = await createCrate(fixture.project, { name: "no-document", version: "1.0.0", license: "MIT", documents: {} })
  const documentSource = await createProject([{ name: "no-document", version: "1.0.0", source: registry, checksum: noDocument.checksum }])
  await writeFile(join(documentSource.project, "output/rust-notices-cache", `${noDocument.checksum}.crate`), noDocument.bytes)
  await expect(inProject(documentSource.project, () => rustNotices(documentSource.archive))).rejects.toThrow("license/NOTICE documents missing")
})

test("does not treat an attribution-only NOTICE as the crate license", async () => {
  const fixture = await createProject([])
  const crate = await createCrate(fixture.project, {
    name: "notice-only", version: "1.0.0", license: "MIT", documents: { NOTICE: "Contributor attribution only." },
  })
  const source = await createProject([{ name: "notice-only", version: "1.0.0", source: registry, checksum: crate.checksum }])
  await writeFile(join(source.project, "output/rust-notices-cache", `${crate.checksum}.crate`), crate.bytes)
  await expect(inProject(source.project, () => rustNotices(source.archive))).rejects.toThrow("license text missing")
})

test("uses only reviewed revision- and checksum-pinned supplemental license texts", async () => {
  const fixture = await createProject([])
  const revision = "a".repeat(40)
  const crate = await createCrate(fixture.project, {
    name: "supplemented", version: "1.0.0", license: "MIT",
    documents: { ".cargo_vcs_info.json": JSON.stringify({ git: { sha1: revision } }), AUTHORS: "Synthetic copyright and permission text" },
  })
  const source = await createProject([{ name: "supplemented", version: "1.0.0", source: registry, checksum: crate.checksum }])
  await writeFile(join(source.project, "output/rust-notices-cache", `${crate.checksum}.crate`), crate.bytes)
  const text = "Synthetic supplemental license text\n"
  const url = `https://raw.githubusercontent.com/example/fixture/${revision}/LICENSE`
  const supplement = { license: "MIT", revision, archiveDocuments: ["AUTHORS"], documents: [{ url, sha256: sha256(text) }] }
  const manifest = join(source.project, "third-party/rust-notice-supplements.json")
  const writeSupplement = () => writeFile(manifest, JSON.stringify({ "supplemented@1.0.0": supplement }))
  await writeSupplement()
  const originalFetch = globalThis.fetch
  const requested: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input))
    return new Response(text)
  }) as typeof fetch
  try {
    const result = await inProject(source.project, () => rustNotices(source.archive))
    expect(result.sections[0]).toContain("Synthetic copyright and permission text")
    expect(result.sections[0]).toContain(text.trim())
    expect(result.sections[0]).toContain(url)
    expect(result.sections[0]).toContain(sha256(text))
    expect(requested).toEqual([url])

    supplement.revision = "b".repeat(40)
    await writeSupplement()
    await expect(inProject(source.project, () => rustNotices(source.archive))).rejects.toThrow("supplement revision mismatch")
    supplement.revision = revision
    supplement.license = "Apache-2.0"
    await writeSupplement()
    await expect(inProject(source.project, () => rustNotices(source.archive))).rejects.toThrow("supplement license mismatch")
    supplement.license = "MIT"
    supplement.documents[0]!.sha256 = "0".repeat(64)
    await writeSupplement()
    await expect(inProject(source.project, () => rustNotices(source.archive))).rejects.toThrow("supplement checksum mismatch")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("accepts reviewed in-archive license text without fetching and rejects a missing declared document", async () => {
  const fixture = await createProject([])
  const revision = "a".repeat(40)
  const crate = await createCrate(fixture.project, {
    name: "authors-license", version: "1.0.0", license: "MIT",
    documents: { ".cargo_vcs_info.json": JSON.stringify({ git: { sha1: revision } }), AUTHORS: "Synthetic permission text" },
  })
  const source = await createProject([{ name: "authors-license", version: "1.0.0", source: registry, checksum: crate.checksum }])
  await writeFile(join(source.project, "output/rust-notices-cache", `${crate.checksum}.crate`), crate.bytes)
  const supplement = { license: "MIT", revision, archiveDocuments: ["AUTHORS"], documents: [] }
  const manifest = join(source.project, "third-party/rust-notice-supplements.json")
  await writeFile(manifest, JSON.stringify({ "authors-license@1.0.0": supplement }))
  const result = await inProject(source.project, () => rustNotices(source.archive))
  expect(result.sections[0]).toContain("--- AUTHORS ---\n\nSynthetic permission text")
  supplement.archiveDocuments = ["MISSING"]
  await writeFile(manifest, JSON.stringify({ "authors-license@1.0.0": supplement }))
  await expect(inProject(source.project, () => rustNotices(source.archive))).rejects.toThrow("declared license file missing")
})

test("waits for started work after failure and admits no later crate", async () => {
  const crateProject = await createProject([])
  const crates = new Map<string, Awaited<ReturnType<typeof createCrate>>>()
  for (const name of ["a-fails", "b-blocked", "c-blocked", "d-blocked", "e-later"]) {
    crates.set(name, await createCrate(crateProject.project, { name, version: "1.0.0", license: "MIT" }))
  }
  const source = await createProject([...crates].map(([name, crate]) => ({
    name, version: "1.0.0", source: registry, checksum: crate.checksum,
  })))
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const requested: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
    const name = basename(url.pathname).replace(/-1\.0\.0\.crate$/, "")
    requested.push(name)
    if (name === "a-fails") return new Response("not the checksum-pinned crate")
    if (name === "e-later") throw new Error("later crate was admitted after failure")
    await blocked
    return new Response(crates.get(name)!.bytes)
  }) as typeof fetch
  let operation: Promise<Awaited<ReturnType<typeof rustNotices>>> | undefined
  try {
    let settled = false
    operation = inProject(source.project, () => rustNotices(source.archive))
    operation.then(() => { settled = true }, () => { settled = true })
    for (let attempt = 0; requested.length < 4 && attempt < 100; attempt++) await Bun.sleep(5)
    expect(requested).toEqual(["a-fails", "b-blocked", "c-blocked", "d-blocked"])
    await Bun.sleep(20)
    expect(settled).toBe(false)
    release()
    await expect(operation).rejects.toThrow("crate checksum mismatch")
    expect(requested).not.toContain("e-later")
  } finally {
    release()
    await operation?.catch(() => undefined)
    globalThis.fetch = originalFetch
  }
})
