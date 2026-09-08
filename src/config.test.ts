import { describe, expect, test } from "bun:test"
import { DEFAULT_CHAT_URL, parseCommand } from "./config.ts"

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
