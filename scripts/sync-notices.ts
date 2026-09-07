// Owner of LICENSE and THIRD_PARTY_NOTICES. Fetches upstream text; never executes it.
import { readFile } from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createHash } from "node:crypto"
import { version } from "../package.json"

const bunRef = "bun-v1.4.0"
const webkitRef = "autobuild-0f966e81b78c84bb23213e391bc679c4ef83e56b"
const raw = (repo: string, ref: string, path: string) => `https://raw.githubusercontent.com/${repo}/${ref}/${path}`
const archiveOption = process.argv.indexOf("--webkit-source")
const webkitArchive = archiveOption >= 0 ? process.argv[archiveOption + 1] : undefined
if (!webkitArchive || webkitArchive.startsWith("--"))
  throw new Error("supply --webkit-source PATH to the accompanying WebKit source archive")
const archiveHash = createHash("sha256")
for await (const chunk of createReadStream(webkitArchive)) archiveHash.update(chunk)
const expectedArchiveHash = (await Bun.file("third-party/sources.sha256").text())
  .split("\n").find((line) => line.endsWith("  webkit-0f966e81-source.tar.gz"))?.split(" ")[0]
if (archiveHash.digest("hex") !== expectedArchiveHash) throw new Error("WebKit source checksum mismatch")
const documents: [string, string, "header"?][] = [
  ["Bun 1.4.0 — upstream runtime and embedded-component notice", raw("oven-sh/bun", bunRef, "LICENSE.md")],
  ["Bun uWebSockets/uSockets", raw("oven-sh/bun", bunRef, "packages/bun-uws/LICENSE")],
  ["Bun clap", raw("oven-sh/bun", bunRef, "src/clap/LICENSE")],
  ["JavaScriptCore library license", raw("oven-sh/WebKit", webkitRef, "Source/JavaScriptCore/COPYING.LIB")],
  ["JavaScriptCore ARM64 disassembler", raw("oven-sh/WebKit", webkitRef, "Source/JavaScriptCore/disassembler/ARM64/LICENSE-binja.txt")],
  ["JavaScriptCore Zycore", raw("oven-sh/WebKit", webkitRef, "Source/JavaScriptCore/disassembler/zydis/LICENSE-zycore.txt")],
  ["JavaScriptCore Zydis", raw("oven-sh/WebKit", webkitRef, "Source/JavaScriptCore/disassembler/zydis/LICENSE-zydis.txt")],
  ["JavaScriptCore Temporal ICU4X portions", raw("oven-sh/WebKit", webkitRef, "Source/JavaScriptCore/runtime/temporal/core/LICENSE-icu4x.txt")],
  ["JavaScriptCore Temporal temporal_rs portions", raw("oven-sh/WebKit", webkitRef, "Source/JavaScriptCore/runtime/temporal/core/LICENSE-temporal_rs.txt")],
  ["WebKit LLVM portions", raw("oven-sh/WebKit", webkitRef, "Source/WTF/LICENSE-LLVM.txt")],
  ["WebKit Dragonbox", raw("oven-sh/WebKit", webkitRef, "Source/WTF/LICENSE-dragonbox.txt")],
  ["WebKit libc++ portions", raw("oven-sh/WebKit", webkitRef, "Source/WTF/LICENSE-libc++.txt")],
  ["WebKit SIMDe", raw("oven-sh/WebKit", webkitRef, "Source/WTF/LICENSE-simde.txt")],
  ["WebKit ICU", raw("oven-sh/WebKit", webkitRef, "Source/WTF/icu/LICENSE")],
  ["WebKit dtoa — COPYING", raw("oven-sh/WebKit", webkitRef, "Source/WTF/wtf/dtoa/COPYING")],
  ["WebKit dtoa — LICENSE", raw("oven-sh/WebKit", webkitRef, "Source/WTF/wtf/dtoa/LICENSE")],
  ["WebKit fast_float", raw("oven-sh/WebKit", webkitRef, "Source/WTF/wtf/fast_float/LICENSE")],
  ["WebKit simdutf", raw("oven-sh/WebKit", webkitRef, "Source/WTF/wtf/simdutf/LICENSE-simdutf.txt")],
  ["WebKit bmalloc mimalloc", raw("oven-sh/WebKit", webkitRef, "Source/bmalloc/mimalloc/mimalloc/LICENSE")],
  ["BoringSSL", raw("oven-sh/boringssl", "2288897e2e716330490893d226b4f079f9da9e0c", "LICENSE")],
  ["Brotli 1.1.0", raw("google/brotli", "v1.1.0", "LICENSE")],
  ["c-ares", raw("c-ares/c-ares", "c7a3138dcfe3bb0eaaf10c0c24c36dc66dc790ab", "LICENSE.md")],
  ["HdrHistogram", raw("HdrHistogram/HdrHistogram_c", "be60a9987ee48d0abf0d7b6a175bad8d6c1585d1", "COPYING.txt")],
  ["Highway", raw("google/highway", "2607d3b5b0113992fe84d3848859eae13b3b52c1", "LICENSE")],
  ["libarchive", raw("libarchive/libarchive", "ded82291ab41d5e355831b96b0e1ff49e24d8939", "COPYING")],
  ["libdeflate", raw("ebiggers/libdeflate", "c8c56a20f8f621e6a966b716b31f1dedab6a41e3", "COPYING")],
  ["libjpeg-turbo", raw("libjpeg-turbo/libjpeg-turbo", "e352b02f794f701407b39af08576035ba3360d60", "LICENSE.md")],
  ["Independent JPEG Group", raw("libjpeg-turbo/libjpeg-turbo", "e352b02f794f701407b39af08576035ba3360d60", "README.ijg")],
  ["libspng", raw("randy408/libspng", "fb768002d4288590083a476af628e51c3f1d47cd", "LICENSE")],
  ["libwebp 1.6.0", raw("webmproject/libwebp", "v1.6.0", "COPYING")],
  ["libwebp patents", raw("webmproject/libwebp", "v1.6.0", "PATENTS")],
  ["lol-html", raw("oven-sh/lol-html", "725ce499aa9b71e38b7a2d0a9fbb6d7294a4079e", "LICENSE")],
  ["ls-hpack", raw("litespeedtech/ls-hpack", "8905c024b6d052f083a3d11d0a169b3c2735c8a1", "LICENSE")],
  ["ls-qpack", raw("litespeedtech/ls-qpack", "1e9c5b8e59f8161c54f168a570c8bfdc59ded0c3", "LICENSE")],
  ["lsquic", raw("litespeedtech/lsquic", "3181911301b1aa4f54c1ed690901abc674ee08fb", "LICENSE")],
  ["lsquic Chromium portions", raw("litespeedtech/lsquic", "3181911301b1aa4f54c1ed690901abc674ee08fb", "LICENSE.chrome")],
  ["mimalloc", raw("oven-sh/mimalloc", "6a14aee24315e503fa295a1fa90fe8b24ad91774", "LICENSE")],
  ["picohttpparser", raw("h2o/picohttpparser", "066d2b1e9ab820703db0837a7255d92d30f0c9f5", "picohttpparser.h"), "header"],
  ["rust-argon2 3.0.0 — Apache license", raw("sru-systems/rust-argon2", "ed81866f163f0c7026aa6fd8388adf37242eb32a", "LICENSE-APACHE")],
  ["rust-argon2 3.0.0 — MIT license", raw("sru-systems/rust-argon2", "ed81866f163f0c7026aa6fd8388adf37242eb32a", "LICENSE-MIT")],
  ["TinyCC (LGPL 2.1)", raw("oven-sh/tinycc", "05f0fafaa3be31e31d7b4b5c17dc60f62c991171", "COPYING")],
  ["zlib-ng", raw("zlib-ng/zlib-ng", "12731092979c6d07f42da27da673a9f6c7b13586", "LICENSE.md")],
  ["Zstandard (BSD option)", raw("facebook/zstd", "f8745da6ff1ad1e7bab384bd1f9d742439278e99", "LICENSE")],
  ["GNU Library GPL 2.0 (WebKit components)", "https://www.gnu.org/licenses/old-licenses/lgpl-2.0.txt"],
  ["GNU Lesser GPL 2.1 (WebKit and TinyCC components)", "https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt"],
]

async function text(url: string) {
  const prefix = raw("oven-sh/WebKit", webkitRef, "")
  if (url.startsWith(prefix)) {
    const path = `webkit-${webkitRef.slice("autobuild-".length)}/${url.slice(prefix.length)}`
    const result = Bun.spawnSync(["tar", "-xOf", webkitArchive!, path])
    if (result.exitCode !== 0 || result.stdout.length === 0) throw new Error(`source notice missing: ${path}`)
    return result.stdout.toString()
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`upstream notice returned ${response.status}: ${url}`)
  const value = await response.text()
  if (!value.trim() || /<!doctype html>/i.test(value)) throw new Error(`invalid notice: ${url}`)
  return value
}

const license = await text("https://www.gnu.org/licenses/agpl-3.0.txt")
const sections = [
  `AIPassport v${version} — third-party notices\n\n` +
  "The project is AGPL-3.0-only. Third-party components retain their own licenses.\n" +
  "The macOS arm64 executable embeds Bun 1.4.0 and playwright-core 1.62.1.\n" +
  "Chrome is installed separately and is not redistributed.\n\n" +
  "Bun statically links LGPL components. See SOURCE.md and the accompanying source\n" +
  "archives for exact source revisions, Bun's patches, and rebuilding/relinking.\n" +
  "Source-file copyright notices in those archives are also retained.\n" +
  "Keep LICENSE, this file, SOURCE.md, and source access with redistributions.\n\n" +
  "Generated by scripts/sync-notices.ts from the sources identified below.\n" +
  "Line endings and trailing whitespace are normalized; license wording is unchanged.\n",
]
for (const [name, url, mode] of documents) {
  let value = await text(url)
  if (mode === "header") {
    const header = value.match(/^\s*\/\*[\s\S]*?\*\//)?.[0]
    if (!header?.includes("Copyright")) throw new Error(`copyright header missing: ${url}`)
    value = header
  }
  sections.push(`\n${"=".repeat(78)}\n${name}\nSource: ${url}\n\n${value.trimEnd()}\n`)
}
const playwright = await Bun.file("node_modules/playwright-core/package.json").json()
if (playwright.version !== "1.62.1") throw new Error("review notices before changing playwright-core")
for (const name of ["LICENSE", "NOTICE", "ThirdPartyNotices.txt"]) {
  const path = `node_modules/playwright-core/${name}`
  sections.push(`\n${"=".repeat(78)}\nplaywright-core 1.62.1 — ${name}\nSource: ${path}\n\n${(await readFile(path, "utf8")).trimEnd()}\n`)
}
const notices = sections.join("").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "")
if (process.argv.includes("--check")) {
  if (await Bun.file("LICENSE").text() !== license || await Bun.file("THIRD_PARTY_NOTICES").text() !== notices)
    throw new Error("redistribution text differs from its declared upstream sources")
} else {
  await Bun.write("LICENSE", license)
  await Bun.write("THIRD_PARTY_NOTICES", notices)
}
console.log(`Verified project license and ${documents.length + 3} upstream notice documents`)
