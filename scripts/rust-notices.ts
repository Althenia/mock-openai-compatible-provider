import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

type CargoPackage = {
  name: string
  version: string
  source?: string
  checksum?: string
}

const CRATES_IO_REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"
const KNOWN_EXTERNAL_PATH_PACKAGES = new Map([
  ["lol_html", "2.7.2"],
  ["rust-argon2", "3.0.0"],
])
const SEPARATOR = "=".repeat(78)

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a TOML table`)
  return value as Record<string, unknown>
}

function string(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function safeMember(member: string, archive: string) {
  const path = member.endsWith("/") ? member.slice(0, -1) : member
  if (
    path.length === 0 || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\") ||
    /[\0\r\n]/.test(path) || path.split("/").some(part => part === "" || part === "." || part === "..")
  ) throw new Error(`unsafe archive path in ${archive}: ${JSON.stringify(member)}`)
  return path
}

async function tarBytes(archive: string, operation: string, ...members: string[]) {
  const process = Bun.spawn(["tar", operation, resolve(archive), "--", ...members], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`tar failed for ${archive}: ${stderr.trim() || `exit ${exitCode}`}`)
  return new Uint8Array(stdout)
}

async function archiveMembers(archive: string) {
  const bytes = await tarBytes(archive, "-tzf")
  let listing: string
  try {
    listing = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error(`archive member list is not UTF-8: ${archive}`, { cause: error })
  }
  const members = listing.split("\n").filter(Boolean)
  if (members.length === 0) throw new Error(`archive is empty: ${archive}`)
  for (const member of members) safeMember(member, archive)
  return members
}

async function archiveMember(archive: string, member: string) {
  safeMember(member, archive)
  return tarBytes(archive, "-xOzf", member)
}

function decodeText(bytes: Uint8Array, label: string) {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error(`${label} is not UTF-8 text`, { cause: error })
  }
  if (!text.trim() || text.includes("\0")) throw new Error(`${label} is empty or binary`)
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trimEnd()
}

async function fileSha256(path: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function verifyBunArchive(archive: string) {
  const archiveName = basename(archive)
  const manifest = await Bun.file(join(process.cwd(), "third-party/sources.sha256")).text()
  const matches = manifest.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+?)\s*$/)
    return match?.[2] === archiveName ? [match[1]!] : []
  })
  if (matches.length !== 1) throw new Error(`Bun source archive is not uniquely pinned in third-party/sources.sha256: ${archiveName}`)
  if (await fileSha256(archive) !== matches[0]) throw new Error(`Bun source checksum mismatch: ${archiveName}`)
}

function parseToml(bytes: Uint8Array, label: string) {
  const text = decodeText(bytes, label)
  try {
    return object(Bun.TOML.parse(text), label)
  } catch (error) {
    if (error instanceof Error && error.message === `${label} must be a TOML table`) throw error
    throw new Error(`invalid TOML in ${label}`, { cause: error })
  }
}

function cargoPackages(lock: Record<string, unknown>) {
  if (!Array.isArray(lock.package)) throw new Error("Cargo.lock package inventory is missing")
  const packages: CargoPackage[] = lock.package.map((value, index) => {
    const entry = object(value, `Cargo.lock package ${index}`)
    const name = string(entry.name, `Cargo.lock package ${index} name`)
    const version = string(entry.version, `Cargo.lock package ${name} version`)
    if (!/^[A-Za-z0-9_-]+$/.test(name) || !/^[A-Za-z0-9.+_-]+$/.test(version)) {
      throw new Error(`unsafe Cargo.lock package identity: ${name}@${version}`)
    }
    const source = entry.source === undefined ? undefined : string(entry.source, `Cargo.lock package ${name} source`)
    const checksum = entry.checksum === undefined ? undefined : string(entry.checksum, `Cargo.lock package ${name} checksum`)
    return { name, version, source, checksum }
  })
  const identities = new Set<string>()
  for (const pkg of packages) {
    const identity = `${pkg.name}\0${pkg.version}\0${pkg.source ?? "path"}`
    if (identities.has(identity)) throw new Error(`duplicate Cargo.lock package identity: ${pkg.name}@${pkg.version}`)
    identities.add(identity)
  }
  return packages
}

function workspaceVersion(manifest: Record<string, unknown>) {
  const workspace = object(manifest.workspace, "Bun Cargo.toml workspace")
  const workspacePackage = object(workspace.package, "Bun Cargo.toml workspace.package")
  return string(workspacePackage.version, "Bun Cargo.toml workspace.package.version")
}

function packageVersion(pkg: Record<string, unknown>, inheritedVersion: string, label: string) {
  if (typeof pkg.version === "string") return string(pkg.version, `${label} version`)
  const inherited = object(pkg.version, `${label} version`)
  if (inherited.workspace !== true) throw new Error(`${label} has unsupported inherited version metadata`)
  return inheritedVersion
}

async function bunWorkspacePackages(
  archive: string,
  root: string,
  members: string[],
  rootManifest: Record<string, unknown>,
) {
  const workspace = object(rootManifest.workspace, "Bun Cargo.toml workspace")
  if (!Array.isArray(workspace.members) || workspace.members.some(member => typeof member !== "string")) {
    throw new Error("Bun Cargo.toml workspace members are invalid")
  }
  const explicit = new Set((workspace.members as string[]).map(member => `${root}/${safeMember(member, "Bun workspace members")}/Cargo.toml`))
  const candidates = members.filter(member => {
    if (!member.endsWith("/Cargo.toml") || member === `${root}/Cargo.toml`) return false
    return explicit.has(member) || member.startsWith(`${root}/src/`)
  })
  for (const member of explicit) {
    if (!members.includes(member)) throw new Error(`Bun workspace manifest missing from source archive: ${member}`)
  }
  const inheritedVersion = workspaceVersion(rootManifest)
  const result = new Map<string, string>()
  for (const member of candidates.sort()) {
    const manifest = parseToml(await archiveMember(archive, member), member)
    const pkg = object(manifest.package, `${member} package`)
    const isExplicit = explicit.has(member)
    const inheritsWorkspaceLints = typeof manifest.lints === "object" && manifest.lints !== null &&
      !Array.isArray(manifest.lints) && (manifest.lints as Record<string, unknown>).workspace === true
    if (!isExplicit && !inheritsWorkspaceLints) continue
    const name = string(pkg.name, `${member} package name`)
    const version = packageVersion(pkg, inheritedVersion, `${member} package`)
    if (result.has(name)) throw new Error(`duplicate Bun workspace package metadata: ${name}`)
    result.set(name, version)
  }
  return result
}

function validateSources(packages: CargoPackage[], workspace: Map<string, string>) {
  const registry: CargoPackage[] = []
  for (const pkg of packages) {
    if (pkg.source === undefined) {
      if (pkg.checksum !== undefined) throw new Error(`path package unexpectedly has a checksum: ${pkg.name}@${pkg.version}`)
      const workspacePackage = workspace.get(pkg.name)
      const knownExternal = KNOWN_EXTERNAL_PATH_PACKAGES.get(pkg.name)
      if (workspacePackage !== pkg.version && knownExternal !== pkg.version) {
        throw new Error(`unknown path package in Cargo.lock: ${pkg.name}@${pkg.version}`)
      }
      continue
    }
    if (pkg.source !== CRATES_IO_REGISTRY) throw new Error(`unknown Cargo.lock source for ${pkg.name}@${pkg.version}: ${pkg.source}`)
    if (pkg.checksum === undefined || !/^[a-f0-9]{64}$/.test(pkg.checksum)) {
      throw new Error(`invalid crates.io checksum for ${pkg.name}@${pkg.version}`)
    }
    registry.push(pkg)
  }
  return registry.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 :
      left.version < right.version ? -1 : left.version > right.version ? 1 : 0)
}

function crateUrl(pkg: CargoPackage) {
  return `https://static.crates.io/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(`${pkg.name}-${pkg.version}.crate`)}`
}

function transient(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

async function downloadCrate(pkg: CargoPackage) {
  const url = crateUrl(pkg)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (response.ok) return new Uint8Array(await response.arrayBuffer())
      if (attempt === 0 && transient(response.status)) continue
      throw new Error(`crate download returned ${response.status}: ${url}`)
    } catch (error) {
      if (attempt === 0 && (error instanceof TypeError || error instanceof DOMException && error.name === "TimeoutError")) continue
      if (error instanceof Error && error.message.startsWith("crate download returned")) throw error
      throw new Error(`crate download failed: ${url}`, { cause: error })
    }
  }
  throw new Error(`crate download failed after retry: ${url}`)
}

async function verifiedCrate(pkg: CargoPackage) {
  const checksum = pkg.checksum!
  const cache = join(process.cwd(), "output/rust-notices-cache")
  const path = join(cache, `${checksum}.crate`)
  const cached = Bun.file(path)
  let bytes: Uint8Array
  if (await cached.exists()) {
    bytes = new Uint8Array(await cached.arrayBuffer())
  } else {
    bytes = await downloadCrate(pkg)
  }
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== checksum) throw new Error(`crate checksum mismatch for ${pkg.name}@${pkg.version}: expected ${checksum}, got ${actual}`)
  if (!await cached.exists()) {
    await mkdir(cache, { recursive: true })
    const temporary = join(cache, `.${checksum}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, bytes, { flag: "wx" })
      await rename(temporary, path)
    } finally {
      try { await unlink(temporary) } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      }
    }
  }
  return { actual }
}

function licenseDocument(relative: string) {
  const parts = relative.split("/")
  const file = parts.at(-1)!
  return /^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/i.test(file) || /^unlicense$/i.test(file) ||
    parts.slice(0, -1).some(part => /^licenses?$/i.test(part))
}

function licenseTextDocument(relative: string) {
  const file = relative.split("/").at(-1)!
  return /^(?:licen[cs]e|copying)(?:$|[._-])/i.test(file) || /^unlicense$/i.test(file) ||
    relative.split("/").slice(0, -1).some(part => /^licenses?$/i.test(part)) && !/^(?:notices?|copyright)(?:$|[._-])/i.test(file)
}

async function crateSection(pkg: CargoPackage, supplements: Record<string, unknown>) {
  const { actual } = await verifiedCrate(pkg)
  const archive = join(process.cwd(), "output/rust-notices-cache", `${pkg.checksum}.crate`)
  const members = await archiveMembers(archive)
  const root = `${pkg.name}-${pkg.version}`
  for (const member of members) {
    const path = safeMember(member, archive)
    if (path !== root && !path.startsWith(`${root}/`)) throw new Error(`unexpected crate archive root for ${pkg.name}@${pkg.version}: ${member}`)
  }
  const manifestMember = `${root}/Cargo.toml`
  if (!members.includes(manifestMember)) throw new Error(`crate Cargo.toml missing for ${pkg.name}@${pkg.version}`)
  const manifest = parseToml(await archiveMember(archive, manifestMember), manifestMember)
  const metadata = object(manifest.package, `${manifestMember} package`)
  if (metadata.name !== pkg.name || metadata.version !== pkg.version) {
    throw new Error(`crate metadata mismatch for ${pkg.name}@${pkg.version}`)
  }
  const license = typeof metadata.license === "string" ? metadata.license.trim() : ""
  if (!license) throw new Error(`missing SPDX license expression for ${pkg.name}@${pkg.version}`)
  const documentMembers = new Set(members.filter(member => {
    if (member.endsWith("/") || !member.startsWith(`${root}/`)) return false
    return licenseDocument(member.slice(root.length + 1))
  }))
  if (typeof metadata["license-file"] === "string") {
    const licenseFile = safeMember(metadata["license-file"], `${manifestMember} license-file`)
    documentMembers.add(`${root}/${licenseFile}`)
  }
  const documents: string[] = []
  const supplementValue = supplements[`${pkg.name}@${pkg.version}`]
  let supplementalLicense = false
  if (supplementValue !== undefined) {
    const supplement = object(supplementValue, "Rust notice supplement")
    if (supplement.license !== license) throw new Error(`supplement license mismatch for ${pkg.name}@${pkg.version}`)
    const vcs = object(JSON.parse(decodeText(await archiveMember(archive, `${root}/.cargo_vcs_info.json`), "crate VCS metadata")), "crate VCS metadata")
    const revision = string(supplement.revision, "supplement revision")
    if (!/^[a-f0-9]{40}$/.test(revision) || object(vcs.git, "crate VCS git").sha1 !== revision) {
      throw new Error(`supplement revision mismatch for ${pkg.name}@${pkg.version}`)
    }
    if (!Array.isArray(supplement.archiveDocuments) || !Array.isArray(supplement.documents)) {
      throw new Error("supplement documents must be arrays")
    }
    for (const path of supplement.archiveDocuments) {
      documentMembers.add(`${root}/${safeMember(string(path, "supplement archive document"), "supplement archive document")}`)
      supplementalLicense = true
    }
    for (const value of supplement.documents) {
      const document = object(value, "supplement document")
      const url = string(document.url, "supplement URL")
      const parsed = new URL(url)
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("supplement URL must be public HTTPS")
      const checksum = string(document.sha256, "supplement SHA-256")
      if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("invalid supplement SHA-256")
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`supplement download returned ${response.status}: ${url}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (createHash("sha256").update(bytes).digest("hex") !== checksum) {
        throw new Error(`supplement checksum mismatch for ${pkg.name}@${pkg.version}: ${url}`)
      }
      documents.push(`--- ${url} ---\nSHA-256: ${checksum}\n\n${decodeText(bytes, url)}`)
      supplementalLicense = true
    }
  }
  for (const member of [...documentMembers].sort()) {
    if (!members.includes(member)) throw new Error(`declared license file missing for ${pkg.name}@${pkg.version}: ${member}`)
    const relative = member.slice(root.length + 1)
    const text = decodeText(await archiveMember(archive, member), `${pkg.name}@${pkg.version} ${relative}`)
    documents.push(`--- ${relative} ---\n\n${text}`)
  }
  if (documents.length === 0) throw new Error(`license/NOTICE documents missing for ${pkg.name}@${pkg.version}`)
  if (!supplementalLicense && ![...documentMembers].some(member => licenseTextDocument(member.slice(root.length + 1))) && typeof metadata["license-file"] !== "string") {
    throw new Error(`license text missing for ${pkg.name}@${pkg.version}`)
  }
  const url = crateUrl(pkg)
  return `\n${SEPARATOR}\n${pkg.name} ${pkg.version} — ${license}\nSource: ${url}\nCargo.lock SHA-256: ${pkg.checksum}\nArchive SHA-256: ${actual}\n\n${documents.join("\n\n")}\n`
}

/**
 * Inventories all crates.io packages pinned by the verified Bun source archive's root Cargo.lock.
 */
export async function rustNotices(bunArchive: string): Promise<{ sections: string[]; crateCount: number }> {
  await verifyBunArchive(bunArchive)
  const supplements = object(await Bun.file(join(process.cwd(), "third-party/rust-notice-supplements.json")).json(), "Rust notice supplements")
  const members = await archiveMembers(bunArchive)
  const lockMembers = members.filter(member => {
    const path = safeMember(member, bunArchive)
    return path.split("/").length === 2 && path.endsWith("/Cargo.lock")
  })
  if (lockMembers.length !== 1) throw new Error(`expected exactly one root Cargo.lock in Bun source archive, found ${lockMembers.length}`)
  const lockMember = lockMembers[0]!
  const root = lockMember.slice(0, -"/Cargo.lock".length)
  const rootManifestMember = `${root}/Cargo.toml`
  if (!members.includes(rootManifestMember)) throw new Error("Bun root Cargo.toml missing from source archive")
  const lock = parseToml(await archiveMember(bunArchive, lockMember), lockMember)
  const rootManifest = parseToml(await archiveMember(bunArchive, rootManifestMember), rootManifestMember)
  const workspace = await bunWorkspacePackages(bunArchive, root, members, rootManifest)
  const registry = validateSources(cargoPackages(lock), workspace)
  const sections = new Array<string>(registry.length)
  let next = 0
  let failure: unknown
  const worker = async () => {
    while (failure === undefined) {
      const index = next++
      if (index >= registry.length) return
      try {
        sections[index] = await crateSection(registry[index]!, supplements)
      } catch (error) {
        failure ??= error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, registry.length) }, worker))
  if (failure !== undefined) throw failure
  return { sections, crateCount: registry.length }
}
