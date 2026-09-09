import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  endpointURL,
  ensureEndpointConfig,
  parseCommand,
  pathsFromRoot,
  selectionPlan,
  usage,
  type Environment,
} from "./config.ts"
import {
  StreamFrameParser,
  StructuredToolShim,
  TypedEnvelopeShim,
  openAIChatCompletion,
  openAIChatSSE,
  openAIChatSSEChunks,
  openAIResponsesSSEChunks,
  parseTypedEnvelope,
  serializeToolDefinitions,
} from "./protocol.ts"
import { BindingStore, pendingDecision, ProfileLock, readOrCreateToken } from "./state.ts"
import { authorize, messageAttachments, parseOpenAIChatRequest, parseOpenAIResponsesRequest } from "./http.ts"
import { estimateTokens } from "./context.ts"

const temporary: string[] = []

function expectStartupPrompts(primingPrompts: readonly string[], instructions: readonly string[] = [], tools: readonly string[] = []) {
  expect(primingPrompts).toHaveLength(instructions.length + tools.length + 1)
  expect(primingPrompts[0]).toContain("You are a text-generation assistant working only as the backend.")
  expect(primingPrompts.join("\n").match(/READY/g)).toHaveLength(1)
  for (const [index, instruction] of instructions.entries()) {
    expect(primingPrompts[index + 1]).toContain(instruction)
    expect(primingPrompts[index + 1]).not.toContain("READY")
  }
  for (const [index, name] of tools.entries()) expect(primingPrompts[instructions.length + index + 1]).toContain(`"name":"${name}"`)
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function root() {
  const path = await mkdtemp(join(tmpdir(), "aipass-ts-"))
  temporary.push(path)
  return path
}

function environment(home: string): Environment {
  return { HOME: home }
}

describe("compiled CLI contract", () => {
  test("preserves help aliases and command options", () => {
    expect(parseCommand(["help"], environment("/tmp/home"))).toEqual({ type: "help" })
    expect(parseCommand(["--help"], environment("/tmp/home"))).toEqual({ type: "help" })
    expect(parseCommand(["-h"], environment("/tmp/home"))).toEqual({ type: "help" })

    const command = parseCommand(
      ["start", "--port", "43123", "--state-root", "/tmp/state", "--config", "/tmp/config.json", "--chrome", "/tmp/chrome"],
      environment("/tmp/home"),
      { verifyChrome: false },
    )
    expect(command.type).toBe("serve")
    if (command.type !== "serve") throw new Error("expected serve")
    expect(command.settings.requestedPort).toBe(43_123)
    expect(command.settings.paths.root).toBe("/tmp/state")
    expect(command.settings.configPath).toBe("/tmp/config.json")
    expect(command.settings.chromeExecutable).toBe("/tmp/chrome")
    expect(usage()).toContain("print-token")
    expect(() => parseCommand(["unknown"], environment("/tmp/home"))).toThrow("usage:")
  })

  test("preserves XDG paths and endpoint format", () => {
    const command = parseCommand(["endpoint"], {
      HOME: "/tmp/home",
      XDG_CONFIG_HOME: "/tmp/config",
      XDG_STATE_HOME: "/tmp/state",
    })
    if (command.type !== "endpoint") throw new Error("expected endpoint")
    expect(command.settings.configPath).toBe("/tmp/config/aipass-browser-provider/config.json")
    expect(command.settings.paths).toEqual(pathsFromRoot("/tmp/state/aipass-browser-provider"))
    expect(endpointURL({ version: 1, host: "127.0.0.1", port: 43_123 })).toBe("http://127.0.0.1:43123/v1")
  })

  test("bootstraps and reuses a private runtime endpoint config", async () => {
    const home = await root()
    const command = parseCommand(["endpoint"], environment(home))
    if (command.type !== "endpoint") throw new Error("expected endpoint")
    const first = await ensureEndpointConfig(command.settings)
    const second = await ensureEndpointConfig(command.settings)
    expect(second).toEqual(first)
    expect(first.host).toBe("127.0.0.1")
    expect(first.port).toBeGreaterThan(0)
    expect((await stat(command.settings.configPath)).mode & 0o777).toBe(0o600)
  })

  test("keeps the verified model and reasoning selection plan", () => {
    expect(selectionPlan("gpt-5.6-terra", "low")).toEqual([
      { type: "choose-thinking", index: 0 },
      { type: "confirm" },
    ])
    expect(selectionPlan("gemini-3.1-flash-lite", "none")).toEqual([{ type: "select-last" }])
    expect(() => selectionPlan("gpt-5.6-terra", "max")).toThrow("does not support")
  })

  test("observability defaults to headed with no screenshots", () => {
    const command = parseCommand(["start", "--chrome", "/tmp/chrome"], environment("/tmp/home"), {
      verifyChrome: false,
    })
    if (command.type !== "serve") throw new Error("expected serve")
    expect(command.settings.browserHeaded).toBe(true)
    expect(command.settings.screenshotDir).toBeUndefined()
  })

  test("observability env disables headed and sets screenshot dir", () => {
    const command = parseCommand(["start", "--chrome", "/tmp/chrome"], {
      HOME: "/tmp/home",
      AIPASS_BROWSER_HEADED: "0",
      AIPASS_SCREENSHOT_DIR: "/tmp/shots",
    }, { verifyChrome: false })
    if (command.type !== "serve") throw new Error("expected serve")
    expect(command.settings.browserHeaded).toBe(false)
    expect(command.settings.screenshotDir).toBe("/tmp/shots")
  })
})

describe("durable compatible state", () => {
  test("creates one private stable credential", async () => {
    const state = await root()
    const paths = pathsFromRoot(state)
    const first = await readOrCreateToken(paths)
    const second = await readOrCreateToken(paths)
    expect(second).toBe(first)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect((await stat(paths.credential)).mode & 0o777).toBe(0o600)
  })

  test("reads and writes the existing version-one binding schema", async () => {
    const state = await root()
    const path = join(state, "bindings.json")
    const store = new BindingStore(path)
    await store.bind("session-a", "https://example.test/chat/remote")
    await store.attempt("session-a", {
      id: "attempt-1",
      promptHash: "hash-1",
      status: "pending",
      updatedAt: 1,
    })
    const restored = await new BindingStore(path).get("session-a")
    expect(restored?.remoteChatID).toBe("https://example.test/chat/remote")
    expect(restored?.attempt?.promptHash).toBe("hash-1")
    expect(pendingDecision(restored?.attempt, "hash-1")).toBe("fail-closed")
    expect(pendingDecision(restored?.attempt, "hash-2")).toBe("recover")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const encoded = JSON.parse(await readFile(path, "utf8"))
    expect(encoded.version).toBe(1)
    expect(encoded.sessions["session-a"].updatedAt).toBeNumber()
  })

  test("rotates compacted remote context and accounts a completed attempt once", async () => {
    const state = await root()
    const store = new BindingStore(join(state, "bindings.json"))
    await store.bind("session-a", "https://example.test/chat/old")
    expect(await store.rotate("session-a", "digest-a")).toBe(true)
    expect((await store.get("session-a"))?.remoteChatID).toBeUndefined()
    expect((await store.get("session-a"))?.context).toMatchObject({
      epoch: 1,
      compactionDigest: "digest-a",
      estimatedTokens: 0,
    })
    expect(await store.rotate("session-a", "digest-a")).toBe(false)
    const completed = { id: "attempt-a", promptHash: "hash-a", status: "complete" as const, updatedAt: 2 }
    await store.complete("session-a", completed, "https://example.test/chat/new", 120, 1, "envelope-a")
    await store.complete("session-a", completed, "https://example.test/chat/new", 120, 1, "envelope-a")
    expect((await store.get("session-a"))?.context).toMatchObject({
      estimatedTokens: 120,
      accountedAttemptID: "attempt-a",
      promptContractVersion: 1,
      actionEnvelopeDigest: "envelope-a",
    })
    const incremental = { id: "attempt-b", promptHash: "hash-b", status: "complete" as const, updatedAt: 3 }
    await store.attempt("session-a", incremental)
    await store.complete("session-a", incremental, "https://example.test/chat/new", 25, undefined, undefined)
    expect((await store.get("session-a"))?.context).toMatchObject({
      estimatedTokens: 145,
      accountedAttemptID: "attempt-b",
      promptContractVersion: 1,
      actionEnvelopeDigest: "envelope-a",
    })
    await store.remove("session-a")
    expect(await store.get("session-a")).toBeUndefined()
  })

  test("rejects a second live profile owner and releases cleanly", async () => {
    const state = await root()
    const paths = pathsFromRoot(state)
    const first = await ProfileLock.acquire(paths)
    await expect(ProfileLock.acquire(paths)).rejects.toThrow("already owned")
    await first.release()
    const second = await ProfileLock.acquire(paths)
    await second.release()
  })
})

describe("OpenAI stream and tool bridge", () => {
  test("parses split SSE and preserves reasoning separately", () => {
    const parser = new StreamFrameParser()
    expect(parser.push('data: {"type":"reason')).toEqual([])
    expect(parser.push('ing","delta":"R"}\n\ndata: {"type":"text","delta":"T"}\n')).toEqual([
      { type: "reasoning", delta: "R" },
    ])
    expect(parser.push("\ndata: [DONE]\n\n")).toEqual([
      { type: "text", delta: "T" },
      { type: "finish", reason: "stop" },
    ])
  })

  test("allows only offered structured tool calls", () => {
    const shim = new StructuredToolShim(new Set(["read"]))
    expect(shim.push('<aipass-action>{"id":"call_1","name":"read","input":{"path":"README.md"}}</aipass-action>')).toEqual([
      { type: "tool-call", id: "call_1", name: "read", input: { path: "README.md" } },
    ])
    const rejected = new StructuredToolShim(new Set(["read"]))
    expect(() => rejected.push('<aipass-action>{"id":"call_2","name":"shell","input":{}}</aipass-action>')).toThrow(
      "not offered",
    )
    const bridge = serializeToolDefinitions([
      { name: "read", description: "Read a local path", inputSchema: { type: "object" } },
    ])
    expect(bridge).toContain('"description":"Read a local path"')
    expect(bridge).toContain("<aipass-action>")
    expect(bridge).toContain("request the calling client")
  })

  test("emits one terminal OpenAI finish and DONE marker", async () => {
    const output = await openAIChatSSE(
      "gpt-5.6-terra",
      [
        { type: "reasoning", delta: "R" },
        { type: "text", delta: "OK" },
        { type: "finish", reason: "stop" },
      ],
      new Set(),
    )
    expect(output).toContain('"reasoning_content":"R"')
    expect(output).toContain('"content":"OK"')
    expect(output.match(/"finish_reason":"stop"/g)).toHaveLength(1)
    expect(output.endsWith("data: [DONE]\n\n")).toBe(true)
  })

  test("estimates streaming completion usage from the complete output", async () => {
    const frames = [
      { type: "text" as const, delta: "O" },
      { type: "text" as const, delta: "K" },
      { type: "finish" as const, reason: "stop" as const },
    ]
    const completion = await openAIChatCompletion("gpt-5.6-terra", frames, new Set(), 0)
    const chatChunks: string[] = []
    for await (const chunk of openAIChatSSEChunks("gpt-5.6-terra", frames, new Set(), { includeUsage: true }))
      chatChunks.push(chunk)
    const chatUsage = chatChunks
      .map((chunk) => chunk.startsWith("data: {") ? JSON.parse(chunk.slice(6)) : undefined)
      .find((chunk) => chunk?.usage)?.usage
    const responseChunks: string[] = []
    for await (const chunk of openAIResponsesSSEChunks("resp_usage", "gpt-5.6-terra", frames, new Set(), { promptTokens: 0 }))
      responseChunks.push(chunk)
    const responseUsage = JSON.parse(responseChunks.at(-1)?.split("\ndata: ")[1] ?? "{}").response.usage
    expect(completion.usage.completion_tokens).toBe(1)
    expect(chatUsage.completion_tokens).toBe(completion.usage.completion_tokens)
    expect(responseUsage.output_tokens).toBe(completion.usage.completion_tokens)
  })
})

describe("authenticated OpenAI request boundary", () => {
  test("preserves inline instruction whitespace and Unicode through a trimming UTF-8 transport", () => {
    const instructions = "  รักษากฎ🙂  \n\t".repeat(900) + "END CONTEXT PART 1/1\n"
    const requests = [
      { role: "SYSTEM", request: parseOpenAIChatRequest({
        model: "gemini-3.1-flash-lite", instruction_mode: "preserve",
        messages: [{ role: "system", content: instructions }, { role: "user", content: "Reply ready." }],
      }, new Headers()) },
      { role: "DEVELOPER", request: parseOpenAIResponsesRequest({
        model: "gemini-3.1-flash-lite", instruction_mode: "preserve",
        instructions, input: "Reply ready.",
      }, new Headers()) },
    ]
    for (const { role, request: { turn } } of requests) {
      expectStartupPrompts(turn.primingPrompts, [`${role}: ${instructions}`])
      for (const prompt of [turn.initialPrompt, turn.incrementalPrompt, turn.recoveryPrompt]) {
        const transmitted = Buffer.from(prompt.trimEnd()).toString("utf8")
        expect(transmitted).not.toContain(instructions)
        expect(transmitted).toContain("USER: Reply ready.")
      }
    }
  })

  test("primes client instructions and all schemas separately from initial and recovery tasks", () => {
    const parsed = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [
          { role: "system", content: "PRIVATE_SYSTEM" },
          { role: "developer", content: "USE_LOCAL_TOOLS" },
          { role: "user", content: [{ type: "text", text: "hello" }] },
          { role: "assistant", content: "previous" },
          { role: "user", content: "next" },
        ],
        reasoning: { mode: "low" },
        tools: [{ type: "function", function: { name: "read", description: "not forwarded", parameters: { type: "object" } } }],
      },
      new Headers({ "x-session-id": " session-a " }),
    )
    expect(parsed.turn.sessionMarker).toBe("session-a")
    expect(parsed.turn.ephemeral).toBe(false)
    expect(parsed.turn.reasoning).toBe("low")
    expectStartupPrompts(parsed.turn.primingPrompts, ["SYSTEM: PRIVATE_SYSTEM", "DEVELOPER: USE_LOCAL_TOOLS"], ["read"])
    expect(parsed.turn.initialPrompt).not.toContain("PRIVATE_SYSTEM")
    expect(parsed.turn.initialPrompt).not.toContain("USE_LOCAL_TOOLS")
    expect(parsed.turn.initialPrompt).toContain("USER: hello")
    expect(parsed.turn.primingPrompts.join("\n")).toContain('"description":"not forwarded"')
    expect(parsed.turn.primingPrompts.join("\n")).toContain('"name":"read"')
    expect(parsed.turn.initialPrompt).not.toContain('"inputSchema"')
    expect(parsed.turn.toolRepairPrompt).toContain("emit exactly one action frame")
    expect(parsed.turn.toolRepairPrompt).not.toContain('"inputSchema"')
    expect(parsed.turn.toolRepairPrompt).toContain("Do not override safety")
    expect(parsed.turn.toolRepairPrompt).not.toContain("Do not repeat that refusal")
    expect(parsed.turn.incrementalPrompt).toBe("USER: next")
    expect(parsed.turn.incrementalPrompt).not.toContain("PRIVATE_SYSTEM")
    expect(parsed.turn.incrementalPrompt).not.toContain('"name":"read"')
    expect(parsed.turn.incrementalPrompt).not.toContain("<aipass-action>")
    expect(parsed.turn.promptContractVersion).toBe(23)
    expect(parsed.turn.actionEnvelopeDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(parsed.turn.toolContinuation).toBe(false)
    expect(parsed.turn.recoveryPrompt).not.toContain("PRIVATE_SYSTEM")
    expect(parsed.turn.recoveryPrompt).not.toContain("USE_LOCAL_TOOLS")
    expect(parsed.turn.recoveryPrompt).toContain("USER: next")
    expect(parsed.turn.recoveryPrompt).not.toContain("Offered actions")
    expect(parsed.turn.recoveryPrompt).not.toContain("not forwarded")
    expect(parsed.turn.recoveryPrompt).not.toContain('"inputSchema"')
    expect(parsed.turn.recoveryPrompt).toContain("ASSISTANT: previous")
    expect(parsed.turn.recoveryPrompt).toBe(parsed.turn.initialPrompt)
    expect(parsed.turn.incrementalPrompt).not.toContain("ASSISTANT: previous")
    expect(parsed.offered).toEqual(new Set(["read"]))

    const continuation = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        instruction_mode: "action-only",
        messages: [
          { role: "user", content: "List the files in the current directory and return their names." },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"path":"package.json"}' } }],
          },
          { role: "tool", tool_call_id: "call_1", content: "result" },
          {
            role: "user",
            content: "<system-update>\nThe client completed its current orchestration step.\n</system-update>",
          },
        ],
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
      },
      new Headers({ "x-session-affinity": "session-a" }),
    )
    expect(continuation.turn.toolContinuation).toBe(true)
    expect(continuation.turn.toolRepairPrompt).toBeUndefined()
    expect(continuation.turn.incrementalPrompt).toContain("TOOL RESULT call_1: result")
    expect(continuation.turn.incrementalPrompt).not.toContain("system-update")
    expect(continuation.turn.recoveryPrompt).toContain("USER: List the files in the current directory and return their names.")
    expect(continuation.turn.recoveryPrompt).toContain("TOOL RESULT call_1: result")
    expect(continuation.turn.recoveryPrompt).not.toContain("system-update")
    expect(continuation.projectedActions).toEqual(["read"])

    const generic = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [
          { role: "system", content: "GENERIC_SYSTEM" },
          { role: "developer", content: "GENERIC_DEVELOPER" },
          { role: "user", content: "hello" },
        ],
        reasoning_effort: "medium",
      },
      new Headers(),
    )
    expectStartupPrompts(generic.turn.primingPrompts, ["SYSTEM: GENERIC_SYSTEM", "DEVELOPER: GENERIC_DEVELOPER"])
    expect(generic.turn.initialPrompt).not.toContain("GENERIC_SYSTEM")
    expect(generic.turn.initialPrompt).not.toContain("GENERIC_DEVELOPER")
    expect(generic.turn.reasoning).toBe("medium")
    expect(generic.turn.sessionMarker).toMatch(/^anon_/)
    expect(generic.turn.ephemeral).toBe(true)
    expect(generic.stream).toBe(false)
    const changedInstructions = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [
          { role: "system", content: "DIFFERENT_SYSTEM" },
          { role: "user", content: "hello" },
        ],
      },
      new Headers(),
    )
    expect(changedInstructions.turn.actionEnvelopeDigest).not.toBe(generic.turn.actionEnvelopeDigest)

    const storedResponse = parseOpenAIResponsesRequest(
      { model: "gpt-5.6-terra", input: "hello" },
      new Headers({ "x-session-id": "wrong-session" }),
    )
    const continuedResponse = parseOpenAIResponsesRequest(
      { model: "gpt-5.6-terra", input: "continue", previous_response_id: storedResponse.responseID },
      new Headers({ "x-session-id": "wrong-session" }),
      storedResponse.turn.sessionMarker,
    )
    expect(storedResponse.turn.ephemeral).toBe(false)
    expect(storedResponse.turn.sessionMarker).toBe(storedResponse.responseID)
    expect(continuedResponse.responseID).not.toBe(storedResponse.responseID)
    expect(continuedResponse.turn.sessionMarker).toBe(storedResponse.turn.sessionMarker)
    const unstoredResponse = parseOpenAIResponsesRequest(
      { model: "gpt-5.6-terra", input: "hello", store: false },
      new Headers({ "x-session-id": "wrong-session" }),
    )
    expect(unstoredResponse.turn.ephemeral).toBe(true)
    expect(unstoredResponse.turn.sessionMarker).toMatch(/^anon_/)
    expect(() =>
      parseOpenAIResponsesRequest(
        {
          model: "gpt-5.6-terra",
          input: "continue",
          previous_response_id: storedResponse.responseID,
          store: false,
        },
        new Headers(),
        storedResponse.turn.sessionMarker,
      ),
    ).toThrow("store false cannot continue a stored response")

    const longInstruction = "KEEP_THIS_RULE. ".repeat(2_000)
    const primed = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [
          { role: "system", content: longInstruction },
          { role: "user", content: "hello" },
        ],
      },
      new Headers(),
    )
    expectStartupPrompts(primed.turn.primingPrompts, [`SYSTEM: ${longInstruction}`])
    expect(primed.turn.initialPrompt).not.toContain(longInstruction)
    expect(primed.turn.incrementalPrompt).toBe(primed.turn.initialPrompt)
    expect(primed.turn.recoveryPrompt).toBe(primed.turn.initialPrompt)
    expect(primed.turn.actionEnvelopeDigest).toStartWith("b0")
    expect(primed.promptTokens).toBeGreaterThan(estimateTokens(longInstruction))
    expect(primed.promptTokens).toBe(estimateTokens(primed.turn.initialPrompt) + primed.turn.primingPrompts.reduce((total, prompt) => total + estimateTokens(prompt), 0))

    const actionOnly = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [
          { role: "system", content: longInstruction },
          { role: "user", content: "hello" },
        ],
        instruction_mode: "action-only",
      },
      new Headers(),
    )
    expectStartupPrompts(actionOnly.turn.primingPrompts)
    expect(actionOnly.turn.initialPrompt).not.toContain("KEEP_THIS_RULE")
    expect(actionOnly.turn.actionEnvelopeDigest).toStartWith("a0")
    expect(actionOnly.promptTokens).toBe(estimateTokens(actionOnly.turn.initialPrompt) + actionOnly.turn.primingPrompts.reduce((total, prompt) => total + estimateTokens(prompt), 0))

    const tinyTools = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "hello" }],
        instruction_mode: "action-only",
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "Reads a file.",
              parameters: { type: "object", properties: { arg: { type: "string" } }, required: ["arg"] },
            },
          },
        ],
      },
      new Headers(),
    )
    expectStartupPrompts(tinyTools.turn.primingPrompts, [], ["read"])

    const bulkyBudget = ["read", "glob", "grep", "shell"].map((name) => ({
      type: "function",
      function: {
        name,
        description: `Tool ${name}. ${"detail ".repeat(600)}`,
        parameters: { type: "object", properties: { arg: { type: "string" } }, required: ["arg"] },
      },
    }))
    const capped = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "hello" }],
        instruction_mode: "action-only",
        tools: bulkyBudget,
      },
      new Headers(),
    )
    expectStartupPrompts(capped.turn.primingPrompts, [], bulkyBudget.map(tool => tool.function.name))
    expect(capped.projectedActions).toEqual(bulkyBudget.map(tool => tool.function.name))
    expect(capped.turn.primingPrompts.join("\n")).toContain(bulkyBudget[0]!.function.description)
    expect(capped.turn.initialPrompt).toBe("USER: hello")
    expect(capped.turn.initialPrompt).not.toContain('"inputSchema"')

    const namedBulky = ["subagent"].map((name) => ({
      type: "function",
      function: {
        name,
        description: `Tool ${name}. ${"detail ".repeat(600)}`,
        parameters: { type: "object", properties: { arg: { type: "string" } }, required: ["arg"] },
      },
    }))
    const named = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "spawn a subagent to help" }],
        instruction_mode: "action-only",
        tools: namedBulky,
      },
      new Headers(),
    )
    expect(named.projectedActions).toEqual(["subagent"])
    expectStartupPrompts(named.turn.primingPrompts, [], ["subagent"])
    expect(named.turn.primingPrompts.join("\n")).toContain(namedBulky[0]!.function.description)
    expect(named.turn.initialPrompt).toBe("USER: spawn a subagent to help")
    expect(named.turn.initialPrompt).not.toContain('"inputSchema"')

    const editFlow = ["edit", "read", "glob", "grep", "shell", "write"].map((name) => ({
      type: "function",
      function: {
        name,
        description:
          name === "edit"
            ? "Replace text in files by exact match"
            : name === "read"
              ? "Read file contents and directory listings"
              : name === "write"
                ? "Create a new file with given content"
                : `${name} op`,
        parameters: { type: "object", properties: {} },
      },
    }))
    const fixup = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "fix readme add header eiei at the beginning" }],
        tools: editFlow,
      },
      new Headers(),
    )
    expect(fixup.projectedActions).toEqual(editFlow.map(tool => tool.function.name))
    expectStartupPrompts(fixup.turn.primingPrompts, [], editFlow.map(tool => tool.function.name))
    expect(fixup.turn.primingPrompts.join("\n")).toContain('"name":"edit"')
    expect(fixup.turn.primingPrompts.join("\n")).toContain('"name":"read"')
    expect(fixup.turn.initialPrompt).not.toContain('"inputSchema"')

    const fitting = ["read", "glob", "grep", "shell", "write", "edit"].map((name) => ({
      type: "function",
      function: {
        name,
        description: `${name} op`,
        parameters: { type: "object", properties: {} },
      },
    }))
    const kept = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "hello" }],
        tools: fitting,
      },
      new Headers(),
    )
    expect(kept.projectedActions).toEqual(fitting.map(tool => tool.function.name))
    expect(kept.turn.initialPrompt).toBe("USER: hello")
    expect(kept.turn.primingPrompts.join("\n")).toContain('"name":"read"')
    expect(kept.turn.primingPrompts.join("\n")).toContain('"name":"glob"')
    expectStartupPrompts(kept.turn.primingPrompts, [], fitting.map(tool => tool.function.name))

    const midBudget = ["read", "glob", "grep", "shell", "write", "edit", "bash_exec", "webfetch"].map((name) => ({
      type: "function",
      function: {
        name,
        description: `Performs the ${name} operation. ${"detail ".repeat(45)}${"detail ".repeat(45)}`,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Target path." },
            pattern: { type: "string", description: "Filter pattern." },
          },
          required: ["path"],
        },
      },
    }))
    const trimmed = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "hello" }],
        tools: midBudget,
      },
      new Headers(),
    )
    expect(trimmed.projectedActions).toEqual(midBudget.map(tool => tool.function.name))
    expectStartupPrompts(trimmed.turn.primingPrompts, [], midBudget.map(tool => tool.function.name))
    expect(trimmed.turn.initialPrompt).toBe("USER: hello")
    expect(trimmed.turn.initialPrompt.length).toBeLessThan(4_000)

    const weakTools = ["read", "glob", "grep", "shell", "question"].map((name) => ({
      type: "function",
      function: {
        name,
        description: name === "question" ? "Ask what to do next" : `${name} file operation`,
        parameters: { type: "object", properties: {} },
      },
    }))
    const weak = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "uh what" }],
        tools: weakTools,
      },
      new Headers(),
    )
    expect(weak.projectedActions).toEqual(weakTools.map(tool => tool.function.name))
    expect(weak.turn.initialPrompt).toBe("USER: uh what")
    expectStartupPrompts(weak.turn.primingPrompts, [], weakTools.map(tool => tool.function.name))

    const affinityDefault = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [
          { role: "system", content: longInstruction },
          { role: "user", content: "hello" },
        ],
      },
      new Headers({ "x-session-affinity": "orchestration-session" }),
    )
    expectStartupPrompts(affinityDefault.turn.primingPrompts, [`SYSTEM: ${longInstruction}`])
    expect(affinityDefault.turn.initialPrompt).not.toContain("KEEP_THIS_RULE")
    expect(affinityDefault.turn.actionEnvelopeDigest).toStartWith("b0")

    const explicitPreserve = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [
          { role: "system", content: longInstruction },
          { role: "user", content: "hello" },
        ],
        instruction_mode: "preserve",
      },
      new Headers({ "x-session-affinity": "orchestration-session" }),
    )
    expectStartupPrompts(explicitPreserve.turn.primingPrompts, [`SYSTEM: ${longInstruction}`])
    expect(explicitPreserve.turn.actionEnvelopeDigest).toStartWith("b0")
    expect(affinityDefault.turn.initialPrompt).toBe(explicitPreserve.turn.initialPrompt)
    expect(affinityDefault.turn.primingPrompts).toEqual(explicitPreserve.turn.primingPrompts)
    expect(() =>
      parseOpenAIChatRequest(
        {
          model: "gpt-5.6-terra",
          messages: [{ role: "user", content: "hello" }],
          instruction_mode: "invalid",
        },
        new Headers(),
      ),
    ).toThrow("instruction_mode must be preserve or action-only")

    const chosen = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "act" }],
        tools: [
          { type: "function", function: { name: "read", parameters: { type: "object" } } },
          { type: "function", function: { name: "mail", parameters: { type: "object" } } },
        ],
        tool_choice: { type: "function", function: { name: "mail" } },
      },
      new Headers(),
    )
    expect(chosen.offered).toEqual(new Set(["mail"]))
    expect(chosen.projectedActions).toEqual(["mail"])
    expect(chosen.turn.primingPrompts.join("\n")).toContain('"name":"mail"')
    expect(chosen.turn.initialPrompt).not.toContain('"inputSchema"')
    expect(chosen.turn.initialPrompt).toContain("must request")
    expect(chosen.turn.toolRepairPrompt).toBeUndefined()
    expect(() =>
      parseOpenAIChatRequest(
        {
          model: "gpt-5.6-terra",
          messages: [{ role: "user", content: "act" }],
          tools: [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }],
          tool_choice: "required",
          stream: true,
        },
        new Headers(),
      ),
    ).toThrow("streaming with required tool_choice is not supported")

    const noTools = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "answer" }],
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
        tool_choice: "none",
      },
      new Headers(),
    )
    expect(noTools.offered.size).toBe(0)
    expect(noTools.turn.initialPrompt).not.toContain("<aipass-action>")
    expect(noTools.turn.toolRepairPrompt).toBeUndefined()

    expect(() =>
      parseOpenAIChatRequest(
        {
          model: "gpt-5.6-terra",
          messages: [{ role: "user", content: "hello" }],
          reasoning: { mode: "low" },
          reasoning_effort: "high",
        },
        new Headers(),
      ),
    ).toThrow("reasoning.mode conflicts with reasoning_effort")

    expect(() => parseOpenAIChatRequest({ model: "gpt-5.6-terra", messages: [] }, new Headers())).toThrow(
      "messages must be a non-empty array",
    )
    expect(() =>
      parseOpenAIChatRequest(
        { model: "gpt-5.6-terra", messages: [{ role: "user", content: "hello" }] },
        new Headers({ "x-session-id": "s".repeat(257) }),
      ),
    ).toThrow("session identifier is invalid")
  })

  test("primes the complete tool set for named, natural, and ambiguous requests", () => {
    const tool = (name: string, description: string) => ({
      type: "function",
      function: { name, description, parameters: { type: "object", properties: {} } },
    })
    const parsed = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "read package.json" }],
        tools: [
          tool("read", "Read a file or directory"),
          tool("mail", "Send an email message"),
          tool("calendar", "Create a calendar event"),
          tool("purchase", "Purchase an item"),
          tool("weather", "Read the weather forecast"),
          tool("music", "Play a song"),
          tool("image", "Generate an image"),
        ],
      },
      new Headers({ "x-session-id": "session-b" }),
    )
    expectStartupPrompts(parsed.turn.primingPrompts, [], ["read", "mail", "calendar", "purchase", "weather", "music", "image"])
    expect(parsed.turn.initialPrompt).toBe("USER: read package.json")
    expect(parsed.turn.primingPrompts.join("\n")).toContain('"name":"mail"')
    expect(parsed.turn.primingPrompts.join("\n")).toContain('"inputSchema"')
    expect(parsed.turn.primingPrompts.join("\n")).toContain('"name":"read"')
    expect(parsed.projectedActions).toEqual(["read", "mail", "calendar", "purchase", "weather", "music", "image"])
    expect(parsed.turn.provisionedActions).toEqual(parsed.projectedActions)
    expect(parsed.offered.has("mail")).toBe(true)

    const directory = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "List the files in the current directory and return their names." }],
        tools: [
          tool("execute", "Execute a program against the current tool catalog and return selected fields"),
          tool("ntfy", "Send an attention notification when user attention is needed"),
          tool("shell", "Execute one shell command in the current working directory"),
          tool("skill", "Load a specialized skill and return its instructions"),
          tool("read", "Read a text file or list a directory page"),
          tool("glob", "Find files by glob pattern"),
        ],
      },
      new Headers(),
    )
    expect(directory.projectedActions).toEqual(["execute", "ntfy", "shell", "skill", "read", "glob"])
    expectStartupPrompts(directory.turn.primingPrompts, [], directory.projectedActions)

    const directoryWithSystemUpdate = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "List the files in the current directory and return their names.",
                  "<system-update>",
                  "The orchestration layer can use ntfy, execute, shell, or subagent when needed.",
                  "</system-update>",
                ].join("\n"),
              },
            ],
          },
        ],
        tools: [
          tool("ntfy", "Send an attention notification when user attention is needed"),
          tool("execute", "Execute a program against the current tool catalog and return selected fields"),
          tool("shell", "Execute one shell command in the current working directory"),
          tool("subagent", "Spawn a subagent to complete a bounded task"),
          tool("read", "Read a text file or list a directory page"),
          tool("glob", "Find files by glob pattern"),
        ],
      },
      new Headers(),
    )
    expect(directoryWithSystemUpdate.projectedActions).toEqual(["ntfy", "execute", "shell", "subagent", "read", "glob"])
    expectStartupPrompts(directoryWithSystemUpdate.turn.primingPrompts, [], directoryWithSystemUpdate.projectedActions)
    expect(directoryWithSystemUpdate.turn.initialPrompt.length).toBeLessThan(2_000)

    const tied = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "inspect the workspace" }],
        tools: [
          tool("read", "Inspect the workspace through a file or directory page"),
          tool("shell", "Inspect the workspace through a shell command"),
        ],
      },
      new Headers({ "x-session-affinity": "orchestration-session" }),
    )
    expect(tied.projectedActions).toEqual(["read", "shell"])
    expect(tied.turn.initialPrompt).toBe("USER: inspect the workspace")
    expect(tied.turn.primingPrompts.join("\n")).toContain('"name":"read"')
    expect(tied.turn.primingPrompts.join("\n")).toContain('"name":"shell"')
  })

  test("tool declarations and chat follow-ups retain the same startup schemas and identity", () => {
    const tool = (name: string, description: string) => ({
      type: "function",
      function: { name, description, parameters: { type: "object", properties: { path: { type: "string" } } } },
    })
    const tools = [tool("read", "Read a file"), tool("shell", "Run a shell command")]
    const first = parseOpenAIChatRequest(
      { model: "gpt-5.6-terra", messages: [{ role: "user", content: "hello" }], tools },
      new Headers({ "x-session-id": "declare-session" }),
    )
    expect(first.projectedActions).toEqual(["read", "shell"])
    expectStartupPrompts(first.turn.primingPrompts, [], ["read", "shell"])
    expect(first.turn.initialPrompt).not.toContain('"inputSchema"')
    const second = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"path":"x"}' } }],
          },
          { role: "tool", tool_call_id: "call_1", content: "ok" },
          { role: "user", content: "continue" },
        ],
        tools,
      },
      new Headers({ "x-session-id": "declare-session" }),
    )
    expect(second.projectedActions).toEqual(["read", "shell"])
    expect(second.turn.actionEnvelopeDigest).toBe(first.turn.actionEnvelopeDigest)
    expect(second.turn.initialPrompt).not.toContain('"inputSchema"')
    expect(second.turn.primingPrompts).toEqual(first.turn.primingPrompts)
    const chatOnly = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "done" },
          { role: "user", content: "thanks" },
        ],
        tools,
      },
      new Headers({ "x-session-id": "declare-session" }),
    )
    expect(chatOnly.projectedActions).toEqual(["read", "shell"])
    expect(chatOnly.turn.primingPrompts).toEqual(first.turn.primingPrompts)
    expect(chatOnly.turn.actionEnvelopeDigest).toBe(first.turn.actionEnvelopeDigest)
    expect(chatOnly.turn.incrementalPrompt).toBe("USER: thanks")
    expect(chatOnly.turn.initialPrompt).not.toContain('"inputSchema"')
  })

  test("exact-name and filename requests both prime all offered schemas", () => {
    const tool = (name: string, description: string, parameters: unknown = { type: "object", properties: {} }) => ({
      type: "function",
      function: { name, description, parameters },
    })
    const tools = [
      tool("read", "Read a file or directory"),
      tool("question", "Ask the user a question", {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      }),
    ]
    const named = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "ask-me-which-file using the question tool" }],
        tools,
      },
      new Headers({ "x-session-id": "exact-name-session" }),
    )
    expect(named.projectedActions).toEqual(["read", "question"])
    expectStartupPrompts(named.turn.primingPrompts, [], ["read", "question"])
    expect(named.turn.initialPrompt).not.toContain('"inputSchema"')
    expect(named.turn.primingPrompts.join("\n")).toContain('"name":"question"')
    expect(named.turn.primingPrompts.join("\n")).toContain('"inputSchema"')
    expect(named.turn.provisionedActions).toEqual(["read", "question"])
    expect(named.turn.offeredToolSchemas.map((entry) => entry.name).sort()).toEqual(["question", "read"])

    const readme = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "fix readme add header at the beginning" }],
        tools: [tool("read", "Read a file or directory"), tool("edit", "Replace text in files")],
      },
      new Headers({ "x-session-id": "exact-name-session" }),
    )
    expect(readme.projectedActions).toEqual(["read", "edit"])
    expectStartupPrompts(readme.turn.primingPrompts, [], ["read", "edit"])
    expect(readme.turn.initialPrompt).not.toContain('"inputSchema"')
    expect(readme.turn.provisionedActions).toEqual(["read", "edit"])
  })

  test("a bulky earlier schema does not hide the question schema at startup", () => {
    const bulky = (name: string) => ({
      type: "function",
      function: {
        name,
        description: `Tool ${name}. ${"detail ".repeat(600)}`,
        parameters: { type: "object", properties: { arg: { type: "string" } }, required: ["arg"] },
      },
    })
    const tools = [
      bulky("read"),
      {
        type: "function",
        function: {
          name: "question",
          description: "Ask the user a question",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      },
    ]
    const parsed = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [
          { role: "user", content: "read the file" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"arg":"x"}' } }],
          },
          { role: "tool", tool_call_id: "call_1", content: "ok" },
          { role: "user", content: "please use the question tool to clarify which file" },
        ],
        tools,
      },
      new Headers({ "x-session-id": "question-budget-session" }),
    )
    expect(parsed.projectedActions).toContain("question")
    expect(parsed.turn.provisionedActions).toContain("question")
    expect(parsed.turn.primingPrompts.join("\n")).toContain('"name":"question"')
    expect(parsed.turn.initialPrompt).not.toContain('"inputSchema"')
    expectStartupPrompts(parsed.turn.primingPrompts, [], ["read", "question"])
  })

  test("a bulky question schema is preserved in its own startup block", () => {
    const bulky = (name: string) => ({
      type: "function",
      function: {
        name,
        description: `Tool ${name}. ${"detail ".repeat(600)}`,
        parameters: { type: "object", properties: { arg: { type: "string" } }, required: ["arg"] },
      },
    })
    const small = (name: string) => ({
      type: "function",
      function: {
        name,
        description: `Tool ${name}.`,
        parameters: { type: "object", properties: {} },
      },
    })
    const tools = [
      small("read"),
      bulky("question"),
    ]
    const parsed = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [
          { role: "user", content: "read the file" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"arg":"x"}' } }],
          },
          { role: "tool", tool_call_id: "call_1", content: "ok" },
          { role: "user", content: "please use the question tool to clarify which file" },
        ],
        tools,
      },
      new Headers({ "x-session-id": "named-budget-exempt-session" }),
    )
    expect(parsed.projectedActions).toEqual(["read", "question"])
    expect(parsed.turn.provisionedActions).toEqual(["read", "question"])
    expect(parsed.turn.primingPrompts[2]).toContain('"name":"question"')
    expect(parsed.turn.primingPrompts[2]).toContain(tools[1]!.function.description)
    expect(parsed.turn.initialPrompt).not.toContain('"inputSchema"')
  })

  test("bound follow-up naming Question retains the exact startup tool name", () => {
    const bulky = (name: string) => ({
      type: "function",
      function: {
        name,
        description: `Tool ${name}. ${"detail ".repeat(600)}`,
        parameters: { type: "object", properties: { arg: { type: "string" } }, required: ["arg"] },
      },
    })
    const tools = [
      bulky("read"),
      {
        type: "function",
        function: {
          name: "question",
          description: "Ask the user a question",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      },
    ]
    const parsed = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [
          { role: "user", content: "read the file" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"arg":"x"}' } }],
          },
          { role: "tool", tool_call_id: "call_1", content: "ok" },
          { role: "user", content: "please use the Question tool to clarify which file" },
        ],
        tools,
      },
      new Headers({ "x-session-id": "live-question-followup-session" }),
    )
    expect(parsed.projectedActions).toContain("question")
    expect(parsed.turn.provisionedActions).toContain("question")
    expect(parsed.turn.primingPrompts.join("\n")).toContain('"name":"question"')
    expect(parsed.turn.initialPrompt).not.toContain('"inputSchema"')
    expect(parsed.turn.incrementalPrompt).toContain("please use the Question tool")
  })

  test("create update delete requests reuse the complete startup file-operation schemas", () => {
    const tool = (name: string, description: string) => ({
      type: "function",
      function: { name, description, parameters: { type: "object", properties: {} } },
    })
    const tools = [
      tool("patch", "Apply add update delete file operations"),
      tool("write", "Create a new file with given content"),
      tool("edit", "Replace text in files by exact match"),
      tool("shell", "Execute one shell command in the current working directory"),
      tool("read", "Read file contents and directory listings"),
    ]
    const created = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "create a new file notes.txt with hello" }],
        tools,
      },
      new Headers({ "x-session-id": "fileop-create-session" }),
    )
    expect(created.projectedActions).toContain("patch")
    expect(created.projectedActions).toContain("write")
    expect(created.turn.provisionedActions).toContain("patch")
    expect(created.turn.provisionedActions).toContain("write")
    expect(created.turn.primingPrompts.join("\n")).toContain('"name":"patch"')
    expect(created.turn.primingPrompts.join("\n")).toContain('"name":"write"')

    const deleted = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "delete the file notes.txt" }],
        tools,
      },
      new Headers({ "x-session-id": "fileop-delete-session" }),
    )
    expect(deleted.projectedActions).toContain("patch")
    expect(deleted.projectedActions).toContain("shell")
    expect(deleted.turn.provisionedActions).toContain("patch")
    expect(deleted.turn.provisionedActions).toContain("shell")

    const updated = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "update the file notes.txt to fix the header" }],
        tools,
      },
      new Headers({ "x-session-id": "fileop-update-session" }),
    )
    expect(updated.projectedActions).toContain("patch")
    expect(updated.projectedActions).toContain("edit")
    expect(updated.turn.provisionedActions).toContain("patch")
    expect(updated.turn.provisionedActions).toContain("edit")
    expect(deleted.turn.actionEnvelopeDigest).toBe(created.turn.actionEnvelopeDigest)
    expect(updated.turn.actionEnvelopeDigest).toBe(created.turn.actionEnvelopeDigest)
    for (const parsed of [created, deleted, updated]) expect(parsed.turn.initialPrompt).not.toContain('"inputSchema"')
  })

  test("classifies authorization failures without exposing token values", () => {
    const token = "a".repeat(64)
    expect(authorize(undefined, token)).toEqual({
      reason: "missing_authorization",
      providedLength: 0,
      expectedLength: 71,
    })
    expect(authorize("Bearer short", token)?.reason).toBe("authorization_length_mismatch")
    expect(authorize(`Bearer ${"b".repeat(64)}`, token)?.reason).toBe("token_mismatch")
    expect(authorize(`Bearer ${token}`, token)).toBeUndefined()
  })

  test("typed envelope preamble keeps English sentence and teaches one envelope", () => {
    const bridge = serializeToolDefinitions([
      { name: "read", description: "Read a file", inputSchema: { type: "object" } },
    ])
    expect(bridge).toContain("Respond in English unless the user explicitly requests another language")
    expect(bridge).toContain("<aipass-action>")
    expect(bridge).toContain('"type"')
    expect(bridge).toContain("chat")
    expect(bridge).toContain("tool")
    expect(bridge).toContain("plan")
  })

  test("typed envelope parser maps chat tool plan and shorthand types", () => {
    const offered = new Set(["read", "question", "skill", "subagent"])
    expect(parseTypedEnvelope({ type: "chat", text: "hello" }, offered)).toEqual([
      { type: "text", delta: "hello" },
    ])
    expect(
      parseTypedEnvelope({ type: "tool", id: "call_1", name: "read", input: { path: "x" } }, offered),
    ).toEqual([{ type: "tool-call", id: "call_1", name: "read", input: { path: "x" } }])
    expect(parseTypedEnvelope({ type: "question", id: "q1", input: { ask: "which?" } }, offered)).toEqual([
      {
        type: "tool-call",
        id: "q1",
        name: "question",
        input: { questions: [{ question: "which?", header: "which?", options: [] }] },
      },
    ])
    expect(parseTypedEnvelope({ type: "skill", id: "s1", input: { name: "x" } }, offered)).toEqual([
      { type: "tool-call", id: "s1", name: "skill", input: { name: "x" } },
    ])
    expect(parseTypedEnvelope({ type: "subagent", id: "a1", input: { task: "t" } }, offered)).toEqual([
      { type: "tool-call", id: "a1", name: "subagent", input: { task: "t" } },
    ])
    const plan = parseTypedEnvelope(
      {
        type: "plan",
        steps: [
          { name: "read", input: { path: "a" } },
          { name: "read", input: { path: "b" } },
        ],
      },
      offered,
    )
    expect(plan?.length).toBe(2)
    expect(plan?.[0]).toMatchObject({ type: "tool-call", name: "read" })
    expect(plan?.[1]).toMatchObject({ type: "tool-call", name: "read" })
    expect(() =>
      parseTypedEnvelope({ type: "tool", id: "x", name: "shell", input: {} }, offered),
    ).toThrow("not offered")
    expect(parseTypedEnvelope({ type: "chat", text: "plain" }, new Set())).toEqual([
      { type: "text", delta: "plain" },
    ])
  })

  test("typed envelope question text-like inputs normalize to questions array", () => {
    const offered = new Set(["question"])
    for (const input of [
      { text: "which?" },
      { message: "which?" },
      { content: "which?" },
      { query: "which?" },
      { ask: "which?" },
    ]) {
      expect(parseTypedEnvelope({ type: "question", id: "q1", input }, offered)).toEqual([
        {
          type: "tool-call",
          id: "q1",
          name: "question",
          input: { questions: [{ question: "which?", header: "which?", options: [] }] },
        },
      ])
    }
  })

  test("offered empty bound follow-up preserves legacy text path", () => {
    const empty = new Set<string>()
    const question = { type: "question", id: "q1", input: { ask: "which?" } }
    expect(parseTypedEnvelope(question, empty)).toBeUndefined()
    const shim = new TypedEnvelopeShim(empty)
    const tagged =
      '<aipass-envelope>{"type":"question","id":"q1","input":{"ask":"which?"}}</aipass-envelope>'
    expect(JSON.stringify([...shim.push(tagged), ...shim.finish()])).toContain("question")
    const strict = new Set(["read"])
    expect(() => parseTypedEnvelope({ type: "tool", id: "x", name: "shell", input: {} }, strict)).toThrow(
      "not offered",
    )
  })

  test("typed envelope shim accepts tagged and bare forms with type-only stderr marker", () => {
    const offered = new Set(["read", "question"])
    const errors: string[] = []
    const original = console.error
    console.error = (...values: unknown[]) => void errors.push(values.map(String).join(" "))
    try {
      const tagged = new TypedEnvelopeShim(offered)
      const frames = [
        ...tagged.push('<aipass-envelope>{"type":"chat","text":"hi"}</aipass-envelope>'),
        ...tagged.finish(),
      ]
      expect(frames).toEqual([{ type: "text", delta: "hi" }])
      const bare = new TypedEnvelopeShim(offered)
      expect(bare.push('{"type":"tool","id":"c1","name":"read","input":{"path":"."}}')).toEqual([])
      expect(bare.finish()).toEqual([
        { type: "tool-call", id: "c1", name: "read", input: { path: "." } },
      ])
      const legacy = new TypedEnvelopeShim(new Set(["read"]))
      expect(legacy.push("plain chat remains").length).toBeGreaterThan(0)
      expect(legacy.finish()).toEqual([])
      const malformed = new TypedEnvelopeShim(offered)
      const malformedFrames = malformed.push("<aipass-envelope>{not json</aipass-envelope>")
      expect(malformedFrames).toEqual([{ type: "text", delta: "{not json" }])
      expect(malformed.finish()).toEqual([])
    } finally {
      console.error = original
    }
    const markers = errors.filter((line) => line.includes("aipass envelope type="))
    expect(markers.length).toBeGreaterThanOrEqual(2)
    expect(markers.every((line) => line === "aipass envelope type=chat" || line === "aipass envelope type=tool")).toBe(
      true,
    )
  })

  test("startup alone introduces the envelope instruction and language rule", () => {
    const offered = {
      type: "function",
      function: { name: "read", description: "Read a file", parameters: { type: "object" } },
    }
    const parsed = parseOpenAIChatRequest(
      { model: "gpt-5.6-terra", messages: [{ role: "user", content: "hello" }], tools: [offered] },
      new Headers({ "x-session-id": "envelope-session" }),
    )
    expect(parsed.turn.primingPrompts[0]).toContain('"type"')
    expect(parsed.turn.primingPrompts[0]).toContain(
      "Respond in English unless the user explicitly requests another language",
    )
    for (const prompt of [parsed.turn.initialPrompt, parsed.turn.incrementalPrompt, parsed.turn.recoveryPrompt]) {
      expect(prompt).toBe("USER: hello")
      expect(prompt).not.toContain("Respond in English unless the user explicitly requests another language")
    }
  })

  test("turn key is generated per request", () => {
    const first = parseOpenAIChatRequest(
      { model: "gpt-5.6-terra", messages: [{ role: "user", content: "hello" }] },
      new Headers({ "x-session-id": "key-session" }),
    )
    const second = parseOpenAIChatRequest(
      { model: "gpt-5.6-terra", messages: [{ role: "user", content: "hello" }] },
      new Headers({ "x-session-id": "key-session" }),
    )
    expect(first.turn.promptKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(second.turn.promptKey).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe("attachment staging upload", () => {
  test("attachment staging uses OS tmp safe basenames byte caps cleanup plus button upload", async () => {
    const browser = await import("./browser.ts")
    const helpers = browser as unknown as Record<string, unknown>
    expect(typeof helpers["safeAttachmentBasename"]).toBe("function")
    expect(typeof helpers["stageAttachments"]).toBe("function")
    expect(typeof helpers["uploadStagedFiles"]).toBe("function")
    expect(typeof helpers["cleanupStagedFiles"]).toBe("function")
    const safeAttachmentBasename = helpers["safeAttachmentBasename"] as (name?: string, index?: number) => string
    const stageAttachments = helpers["stageAttachments"] as (
      attachments: readonly { kind: "image" | "file"; url?: string; data?: string; mime?: string; filename?: string }[],
    ) => Promise<{ dir: string | null; files: { path: string; filename: string }[] }>
    const uploadStagedFiles = helpers["uploadStagedFiles"] as (page: unknown, files: { path: string }[]) => Promise<void>
    const cleanupStagedFiles = helpers["cleanupStagedFiles"] as (dir: string | null | undefined) => Promise<void>
    expect(safeAttachmentBasename("../../etc/passwd", 0)).not.toContain("/")
    expect(safeAttachmentBasename("../../etc/passwd", 0)).not.toContain("..")
    expect(safeAttachmentBasename("", 0).length).toBeGreaterThan(0)
    const payload = Buffer.from("hello-attachment").toString("base64")
    const staged = await stageAttachments([{ kind: "file", data: payload, filename: "../../evil.txt", mime: "text/plain" }])
    expect(staged.dir).toBeString()
    expect(staged.dir!.startsWith(tmpdir())).toBe(true)
    expect(staged.files).toHaveLength(1)
    expect(staged.files[0]!.path.startsWith(staged.dir!)).toBe(true)
    expect(staged.files[0]!.filename).not.toContain("/")
    const content = await readFile(staged.files[0]!.path, "utf8")
    expect(content).toBe("hello-attachment")
    await expect(stageAttachments([{ kind: "file", data: "A".repeat(15_000_001), filename: "big.bin" }])).rejects.toThrow(
      /too large/i,
    )
    const calls: string[] = []
    const fakePage = {
      locator: (selector: string) => ({
        first: () => ({
          setInputFiles: async (path: string) => void calls.push(`files:${selector}:${path}`),
          click: async () => void calls.push(`click:${selector}`),
        }),
      }),
    }
    await uploadStagedFiles(fakePage, staged.files)
    expect(calls.some((call) => call.startsWith("files:"))).toBe(true)
    expect(calls.some((call) => call.startsWith("click:"))).toBe(true)
    expect(calls.some((call) => /send|submit/i.test(call))).toBe(false)
    await cleanupStagedFiles(staged.dir)
    await expect(stat(staged.dir!)).rejects.toThrow()
  })

  test("message attachments project placeholders plus descriptors", () => {
    const parsed = parseOpenAIChatRequest(
      {
        model: "gpt-5.6-terra",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see this" },
              { type: "image_url", image_url: { url: `data:text/plain;base64,${Buffer.from("img").toString("base64")}` } },
            ],
          },
        ],
      },
      new Headers({ "x-session-id": "attach-session" }),
    )
    expect(parsed.turn.initialPrompt).toContain("[attachment:image]")
    expect(parsed.turn.attachments).toHaveLength(1)
    expect(messageAttachments("not-array")).toEqual([])
  })
})
