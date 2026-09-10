import { describe, expect, test } from "bun:test"
import type { BrowserTurnInput } from "./browser.ts"
import { envelopesMatchTurnKey, hasTerminalEnvelope, TypedEnvelopeShim } from "./protocol.ts"
import { StandaloneBrowserService } from "./runtime.ts"
import { createRequestHandler } from "./server.ts"

const answer = "The README.md details the Google Workspace MCP server..."
const reasoning = "Checked the configured MCP server."
const bareAnswer = (key: string) => JSON.stringify({ key, id: "answer_1", text: answer })
const thinking = (key: string) => JSON.stringify({ type: "thinking", key, id: "reason_1", text: reasoning })

describe("missing answer-envelope type", () => {
  test("decodes only the recognizable answer shape and preserves tool validation", () => {
    for (const source of [
      bareAnswer("turn-key"),
      `<aipass-envelope>${bareAnswer("turn-key")}</aipass-envelope>`,
    ]) {
      const shim = new TypedEnvelopeShim(new Set(["read"]))
      const frames = [...source].flatMap(chunk => shim.push(chunk))
      frames.push(...shim.finish())
      expect(frames).toEqual([{ type: "text", delta: answer }])
    }
    expect(hasTerminalEnvelope(bareAnswer("turn-key"))).toBe(true)
    expect(envelopesMatchTurnKey(bareAnswer("turn-key"), "turn-key")).toBe(true)
    expect(envelopesMatchTurnKey(bareAnswer("wrong-key"), "turn-key")).toBe(false)

    for (const ordinary of [
      JSON.stringify({ key: "turn-key", id: "message_1", text: answer }),
      JSON.stringify({ id: "answer_1", text: answer }),
      JSON.stringify({ type: "unknown", key: "turn-key", id: "answer_1", text: answer }),
    ]) {
      const plain = new TypedEnvelopeShim(new Set(["read"]))
      expect([...plain.push(ordinary), ...plain.finish()]).toEqual([{ type: "text", delta: ordinary }])
    }

    const invalidTool = JSON.stringify({ key: "turn-key", id: "answer_1", name: "unoffered", input: {}, text: answer })
    const strict = new TypedEnvelopeShim(new Set(["read"]))
    expect(() => [...strict.push(invalidTool), ...strict.finish()]).toThrow("tool unoffered was not offered")
  })

  for (const endpoint of ["chat/completions", "responses"] as const)
  for (const stream of [false, true]) test(`${endpoint} ${stream ? "streaming" : "non-streaming"} emits missing-type answer text`, async () => {
    const browser = new StandaloneBrowserService({ async *turn(input: BrowserTurnInput) {
      yield { type: "text", delta: `${thinking(input.promptKey!)}\n${bareAnswer(input.promptKey!)}` }
      yield { type: "finish", reason: "stop" }
    }, async discard() {} } as never)
    const handler = createRequestHandler({ token: "fixture-token", browser, shutdown: async () => {} })
    const body = endpoint === "chat/completions"
      ? { model: "gpt-5.6-terra", stream, messages: [{ role: "user", content: "Summarize the README." }] }
      : { model: "gpt-5.6-terra", stream, input: "Summarize the README." }
    const response = await handler(new Request(`http://localhost/v1/${endpoint}`, {
      method: "POST",
      headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
      body: JSON.stringify(body),
    }))

    expect(response.status).toBe(200)
    if (!stream) {
      const output = await response.json()
      expect(JSON.stringify(output)).not.toContain("aipass-envelope")
      expect(JSON.stringify(output)).not.toContain("answer_1")
      expect(output.usage.estimated).toBe(true)
      if (endpoint === "chat/completions") {
        expect(output.choices[0].message).toMatchObject({ content: answer, reasoning_content: reasoning })
        expect(output.choices[0].finish_reason).toBe("stop")
      } else {
        expect(output.status).toBe("completed")
        expect(output.output.find((item: { type: string }) => item.type === "message").content[0].text).toBe(answer)
        expect(output.output.find((item: { type: string }) => item.type === "reasoning").summary[0].text).toBe(reasoning)
      }
      return
    }

    const raw = await response.text()
    expect(raw).not.toContain("aipass-envelope")
    expect(raw).not.toContain("answer_1")
    const events = raw.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
      .map(line => JSON.parse(line.slice(6)))
    if (endpoint === "chat/completions") {
      const deltas = events.flatMap(event => event.choices ?? []).map(choice => choice.delta)
      expect(deltas.map(delta => delta.content ?? "").join("")).toBe(answer)
      expect(deltas.map(delta => delta.reasoning_content ?? "").join("")).toBe(reasoning)
      expect(events.flatMap(event => event.choices ?? []).map(choice => choice.finish_reason).filter(Boolean)).toEqual(["stop"])
      expect(raw.match(/data: \[DONE\]/g)).toHaveLength(1)
    } else {
      expect(events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join("")).toBe(answer)
      expect(events.filter(event => event.type === "response.reasoning_summary_text.delta").map(event => event.delta).join("")).toBe(reasoning)
      const completed = events.filter(event => event.type === "response.completed")
      expect(completed).toHaveLength(1)
      expect(completed[0].response.usage.estimated).toBe(true)
    }
  })
})
