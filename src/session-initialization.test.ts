import { describe, expect, mock, spyOn, test } from "bun:test"

import type { ProjectedTurn } from "./http.ts"
import type { BrowserFrame } from "./protocol.ts"
import { createRequestHandler, type BrowserService } from "./server.ts"

const token = "session-initialization-fixture"
const chatTool = {
  type: "function",
  function: {
    name: "lookup",
    description: "Look up a fixture value",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
}
const responsesTool = { type: "function", ...chatTool.function }
const alternateChatTool = {
  type: "function",
  function: { name: "other", parameters: { type: "object", properties: { value: { type: "string" } } } },
}
const alternateResponsesTool = { type: "function", ...alternateChatTool.function }

function request(path: string, body: Record<string, unknown>, sessionID?: string) {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(sessionID ? { "x-session-id": sessionID } : {}),
    },
    body: JSON.stringify({ model: "gemini-3.1-flash-lite", ...body }),
  })
}

function handlerWith(turn: (input: ProjectedTurn, index: number) => readonly BrowserFrame[]) {
  const turns: ProjectedTurn[] = []
  const submit = mock(async function* (input: ProjectedTurn) {
    const index = turns.push(input) - 1
    yield* turn(input, index)
  })
  const browser: BrowserService = { turn: submit, async login() {}, async close() {} }
  return { turns, submit, handler: createRequestHandler({ token, browser, shutdown: async () => {} }) }
}

async function responseID(response: Response) {
  expect(response.status).toBe(200)
  return ((await response.json()) as { id: string }).id
}

describe("logical-session initialization retention", () => {
  test("Chat retains initialization across task and tool-result turns without changing startup identity", async () => {
    const fixture = handlerWith((_input, index) => index === 1
      ? [{ type: "tool-call", id: "call_lookup", name: "lookup", input: { key: "alpha" } }, { type: "finish", reason: "tool-calls" }]
      : [{ type: "text", delta: "OK" }, { type: "finish", reason: "stop" }])
    const sessionID = "chat-init-once"
    const first = await fixture.handler(request("/v1/chat/completions", {
      messages: [
        { role: "system", content: "HARNESS_INIT_RULE" },
        { role: "developer", content: "WORKSPACE_INIT_RULE" },
        { role: "user", content: "INITIAL_TASK" },
      ],
      tools: [chatTool],
    }, sessionID))
    expect(first.status).toBe(200)
    const second = await fixture.handler(request("/v1/chat/completions", {
      messages: [{ role: "user", content: "NEXT_TASK" }],
    }, sessionID))
    expect(second.status).toBe(200)
    const third = await fixture.handler(request("/v1/chat/completions", {
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "call_lookup", function: { name: "lookup", arguments: '{"key":"alpha"}' } }] },
        { role: "tool", tool_call_id: "call_lookup", content: "LOOKUP_RESULT" },
      ],
    }, sessionID))
    expect(third.status).toBe(200)

    expect(fixture.turns).toHaveLength(3)
    for (const turn of fixture.turns) {
      expect(turn.actionEnvelopeDigest).toBe(fixture.turns[0]!.actionEnvelopeDigest)
      expect(turn.primingPrompts).toEqual(fixture.turns[0]!.primingPrompts)
      expect(turn.offeredActions).toEqual(["lookup"])
    }
    expect(fixture.turns[0]!.primingPrompts.join("\n")).toContain("HARNESS_INIT_RULE")
    expect(fixture.turns[0]!.primingPrompts.join("\n")).toContain("WORKSPACE_INIT_RULE")
    expect(fixture.turns[1]!.incrementalPrompt).toBe("USER: NEXT_TASK")
    expect(fixture.turns[2]!.incrementalPrompt).toBe("TOOL RESULT call_lookup: LOOKUP_RESULT")
    for (const turn of fixture.turns.slice(1)) {
      expect(turn.incrementalPrompt).not.toContain("INIT_RULE")
      expect(turn.incrementalPrompt).not.toContain('"inputSchema"')
    }
  })

  test("Responses continuation inherits omitted top-level instructions and full tool catalog", async () => {
    const fixture = handlerWith((_input, index) => index === 0
      ? [{ type: "tool-call", id: "call_lookup", name: "lookup", input: { key: "alpha" } }, { type: "finish", reason: "tool-calls" }]
      : [{ type: "text", delta: "DONE" }, { type: "finish", reason: "stop" }])
    const first = await responseID(await fixture.handler(request("/v1/responses", {
      instructions: "RESPONSES_INIT_RULE",
      tools: [responsesTool],
      input: "INITIAL_TASK",
    })))
    await responseID(await fixture.handler(request("/v1/responses", {
      previous_response_id: first,
      input: [{ type: "function_call_output", call_id: "call_lookup", output: "LOOKUP_RESULT" }],
    })))

    expect(fixture.turns).toHaveLength(2)
    expect(fixture.turns[1]!.actionEnvelopeDigest).toBe(fixture.turns[0]!.actionEnvelopeDigest)
    expect(fixture.turns[1]!.primingPrompts).toEqual(fixture.turns[0]!.primingPrompts)
    expect(fixture.turns[1]!.offeredActions).toEqual(["lookup"])
    expect(fixture.turns[1]!.incrementalPrompt).toBe("TOOL RESULT call_lookup: LOOKUP_RESULT")
    expect(fixture.turns[1]!.incrementalPrompt).not.toContain("RESPONSES_INIT_RULE")
    expect(fixture.turns[1]!.incrementalPrompt).not.toContain('"inputSchema"')
  })

  test("tool_choice constrains one Chat turn without replacing the retained full catalog", async () => {
    const fixture = handlerWith(() => [{ type: "text", delta: "OK" }, { type: "finish", reason: "stop" }])
    const sessionID = "chat-tool-choice"
    expect((await fixture.handler(request("/v1/chat/completions", {
      messages: [{ role: "user", content: "INITIAL" }], tools: [chatTool],
    }, sessionID))).status).toBe(200)
    expect((await fixture.handler(request("/v1/chat/completions", {
      messages: [{ role: "user", content: "NO_ACTION" }], tool_choice: "none",
    }, sessionID))).status).toBe(200)
    expect((await fixture.handler(request("/v1/chat/completions", {
      messages: [{ role: "user", content: "AUTO_AGAIN" }],
    }, sessionID))).status).toBe(200)

    expect(fixture.turns.map(turn => turn.offeredActions)).toEqual([["lookup"], [], ["lookup"]])
    expect(fixture.turns[1]!.primingPrompts).toEqual(fixture.turns[0]!.primingPrompts)
    expect(fixture.turns[2]!.primingPrompts).toEqual(fixture.turns[0]!.primingPrompts)
    expect(fixture.turns[1]!.actionEnvelopeDigest).toBe(fixture.turns[0]!.actionEnvelopeDigest)
    expect(fixture.turns[1]!.incrementalPrompt).toStartWith("Do not request a client action on this turn")
    expect(fixture.turns[2]!.incrementalPrompt).toBe("USER: AUTO_AGAIN")
  })

  test("explicit Chat initialization replaces or clears retained fields and action-only never projects retained text", async () => {
    const fixture = handlerWith(() => [{ type: "text", delta: "OK" }, { type: "finish", reason: "stop" }])
    const sessionID = "chat-explicit-update"
    for (const body of [
      { messages: [{ role: "system", content: "OLD_RULE" }, { role: "user", content: "INITIAL" }], tools: [chatTool] },
      { messages: [{ role: "system", content: "NEW_RULE" }, { role: "user", content: "UPDATE" }], tools: [alternateChatTool] },
      { messages: [{ role: "user", content: "ACTION_ONLY" }], instruction_mode: "action-only" },
      { messages: [{ role: "user", content: "ACTION_ONLY_AGAIN" }] },
      { messages: [{ role: "user", content: "CLEAR_TOOLS" }], tools: [] },
      { messages: [{ role: "user", content: "CLEARED_AGAIN" }] },
    ]) expect((await fixture.handler(request("/v1/chat/completions", body, sessionID))).status).toBe(200)

    expect(fixture.turns[1]!.primingPrompts.join("\n")).toContain("NEW_RULE")
    expect(fixture.turns[1]!.primingPrompts.join("\n")).not.toContain("OLD_RULE")
    expect(fixture.turns[1]!.offeredActions).toEqual(["other"])
    for (const turn of fixture.turns.slice(2, 4)) {
      expect(turn.primingPrompts.join("\n")).not.toContain("NEW_RULE")
      expect(turn.incrementalPrompt).not.toContain("NEW_RULE")
      expect(turn.offeredActions).toEqual(["other"])
    }
    expect(fixture.turns[3]!.actionEnvelopeDigest).toBe(fixture.turns[2]!.actionEnvelopeDigest)
    for (const turn of fixture.turns.slice(4)) expect(turn.offeredActions).toEqual([])
    expect(fixture.turns[5]!.actionEnvelopeDigest).toBe(fixture.turns[4]!.actionEnvelopeDigest)
  })

  test("Chat initialization is isolated, anonymous requests are stateless, and invalid updates do not poison retained state", async () => {
    const fixture = handlerWith(() => [{ type: "text", delta: "OK" }, { type: "finish", reason: "stop" }])
    expect((await fixture.handler(request("/v1/chat/completions", {
      messages: [{ role: "system", content: "SESSION_A_RULE" }, { role: "user", content: "A" }], tools: [chatTool],
    }, "session-a"))).status).toBe(200)
    const invalid = await fixture.handler(request("/v1/chat/completions", {
      messages: [{ role: "user", content: "INVALID" }], tools: [{}],
    }, "session-a"))
    expect(invalid.status).toBe(400)
    expect((await fixture.handler(request("/v1/chat/completions", {
      messages: [{ role: "user", content: "A_AGAIN" }],
    }, "session-a"))).status).toBe(200)
    expect((await fixture.handler(request("/v1/chat/completions", {
      messages: [{ role: "user", content: "B" }],
    }, "session-b"))).status).toBe(200)
    expect((await fixture.handler(request("/v1/chat/completions", {
      messages: [{ role: "user", content: "ANON" }], tools: [alternateChatTool],
    }))).status).toBe(200)
    expect((await fixture.handler(request("/v1/chat/completions", {
      messages: [{ role: "user", content: "ANON_AGAIN" }],
    }))).status).toBe(200)

    expect(fixture.turns).toHaveLength(5)
    expect(fixture.turns[1]!.offeredActions).toEqual(["lookup"])
    expect(fixture.turns[1]!.primingPrompts.join("\n")).toContain("SESSION_A_RULE")
    expect(fixture.turns[2]!.offeredActions).toEqual([])
    expect(fixture.turns[2]!.primingPrompts.join("\n")).not.toContain("SESSION_A_RULE")
    expect(fixture.turns[3]!.offeredActions).toEqual(["other"])
    expect(fixture.turns[4]!.offeredActions).toEqual([])
  })

  test("valid Chat initialization remains admitted when the browser fails", async () => {
    const turns: ProjectedTurn[] = []
    const submit = mock(async function* (input: ProjectedTurn) {
      turns.push(input)
      if (turns.length === 1) throw new Error("synthetic browser failure")
      yield { type: "tool-call", id: "call_lookup", name: "lookup", input: { key: "retry" } } as BrowserFrame
      yield { type: "finish", reason: "tool-calls" } as BrowserFrame
    })
    const browser: BrowserService = { turn: submit, async login() {}, async close() {} }
    const handler = createRequestHandler({ token, browser, shutdown: async () => {} })
    expect((await handler(request("/v1/chat/completions", {
      messages: [{ role: "system", content: "RETRY_RULE" }, { role: "user", content: "INITIAL" }], tools: [chatTool],
    }, "admitted-before-browser"))).status).toBe(502)
    expect((await handler(request("/v1/chat/completions", {
      messages: [{ role: "user", content: "RETRY" }],
    }, "admitted-before-browser"))).status).toBe(200)
    expect(turns[1]!.offeredActions).toEqual(["lookup"])
    expect(turns[1]!.primingPrompts.join("\n")).toContain("RETRY_RULE")
  })

  test("concurrent Chat admissions keep immutable request snapshots and synchronously publish valid updates", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const turns: ProjectedTurn[] = []
    const submit = mock(async function* (input: ProjectedTurn) {
      const index = turns.push(input) - 1
      if (index === 0) {
        entered.resolve()
        await release.promise
      }
      yield { type: "text", delta: "OK" } as BrowserFrame
      yield { type: "finish", reason: "stop" } as BrowserFrame
    })
    const browser: BrowserService = { turn: submit, async login() {}, async close() {} }
    const handler = createRequestHandler({ token, browser, shutdown: async () => {} })
    const first = handler(request("/v1/chat/completions", {
      messages: [{ role: "system", content: "FIRST_RULE" }, { role: "user", content: "FIRST" }], tools: [chatTool],
    }, "concurrent-chat"))
    await entered.promise
    const second = await handler(request("/v1/chat/completions", {
      messages: [{ role: "system", content: "SECOND_RULE" }, { role: "user", content: "SECOND" }], tools: [alternateChatTool],
    }, "concurrent-chat"))
    expect(second.status).toBe(200)
    release.resolve()
    expect((await first).status).toBe(200)
    expect((await handler(request("/v1/chat/completions", {
      messages: [{ role: "user", content: "THIRD" }],
    }, "concurrent-chat"))).status).toBe(200)

    expect(turns[0]!.primingPrompts.join("\n")).toContain("FIRST_RULE")
    expect(turns[0]!.primingPrompts.join("\n")).not.toContain("SECOND_RULE")
    expect(turns[0]!.offeredActions).toEqual(["lookup"])
    for (const turn of turns.slice(1)) {
      expect(turn.primingPrompts.join("\n")).toContain("SECOND_RULE")
      expect(turn.primingPrompts.join("\n")).not.toContain("FIRST_RULE")
      expect(turn.offeredActions).toEqual(["other"])
    }
    expect(turns[2]!.actionEnvelopeDigest).toBe(turns[1]!.actionEnvelopeDigest)
  })

  test("Responses explicit updates replace, empty values clear, and invalid continuations leave the predecessor retryable", async () => {
    const fixture = handlerWith(() => [{ type: "text", delta: "OK" }, { type: "finish", reason: "stop" }])
    const first = await responseID(await fixture.handler(request("/v1/responses", {
      instructions: "OLD_RESPONSE_RULE", tools: [responsesTool], input: "INITIAL",
    })))
    const invalid = await fixture.handler(request("/v1/responses", {
      previous_response_id: first, input: "INVALID", tools: [{}],
    }))
    expect(invalid.status).toBe(400)
    const second = await responseID(await fixture.handler(request("/v1/responses", {
      previous_response_id: first, input: "UPDATE", instructions: "NEW_RESPONSE_RULE", tools: [alternateResponsesTool],
    })))
    const third = await responseID(await fixture.handler(request("/v1/responses", {
      previous_response_id: second, input: "CLEAR", instructions: "", tools: [],
    })))
    await responseID(await fixture.handler(request("/v1/responses", {
      previous_response_id: third, input: "CLEARED_AGAIN",
    })))

    expect(fixture.turns).toHaveLength(4)
    expect(fixture.turns[1]!.primingPrompts.join("\n")).toContain("NEW_RESPONSE_RULE")
    expect(fixture.turns[1]!.primingPrompts.join("\n")).not.toContain("OLD_RESPONSE_RULE")
    expect(fixture.turns[1]!.offeredActions).toEqual(["other"])
    for (const turn of fixture.turns.slice(2)) {
      expect(turn.primingPrompts.join("\n")).not.toContain("NEW_RESPONSE_RULE")
      expect(turn.offeredActions).toEqual([])
    }
    expect(fixture.turns[3]!.actionEnvelopeDigest).toBe(fixture.turns[2]!.actionEnvelopeDigest)
  })

  test("Responses retains instruction mode and catalog while tool_choice remains per-turn", async () => {
    const fixture = handlerWith(() => [{ type: "text", delta: "OK" }, { type: "finish", reason: "stop" }])
    const first = await responseID(await fixture.handler(request("/v1/responses", {
      instructions: "MODE_RULE", tools: [responsesTool], input: "INITIAL",
    })))
    const second = await responseID(await fixture.handler(request("/v1/responses", {
      previous_response_id: first, input: "NO_ACTION", tool_choice: "none", instruction_mode: "action-only",
    })))
    await responseID(await fixture.handler(request("/v1/responses", {
      previous_response_id: second, input: "ACTION_ONLY_AGAIN",
    })))

    expect(fixture.turns.map(turn => turn.offeredActions)).toEqual([["lookup"], [], ["lookup"]])
    for (const turn of fixture.turns.slice(1)) {
      expect(turn.primingPrompts.join("\n")).not.toContain("MODE_RULE")
      expect(turn.incrementalPrompt).not.toContain("MODE_RULE")
    }
    expect(fixture.turns[2]!.actionEnvelopeDigest).toBe(fixture.turns[1]!.actionEnvelopeDigest)
    expect(fixture.turns[2]!.primingPrompts).toEqual(fixture.turns[1]!.primingPrompts)
  })

  test("Chat initialization count capacity fails before submission without evicting retained sessions", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      const fixture = handlerWith(() => [{ type: "text", delta: "OK" }, { type: "finish", reason: "stop" }])
      let firstDigest = ""
      for (let index = 0; index < 1_000; index++) {
        const response = await fixture.handler(request("/v1/chat/completions", {
          messages: [{ role: "system", content: `RULE_${index}` }, { role: "user", content: "INITIAL" }],
        }, `bounded-${index}`))
        expect(response.status).toBe(200)
        if (index === 0) firstDigest = fixture.turns[0]!.actionEnvelopeDigest
      }
      const overflow = await fixture.handler(request("/v1/chat/completions", {
        messages: [{ role: "system", content: "OVERFLOW_RULE" }, { role: "user", content: "INITIAL" }],
      }, "bounded-overflow"))
      expect(overflow.status).toBe(507)
      expect(await overflow.json()).toMatchObject({ error: { code: "session_initialization_capacity" } })
      expect(fixture.submit).toHaveBeenCalledTimes(1_000)
      expect((await fixture.handler(request("/v1/chat/completions", {
        messages: [{ role: "user", content: "REUSE" }],
      }, "bounded-0"))).status).toBe(200)
      expect(fixture.turns.at(-1)!.actionEnvelopeDigest).toBe(firstDigest)
    } finally { log.mockRestore() }
  })

  test("Chat initialization byte capacity counts UTF-8 and fails before browser submission", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      const fixture = handlerWith(() => [{ type: "text", delta: "OK" }, { type: "finish", reason: "stop" }])
      const overflow = await fixture.handler(request("/v1/chat/completions", {
        messages: [{ role: "system", content: "ก".repeat(6 * 1024 * 1024) }, { role: "user", content: "INITIAL" }],
      }, "utf8-overflow"))
      expect(overflow.status).toBe(507)
      expect(await overflow.json()).toMatchObject({ error: { code: "session_initialization_capacity" } })
      expect(fixture.submit).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  })

  test("Responses initialization bytes are included in capacity admission", async () => {
    const fixture = handlerWith(() => [{ type: "text", delta: "OK" }, { type: "finish", reason: "stop" }])
    const overflow = await fixture.handler(request("/v1/responses", {
      instructions: "ก".repeat(6 * 1024 * 1024), input: "INITIAL",
    }))
    expect(overflow.status).toBe(507)
    expect(await overflow.json()).toMatchObject({ error: { code: "session_initialization_capacity" } })
    expect(fixture.submit).not.toHaveBeenCalled()
  })

  test("Responses discards a completed non-stream continuation when its output exceeds retained capacity", async () => {
    let calls = 0
    const submit = mock(async function* () {
      calls++
      yield { type: "text", delta: calls === 1 ? "ROOT" : "x".repeat(4_096) } as BrowserFrame
      yield { type: "finish", reason: "stop" } as BrowserFrame
    })
    const discard = mock(async () => undefined)
    const browser: BrowserService = { turn: submit, discard, async login() {}, async close() {} }
    const handler = createRequestHandler({ token, browser, shutdown: async () => {} })
    const first = await responseID(await handler(request("/v1/responses", {
      instructions: "i".repeat(16 * 1024 * 1024 - 2_048), input: "ROOT",
    })))

    const overflow = await handler(request("/v1/responses", {
      previous_response_id: first, input: "CHILD",
    }))
    expect(overflow.status).toBe(507)
    expect(await overflow.json()).toMatchObject({ error: { code: "session_initialization_capacity" } })
    expect(discard).toHaveBeenCalledTimes(1)
    expect((await handler(request("/v1/responses", {
      previous_response_id: first, input: "RETRY",
    }))).status).toBe(400)
    expect(submit).toHaveBeenCalledTimes(2)
  })
})
