import { describe, expect, test } from "bun:test"
import { DEFAULT_CHAT_URL, parseCommand, usage } from "./config.ts"

function nativeAccountHome() {
  const result = Bun.spawnSync(["/usr/bin/dscacheutil", "-q", "user", "-a", "uid", String(process.getuid!())], {
    env: {},
    stdout: "pipe",
    stderr: "pipe",
    timeout: 2_000,
  })
  expect(result.exitCode).toBe(0)
  const homes = result.stdout.toString().split(/\r?\n/).flatMap((line) => line.startsWith("dir: ") ? [line.slice(5)] : [])
  expect(homes).toHaveLength(1)
  expect(homes[0]).toStartWith("/")
  return homes[0]!
}

test("fresh parsing ignores HOME, XDG, and former AIPASS settings for native-account defaults", async () => {
  const spoof = "/tmp/aipass-spoofed-home"
  const source = `
    import { parseCommand } from ${JSON.stringify(new URL("./config.ts", import.meta.url).href)};
    const command = parseCommand(["endpoint"]);
    if (command.type !== "endpoint") throw new Error("expected endpoint");
    console.log(JSON.stringify({
      configPath: command.settings.configPath,
      stateRoot: command.settings.paths.root,
      chatURL: command.settings.chatURL,
      chromeExecutable: command.settings.chromeExecutable,
      navigationTimeoutMs: command.settings.navigationTimeoutMs,
      streamIdleTimeoutMs: command.settings.streamIdleTimeoutMs,
      streamURLPattern: command.settings.streamURLPattern,
      browserHeaded: command.settings.browserHeaded,
      screenshotDir: command.settings.screenshotDir,
      installDir: command.settings.installDir,
    }));
  `
  const child = Bun.spawn([process.execPath, "--eval", source], {
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      HOME: spoof,
      XDG_CONFIG_HOME: "/tmp/aipass-spoofed-config",
      XDG_STATE_HOME: "/tmp/aipass-spoofed-state",
      AIPASS_CONFIG_PATH: "/tmp/aipass-attacker-config.json",
      AIPASS_STATE_ROOT: "/tmp/aipass-attacker-state",
      AIPASS_PORT: "invalid",
      AIPASS_BROWSER_EXECUTABLE: "/tmp/aipass-attacker-chrome",
      AIPASS_CHAT_URL: "https://attacker.invalid/chat",
      AIPASS_NAVIGATION_TIMEOUT_MS: "1",
      AIPASS_STREAM_IDLE_TIMEOUT_MS: "2",
      AIPASS_STREAM_URL_PATTERN: "/attacker/stream",
      AIPASS_BROWSER_HEADED: "0",
      AIPASS_SCREENSHOT_DIR: "/tmp/aipass-attacker-shots",
      AIPASS_INSTALL_DIR: "/tmp/aipass-attacker-bin",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(exit, stderr).toBe(0)
  const defaults = JSON.parse(stdout) as Record<string, unknown>
  const home = nativeAccountHome()
  expect(defaults).toEqual({
    configPath: `${home}/.config/aipass-browser-provider/config.json`,
    stateRoot: `${home}/.local/state/aipass-browser-provider`,
    chatURL: DEFAULT_CHAT_URL,
    chromeExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    navigationTimeoutMs: 90_000,
    streamIdleTimeoutMs: 120_000,
    browserHeaded: true,
  })
})

describe("chat URL configuration", () => {
  test("uses the temporary-chat URL default and ignores former runtime environment overrides", () => {
    const defaults = parseCommand(["endpoint"])
    expect(DEFAULT_CHAT_URL).toBe("https://de.aipass.net/chat?temporary-chat=true")
    expect(defaults.type).toBe("endpoint")
    if (defaults.type !== "endpoint") throw new Error("expected endpoint")
    expect(defaults.settings.chatURL).toBe(DEFAULT_CHAT_URL)

  })
})
test("update accepts version and explicit shared state settings without checking Chrome", () => {
  const command = parseCommand(["update", "--version", "v0.2.0", "--install-dir", "/tmp/custom", "--state-root", "/tmp/state", "--config", "/tmp/config"])
  expect(command.type).toBe("update")
  if (command.type !== "update") throw new Error("expected update")
  expect(command.version).toBe("v0.2.0")
  expect(command.installDir).toBe("/tmp/custom")
  expect(command.settings.paths.root).toBe("/tmp/state")
  expect(command.settings.configPath).toBe("/tmp/config")
  expect(usage()).toContain("update       install the latest verified release")
})
