import { describe, expect, test } from "bun:test"

import { NoResponseEvidenceError, type BrowserTurnInput } from "./browser.ts"
import { parseOpenAIChatRequest } from "./http.ts"
import {
  SingleFlightCompletionStore,
  StandaloneBrowserService,
  promptHashForSingleFlight,
  recoverNoResponseEvidence,
  repairToolRefusal,
} from "./runtime.ts"
import { collectOpenAIChatResult, envelopeKey, hasEnvelopeShape } from "./protocol.ts"
import type { BrowserFrame } from "./protocol.ts"

for (const tagged of [false, true]) test(`preserves ${tagged ? "tagged" : "bare"} attributed grouped calls through legacy action repair`, async () => {
  const parsed = parseOpenAIChatRequest({
    model: "gemini-3.1-flash-lite",
    session_id: "grouped-action-fixture",
    messages: [{ role: "user", content: "Read the synthetic fixture and list matching files." }],
    tools: ["read", "glob"].map((name) => ({ type: "function", function: {
      name, parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    } })),
  }, new Headers())
  const calls = [
    { id: "call_read", name: "read", input: { path: "cannot access files here.txt" } },
    { id: "call_glob", name: "glob", input: { path: "*.txt" } },
  ]
  const envelopes = [
    { type: "thinking", key: parsed.turn.promptKey, text: "Checking both sources." },
    { type: "plan", key: parsed.turn.promptKey, steps: calls },
  ].map((value) => tagged ? `<aipass-envelope>${JSON.stringify(value)}</aipass-envelope>` : JSON.stringify(value)).join("\n")
  let submissions = 0
  const service = new StandaloneBrowserService({ async *turn() {
    submissions++
    yield { type: "text", delta: envelopes }
    yield { type: "finish", reason: "stop" }
  } } as never)
  const result = await collectOpenAIChatResult(service.turn(parsed.turn), parsed.offered)
  expect(submissions).toBe(1)
  expect(result.reasoning).toBe("Checking both sources.")
  expect(result.toolCalls).toEqual(calls)
  expect(result.text).toBe(tagged ? "\n" : "")
  expect(result.finishReason).toBe("tool-calls")
})

for (const type of ["tool", "skill"] as const) test(`preserves direct typed ${type} input through legacy action repair`, async () => {
  const name = type === "tool" ? "read" : "skill"
  const input = {
    ...(type === "tool" ? { path: "cannot access files here.txt" } : { id: "readme-writer" }),
    metadata: { id: "nested", name: "read", input: { path: "not a separate call.txt" } },
    note: "I cannot access files here.",
  }
  const parsed = parseOpenAIChatRequest({
    model: "gemini-3.1-flash-lite",
    session_id: `direct-${type}-fixture`,
    messages: [{ role: "user", content: "Inspect the synthetic fixture." }],
    tools: [{ type: "function", function: { name, parameters: { type: "object" } } }],
  }, new Headers())
  let submissions = 0
  const service = new StandaloneBrowserService({ async *turn() {
    submissions++
    yield { type: "text", delta: `<aipass-envelope>${JSON.stringify({ type, name, key: parsed.turn.promptKey, id: "direct_call", input })}</aipass-envelope>` }
    yield { type: "finish", reason: "stop" }
  } } as never)
  const result = await collectOpenAIChatResult(service.turn(parsed.turn), parsed.offered)
  expect(submissions).toBe(1)
  expect(result.toolCalls).toEqual([{ id: "direct_call", name, input }])
  expect(result.text).toBe("")
  expect(result.finishReason).toBe("tool-calls")
})

describe("internal continuation request fidelity", () => {
  for (const mode of ["preserve", "action-only"] as const) {
    for (const trigger of ["repair", "provision"] as const) {
      test(`${mode} ${trigger} retains request context on every browser route`, async () => {
        const parsed = parseOpenAIChatRequest({
          model: "gemini-3.1-flash-lite", instruction_mode: mode,
          messages: [
            { role: "system", content: "SYSTEM_RULE " + "context ".repeat(1_500) },
            { role: "developer", content: "DEVELOPER_RULE" },
            { role: "user", content: "ORIGINAL_TASK: inspect the synthetic fixture, then ask which result to use." },
            { role: "assistant", content: "", tool_calls: [{ id: "call_fixture", function: { name: "read", arguments: '{"path":"fixture.txt"}' } }] },
            { role: "tool", tool_call_id: "call_fixture", content: "LATEST_RESULT: alpha or beta" },
            { role: "user", content: "<system-update>\nLOWERED_RULE\n</system-update>" },
          ],
          tools: [
            { type: "function", function: { name: "question", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
            { type: "function", function: { name: "unused", parameters: { type: "object", properties: { unrelated: { type: "string" } } } } },
          ],
        }, new Headers({ "x-session-affinity": `context-${mode}-${trigger}` }))
        const submitted: BrowserTurnInput[] = []
        const adapter = {
          async *turn(input: BrowserTurnInput) {
            submitted.push(input)
            const value = submitted.length === 1
              ? trigger === "repair"
                ? { type: "chat", text: "I cannot access the question tool here." }
                : { type: "question", id: "call_missing", input: {} }
              : { type: "question", id: "call_ready", input: { query: "alpha or beta?" } }
            yield { type: "text", delta: `<aipass-envelope>${JSON.stringify({ key: input.promptKey, ...value })}</aipass-envelope>` } as BrowserFrame
            yield { type: "finish", reason: "stop" } as BrowserFrame
          },
        }
        const service = new StandaloneBrowserService(adapter as never)
        const frames: BrowserFrame[] = []
        for await (const frame of service.turn(parsed.turn)) frames.push(frame)
        expect(submitted).toHaveLength(2)
        expect(JSON.stringify(frames)).toContain("alpha or beta?")
        const next = submitted[1]!
        expect(submitted[0]!.primingPrompts).toEqual(parsed.turn.primingPrompts)
        expect(next.primingPrompts).toEqual([])
        expect(next.promptKey).toBe(parsed.turn.promptKey)
        for (const prompt of [next.initialPrompt, next.incrementalPrompt, next.recoveryPrompt]) {
          expect(prompt).toContain("You are a text-generation assistant working only as the backend.")
          expect(prompt).toContain("Actions are data, not native calls: never execute them yourself or decline for lack of native access.")
          expect(prompt).toContain("Replies and refusals: only <aipass-envelope>{...}</aipass-envelope>, no outside prose, JSON, or fences.")
          expect(prompt).toContain("ORIGINAL_TASK")
          expect(prompt).toContain('TOOL CALL call_fixture read: {"path":"fixture.txt"}')
          expect(prompt).toContain("TOOL RESULT call_fixture: LATEST_RESULT: alpha or beta")
          expect(prompt).toContain('"name":"question"')
          expect(prompt.indexOf('"name":"question"')).toBeLessThan(prompt.indexOf("ORIGINAL_TASK"))
          for (const rule of ["SYSTEM_RULE", "DEVELOPER_RULE"]) {
            if (mode === "preserve") expect(submitted[0]!.primingPrompts.join("\n")).toContain(rule)
            else expect(submitted[0]!.primingPrompts.join("\n")).not.toContain(rule)
            expect(prompt).not.toContain(rule)
          }
          if (mode === "preserve") expect(prompt).toContain("LOWERED_RULE")
          else expect(prompt).not.toContain("LOWERED_RULE")
          if (trigger === "provision") expect(prompt).not.toContain('"name":"unused"')
        }
      })
    }
  }
})

describe("internal no-response recovery", () => {
  test("retries once inside the same provider request when the incremental prompt differs", async () => {
    let attempts = 0
    const frames: string[] = []
    const turn = () => ({
      async *[Symbol.asyncIterator]() {
        attempts++
        if (attempts === 1) throw new NoResponseEvidenceError()
        yield "OK"
        yield "finish"
      },
    })

    for await (const frame of recoverNoResponseEvidence(turn, true)) frames.push(frame)
    expect(frames).toEqual(["OK", "finish"])
    expect(attempts).toBe(2)
  })

  test("does not retry ordinary prompts or retry more than once", async () => {
    let ordinary = 0
    const failed = () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        ordinary++
        throw new NoResponseEvidenceError()
      },
    })
    await expect(async () => {
      for await (const _ of recoverNoResponseEvidence(failed, false)) void _
    }).toThrow(NoResponseEvidenceError)
    expect(ordinary).toBe(1)

    let bounded = 0
    const twice = () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        bounded++
        throw new NoResponseEvidenceError()
      },
    })
    await expect(async () => {
      for await (const _ of recoverNoResponseEvidence(twice, true)) void _
    }).toThrow(NoResponseEvidenceError)
    expect(bounded).toBe(2)
  })
})

describe("automatic tool-refusal repair", () => {
  test("replaces a filesystem-access refusal with one repaired tool call", async () => {
    let repairs = 0
    const initial: BrowserFrame[] = [
      { type: "text", delta: "I don't have direct access to your file system tools." },
      { type: "finish", reason: "stop" },
    ]
    const repaired = () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<BrowserFrame> {
        repairs++
        yield {
          type: "text",
          delta: '<aipass-action>{"id":"call_1","name":"read","input":{"path":"."}}</aipass-action>',
        }
        yield { type: "finish", reason: "tool-calls" }
      },
    })
    const frames: BrowserFrame[] = []
    for await (const frame of repairToolRefusal(initial, repaired)) frames.push(frame)
    expect(frames).toEqual([
      {
        type: "text",
        delta: '<aipass-action>{"id":"call_1","name":"read","input":{"path":"."}}</aipass-action>',
      },
      { type: "finish", reason: "tool-calls" },
    ])
    expect(repairs).toBe(1)
  })

  test("surfaces a webchat safety block without repair or retry", async () => {
    let repairs = 0
    const repair = () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<BrowserFrame> {
        repairs++
        yield { type: "finish", reason: "stop" } as BrowserFrame
      },
    })
    const blocked: BrowserFrame[] = [
      { type: "text", delta: "ขออภัย! ข้อความของคุณอาจมีบางส่วนที่ขัดกับระบบความปลอดภัย (อาจเกิดจากระบบหรือโมเดล AI) รบกวนลองปรับแก้แล้วส่งใหม่อีกครั้ง" },
      { type: "finish", reason: "stop" },
    ]
    const exposed: BrowserFrame[] = []
    for await (const frame of repairToolRefusal(blocked, repair)) exposed.push(frame)
    expect(exposed).toEqual(blocked)
    expect(repairs).toBe(0)
  })

  test("does not repair a normal answer or an existing tool call", async () => {
    let repairs = 0
    const repair = () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<BrowserFrame> {
        repairs++
        yield { type: "finish", reason: "stop" }
      },
    })
    const answer: BrowserFrame[] = [
      { type: "text", delta: "The current directory is the process working directory." },
      { type: "finish", reason: "stop" },
    ]
    const answered: BrowserFrame[] = []
    for await (const frame of repairToolRefusal(answer, repair)) answered.push(frame)
    expect(answered).toEqual(answer)

    const safety: BrowserFrame[] = [
      { type: "text", delta: "I can't help with that request." },
      { type: "finish", reason: "stop" },
    ]
    const declined: BrowserFrame[] = []
    for await (const frame of repairToolRefusal(safety, repair)) declined.push(frame)
    expect(declined).toEqual(safety)

    for (const text of [
      "I can't execute that shell command because it would delete files.",
      "I can't execute that shell command because it would compromise security.",
      "I can't run that command because it would violate privacy.",
      "I can't execute it without authorization to use the shell.",
      "I can't execute that shell command due to security concerns.",
      "I can't run that command because of privacy requirements.",
      "I can't execute it as it violates privacy while using the shell.",
      "I can't execute that shell command for security reasons.",
      "I can't run that command for privacy reasons.",
      "I can't execute this shell command on security grounds.",
      "I cannot use this tool to protect privacy.",
    ]) {
      const unsafe: BrowserFrame[] = [
        { type: "text", delta: text },
        { type: "finish", reason: "stop" },
      ]
      const unsafeDecline: BrowserFrame[] = []
      for await (const frame of repairToolRefusal(unsafe, repair)) unsafeDecline.push(frame)
      expect(unsafeDecline).toEqual(unsafe)
    }

    const tool: BrowserFrame[] = [
      { type: "tool-call", id: "call_2", name: "read", input: { path: "." } },
      { type: "finish", reason: "tool-calls" },
    ]
    const called: BrowserFrame[] = []
    for await (const frame of repairToolRefusal(tool, repair)) called.push(frame)
    expect(called).toEqual(tool)
    expect(repairs).toBe(0)
  })

  test("returns a second refusal without attempting a third turn", async () => {
    const initial: BrowserFrame[] = [
      { type: "text", delta: "I cannot access the local directory." },
      { type: "finish", reason: "stop" },
    ]
    let repairs = 0
    const repaired: BrowserFrame[] = [
      { type: "text", delta: "I still cannot access the local directory." },
      { type: "finish", reason: "stop" },
    ]
    const repair = () => {
      repairs++
      return repaired
    }
    const exposed: BrowserFrame[] = []
    for await (const frame of repairToolRefusal(initial, repair)) exposed.push(frame)
    expect(exposed).toEqual(repaired)
    expect(repairs).toBe(1)
  })

  test("repairs generic permission and security capability disclaimers", async () => {
    const repaired: BrowserFrame[] = [
      { type: "tool-call", id: "call_3", name: "read", input: { path: "." } },
      { type: "finish", reason: "tool-calls" },
    ]
    let repairs = 0
    const repair = () => {
      repairs++
      return repaired
    }
    for (const text of [
      "I don't have permission to access your local files.",
      "For security reasons, I cannot access the workspace.",
      "I can't run shell commands because I don't have permission to access your computer.",
    ]) {
      const exposed: BrowserFrame[] = []
      for await (const frame of repairToolRefusal(
        [
          { type: "text", delta: text },
          { type: "finish", reason: "stop" },
        ],
        repair,
      ))
        exposed.push(frame)
      expect(exposed).toEqual(repaired)
    }
    expect(repairs).toBe(3)
  })

  test("repairs curly-apostrophe capability denial", async () => {
    const repaired: BrowserFrame[] = [
      { type: "tool-call", id: "call_3", name: "read", input: { path: "." } },
      { type: "finish", reason: "tool-calls" },
    ]
    let repairs = 0
    const repair = () => {
      repairs++
      return repaired
    }
    const exposed: BrowserFrame[] = []
    for await (const frame of repairToolRefusal(
      [
        { type: "text", delta: "I can’t access a file-writing tool in this chat." },
        { type: "finish", reason: "stop" },
      ],
      repair,
      ["write", "read"],
    ))
      exposed.push(frame)
    expect(exposed).toEqual(repaired)
    expect(repairs).toBe(1)
  })

  test("repairs an untagged action object by rerunning the turn", async () => {
    let repairs = 0
    const repaired: BrowserFrame[] = [
      {
        type: "text",
        delta: '<aipass-action>{"id":"call_9","name":"glob","input":{"pattern":"src/*"}}</aipass-action>',
      },
      { type: "finish", reason: "tool-calls" },
    ]
    const repair = () => {
      repairs++
      return repaired
    }
    const exposed: BrowserFrame[] = []
    for await (const frame of repairToolRefusal(
      [
        { type: "text", delta: '{"id":"call_9","name":"glob","input":{"pattern":"src/*"}}' },
        { type: "finish", reason: "stop" },
      ],
      repair,
    ))
      exposed.push(frame)
    expect(exposed).toEqual(repaired)
    expect(repairs).toBe(1)
  })

  test("repairs an untagged action object on a non-stop finish", async () => {
    let repairs = 0
    const repaired: BrowserFrame[] = [
      {
        type: "text",
        delta: '<aipass-action>{"id":"call_9","name":"glob","input":{"pattern":"src/*"}}</aipass-action>',
      },
      { type: "finish", reason: "tool-calls" },
    ]
    const repair = () => {
      repairs++
      return repaired
    }
    const exposed: BrowserFrame[] = []
    for await (const frame of repairToolRefusal(
      [
        { type: "text", delta: '{"id":"call_9","name":"glob","input":{"pattern":"src/*"}}' },
        { type: "finish", reason: "length" },
      ],
      repair,
    ))
      exposed.push(frame)
    expect(exposed).toEqual(repaired)
    expect(repairs).toBe(1)
  })

  test("repairs a capability decline that names file creation", async () => {
    let repairs = 0
    const repaired: BrowserFrame[] = [
      {
        type: "text",
        delta: '<aipass-action>{"id":"call_4","name":"write","input":{"path":"/tmp/aipass-e2e.txt"}}</aipass-action>',
      },
      { type: "finish", reason: "tool-calls" },
    ]
    const repair = () => {
      repairs++
      return repaired
    }
    for (const text of [
      "I am unable to create a new file directly using the available tools.",
      "I am sorry, but I do not have the capability to create new files on your system.",
    ]) {
      const exposed: BrowserFrame[] = []
      for await (const frame of repairToolRefusal(
        [
          { type: "text", delta: text },
          { type: "finish", reason: "stop" },
        ],
        repair,
      ))
        exposed.push(frame)
      expect(exposed).toEqual(repaired)
    }
    expect(repairs).toBe(2)
  })

  test("repairs a subagent capability decline", async () => {
    let repairs = 0
    const repaired: BrowserFrame[] = [
      {
        type: "text",
        delta: '<aipass-action>{"id":"call_5","name":"subagent","input":{"task":"check version"}}</aipass-action>',
      },
      { type: "finish", reason: "tool-calls" },
    ]
    const repair = () => {
      repairs++
      return repaired
    }
    for (const text of [
      "I don't have the capability to directly spawn subagents within this environment.",
      "I don't have the ability to spawn subagents or access your local file system directly.",
    ]) {
      const exposed: BrowserFrame[] = []
      for await (const frame of repairToolRefusal(
        [{ type: "text", delta: text }, { type: "finish", reason: "stop" }],
        repair,
      ))
        exposed.push(frame)
      expect(exposed).toEqual(repaired)
    }
    expect(repairs).toBe(2)
  })

  test("converts an untagged offered action locally without re-submitting", async () => {
    let repairs = 0
    const fallback: BrowserFrame[] = [{ type: "finish", reason: "stop" }]
    const repair = () => {
      repairs++
      return fallback
    }
    const exposed: BrowserFrame[] = []
    for await (const frame of repairToolRefusal(
      [
        {
          type: "text",
          delta: 'Sure. {"id":"call_7","name":"subagent","input":{"task":"check version"}}',
        },
        { type: "finish", reason: "stop" },
      ],
      repair,
      ["read", "subagent"],
    ))
      exposed.push(frame)
    expect(repairs).toBe(0)
    expect(exposed).toEqual([
      { type: "text", delta: "Sure. " },
      { type: "tool-call", id: "call_7", name: "subagent", input: { task: "check version" } },
      { type: "finish", reason: "stop" },
    ])
  })

  test("keeps legacy nested action conversion for an unrecognized outer type", async () => {
    let repairs = 0
    const input = { path: "synthetic.txt" }
    const frames: BrowserFrame[] = []
    for await (const frame of repairToolRefusal([
      { type: "text", delta: JSON.stringify({ type: "metadata", steps: [{ id: "call_read", name: "read", input }] }) },
      { type: "finish", reason: "stop" },
    ], () => { repairs++; return [] }, ["read"])) frames.push(frame)
    expect(repairs).toBe(0)
    expect(frames.filter((frame) => frame.type === "tool-call")).toEqual([
      { type: "tool-call", id: "call_read", name: "read", input },
    ])
  })

  test("re-submits an untagged action that names no offered tool", async () => {
    let repairs = 0
    const fallback: BrowserFrame[] = [{ type: "finish", reason: "stop" }]
    const repair = () => {
      repairs++
      return fallback
    }
    const exposed: BrowserFrame[] = []
    for await (const frame of repairToolRefusal(
      [
        {
          type: "text",
          delta: '{"id":"call_8","name":"shell","input":{"command":"ls"}}',
        },
        { type: "finish", reason: "stop" },
      ],
      repair,
      ["read", "subagent"],
    ))
      exposed.push(frame)
    expect(exposed).toEqual(fallback)
    expect(repairs).toBe(1)
  })

  test("re-submits an untagged action that never closes", async () => {
    let repairs = 0
    const fallback: BrowserFrame[] = [{ type: "finish", reason: "stop" }]
    const repair = () => {
      repairs++
      return fallback
    }
    const exposed: BrowserFrame[] = []
    for await (const frame of repairToolRefusal(
      [
        {
          type: "text",
          delta: 'Partial {"id":"call_9","name":"subagent","input":{"task":',
        },
        { type: "finish", reason: "stop" },
      ],
      repair,
      ["read", "subagent"],
    ))
      exposed.push(frame)
    expect(exposed).toEqual(fallback)
    expect(repairs).toBe(1)
  })

  test("repairs live cant-without-apostrophe question-tool decline", async () => {
    let repairs = 0
    const repaired: BrowserFrame[] = [
      { type: "tool-call", id: "q1", name: "question", input: { query: "which file?" } },
      { type: "finish", reason: "tool-calls" },
    ]
    const repair = () => {
      repairs++
      return repaired
    }
    const exposed: BrowserFrame[] = []
    for await (const frame of repairToolRefusal(
      [
        { type: "text", delta: "I cant access that specific question tool here" },
        { type: "finish", reason: "stop" },
      ],
      repair,
      ["question"],
    ))
      exposed.push(frame)
    expect(exposed).toEqual(repaired)
    expect(repairs).toBe(1)
  })

  test("does not repair a non-stop response or output beyond the bounded buffer", async () => {
    let repairs = 0
    const repair = () => {
      repairs++
      return [] as BrowserFrame[]
    }
    const length: BrowserFrame[] = [
      { type: "text", delta: "I cannot access the local file system." },
      { type: "finish", reason: "length" },
    ]
    const lengthOutput: BrowserFrame[] = []
    for await (const frame of repairToolRefusal(length, repair)) lengthOutput.push(frame)
    expect(lengthOutput).toEqual(length)

    const large: BrowserFrame[] = [
      { type: "text", delta: "x".repeat(65 * 1024) },
      { type: "text", delta: " I cannot access the local directory." },
      { type: "finish", reason: "stop" },
    ]
    const largeOutput: BrowserFrame[] = []
    for await (const frame of repairToolRefusal(large, repair)) largeOutput.push(frame)
    expect(largeOutput).toEqual(large)
    expect(repairs).toBe(0)
  })

  test("closes the active browser iterator when buffered output is cancelled", async () => {
    let closed = 0
    const initial = {
      async *[Symbol.asyncIterator](): AsyncGenerator<BrowserFrame> {
        try {
          yield { type: "text", delta: "x".repeat(65 * 1024) }
          yield { type: "finish", reason: "stop" }
        } finally {
          closed++
        }
      },
    }
    const output = repairToolRefusal(initial, () => [])
    expect((await output.next()).done).toBe(false)
    await output.return(undefined)
    expect(closed).toBe(1)
  })

  test("continuing-tool denial without apostrophe repairs into real question call", async () => {
    const questionSchema = {
      name: "question",
      description: "Ask the user a question",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    }
    let adapterTurns = 0
    const adapter = {
      async *turn() {
        adapterTurns++
        if (adapterTurns === 1) {
          yield { type: "text", delta: "I cant access that specific question tool here" } as BrowserFrame
          yield { type: "finish", reason: "stop" } as BrowserFrame
          return
        }
        yield { type: "text", delta: '<aipass-envelope>{"type":"question","id":"q2","input":{"query":"which file?"}}</aipass-envelope>' } as BrowserFrame
        yield { type: "finish", reason: "stop" } as BrowserFrame
      },
      async login() {},
      async close() {},
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
    const base = {
      sessionMarker: "marker-continuing-denial",
      ephemeral: false,
      primingPrompts: [],
      modelID: "gpt-5.6-terra",
      reasoning: "none" as const,
      initialPrompt: "p",
      incrementalPrompt: "TOOL RESULT call_1: ok",
      recoveryPrompt: "p",
      promptContractVersion: 10,
      actionEnvelopeDigest: "digest",
      toolContinuation: true,
      toolRepairPrompt: undefined,
      offeredActions: ["question"] as readonly string[],
      attachments: [] as readonly { readonly kind: "image" | "file" }[],
      promptKey: undefined as string | undefined,
      offeredToolSchemas: [questionSchema] as readonly { readonly name: string; readonly inputSchema: unknown }[],
      provisionedActions: [] as readonly string[],
    } as never
    const frames: BrowserFrame[] = []
    for await (const frame of service.turn(base)) frames.push(frame)
    expect(adapterTurns).toBe(2)
    expect(JSON.stringify(frames)).toContain("which file?")
  })

  test("embedded bare envelope across text frames triggers provision", async () => {
    const questionSchema = {
      name: "question",
      description: "Ask the user a question",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    }
    let adapterTurns = 0
    const adapter = {
      async *turn(input: { initialPrompt: string }) {
        adapterTurns++
        if (adapterTurns === 1) {
          yield { type: "text", delta: "Sure, " } as BrowserFrame
          yield { type: "text", delta: JSON.stringify({ type: "question", id: "q1", input: {} }) } as BrowserFrame
          yield { type: "finish", reason: "stop" } as BrowserFrame
          return
        }
        yield { type: "text", delta: '<aipass-envelope>{"type":"question","id":"q2","input":{"query":"which file?"}}</aipass-envelope>' } as BrowserFrame
        yield { type: "finish", reason: "stop" } as BrowserFrame
      },
      async login() {},
      async close() {},
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
    const input = {
      sessionMarker: "marker-provision-embedded-bare",
      ephemeral: false,
      primingPrompts: [],
      modelID: "gpt-5.6-terra",
      reasoning: "none" as const,
      initialPrompt: "ask-me-which-file using the question tool",
      incrementalPrompt: "ask-me-which-file using the question tool",
      recoveryPrompt: "ask-me-which-file using the question tool",
      promptContractVersion: 10,
      actionEnvelopeDigest: "digest",
      toolContinuation: false,
      toolRepairPrompt: undefined,
      offeredActions: ["question", "read"] as readonly string[],
      attachments: [] as readonly { readonly kind: "image" | "file" }[],
      promptKey: undefined as string | undefined,
      offeredToolSchemas: [questionSchema, { name: "read", inputSchema: { type: "object" } }] as readonly { readonly name: string; readonly inputSchema: unknown }[],
      provisionedActions: [] as readonly string[],
    } as never
    const frames: BrowserFrame[] = []
    for await (const frame of service.turn(input)) frames.push(frame)
    expect(adapterTurns).toBe(2)
    expect(JSON.stringify(frames)).toContain("which file?")
  })
})

describe("duplicate-submit single-flight", () => {
  function turnInput(marker: string, text: string) {
    return {
      sessionMarker: marker,
      ephemeral: false,
      primingPrompts: [],
      modelID: "gpt-5.6-terra",
      reasoning: "none" as const,
      initialPrompt: text,
      incrementalPrompt: text,
      recoveryPrompt: text,
      promptContractVersion: 10,
      actionEnvelopeDigest: "digest",
      toolContinuation: false,
      toolRepairPrompt: undefined,
      offeredActions: [] as readonly string[],
      attachments: [] as readonly { readonly kind: "image" | "file" }[],
      promptKey: undefined as string | undefined,
      offeredToolSchemas: [] as readonly { readonly name: string; readonly inputSchema: unknown }[],
      provisionedActions: [] as readonly string[],
    }
  }

  test("prompt hash matches the attempt path sha256 derivation", async () => {
    const { createHash } = await import("node:crypto")
    expect(promptHashForSingleFlight("hello")).toBe(createHash("sha256").update("hello").digest("hex"))
  })

  test("duplicate same marker plus same hash serves stored frames with no second adapter turn", async () => {
    let adapterTurns = 0
    const adapter = {
      async *turn() {
        adapterTurns++
        yield { type: "text", delta: "done" } as BrowserFrame
        yield { type: "finish", reason: "stop" } as BrowserFrame
      },
      async login() {},
      async close() {},
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
    const first: BrowserFrame[] = []
    for await (const frame of service.turn(turnInput("marker-a", "same prompt"))) first.push(frame)
    const second: BrowserFrame[] = []
    for await (const frame of service.turn(turnInput("marker-a", "same prompt"))) second.push(frame)
    expect(adapterTurns).toBe(1)
    expect(second).toEqual(first)
    expect(second).toContainEqual({ type: "text", delta: "done" })
  })

  test("different hash still recovers with a second adapter turn", async () => {
    let adapterTurns = 0
    const adapter = {
      async *turn() {
        adapterTurns++
        yield { type: "text", delta: `turn-${adapterTurns}` } as BrowserFrame
        yield { type: "finish", reason: "stop" } as BrowserFrame
      },
      async login() {},
      async close() {},
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
    const first: BrowserFrame[] = []
    for await (const frame of service.turn(turnInput("marker-b", "first prompt"))) first.push(frame)
    const second: BrowserFrame[] = []
    for await (const frame of service.turn(turnInput("marker-b", "second prompt"))) second.push(frame)
    expect(adapterTurns).toBe(2)
    expect(first).not.toEqual(second)
  })

  test("concurrent same hash waits for the leader with one adapter turn", async () => {
    let adapterTurns = 0
    let releaseLeader!: () => void
    const gate = new Promise<void>((resolve) => (releaseLeader = resolve))
    const adapter = {
      async *turn() {
        adapterTurns++
        await gate
        yield { type: "text", delta: "leader-done" } as BrowserFrame
        yield { type: "finish", reason: "stop" } as BrowserFrame
      },
      async login() {},
      async close() {},
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 5_000 })
    const input = turnInput("marker-concurrent", "same prompt")
    const followerCollected: BrowserFrame[] = []
    const leader = (async () => {
      const frames: BrowserFrame[] = []
      for await (const frame of service.turn(input)) frames.push(frame)
      return frames
    })()
    await Bun.sleep(10)
    const follower = (async () => {
      for await (const frame of service.turn(input)) followerCollected.push(frame)
      return followerCollected
    })()
    await Bun.sleep(10)
    expect(adapterTurns).toBe(1)
    releaseLeader()
    const [leaderFrames, followerFrames] = await Promise.all([leader, follower])
    expect(adapterTurns).toBe(1)
    expect(followerFrames).toEqual(leaderFrames)
    expect(followerFrames).toContainEqual({ type: "text", delta: "leader-done" })
  })

  test("flight hash follows the attempt path for cross-origin and reset contexts", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { BindingStore } = await import("./state.ts")
    const chatURL = "https://chat.test/c/123"
    const dir = await mkdtemp(join(tmpdir(), "aipass-flight-"))
    try {
      const base = {
        ...turnInput("marker-bound", "same"),
        promptContractVersion: 7,
        actionEnvelopeDigest: "digest-7",
        toolContinuation: false,
      }
      const runTwo = async (store: InstanceType<typeof BindingStore>, first: typeof base, second: typeof base) => {
        let adapterTurns = 0
        const adapter = {
          async *turn() {
            adapterTurns++
            yield { type: "text", delta: `t${adapterTurns}` } as BrowserFrame
            yield { type: "finish", reason: "stop" } as BrowserFrame
          },
          async login() {},
          async close() {},
        }
        const service = new StandaloneBrowserService(adapter as never, { waitMs: 50, store, chatURL } as never)
        for await (const frame of service.turn(first)) void frame
        for await (const frame of service.turn(second)) void frame
        return adapterTurns
      }
      const fresh = () => new BindingStore(join(dir, `b-${Math.random().toString(36).slice(2)}.json`))
      const crossOrigin = fresh()
      await crossOrigin.bind(base.sessionMarker, "https://other.test/c/999")
      await crossOrigin.complete(
        base.sessionMarker,
        { id: "a3", promptHash: "h", status: "complete" as const, updatedAt: Date.now() },
        "https://other.test/c/999",
        0,
        7,
        "digest-7",
      )
      expect(
        await runTwo(
          crossOrigin,
          { ...base, initialPrompt: "A", incrementalPrompt: "B", recoveryPrompt: "C" },
          { ...base, initialPrompt: "A", incrementalPrompt: "DIFFERENT", recoveryPrompt: "OTHER" },
        ),
      ).toBe(1)
      const resetStore = fresh()
      await resetStore.bind(base.sessionMarker, chatURL)
      await resetStore.complete(
        base.sessionMarker,
        { id: "a4", promptHash: "h", status: "complete" as const, updatedAt: Date.now() },
        chatURL,
        0,
        7,
        "old-digest",
      )
      const resetFirst = { ...base, initialPrompt: "A", incrementalPrompt: "B", recoveryPrompt: "C", actionEnvelopeDigest: "a0-new" }
      const resetSecond = { ...base, initialPrompt: "A", incrementalPrompt: "B2", recoveryPrompt: "C2", actionEnvelopeDigest: "a0-new" }
      expect(await runTwo(resetStore, resetFirst, resetSecond)).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("bounds markers bytes and TTL", async () => {
    const store = new SingleFlightCompletionStore({ maxMarkers: 2, maxBytes: 64, ttlMs: 10 })
    store.set("m1", "h1", [{ type: "text", delta: "x".repeat(40) } as BrowserFrame])
    store.set("m2", "h2", [{ type: "text", delta: "y".repeat(40) } as BrowserFrame])
    store.set("m3", "h3", [{ type: "text", delta: "z" } as BrowserFrame])
    expect(store.get("m1", "h1")).toBeUndefined()
    expect(store.get("m3", "h3")).toBeDefined()
    await Bun.sleep(20)
    expect(store.get("m3", "h3")).toBeUndefined()
  })

  test("unshown envelope declaration triggers exactly one provision pass", async () => {
    const questionSchema = {
      name: "question",
      description: "Ask the user a question",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    }
    let adapterTurns = 0
    const seenPrompts: string[] = []
    const adapter = {
      async *turn(input: { initialPrompt: string }) {
        adapterTurns++
        seenPrompts.push(input.initialPrompt)
        if (adapterTurns === 1) {
          yield { type: "text", delta: '<aipass-envelope>{"type":"question","id":"q1","input":{}}</aipass-envelope>' } as BrowserFrame
          yield { type: "finish", reason: "stop" } as BrowserFrame
          return
        }
        yield { type: "text", delta: '<aipass-envelope>{"type":"question","id":"q2","input":{"query":"which file?"}}</aipass-envelope>' } as BrowserFrame
        yield { type: "finish", reason: "stop" } as BrowserFrame
      },
      async login() {},
      async close() {},
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
    const input = {
      ...turnInput("marker-provision", "ask-me-which-file using the question tool"),
      offeredActions: ["question", "read"],
      offeredToolSchemas: [questionSchema, { name: "read", inputSchema: { type: "object" } }],
      provisionedActions: [],
    } as never
    const frames: BrowserFrame[] = []
    for await (const frame of service.turn(input)) frames.push(frame)
    expect(adapterTurns).toBe(2)
    expect(seenPrompts[1]).toContain('"name":"question"')
    expect(seenPrompts[1]).toContain('"inputSchema"')
    expect(seenPrompts[1]).not.toContain('"name":"read"')
    expect(JSON.stringify(frames)).toContain("which file?")
  })

  test("bare JSON typed envelope in text frames triggers provision when required keys missing", async () => {
    const questionSchema = {
      name: "question",
      description: "Ask the user a question",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    }
    let adapterTurns = 0
    const seenPrompts: string[] = []
    const adapter = {
      async *turn(input: { initialPrompt: string }) {
        adapterTurns++
        seenPrompts.push(input.initialPrompt)
        if (adapterTurns === 1) {
          yield { type: "text", delta: JSON.stringify({ type: "question", id: "q1", input: {} }) } as BrowserFrame
          yield { type: "finish", reason: "stop" } as BrowserFrame
          return
        }
        yield { type: "text", delta: '<aipass-envelope>{"type":"question","id":"q2","input":{"query":"which file?"}}</aipass-envelope>' } as BrowserFrame
        yield { type: "finish", reason: "stop" } as BrowserFrame
      },
      async login() {},
      async close() {},
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
    const input = {
      ...turnInput("marker-provision-bare", "ask-me-which-file using the question tool"),
      offeredActions: ["question", "read"],
      offeredToolSchemas: [questionSchema, { name: "read", inputSchema: { type: "object" } }],
      provisionedActions: [],
    } as never
    const frames: BrowserFrame[] = []
    for await (const frame of service.turn(input)) frames.push(frame)
    expect(adapterTurns).toBe(2)
    expect(seenPrompts[1]).toContain('"name":"question"')
    expect(seenPrompts[1]).toContain('"inputSchema"')
    expect(JSON.stringify(frames)).toContain("which file?")
  })

  test("typeless bare JSON envelope in text frames triggers provision when required keys missing", async () => {
    const questionSchema = {
      name: "question",
      description: "Ask the user a question",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    }
    let adapterTurns = 0
    const seenPrompts: string[] = []
    const adapter = {
      async *turn(input: { initialPrompt: string }) {
        adapterTurns++
        seenPrompts.push(input.initialPrompt)
        if (adapterTurns === 1) {
          yield { type: "text", delta: JSON.stringify({ id: "q1", name: "question", input: {} }) } as BrowserFrame
          yield { type: "finish", reason: "stop" } as BrowserFrame
          return
        }
        yield { type: "text", delta: '<aipass-envelope>{"type":"question","id":"q2","input":{"query":"which file?"}}</aipass-envelope>' } as BrowserFrame
        yield { type: "finish", reason: "stop" } as BrowserFrame
      },
      async login() {},
      async close() {},
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
    const input = {
      ...turnInput("marker-provision-typeless-bare", "ask-me-which-file using the question tool"),
      offeredActions: ["question", "read"],
      offeredToolSchemas: [questionSchema, { name: "read", inputSchema: { type: "object" } }],
      provisionedActions: [],
    } as never
    const frames: BrowserFrame[] = []
    for await (const frame of service.turn(input)) frames.push(frame)
    expect(adapterTurns).toBe(2)
    expect(seenPrompts[1]).toContain('"name":"question"')
    expect(seenPrompts[1]).toContain('"inputSchema"')
    expect(JSON.stringify(frames)).toContain("which file?")
  })

  test("shown envelope declaration dispatches directly with no extra pass", async () => {
    const questionSchema = {
      name: "question",
      description: "Ask the user a question",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    }
    let adapterTurns = 0
    const adapter = {
      async *turn() {
        adapterTurns++
        yield { type: "text", delta: '<aipass-envelope>{"type":"question","id":"q1","input":{"query":"which file?"}}</aipass-envelope>' } as BrowserFrame
        yield { type: "finish", reason: "stop" } as BrowserFrame
      },
      async login() {},
      async close() {},
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
    const input = {
      ...turnInput("marker-provision-shown", "ask-me-which-file using the question tool"),
      offeredActions: ["question", "read"],
      offeredToolSchemas: [questionSchema, { name: "read", inputSchema: { type: "object" } }],
      provisionedActions: ["question"],
    } as never
    const frames: BrowserFrame[] = []
    for await (const frame of service.turn(input)) frames.push(frame)
    expect(adapterTurns).toBe(1)
    expect(JSON.stringify(frames)).toContain("which file?")
  })

  test("unshown declaration with all required keys dispatches directly (fast path)", async () => {
    const questionSchema = {
      name: "question",
      description: "Ask the user a question",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    }
    let adapterTurns = 0
    const adapter = {
      async *turn() {
        adapterTurns++
        yield { type: "text", delta: '<aipass-envelope>{"type":"question","id":"q1","input":{"query":"which file?"}}</aipass-envelope>' } as BrowserFrame
        yield { type: "finish", reason: "stop" } as BrowserFrame
      },
      async login() {},
      async close() {},
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
    const input = {
      ...turnInput("marker-provision-fast", "ask-me-which-file using the question tool"),
      offeredActions: ["question"],
      offeredToolSchemas: [questionSchema],
      provisionedActions: [],
    } as never
    const frames: BrowserFrame[] = []
    for await (const frame of service.turn(input)) frames.push(frame)
    expect(adapterTurns).toBe(1)
    expect(JSON.stringify(frames)).toContain("which file?")
  })

  test("shown declaration missing required keys still provisions", async () => {
    const questionSchema = {
      name: "question",
      description: "Ask the user a question",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    }
    let adapterTurns = 0
    const seenPrompts: string[] = []
    const adapter = {
      async *turn(input: { initialPrompt: string }) {
        adapterTurns++
        seenPrompts.push(input.initialPrompt)
        if (adapterTurns === 1) {
          yield { type: "text", delta: '<aipass-envelope>{"type":"question","id":"q1","input":{}}</aipass-envelope>' } as BrowserFrame
          yield { type: "finish", reason: "stop" } as BrowserFrame
          return
        }
        yield { type: "text", delta: '<aipass-envelope>{"type":"question","id":"q2","input":{"query":"which file?"}}</aipass-envelope>' } as BrowserFrame
        yield { type: "finish", reason: "stop" } as BrowserFrame
      },
      async login() {},
      async close() {},
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
    const input = {
      ...turnInput("marker-provision-shown-missing", "hello"),
      offeredActions: ["question"],
      offeredToolSchemas: [questionSchema],
      provisionedActions: ["question"],
    } as never
    const frames: BrowserFrame[] = []
    for await (const frame of service.turn(input)) frames.push(frame)
    expect(adapterTurns).toBe(2)
    expect(seenPrompts[1]).toContain('"name":"question"')
    expect(JSON.stringify(frames)).toContain("which file?")
  })

  test("envelope-key forwards attachments plus promptKey to browser input", async () => {
    const seen: Array<{ promptKey?: string; attachments?: readonly unknown[] }> = []
    const adapter = {
      async *turn(input: { promptKey?: string; attachments?: readonly unknown[] }) {
        seen.push({ promptKey: input.promptKey, attachments: input.attachments })
        yield { type: "text", delta: '<aipass-envelope>{"type":"chat","id":"a","text":"hi","key":"key-123"}</aipass-envelope>' } as BrowserFrame
        yield { type: "finish", reason: "stop" } as BrowserFrame
      },
      async login() {},
      async close() {},
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
    const attachments = [{ kind: "file", filename: "a.txt", data: Buffer.from("hi").toString("base64") }]
    const input = {
      ...turnInput("marker-envelope-key-forward", "hello"),
      attachments,
      promptKey: "key-123",
    } as never
    const frames: BrowserFrame[] = []
    for await (const frame of service.turn(input)) frames.push(frame)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.promptKey).toBe("key-123")
    expect(seen[0]?.attachments).toEqual(attachments)
    expect(JSON.stringify(frames)).toContain("hi")
  })

  test("envelope-key mismatch triggers exactly one strict re-request", async () => {
    let adapterTurns = 0
    const seenKeys: Array<string | undefined> = []
    const adapter = {
      async *turn(input: { promptKey?: string }) {
        adapterTurns++
        seenKeys.push(input.promptKey)
        if (adapterTurns === 1) {
          yield { type: "text", delta: '<aipass-envelope>{"type":"chat","id":"a","text":"first","key":"WRONG"}</aipass-envelope>' } as BrowserFrame
          yield { type: "finish", reason: "stop" } as BrowserFrame
          return
        }
        yield { type: "text", delta: '<aipass-envelope>{"type":"chat","id":"b","text":"second","key":"key-123"}</aipass-envelope>' } as BrowserFrame
        yield { type: "finish", reason: "stop" } as BrowserFrame
      },
      async login() {},
      async close() {},
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
    const input = {
      ...turnInput("marker-envelope-key-retry", "hello"),
      promptKey: "key-123",
    } as never
    const frames: BrowserFrame[] = []
    for await (const frame of service.turn(input)) frames.push(frame)
    expect(adapterTurns).toBe(2)
    expect(seenKeys).toEqual(["key-123", "key-123"])
    const text = frames.map((frame) => (frame.type === "text" ? frame.delta : "")).join("")
    expect(text).toContain("second")
    expect(text).not.toContain("first")
    expect(envelopeKey(text)).toBe("key-123")

    let persistentTurns = 0
    const persistent = {
      async *turn() {
        persistentTurns++
        yield { type: "text", delta: `<aipass-envelope>{"type":"chat","id":"c${persistentTurns}","text":"wrong-${persistentTurns}","key":"WRONG"}</aipass-envelope>` } as BrowserFrame
        yield { type: "finish", reason: "stop" } as BrowserFrame
      },
      async login() {},
      async close() {},
    }
    const persistentService = new StandaloneBrowserService(persistent as never, { waitMs: 50 })
    const persistentFrames: BrowserFrame[] = []
    await expect(async () => {
      for await (const frame of persistentService.turn({
        ...turnInput("marker-envelope-key-once", "hello"),
        promptKey: "key-123",
      } as never)) persistentFrames.push(frame)
    }).toThrow("TURN KEY mismatch")
    expect(persistentTurns).toBe(2)
    expect(persistentFrames).toEqual([])
  })

  test("turn-key cache never replays a previous key and still reuses the same key", async () => {
    let turns = 0
    const adapter = {
      async *turn(input: { promptKey?: string }): AsyncGenerator<BrowserFrame> {
        turns++
        yield { type: "text", delta: JSON.stringify({ type: "chat", key: input.promptKey, id: "answer", text: "ok" }) }
        yield { type: "finish", reason: "stop" }
      },
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
    for (const key of ["k1", "k1", "k2"]) {
      const frames: BrowserFrame[] = []
      for await (const frame of service.turn({ ...turnInput("key-cache", "same prompt"), promptKey: key } as never))
        frames.push(frame)
      expect(envelopeKey(frames.filter(f => f.type === "text").map(f => f.delta).join(""))).toBe(key)
    }
    expect(turns).toBe(2)
  })

  for (const shape of ["bare-chain", "tagged-keyless-sibling", "bare-convertible"] as const) {
    test(`turn-key rejects ${shape} before exposing any frames`, async () => {
      let turns = 0
      const adapter = {
        async *turn(): AsyncGenerator<BrowserFrame> {
          turns++
          const good = JSON.stringify({ type: "thinking", key: "current", id: "r", text: "reason" })
          const bad = JSON.stringify({ type: "chat", key: "old", id: "c", text: "stale" })
          const keyless = JSON.stringify({ type: "chat", id: "c", text: "unattributed" })
          const text = shape === "bare-chain" ? `${good}\n${bad}`
            : shape === "tagged-keyless-sibling" ? `<aipass-envelope>${good}</aipass-envelope><aipass-envelope>${keyless}</aipass-envelope>`
            : JSON.stringify({ id: "tool", name: "read", input: { path: "." }, key: "old" })
          yield { type: "text", delta: text }
          yield { type: "finish", reason: "stop" }
        },
      }
      const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
      const frames: BrowserFrame[] = []
      await expect(async () => {
        for await (const frame of service.turn({
          ...turnInput(`key-${shape}`, "request"), promptKey: "current", offeredActions: ["read"],
          toolRepairPrompt: "repair format",
        } as never)) frames.push(frame)
      }).toThrow("TURN KEY mismatch")
      expect(turns).toBe(2)
      expect(frames).toEqual([])
    })
  }

  test("turn-key rejects a complete keyed envelope followed by a truncated bare envelope", async () => {
    let turns = 0
    const adapter = {
      async *turn(): AsyncGenerator<BrowserFrame> {
        turns++
        if (turns === 1) {
          yield { type: "text", delta: `${JSON.stringify({ type: "thinking", key: "current", id: "r", text: "reason" })}\n{\"type\":\"chat\",\"key\":\"current\"` }
          yield { type: "finish", reason: "stop" }
          return
        }
        yield { type: "text", delta: JSON.stringify({ type: "chat", key: "current", id: "answer", text: "retry" }) }
        yield { type: "finish", reason: "stop" }
      },
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
    const frames: BrowserFrame[] = []
    for await (const frame of service.turn({ ...turnInput("key-truncated-typed", "request"), promptKey: "current" } as never))
      frames.push(frame)
    expect(turns).toBe(2)
    expect(frames.map((frame) => frame.type === "text" ? frame.delta : "").join("")).toContain("retry")
    expect(JSON.stringify(frames)).not.toContain('"text":"reason"')
  })

  test("turn-key rejects a truncated typeless envelope but preserves ordinary JSON and quoted JSON in chat text", async () => {
    let malformedTurns = 0
    const malformed = {
      async *turn(): AsyncGenerator<BrowserFrame> {
        malformedTurns++
        yield { type: "text", delta: '{"name":"read","key":"current","id":"call"' }
        yield { type: "finish", reason: "stop" }
      },
    }
    const malformedService = new StandaloneBrowserService(malformed as never, { waitMs: 50 })
    await expect(async () => {
      for await (const _ of malformedService.turn({ ...turnInput("key-truncated-typeless", "request"), promptKey: "current" } as never)) {
        // The malformed response must never be exposed.
      }
    }).toThrow("TURN KEY mismatch")
    expect(malformedTurns).toBe(2)

    for (const [marker, text] of [
      ["key-ordinary-json", '{"answer":"ok"}'],
      ["key-quoted-json", `<aipass-envelope>${JSON.stringify({ type: "chat", key: "current", id: "answer", text: 'Example: {"type":"chat","key":"old"' })}</aipass-envelope>`],
    ] as const) {
      let turns = 0
      const adapter = {
        async *turn(): AsyncGenerator<BrowserFrame> {
          turns++
          yield { type: "text", delta: text }
          yield { type: "finish", reason: "stop" }
        },
      }
      const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
      const frames: BrowserFrame[] = []
      for await (const frame of service.turn({ ...turnInput(marker, "request"), promptKey: "current" } as never)) frames.push(frame)
      expect(turns).toBe(1)
      expect(frames).toHaveLength(2)
    }
  })

  test("turn-key validates provisioning responses before yielding or caching", async () => {
    let turns = 0
    const adapter = {
      async *turn(): AsyncGenerator<BrowserFrame> {
        turns++
        yield { type: "text", delta: JSON.stringify({
          type: "tool", key: turns === 1 ? "current" : "old", id: "call", name: "read",
          input: turns === 1 ? {} : { path: "." },
        }) }
        yield { type: "finish", reason: "stop" }
      },
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
    const frames: BrowserFrame[] = []
    await expect(async () => {
      for await (const frame of service.turn({
        ...turnInput("key-provision", "request"), promptKey: "current", offeredActions: ["read"],
        offeredToolSchemas: [{ name: "read", inputSchema: {
          type: "object", properties: { path: { type: "string" } }, required: ["path"],
        } }],
      } as never)) frames.push(frame)
    }).toThrow("TURN KEY mismatch")
    expect(turns).toBe(3)
    expect(frames).toEqual([])
  })

  test("envelope-key preserves legacy non-envelope text without re-request", async () => {
    let adapterTurns = 0
    const adapter = {
      async *turn() {
        adapterTurns++
        yield { type: "text", delta: "plain legacy answer" } as BrowserFrame
        yield { type: "finish", reason: "stop" } as BrowserFrame
      },
      async login() {},
      async close() {},
    }
    const service = new StandaloneBrowserService(adapter as never, { waitMs: 50 })
    const input = {
      ...turnInput("marker-envelope-key-legacy", "hello"),
      promptKey: "key-123",
    } as never
    const frames: BrowserFrame[] = []
    for await (const frame of service.turn(input)) frames.push(frame)
    expect(adapterTurns).toBe(1)
    expect(frames).toEqual([
      { type: "text", delta: "plain legacy answer" },
      { type: "finish", reason: "stop" },
    ])
    expect(hasEnvelopeShape("plain legacy answer")).toBe(false)
  })
})
