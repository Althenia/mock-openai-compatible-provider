import { describe, expect, test } from "bun:test"
import { createRequestHandler, type BrowserService } from "./server.ts"
import type { ProjectedTurn } from "./http.ts"
import type { BrowserFrame } from "./protocol.ts"
import { NoResponseEvidenceError, WebchatSafetyBlockError } from "./browser.ts"

interface ChatCompletionBody {
  readonly object: string
  readonly choices: Array<{
    readonly finish_reason: string
    readonly message: {
      readonly role: string
      readonly content: string | null
      readonly reasoning_content?: string
      readonly tool_calls?: Array<{
        readonly id: string
        readonly type: string
        readonly function: { readonly name: string; readonly arguments: string }
      }>
    }
  }>
  readonly usage: { readonly prompt_tokens: number; readonly completion_tokens: number }
}

interface ResponsesBody {
  readonly id: string
  readonly object: string
  readonly status: string
  readonly model: string
  readonly output: Array<{
    readonly type: string
    readonly content?: Array<{ readonly type: string; readonly text: string; readonly annotations?: unknown[] }>
  }>
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number; readonly total_tokens: number }
}

function browser(frames: readonly BrowserFrame[]): BrowserService & { turns: ProjectedTurn[] } {
  return {
    turns: [],
    async *turn(input) {
      this.turns.push(input)
      yield* frames
    },
    async login() {},
    async close() {},
  }
}

describe("Bun HTTP boundary", () => {
  test("authenticates health without exposing credentials", async () => {
    const token = "a".repeat(64)
    const handler = createRequestHandler({ token, browser: browser([]), shutdown: async () => undefined })
    const missing = await handler(new Request("http://127.0.0.1/health"))
    expect(missing.status).toBe(401)
    expect(await missing.json()).toEqual({
      error: {
        message: "invalid bearer token",
        type: "authentication_error",
        param: null,
        code: "invalid_api_key",
      },
    })
    const health = await handler(
      new Request("http://127.0.0.1/health", { headers: { authorization: `Bearer ${token}` } }),
    )
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })
  })

  test("lists the provider model catalog through the authenticated OpenAI endpoint", async () => {
    const token = "a".repeat(64)
    const handler = createRequestHandler({ token, browser: browser([]), shutdown: async () => undefined })
    const response = await handler(
      new Request("http://127.0.0.1/v1/models", { headers: { authorization: `Bearer ${token}` } }),
    )
    expect(response.status).toBe(200)
    const catalog = (await response.json()) as {
      object: string
      data: Array<{
        id: string
        object: string
        created: number
        owned_by: string
        name: string
        reasoning: string[]
        capabilities: { tools: boolean; input: string[]; output: string[] }
        variants: Array<{ id: string; body: { reasoning: { mode: string } } }>
      }>
    }
    expect(catalog.object).toBe("list")
    expect(catalog.data.length).toBeGreaterThan(1)
    expect(catalog.data.find((entry) => entry.id === "gpt-5.6-terra")).toEqual({
      id: "gpt-5.6-terra",
      object: "model",
      created: 0,
      owned_by: "th-ai-passport",
      name: "GPT-5.6 Terra",
      reasoning: ["none", "low", "medium", "high"],
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [
        { id: "low", body: { reasoning: { mode: "low" } } },
        { id: "medium", body: { reasoning: { mode: "medium" } } },
        { id: "high", body: { reasoning: { mode: "high" } } },
      ],
    })

    const detail = await handler(
      new Request("http://127.0.0.1/v1/models/gpt-5.6-terra", {
        headers: { authorization: `Bearer ${token}` },
      }),
    )
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({ id: "gpt-5.6-terra", object: "model" })
  })

  test("preflights the first browser frame before returning OpenAI SSE", async () => {
    const token = "a".repeat(64)
    const service = browser([
      { type: "text", delta: "OK" },
      { type: "finish", reason: "stop" },
    ])
    const handler = createRequestHandler({ token, browser: service, shutdown: async () => undefined })
    const response = await handler(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-session-id": "session-a",
        },
        body: JSON.stringify({
          model: "gpt-5.6-terra",
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: "reply OK" }],
          reasoning: { mode: "low" },
        }),
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const body = await response.text()
    expect(body).toContain('"content":"OK"')
    expect(body).toContain('"finish_reason":"stop"')
    expect(body).toContain('"usage":{"prompt_tokens":')
    expect(body.endsWith("data: [DONE]\n\n")).toBe(true)
    expect(service.turns).toHaveLength(1)
  })

  test("returns a non-streaming Chat Completions response without session affinity", async () => {
    const token = "a".repeat(64)
    const service = browser([
      { type: "reasoning", delta: "R" },
      { type: "text", delta: "OK" },
      { type: "finish", reason: "stop" },
    ])
    const handler = createRequestHandler({ token, browser: service, shutdown: async () => undefined })
    const response = await handler(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-terra", messages: [{ role: "user", content: "reply OK" }] }),
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    const body = (await response.json()) as ChatCompletionBody
    expect(body.object).toBe("chat.completion")
    expect(body.choices[0]).toMatchObject({
      finish_reason: "stop",
      message: { role: "assistant", content: "OK", reasoning_content: "R" },
    })
    expect(body.usage.prompt_tokens).toBeGreaterThan(0)
    expect(body.usage.completion_tokens).toBeGreaterThan(0)
    expect(service.turns[0]?.sessionMarker).toMatch(/^anon_/)
  })

  test("returns non-streaming OpenAI tool calls", async () => {
    const token = "a".repeat(64)
    const handler = createRequestHandler({
      token,
      browser: browser([
        { type: "tool-call", id: "call_1", name: "read", input: { path: "package.json" } },
        { type: "finish", reason: "tool-calls" },
      ]),
      shutdown: async () => undefined,
    })
    const response = await handler(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-terra",
          messages: [{ role: "user", content: "read package.json" }],
          tools: [
            {
              type: "function",
              function: { name: "read", description: "Read a file", parameters: { type: "object" } },
            },
          ],
        }),
      }),
    )
    const body = (await response.json()) as ChatCompletionBody
    expect(body.choices[0].finish_reason).toBe("tool_calls")
    expect(body.choices[0]?.message.tool_calls?.[0]).toMatchObject({
      id: "call_1",
      type: "function",
      function: { name: "read", arguments: '{"path":"package.json"}' },
    })

    const required = await createRequestHandler({
      token,
      browser: browser([
        { type: "text", delta: "I skipped the function" },
        { type: "finish", reason: "stop" },
      ]),
      shutdown: async () => undefined,
    })(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-terra",
          messages: [{ role: "user", content: "read package.json" }],
          tools: [
            { type: "function", function: { name: "read", parameters: { type: "object" } } },
          ],
          tool_choice: "required",
        }),
      }),
    )
    expect(required.status).toBe(502)
    expect(await required.json()).toMatchObject({
      error: { message: "tool_choice required but no tool call was produced" },
    })
  })

  test("supports Responses API JSON and streaming output", async () => {
    const token = "a".repeat(64)
    const service = browser([
      { type: "reasoning", delta: "R" },
      { type: "text", delta: "OK" },
      { type: "finish", reason: "stop" },
    ])
    const handler = createRequestHandler({
      token,
      browser: service,
      shutdown: async () => undefined,
    })
    const request = (stream: boolean, previousResponseID?: string) =>
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-terra",
          instructions: "Answer concisely",
          input: "reply OK",
          reasoning: { effort: "low" },
          stream,
          ...(previousResponseID ? { previous_response_id: previousResponseID } : {}),
        }),
      })

    const response = await handler(request(false))
    expect(response.status).toBe(200)
    const body = (await response.json()) as ResponsesBody
    expect(body).toMatchObject({ object: "response", status: "completed", model: "gpt-5.6-terra" })
    expect(body.output.find((item) => item.type === "message")?.content?.[0]).toEqual({
      type: "output_text",
      text: "OK",
      annotations: [],
    })
    expect(body.usage.input_tokens).toBeGreaterThan(0)

    const streamed = await handler(request(true, body.id))
    expect(streamed.status).toBe(200)
    const events = await streamed.text()
    expect(events).toContain("event: response.output_text.delta")
    expect(events).toContain("event: response.completed")
    expect(events).not.toContain("data: [DONE]")
    const eventBlocks = events
      .split("\n\n")
      .filter((event) => event.startsWith("event: "))
    expect(eventBlocks[0]).toStartWith("event: response.created\n")
    expect(eventBlocks[1]).toStartWith("event: response.in_progress\n")
    expect(eventBlocks.at(-1)).toStartWith("event: response.completed\n")
    expect(
      eventBlocks.map((event) => (JSON.parse(event.split("\ndata: ")[1] ?? "{}") as { sequence_number?: number }).sequence_number),
    ).toEqual(eventBlocks.map((_, index) => index))
    const completed = eventBlocks.find((event) => event.startsWith("event: response.completed\n"))
    const completedData = JSON.parse(completed?.split("\ndata: ")[1] ?? "{}") as { response?: { id?: string } }
    expect(completedData.response?.id).not.toBe(body.id)
    expect(service.turns[0]?.sessionMarker).toBe(service.turns[1]?.sessionMarker)

    const branch = await handler(request(false, body.id))
    expect(branch.status).toBe(400)
    expect(await branch.json()).toMatchObject({ error: { code: "previous_response_not_found" } })
    expect(service.turns).toHaveLength(2)
  })

  test("invalidates and discards a continuation when its stream fails after submission", async () => {
    const token = "a".repeat(64)
    const sequences: BrowserFrame[][] = [
      [{ type: "text", delta: "root" }, { type: "finish", reason: "stop" }],
      [{ type: "text", delta: "partial" }, { type: "error", message: "late failure" }],
      [{ type: "text", delta: "retry" }, { type: "finish", reason: "stop" }],
    ]
    const discarded: string[] = []
    const service: BrowserService = {
      async *turn() {
        yield* (sequences.shift() ?? [])
      },
      async login() {},
      async close() {},
      async discard(sessionMarker) {
        discarded.push(sessionMarker)
      },
    }
    const handler = createRequestHandler({ token, browser: service, shutdown: async () => undefined })
    const request = (stream: boolean, previousResponseID?: string) =>
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-terra",
          input: "continue",
          stream,
          ...(previousResponseID ? { previous_response_id: previousResponseID } : {}),
        }),
      })

    const root = (await (await handler(request(false))).json()) as ResponsesBody
    const failed = await handler(request(true, root.id))
    expect(failed.status).toBe(200)
    await expect(failed.text()).rejects.toThrow("late failure")
    const retry = await handler(request(false, root.id))
    expect(retry.status).toBe(400)
    expect(discarded).toEqual([root.id])
  })

  test("returns 428 and 502 before streaming and signals shutdown once", async () => {
    const token = "a".repeat(64)
    let stopped = 0
    const authBrowser: BrowserService = {
      async *turn() {
        yield { type: "auth-required" }
      },
      async login() {},
      async close() {},
    }
    const authHandler = createRequestHandler({
      token,
      browser: authBrowser,
      shutdown: async () => {
        stopped++
      },
    })
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-session-id": "session-a",
    }
    const request = () =>
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "gpt-5.6-terra", messages: [{ role: "user", content: "hello" }] }),
      })
    expect((await authHandler(request())).status).toBe(428)

    const invalid = await authHandler(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-terra", messages: [] }),
      }),
    )
    expect(await invalid.json()).toEqual({
      error: {
        message: "messages must be a non-empty array",
        type: "invalid_request_error",
        param: null,
        code: "invalid_request",
      },
    })

    const failed: BrowserService = {
      async *turn() {
        throw new Error("browser failed")
      },
      async login() {},
      async close() {},
    }
    expect((await createRequestHandler({ token, browser: failed, shutdown: async () => undefined })(request())).status).toBe(502)

    const shutdown = await authHandler(
      new Request("http://127.0.0.1/shutdown", { method: "POST", headers: { authorization: `Bearer ${token}` } }),
    )
    expect(shutdown.status).toBe(200)
    await Bun.sleep(0)
    expect(stopped).toBe(1)
  })

  test("returns a non-retryable error for unrecognized browser responses", async () => {
    const token = "a".repeat(64)
    const unrecognized: BrowserService = {
      async *turn() {
        throw new NoResponseEvidenceError()
      },
      async login() {},
      async close() {},
    }
    const handler = createRequestHandler({ token, browser: unrecognized, shutdown: async () => undefined })
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const expected = {
      error: {
        message: "browser submission produced activity but no recognizable assistant response",
        type: "browser_error",
        param: null,
        code: "browser_response_unrecognized",
      },
    }

    const chat = await handler(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "gpt-5.6-terra", messages: [{ role: "user", content: "hello" }] }),
      }),
    )
    expect(chat.status).toBe(422)
    expect(await chat.json()).toEqual(expected)

    const responses = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "gpt-5.6-terra", input: "hello" }),
      }),
    )
    expect(responses.status).toBe(422)
    expect(await responses.json()).toEqual(expected)
  })

  test("returns a non-retryable error for webchat safety-filter blocks", async () => {
    const token = "a".repeat(64)
    const blocked: BrowserService = {
      async *turn() {
        throw new WebchatSafetyBlockError()
      },
      async login() {},
      async close() {},
    }
    const handler = createRequestHandler({ token, browser: blocked, shutdown: async () => undefined })
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const expected = {
      error: {
        message: "webchat safety filter blocked the response; revise the prompt and retry explicitly",
        type: "browser_error",
        param: null,
        code: "webchat_safety_block",
      },
    }
    for (const path of ["/v1/chat/completions", "/v1/responses"]) {
      const body = path === "/v1/chat/completions"
        ? { model: "gpt-5.6-terra", messages: [{ role: "user", content: "hello" }] }
        : { model: "gpt-5.6-terra", input: "hello" }
      const response = await handler(
        new Request(`http://127.0.0.1${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      )
      expect(response.status).toBe(422)
      expect(await response.json()).toEqual(expected)
    }
  })
})
