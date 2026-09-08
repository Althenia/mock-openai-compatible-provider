import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { runCLI } from "./cli.ts"
import { pathsFromRoot } from "./config.ts"
import { ProfileLock } from "./state.ts"

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "aipass-update-"))
  temporary.push(home)
  const bin = join(home, "bin")
  const install = join(home, ".local/bin")
  const state = join(home, "state")
  await Promise.all([mkdir(bin), mkdir(install, { recursive: true }), mkdir(state)])
  const asset = '#!/bin/sh\nprintf "0.2.0\\n"\n'
  await writeFile(join(home, "asset"), asset)
  const digest = createHash("sha256").update(asset).digest("hex")
  await writeFile(join(home, "metadata"), JSON.stringify({ tag_name: "v0.2.0", assets: [{ name: "aipass-browser-provider-darwin-arm64", state: "uploaded", digest: `sha256:${digest}` }] }))
  await writeFile(join(bin, "curl"), `#!/bin/sh
set -eu
test -s "$AIPASS_STATE_ROOT/profile.lock"
printf 'request\\n' >> "$HOME/requests"
[ "\${FAIL_DOWNLOAD:-0}" != 1 ] || exit 22
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  */releases/latest) printf 'https://github.com/Althenia/mock-openai-compatible-provider/releases/tag/v0.2.0' ;;
  */releases/tags/v0.2.0) cp "$HOME/metadata" "$output" ;;
  */releases/download/v0.2.0/aipass-browser-provider-darwin-arm64) cp "$HOME/asset" "$output" ;;
  *) exit 22 ;;
esac
`)
  await chmod(join(bin, "curl"), 0o700)
  await writeFile(join(install, "aipass-browser-provider"), "old executable")
  await writeFile(join(state, "credential"), "synthetic credential")
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: home, AIPASS_STATE_ROOT: state, AIPASS_BROWSER_EXECUTABLE: "/missing-chrome", AIPASS_PORT: "invalid" }
  const output: string[] = [], errors: string[] = []
  const io = { out: (text: string) => output.push(text), error: (text: string) => errors.push(text) }
  return { home, install, state, env, output, errors, io, asset }
}

test("update installs latest through verified installer and preserves credentials", async () => {
  const f = await fixture()
  expect(await runCLI(["update"], f.env, f.io)).toBe(0)
  const target = join(f.install, "aipass-browser-provider")
  expect(await readFile(target, "utf8")).toBe(f.asset)
  expect((await stat(target)).mode & 0o777).toBe(0o700)
  expect(await readFile(join(f.state, "credential"), "utf8")).toBe("synthetic credential")
  expect(await readdir(f.state)).toEqual(["credential"])
  expect(f.output.join("\n")).toContain("Installed AIPass browser provider v0.2.0")
  expect(f.errors).toEqual([])
})

test("update accepts a pinned version and a literal install directory, then is idempotent", async () => {
  const f = await fixture()
  const target = join(f.home, "custom path $(touch SHOULD_NOT_EXIST)")
  const args = ["update", "--version", "0.2.0", "--install-dir", target]
  expect(await runCLI(args, f.env, f.io)).toBe(0)
  expect(await readFile(join(target, "aipass-browser-provider"), "utf8")).toBe(f.asset)
  expect(await readFile(join(f.install, "aipass-browser-provider"), "utf8")).toBe("old executable")
  expect(await runCLI(args, f.env, f.io)).toBe(0)
  expect(f.output.join("\n")).toContain("already installed")
  expect(await Bun.file("SHOULD_NOT_EXIST").exists()).toBe(false)
})

for (const failure of ["download", "checksum", "metadata", "executable"] as const) test(`update preserves the installed binary on ${failure} failure`, async () => {
  const f = await fixture()
  if (failure === "checksum") await writeFile(join(f.home, "asset"), "tampered")
  if (failure === "metadata") await writeFile(join(f.home, "metadata"), "{}")
  if (failure === "executable") {
    const asset = "#!/bin/sh\nexit 1\n"
    await writeFile(join(f.home, "asset"), asset)
    await writeFile(join(f.home, "metadata"), JSON.stringify({ tag_name: "v0.2.0", assets: [{ name: "aipass-browser-provider-darwin-arm64", state: "uploaded", digest: `sha256:${createHash("sha256").update(asset).digest("hex")}` }] }))
  }
  expect(await runCLI(["update"], { ...f.env, FAIL_DOWNLOAD: failure === "download" ? "1" : "0" }, f.io)).toBe(1)
  expect(await readFile(join(f.install, "aipass-browser-provider"), "utf8")).toBe("old executable")
  expect(f.errors.join("\n")).toContain(failure === "checksum" ? "checksum verification failed" : failure === "executable" ? "help check" : failure === "metadata" ? "invalid release metadata" : "could not resolve")
  expect(f.output.join("\n")).not.toContain("Installed AIPass")
  expect(await readdir(f.state)).toEqual(["credential"])
})

test("update refuses an active profile before downloading and retains its lock", async () => {
  const f = await fixture()
  const lock = await ProfileLock.acquire(pathsFromRoot(f.state))
  try {
    const before = await readFile(join(f.state, "profile.lock"), "utf8")
    expect(await runCLI(["update"], f.env, f.io)).toBe(1)
    expect(f.errors.join("\n")).toContain("cannot update: stop the provider")
    expect(await Bun.file(join(f.home, "requests")).exists()).toBe(false)
    expect(await readFile(join(f.state, "profile.lock"), "utf8")).toBe(before)
  } finally { await lock.release() }
})

test("update rejects invalid arguments without download or state writes", async () => {
  const f = await fixture()
  for (const args of [["--version"], ["--version", "latest"], ["--version", "0.2.0; echo bad"], ["--install-dir"], ["--port", "1234"], ["--unknown", "x"]]) {
    expect(await runCLI(["update", ...args], f.env, f.io)).toBe(1)
  }
  expect(await Bun.file(join(f.home, "requests")).exists()).toBe(false)
  expect(await readdir(f.state)).toEqual(["credential"])
})

test("update honors install environment and refuses symlink destinations", async () => {
  const f = await fixture()
  const install = join(f.home, "custom")
  await mkdir(install)
  const original = join(f.install, "aipass-browser-provider")
  await symlink(original, join(install, "aipass-browser-provider"))
  expect(await runCLI(["update", "--version", "v0.2.0"], { ...f.env, AIPASS_INSTALL_DIR: install }, f.io)).toBe(1)
  expect(f.errors.join("\n")).toContain("not a regular file")
  expect(await readFile(original, "utf8")).toBe("old executable")
})
