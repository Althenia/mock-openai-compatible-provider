import { describe, expect, test } from "bun:test"
import { DEFAULT_CHAT_URL, parseCommand, usage } from "./config.ts"

describe("chat URL configuration", () => {
  test("uses the temporary-chat URL by default and preserves an explicit override", () => {
    const defaults = parseCommand(["endpoint"], { HOME: "/tmp/home" })
    expect(DEFAULT_CHAT_URL).toBe("https://de.aipass.net/chat?temporary-chat=true")
    expect(defaults.type).toBe("endpoint")
    if (defaults.type !== "endpoint") throw new Error("expected endpoint")
    expect(defaults.settings.chatURL).toBe(DEFAULT_CHAT_URL)

    const overridden = parseCommand(["endpoint"], {
      HOME: "/tmp/home",
      AIPASS_CHAT_URL: "https://remote.example/chat?bound=true",
    })
    expect(overridden.type).toBe("endpoint")
    if (overridden.type !== "endpoint") throw new Error("expected endpoint")
    expect(overridden.settings.chatURL).toBe("https://remote.example/chat?bound=true")
  })
})
test("update accepts version and shared state settings without Chrome or a valid server port", () => {
  const command = parseCommand(["update", "--version", "v0.2.0", "--install-dir", "/tmp/custom", "--state-root", "/tmp/state", "--config", "/tmp/config"], { HOME: "/tmp/home", AIPASS_PORT: "invalid", AIPASS_BROWSER_EXECUTABLE: "/missing" })
  expect(command.type).toBe("update")
  if (command.type !== "update") throw new Error("expected update")
  expect(command.version).toBe("v0.2.0")
  expect(command.installDir).toBe("/tmp/custom")
  expect(command.settings.paths.root).toBe("/tmp/state")
  expect(command.settings.configPath).toBe("/tmp/config")
  expect(usage()).toContain("update       install the latest verified release")
})
