import { expect, mock, test } from "bun:test"

import type { BrowserTurnInput } from "./browser.ts"
import { StandaloneBrowserService } from "./runtime.ts"
import { createRequestHandler } from "./server.ts"

const token = "a".repeat(64)
const tool = { type: "function", function: { name: "lookup", parameters: { type: "object", required: ["key"] } } }
const responsesTool = { type: "function", ...tool.function }
const pending = Symbol("pending")

function request(path: string, body: Record<string, unknown>, sessionID = "agent-turn-stream") {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-session-id": sessionID },
    body: JSON.stringify({ model: "gemini-3.1-flash-lite", stream: true, ...body }),
  })
}

async function readAll(response: Response) {
  const reader = response.body!.getReader(), decoder = new TextDecoder()
  let output = ""
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) return output
      output += decoder.decode(part.value, { stream: true })
    }
  } finally { reader.releaseLock() }
}

function records(output: string, endpoint: "chat/completions" | "responses") {
  return output.trim().split("\n\n").filter(record => /^data: /m.test(record)).map((record) => {
    const event = record.match(/^event: (.+)$/m)?.[1]
    const raw = record.match(/^data: (.+)$/m)?.[1]
    if (raw === "[DONE]") return { event, done: true }
    expect(raw).toBeDefined()
    const data: unknown = JSON.parse(raw!)
    expect(event).not.toBe("aipass.stage")
    expect(data).not.toEqual({ stage: expect.any(String) })
    if (endpoint === "chat/completions")
      expect(data).toSatisfy((value: unknown) => typeof value === "object" && value !== null && (Array.isArray((value as { choices?: unknown }).choices) || "error" in value))
    else expect(data).toSatisfy((value: unknown) => typeof value === "object" && value !== null && (typeof (value as { type?: unknown }).type === "string" || "error" in value))
    return { event, data }
  })
}

async function afterMicrotasks<T>(work: Promise<T>) {
  return Promise.race([work, (async (): Promise<typeof pending> => {
    for (let index = 0; index < 128; index++) await Promise.resolve()
    return pending
  })()])
}

for (const endpoint of ["chat/completions", "responses"] as const) {
  for (const source of ["dom", "keyed"] as const) test(`${endpoint} streams actual ${source} reasoning before completion and withholds the answer`, async () => {
    const finish = Promise.withResolvers<void>()
    const adapter = { turn: mock(async function* (input: BrowserTurnInput) {
      if (source === "dom") yield { type: "reasoning" as const, delta: "DRAFT", domTurnKey: input.promptKey }
      else yield { type: "text" as const, delta: `<aipass-envelope>${JSON.stringify({ type: "thinking", key: input.promptKey, id: "reason", text: "DRAFT" })}</aipass-envelope>` }
      yield { type: "text" as const, delta: `<aipass-envelope>${JSON.stringify({ type: "chat", key: input.promptKey, text: "FINAL" })}</aipass-envelope>` }
      await finish.promise
      yield { type: "finish" as const, reason: "stop" as const }
    }), async discard() {}, async close() {} }
    const handler = createRequestHandler({ token, browser: new StandaloneBrowserService(adapter as never), shutdown: async () => {} })
    const response = await handler(request(`/v1/${endpoint}`, endpoint === "responses" ? { input: "TASK" } : { messages: [{ role: "user", content: "TASK" }] }))
    const reader = response.body!.getReader(), decoder = new TextDecoder()
    let observed = ""
    const reasoning = (async () => {
      while (!observed.includes("DRAFT")) {
        const part = await reader.read()
        if (part.done) throw new Error("stream ended before reasoning")
        observed += decoder.decode(part.value, { stream: true })
      }
      return observed
    })()
    try {
      const early = await afterMicrotasks(reasoning)
      expect(early).not.toBe(pending)
      expect(observed).toContain("DRAFT")
      expect(observed).not.toContain("FINAL")
      expect(observed).not.toContain("response.completed")
      expect(observed).not.toContain("[DONE]")
      records(observed, endpoint)
      finish.resolve()
      while (true) {
        const part = await reader.read()
        if (part.done) break
        observed += decoder.decode(part.value, { stream: true })
      }
      expect(observed).toContain("FINAL")
      const data = records(observed, endpoint).flatMap(record => record.data ? [record.data as { type?: string, delta?: string, choices?: { delta?: { reasoning_content?: string } }[] }] : [])
      const deltas = endpoint === "responses" ? data.filter(item => item.type === "response.reasoning_summary_text.delta").map(item => item.delta ?? "")
        : data.flatMap(item => item.choices ?? []).map(choice => choice.delta?.reasoning_content ?? "")
      expect(deltas.join("")).toBe("DRAFT")
    } finally {
      finish.resolve()
      await reasoning
      await reader.cancel()
      reader.releaseLock()
    }
  })
}

for (const endpoint of ["chat/completions", "responses"] as const) {
  test(`${endpoint} dispatches a completed tool turn before sending the retained delta continuation`, async () => {
    const firstFinish = Promise.withResolvers<void>()
    const secondFinish = Promise.withResolvers<void>()
    const inputs: BrowserTurnInput[] = []
    const adapter = { turn: mock(async function* (input: BrowserTurnInput) {
      inputs.push(input)
      if (inputs.length === 1) {
        yield { type: "text" as const, delta: `<aipass-envelope>${JSON.stringify({ type: "tool", key: input.promptKey, id: "call_lookup", name: "lookup", input: { key: "alpha" } })}</aipass-envelope>` }
        await firstFinish.promise
      } else {
        yield { type: "text" as const, delta: `<aipass-envelope>${JSON.stringify({ type: "chat", key: input.promptKey, text: "FINAL" })}</aipass-envelope>` }
        await secondFinish.promise
      }
      yield { type: "finish" as const, reason: "stop" as const }
    }), async discard() {}, async close() {} }
    const dispatch = mock(async (_name: string, _input: Record<string, unknown>) => "LOOKUP_RESULT")
    const handler = createRequestHandler({ token, browser: new StandaloneBrowserService(adapter as never), shutdown: async () => {} })
    const initial = await handler(request(`/v1/${endpoint}`, endpoint === "responses"
      ? { instructions: "HARNESS", tools: [responsesTool], input: "TASK" }
      : { messages: [{ role: "system", content: "HARNESS" }, { role: "user", content: "TASK" }], tools: [tool] },
    ))
    const initialBody = readAll(initial)
    try {
      expect(await afterMicrotasks(initialBody)).toBe(pending)
      expect(dispatch).not.toHaveBeenCalled()
      firstFinish.resolve()
      const first = records(await initialBody, endpoint)
      const serialized = JSON.stringify(first)
      expect(serialized).toContain("call_lookup")
      expect(dispatch).not.toHaveBeenCalled()
      const call = endpoint === "responses"
        ? (first.find(record => record.event === "response.output_item.done" && (record.data as { item?: { type?: string } })?.item?.type === "function_call")?.data as { item: { name: string, arguments: string } }).item
        : (first.flatMap(record => (record.data as { choices?: { delta?: { tool_calls?: { function: { name: string, arguments: string } }[] } }[] })?.choices ?? [])
          .flatMap(choice => choice.delta?.tool_calls ?? [])[0]!).function
      const result = await dispatch(call.name, JSON.parse(call.arguments))
      expect(dispatch).toHaveBeenCalledWith("lookup", { key: "alpha" })
      const continuation = endpoint === "responses"
        ? request(`/v1/${endpoint}`, { previous_response_id: (first.find(record => (record.data as { type?: string })?.type === "response.created")?.data as { response: { id: string } }).response.id, input: [{ type: "function_call_output", call_id: "call_lookup", output: result }] })
        : request(`/v1/${endpoint}`, { messages: [{ role: "assistant", content: "", tool_calls: [{ id: "call_lookup", function: { name: "lookup", arguments: '{"key":"alpha"}' } }] }, { role: "tool", tool_call_id: "call_lookup", content: result }] })
      const final = await handler(continuation)
      secondFinish.resolve()
      expect(JSON.stringify(records(await readAll(final), endpoint))).toContain("FINAL")
      expect(inputs).toHaveLength(2)
      expect(inputs[1]!.primingPrompts).toEqual(inputs[0]!.primingPrompts)
      expect(inputs[1]!.incrementalPrompt).toContain("LOOKUP_RESULT")
      expect(inputs[1]!.incrementalPrompt).not.toContain("HARNESS")
    } finally { firstFinish.resolve(); secondFinish.resolve(); await initialBody }
  })
}
