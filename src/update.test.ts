import { afterEach, expect, spyOn, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { runCLI, type CLIDependencies } from "./cli.ts"
import { pathsFromRoot } from "./config.ts"
import { ProfileLock } from "./state.ts"

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

function nativeAccountHome() {
  const result = Bun.spawnSync(["/usr/bin/dscacheutil", "-q", "user", "-a", "uid", String(process.getuid!())], {
    env: {}, stdout: "pipe", stderr: "pipe", timeout: 2_000,
  })
  expect(result.exitCode).toBe(0)
  const home = result.stdout.toString().split(/\r?\n/).find((line) => line.startsWith("dir: "))?.slice(5)
  expect(home).toStartWith("/")
  return home!
}

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
test -s "$AIPASS_FIXTURE_STATE_ROOT/profile.lock"
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
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: home, AIPASS_FIXTURE_STATE_ROOT: state }
  const output: string[] = [], errors: string[] = []
  const io = { out: (text: string) => output.push(text), error: (text: string) => errors.push(text) }
  return { home, install, state, env, output, errors, io, asset }
}

function dependencies(installerEnvironment: Record<string, string | undefined>): CLIDependencies {
  return { installerEnvironment }
}

test("update installs latest through verified installer and preserves credentials", async () => {
  const f = await fixture()
  expect(await runCLI(["update", "--state-root", f.state, "--install-dir", f.install], f.io, dependencies(f.env))).toBe(0)
  const target = join(f.install, "aipass-browser-provider")
  expect(await readFile(target, "utf8")).toBe(f.asset)
  expect((await stat(target)).mode & 0o777).toBe(0o700)
  expect(await readFile(join(f.state, "credential"), "utf8")).toBe("synthetic credential")
  expect(await readdir(f.state)).toEqual(["credential"])
  expect(f.output.join("\n")).toContain("Installed AIPass browser provider v0.2.0")
  expect(f.errors).toEqual([])
})

test("a removed installer environment setting cannot redirect an explicit provider destination", async () => {
  const f = await fixture()
  const redirected = join(f.home, "removed-env-target")
  expect(await runCLI(["update", "--state-root", f.state, "--install-dir", f.install], f.io, {
    installerEnvironment: { ...f.env, AIPASS_INSTALL_DIR: redirected },
  })).toBe(0)
  expect(await readFile(join(f.install, "aipass-browser-provider"), "utf8")).toBe(f.asset)
  expect(await Bun.file(join(redirected, "aipass-browser-provider")).exists()).toBe(false)
})

test("update uses the selected file's state and install directories", async () => {
  const f = await fixture()
  const target = join(f.home, "file-install")
  const config = join(f.home, "provider.json")
  await writeFile(config, JSON.stringify({
    version: 1,
    host: "127.0.0.1",
    stateRoot: f.state,
    installDir: target,
  }))
  expect(await runCLI(["update", "--config", config], f.io, dependencies(f.env))).toBe(0)
  expect(await readFile(join(target, "aipass-browser-provider"), "utf8")).toBe(f.asset)
})

test("source update resolves a custom config without installDir before the installer handoff", async () => {
  const f = await fixture()
  const config = join(f.home, "custom-without-install.json")
  await writeFile(config, JSON.stringify({ version: 1, host: "127.0.0.1", stateRoot: f.state }))
  let captured: readonly string[] = []
  const spawn = spyOn(Bun, "spawn").mockImplementation(((args: readonly string[]) => {
    captured = args
    return {
      exited: Promise.resolve(0),
      stdout: new Response("").body!,
      stderr: new Response("").body!,
    }
  }) as never)
  try {
    expect(await runCLI(["update", "--config", config], f.io, {
      installerEnvironment: {
        ...f.env,
        HOME: join(f.home, "spoofed-home-with-conflicting-default"),
        XDG_CONFIG_HOME: join(f.home, "spoofed-config-with-conflicting-default"),
      },
      spawnInstaller: spawn as never,
    })).toBe(0)
  } finally { spawn.mockRestore() }
  expect(captured).toContain("--install-dir")
  expect(captured[captured.indexOf("--install-dir") + 1]).toBe(join(nativeAccountHome(), ".local/bin"))
  expect(captured).not.toContain("--config")
})

test("update accepts a pinned version and a literal install directory, then is idempotent", async () => {
  const f = await fixture()
  const target = join(f.home, "custom path $(touch SHOULD_NOT_EXIST)")
  const args = ["update", "--version", "0.2.0", "--install-dir", target, "--state-root", f.state]
  expect(await runCLI(args, f.io, dependencies(f.env))).toBe(0)
  expect(await readFile(join(target, "aipass-browser-provider"), "utf8")).toBe(f.asset)
  expect(await readFile(join(f.install, "aipass-browser-provider"), "utf8")).toBe("old executable")
  expect(await runCLI(args, f.io, dependencies(f.env))).toBe(0)
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
  expect(await runCLI(["update", "--state-root", f.state], f.io, dependencies({ ...f.env, FAIL_DOWNLOAD: failure === "download" ? "1" : "0" }))).toBe(1)
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
    expect(await runCLI(["update", "--state-root", f.state], f.io, dependencies(f.env))).toBe(1)
    expect(f.errors.join("\n")).toContain("cannot update: stop the provider")
    expect(await Bun.file(join(f.home, "requests")).exists()).toBe(false)
    expect(await readFile(join(f.state, "profile.lock"), "utf8")).toBe(before)
  } finally { await lock.release() }
})

test("update rejects invalid arguments without download or state writes", async () => {
  const f = await fixture()
  for (const args of [["--version"], ["--version", "latest"], ["--version", "0.2.0; echo bad"], ["--install-dir"], ["--port", "1234"], ["--unknown", "x"]]) {
    expect(await runCLI(["update", ...args], f.io, dependencies(f.env))).toBe(1)
  }
  expect(await Bun.file(join(f.home, "requests")).exists()).toBe(false)
  expect(await readdir(f.state)).toEqual(["credential"])
})

test("update honors explicit install directory and refuses symlink destinations", async () => {
  const f = await fixture()
  const install = join(f.home, "custom")
  await mkdir(install)
  const original = join(f.install, "aipass-browser-provider")
  await symlink(original, join(install, "aipass-browser-provider"))
  expect(await runCLI(["update", "--version", "v0.2.0", "--install-dir", install, "--state-root", f.state], f.io, dependencies(f.env))).toBe(1)
  expect(f.errors.join("\n")).toContain("not a regular file")
  expect(await readFile(original, "utf8")).toBe("old executable")
})
