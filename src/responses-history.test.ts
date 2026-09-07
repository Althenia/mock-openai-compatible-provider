import { describe, expect, test } from "bun:test"
import { createRequestHandler, type BrowserService } from "./server.ts"
import type { ProjectedTurn } from "./http.ts"

const token = "synthetic-history-credential"
const tool = { type: "function", name: "lookup", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }
const request = (body: Record<string, unknown>) => new Request("http://127.0.0.1/v1/responses", {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "gemini-3.1-flash-lite", ...body }),
})
async function result(response: Response, stream: boolean) {
  expect(response.status).toBe(200)
  if (!stream) return await response.json() as { id: string; output: unknown[] }
  const text = await response.text()
  const completed = text.split("\n\n").filter((part) => part.startsWith("event: response.completed\n"))
  expect(completed).toHaveLength(1)
  expect(text).not.toContain("[DONE]")
  return JSON.parse(completed[0]!.split("\ndata: ")[1]!).response as { id: string; output: unknown[] }
}
function service(turn: BrowserService["turn"]): BrowserService {
  return { turn, async login() {}, async close() {} }
}

describe("process-memory Responses continuation", () => {
  for (const stream of [false, true]) {
    test(`replays input, emitted reasoning/call, and results without old top-level instructions (${stream ? "SSE" : "JSON"})`, async () => {
      const turns: ProjectedTurn[] = []
      const handler = createRequestHandler({ token, shutdown: async () => {}, browser: service(async function* (turn) {
        turns.push(turn)
        if (turns.length === 1) {
          yield { type: "reasoning", delta: "PRIOR_REASONING" }
          yield { type: "text", delta: "PRIOR_ASSISTANT" }
          yield { type: "tool-call", id: "call_lookup", name: "lookup", input: { key: "fixture-alpha" } }
        } else yield { type: "text", delta: "CONTINUATION_ANSWER" }
        yield { type: "finish", reason: "stop" }
      }) })
      const first = await result(await handler(request({
        stream, tools: [tool], instructions: "OLD_TOP_LEVEL_RULE",
        input: [{ role: "developer", content: "RETAINED_MESSAGE_RULE" }, { role: "user", content: "ORIGINAL_TASK" }],
      })), stream)
      const second = await result(await handler(request({
        stream: !stream, tools: [tool], previous_response_id: first.id, instructions: "NEW_TOP_LEVEL_RULE",
        input: [{ type: "function_call_output", call_id: "call_lookup", output: "LOOKUP_RESULT" }],
      })), !stream)
      expect(turns[1]!.sessionMarker).toBe(turns[0]!.sessionMarker)
      for (const prompt of [turns[1]!.initialPrompt, turns[1]!.incrementalPrompt, turns[1]!.recoveryPrompt]) {
        for (const value of ["RETAINED_MESSAGE_RULE", "NEW_TOP_LEVEL_RULE", "ORIGINAL_TASK", "ASSISTANT REASONING: PRIOR_REASONING",
          "ASSISTANT: PRIOR_ASSISTANT", 'TOOL CALL call_lookup lookup: {"key":"fixture-alpha"}', "TOOL RESULT call_lookup: LOOKUP_RESULT"])
          expect(prompt).toContain(value)
        expect(prompt).not.toContain("OLD_TOP_LEVEL_RULE")
        expect(prompt.indexOf("ORIGINAL_TASK")).toBeLessThan(prompt.indexOf("TOOL CALL call_lookup"))
        expect(prompt.indexOf("TOOL CALL call_lookup")).toBeLessThan(prompt.indexOf("TOOL RESULT call_lookup"))
      }
      await result(await handler(request({ previous_response_id: second.id, input: "FINAL_QUESTION" })), false)
      expect(turns[2]!.initialPrompt).toContain("ORIGINAL_TASK")
      expect(turns[2]!.initialPrompt).toContain("CONTINUATION_ANSWER")
      expect(turns[2]!.initialPrompt).toContain("FINAL_QUESTION")
      expect(turns[2]!.initialPrompt).not.toContain("NEW_TOP_LEVEL_RULE")
      expect(turns[2]!.initialPrompt.match(/ORIGINAL_TASK/g)).toHaveLength(1)
      const consumed = await handler(request({ previous_response_id: first.id, input: "branch" }))
      expect(consumed.status).toBe(400)
      expect(await consumed.json()).toMatchObject({ error: { code: "previous_response_not_found" } })
      expect(turns).toHaveLength(3)
    })
  }

  test("store:false and a fresh handler never recover prior input or evict stored history", async () => {
    const turns: ProjectedTurn[] = []
    const dependencies = { token, shutdown: async () => {}, browser: service(async function* (turn) {
      turns.push(turn)
      yield { type: "text", delta: "reply" }
      yield { type: "finish", reason: "stop" }
    }) }
    const handler = createRequestHandler(dependencies)
    const stored = await result(await handler(request({ input: "RETAIN_THIS" })), false)
    const ephemeral = await result(await handler(request({ store: false, input: "x".repeat(16 * 1024 * 1024) })), false)
    expect((await handler(request({ previous_response_id: ephemeral.id, input: "continue" }))).status).toBe(400)
    const restarted = createRequestHandler(dependencies)
    expect((await restarted(request({ previous_response_id: stored.id, input: "continue" }))).status).toBe(400)
    await result(await handler(request({ previous_response_id: stored.id, input: "CONTINUE_STORED" })), false)
    expect(turns.at(-1)!.initialPrompt).toContain("RETAIN_THIS")
    expect(turns).toHaveLength(3)
  })

  test("evicts by UTF-8 payload bytes and rejects an evicted ID without submitting a partial request", async () => {
    let calls = 0
    let lastPrompt = ""
    const handler = createRequestHandler({ token, shutdown: async () => {}, browser: service(async function* (turn) {
      calls++
      lastPrompt = turn.initialPrompt
      yield { type: "text", delta: "reply" }
      yield { type: "finish", reason: "stop" }
    }) })
    const input = "ก".repeat(3 * 1024 * 1024)
    const first = await result(await handler(request({ input: "FIRST_CONTEXT " + input })), false)
    const second = await result(await handler(request({ input: "SECOND_CONTEXT " + input })), false)
    const evicted = await handler(request({ previous_response_id: first.id, input: "continue" }))
    expect(evicted.status).toBe(400)
    expect(await evicted.json()).toMatchObject({ error: { code: "previous_response_not_found" } })
    expect(calls).toBe(2)
    await result(await handler(request({ previous_response_id: second.id, input: "continue" })), false)
    expect(lastPrompt).toContain("SECOND_CONTEXT")
    expect(lastPrompt).not.toContain("FIRST_CONTEXT")
  })

  test("an oversized response is unavailable without truncation or eviction of unrelated retained history", async () => {
    let calls = 0
    const handler = createRequestHandler({ token, shutdown: async () => {}, browser: service(async function* () {
      calls++
      yield { type: "text", delta: "reply" }
      yield { type: "finish", reason: "stop" }
    }) })
    const retained = await result(await handler(request({ input: "SAFE_CONTEXT" })), false)
    const oversized = await result(await handler(request({ input: "x".repeat(16 * 1024 * 1024), stream: true })), true)
    const missing = await handler(request({ previous_response_id: oversized.id, input: "continue" }))
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ error: { code: "previous_response_not_found" } })
    expect(calls).toBe(2)
    await result(await handler(request({ previous_response_id: retained.id, input: "continue" })), false)
    expect(calls).toBe(3)
  })

  test("retains the existing 1,000 response limit independently of payload bytes", async () => {
    const handler = createRequestHandler({ token, shutdown: async () => {}, browser: service(async function* () {
      yield { type: "text", delta: "reply" }
      yield { type: "finish", reason: "stop" }
    }) })
    const first = await result(await handler(request({ input: "first" })), false)
    let last = first
    for (let index = 0; index < 1_000; index++) last = await result(await handler(request({ input: `independent-${index}` })), false)
    expect((await handler(request({ previous_response_id: first.id, input: "continue" }))).status).toBe(400)
    expect((await handler(request({ previous_response_id: last.id, input: "continue" }))).status).toBe(200)
  })

  test("byte eviction does not steal a reserved predecessor from an in-flight continuation", async () => {
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const handler = createRequestHandler({ token, shutdown: async () => {}, browser: service(async function* (turn) {
      if (turn.initialPrompt.includes("HELD_CONTINUATION")) {
        entered()
        await gate
      }
      yield { type: "text", delta: "reply" }
      yield { type: "finish", reason: "stop" }
    }) })
    const input = "x".repeat(9 * 1024 * 1024)
    const first = await result(await handler(request({ input })), false)
    const pending = handler(request({ previous_response_id: first.id, input: "HELD_CONTINUATION" }))
    try {
      await started
      const next = await result(await handler(request({ input })), false)
      const conflict = await handler(request({ previous_response_id: first.id, input: "conflict" }))
      expect(conflict.status).toBe(409)
      expect(await conflict.json()).toMatchObject({ error: { code: "previous_response_in_use" } })
      expect((await handler(request({ previous_response_id: next.id, input: "evicted" }))).status).toBe(400)
    } finally { release() }
    const continued = await result(await pending, false)
    expect((await handler(request({ previous_response_id: first.id, input: "consumed" }))).status).toBe(400)
    expect((await handler(request({ previous_response_id: continued.id, input: "valid" }))).status).toBe(200)
  })

  test("cancelled streams retain neither partial child history nor the consumed predecessor", async () => {
    const discarded: string[] = []
    let calls = 0
    const backend = service(async function* () {
      calls++
      yield { type: "text", delta: calls === 1 ? "ROOT" : "PARTIAL" }
      yield { type: "finish", reason: "stop" }
    })
    backend.discard = async (marker) => { discarded.push(marker) }
    const handler = createRequestHandler({ token, shutdown: async () => {}, browser: backend })
    const first = await result(await handler(request({ input: "ROOT_INPUT" })), false)
    const stream = await handler(request({ previous_response_id: first.id, input: "CANCELLED_INPUT", stream: true }))
    const reader = stream.body!.getReader()
    const created = new TextDecoder().decode((await reader.read()).value)
    const childID = JSON.parse(created.split("\ndata: ")[1]!).response.id
    await reader.cancel()
    for (const id of [first.id, childID]) {
      const missing = await handler(request({ previous_response_id: id, input: "retry" }))
      expect(missing.status).toBe(400)
      expect(await missing.json()).toMatchObject({ error: { code: "previous_response_not_found" } })
    }
    expect(discarded).toEqual([first.id])
    expect(calls).toBe(2)
  })
})
