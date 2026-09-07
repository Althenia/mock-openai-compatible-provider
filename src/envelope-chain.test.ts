import { describe, expect, test } from "bun:test";
import { withTurnKey } from "./browser.ts";
import { parseOpenAIChatRequest } from "./http.ts";
import type { ProjectedTurn } from "./http.ts";
import { StandaloneBrowserService } from "./runtime.ts";
import { createRequestHandler } from "./server.ts";
import type { BrowserFrame } from "./protocol.ts";
import {
  ENVELOPE_CLOSE,
  ENVELOPE_OPEN,
  PROMPT_CONTRACT_VERSION,
  TypedEnvelopeShim,
  envelopeKeys,
  hasEnvelopeShape,
  parseTypedEnvelope,
  serializeToolDefinitions,
} from "./protocol.ts";

describe("envelope-chain upgrade", () => {
  for (const endpoint of ["chat/completions", "responses"] as const) {
    test(`${endpoint} preserves executed tool-skill continuations then ordered reasoning and final response`, async () => {
      const calls = [
        { id: "call_1", name: "read", input: { path: "first.txt" } },
        { id: "call_2", name: "glob", input: { pattern: "*.txt" } },
        { id: "call_skill", name: "skill", input: { id: "fixture-skill" } },
        { id: "call_3", name: "read", input: { path: "last.txt" } },
      ];
      const seen: ProjectedTurn[] = [];
      const adapter = {
        async *turn(input: ProjectedTurn): AsyncGenerator<BrowserFrame> {
          const index = seen.length;
          seen.push(input);
          const call = calls[index];
          const envelopes = call
            ? [{ type: "tool", key: input.promptKey, ...call }]
            : [
                { type: "thinking", key: input.promptKey, id: "reason_1", text: "First reasoning segment." },
                { type: "thinking", key: input.promptKey, id: "reason_2", text: "Second reasoning segment." },
                { type: "chat", key: input.promptKey, id: "answer", text: "CHAIN-OK" },
              ];
          const text = envelopes.map(value => `${ENVELOPE_OPEN}${JSON.stringify(value)}${ENVELOPE_CLOSE}`).join("\n");
          // Exercise envelope boundaries independently of browser chunk boundaries.
          for (let offset = 0; offset < text.length; offset += 13)
            yield { type: "text", delta: text.slice(offset, offset + 13) };
          yield { type: "finish", reason: "stop" };
        },
        async close() {},
      };
      const browser = new StandaloneBrowserService(adapter as never, { waitMs: 50 });
      const handler = createRequestHandler({ token: "synthetic-chain-token", browser, shutdown: async () => {} });
      const definitions = [
        { name: "read", field: "path" },
        { name: "glob", field: "pattern" },
        { name: "skill", field: "id" },
      ].map(({ name, field }) => ({ name, description: name, parameters: {
        type: "object", properties: { [field]: { type: "string" } }, required: [field],
      } }));
      const messages: unknown[] = [{ role: "user", content: "Perform the requested tool and skill sequence." }];
      let previous: string | undefined;
      for (let index = 0; index <= calls.length; index++) {
        const last = index === calls.length;
        const prior = calls[index - 1];
        const body = endpoint === "chat/completions"
          ? { model: "gpt-5.6-terra", messages, tools: definitions.map(fn => ({ type: "function", function: fn })), stream: last }
          : { model: "gpt-5.6-terra", input: prior
                ? [{ type: "function_call_output", call_id: prior.id, output: `RESULT-${index}` }]
                : "Perform the requested tool and skill sequence.",
              previous_response_id: previous, tools: definitions.map(fn => ({ type: "function", ...fn })), stream: last };
        const response = await handler(new Request(`http://localhost/v1/${endpoint}`, {
          method: "POST",
          headers: { authorization: "Bearer synthetic-chain-token", "content-type": "application/json", "x-session-id": "chain-session" },
          body: JSON.stringify(body),
        }));
        expect(response.status).toBe(200);
        if (!last) {
          const value = await response.json();
          const expected = calls[index]!;
          if (endpoint === "chat/completions") {
            const choice = value.choices[0];
            expect(choice.finish_reason).toBe("tool_calls");
            expect(choice.message.tool_calls).toEqual([{ id: expected.id, type: "function", function: {
              name: expected.name, arguments: JSON.stringify(expected.input),
            } }]);
            messages.push(choice.message, { role: "tool", tool_call_id: expected.id, content: `RESULT-${index + 1}` });
          } else {
            previous = value.id;
            expect(value.output.filter((item: { type: string }) => item.type === "function_call")).toMatchObject([
              { call_id: expected.id, name: expected.name, arguments: JSON.stringify(expected.input) },
            ]);
          }
        } else {
          const stream = await response.text();
          const first = stream.indexOf("First reasoning segment.");
          const second = stream.indexOf("Second reasoning segment.");
          const answer = stream.indexOf("CHAIN-OK");
          expect(first).toBeGreaterThanOrEqual(0);
          expect(second).toBeGreaterThan(first);
          expect(answer).toBeGreaterThan(second);
          if (endpoint === "chat/completions") {
            expect(stream).toContain('"reasoning_content":"First reasoning segment."');
            expect(stream).toContain('"content":"CHAIN-OK"');
            expect(stream).toContain('"finish_reason":"stop"');
            expect(stream.match(/data: \[DONE\]/g)).toHaveLength(1);
          } else {
            expect(stream).toContain("response.reasoning_summary_text.delta");
            expect(stream).toContain("response.output_text.delta");
            expect(stream.match(/event: response.completed\n/g)).toHaveLength(1);
          }
          expect(stream).not.toContain(ENVELOPE_OPEN);
        }
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen.map(input => input.sessionMarker)).size).toBe(1);
      expect(new Set(seen.map(input => input.promptKey)).size).toBe(5);
      expect(seen.every(input => !!input.promptKey)).toBe(true);
      expect(seen.map(input => input.toolContinuation)).toEqual([false, true, true, true, true]);
      for (let index = 1; index < seen.length; index++)
        expect(seen[index]!.incrementalPrompt).toContain(`RESULT-${index}`);
      await browser.close();
    });
  }

  test("thinking envelope parses to reasoning (tagged + bare)", () => {
    const offered = new Set(["read"]);
    expect(
      parseTypedEnvelope({ type: "thinking", key: "k1", id: "t1", text: "hmm" }, offered),
    ).toEqual([{ type: "reasoning", delta: "hmm" }]);
    const shim = new TypedEnvelopeShim(offered);
    const frames = [
      ...shim.push(`${ENVELOPE_OPEN}${JSON.stringify({ type: "thinking", key: "k1", id: "t1", text: "bare-hmm" })}${ENVELOPE_CLOSE}`),
      ...shim.finish(),
    ];
    expect(frames).toEqual([{ type: "reasoning", delta: "bare-hmm" }]);
    const bare = new TypedEnvelopeShim(offered);
    expect(bare.push('{"type":"thinking","key":"k1","id":"t1","text":"bare"}')).toEqual([]);
    expect(bare.finish()).toEqual([{ type: "reasoning", delta: "bare" }]);
  });

  test("shim preserves thinking -> tool -> chat order", () => {
    const offered = new Set(["read"]);
    const shim = new TypedEnvelopeShim(offered);
    const text =
      `${ENVELOPE_OPEN}${JSON.stringify({ type: "thinking", key: "k", id: "t1", text: "r1" })}${ENVELOPE_CLOSE}` +
      `${ENVELOPE_OPEN}${JSON.stringify({ type: "tool", key: "k", id: "c1", name: "read", input: { path: "." } })}${ENVELOPE_CLOSE}` +
      `${ENVELOPE_OPEN}${JSON.stringify({ type: "chat", key: "k", id: "c2", text: "done" })}${ENVELOPE_CLOSE}`;
    expect([...shim.push(text), ...shim.finish()]).toEqual([
      { type: "reasoning", delta: "r1" },
      { type: "tool-call", id: "c1", name: "read", input: { path: "." } },
      { type: "text", delta: "done" },
    ]);
  });

  test("withTurnKey prepends TURN KEY as the first line", () => {
    expect(withTurnKey("BODY", "key-1")).toBe("TURN KEY: key-1\n\nBODY");
    expect(withTurnKey("BODY", "key-1").split("\n")[0]).toBe("TURN KEY: key-1");
  });

  test("envelopeKeys extracts every tagged and bare key", () => {
    const tagged =
      `${ENVELOPE_OPEN}${JSON.stringify({ type: "thinking", key: "k1", id: "a", text: "r" })}${ENVELOPE_CLOSE}` +
      `${ENVELOPE_OPEN}${JSON.stringify({ type: "chat", key: "k1", id: "b", text: "hi" })}${ENVELOPE_CLOSE}`;
    expect(envelopeKeys(tagged)).toEqual(["k1", "k1"]);
    const mixed =
      `${ENVELOPE_OPEN}${JSON.stringify({ type: "chat", key: "k1", id: "a", text: "hi" })}${ENVELOPE_CLOSE}` +
      ` ${JSON.stringify({ type: "chat", key: "k2", id: "b", text: "yo" })}`;
    expect(envelopeKeys(mixed)).toEqual(["k1", "k2"]);
    // Envelope shape present but zero parsable keys -> empty (mismatch upstream).
    expect(envelopeKeys(`${ENVELOPE_OPEN}{not json${ENVELOPE_CLOSE}`)).toEqual([]);
  });

  test("tool contract teaches thinking + chain grammar + first-line key", () => {
    const contract = serializeToolDefinitions([
      { name: "read", description: "Read", inputSchema: { type: "object" } },
    ]);
    expect(contract).toContain('"type":"thinking"');
    expect(contract).toContain("reasoning");
    expect(contract).toContain("never a final answer");
    expect(contract).toContain("thinking*");
    expect(contract).toContain("nothing else");
    expect(contract).toContain("FIRST line");
    expect(contract).toContain("Every envelope");
    expect(contract).toContain('Do not emit legacy <aipass-action> wrappers');
    expect(contract).not.toContain('emitting exactly <aipass-action>');
    expect(contract).toContain('<aipass-envelope>{"type":"tool","key":"<key>","id":"call_unique","name":"offered_name","input":{}}</aipass-envelope>');
    expect(contract).toContain('{"type":"thinking","key":"<key>","id":"reason_1","text":"..."}');
  });

  test("bare multi-envelope chain parses in order (thinking + tool)", () => {
    const offered = new Set(["read"]);
    const shim = new TypedEnvelopeShim(offered);
    const chain =
      JSON.stringify({ type: "thinking", key: "k", id: "t1", text: "r1" }) +
      "\n" +
      JSON.stringify({ type: "tool", key: "k", id: "c1", name: "read", input: { path: "." } });
    expect(shim.push(chain)).toEqual([]);
    expect(shim.finish()).toEqual([
      { type: "reasoning", delta: "r1" },
      { type: "tool-call", id: "c1", name: "read", input: { path: "." } },
    ]);
  });

  test("default bare-chain parsing preserves legacy prose without dispatching unoffered actions", () => {
    const shim = new TypedEnvelopeShim(new Set(["read"]));
    const chain = JSON.stringify({ type: "thinking", key: "k", text: "r1" }) + "\n" +
      JSON.stringify({ type: "tool", key: "k", name: "unoffered", input: {} });
    expect(shim.push(chain)).toEqual([]);
    expect(shim.finish()).toEqual([{ type: "text", delta: chain }]);
  });

  test("start prompt carries full name index but budgets schemas (stall guard)", () => {
    const tools = ["read", "glob", "grep", "shell", "write", "edit", "question"].map((name) => ({
      type: "function" as const,
      function: {
        name,
        description: `${name} op`,
        parameters: { type: "object", properties: { arg: { type: "string" } }, required: ["arg"] },
      },
    }));
    const parsed = parseOpenAIChatRequest(
      { model: "gpt-5.6-terra", messages: [{ role: "user", content: "hello" }], tools },
      new Headers({ "x-session-id": "budgeted-index-session" }),
    );
    // Name index is always complete (live 17-tool PTY stalls at ~24k full-schema chars).
    expect(parsed.turn.initialPrompt).toContain("Offered tool index");
    for (const name of ["read", "glob", "grep", "shell", "write", "edit", "question"]) {
      expect(parsed.turn.initialPrompt).toContain(`- ${name}:`);
    }
    // No tool declared/named yet: schemas stay out of the submit.
    expect(parsed.turn.initialPrompt).not.toContain('"inputSchema"');
    // Naming a tool in the latest request projects its full schema.
    const named = parseOpenAIChatRequest(
      { model: "gpt-5.6-terra", messages: [{ role: "user", content: "use the read tool on x" }], tools },
      new Headers({ "x-session-id": "budgeted-index-session" }),
    );
    expect(named.turn.initialPrompt).toContain('"name":"read"');
    expect(named.turn.initialPrompt).toContain('"inputSchema"');
  });

  test("typeless tool envelope parses to tool-call (live terra omits type)", () => {
    const offered = new Set(["read", "patch"]);
    expect(
      parseTypedEnvelope({ key: "k1", id: "c1", name: "read", input: { path: "test.png" } }, offered),
    ).toEqual([{ type: "tool-call", id: "c1", name: "read", input: { path: "test.png" } }]);
    const shim = new TypedEnvelopeShim(offered);
    const chain =
      JSON.stringify({ key: "k1", id: "call_2", name: "patch", input: { patchText: "x" } });
    expect(shim.push(chain)).toEqual([]);
    expect(shim.finish()).toEqual([
      { type: "tool-call", id: "call_2", name: "patch", input: { patchText: "x" } },
    ]);
    expect(hasEnvelopeShape(JSON.stringify({ id: "c1", name: "read", input: {} }))).toBe(true);
  });

  test("parsed turn carries the current contract version", () => {
    expect(PROMPT_CONTRACT_VERSION).toBe(15);
    const parsed = parseOpenAIChatRequest(
      { model: "gpt-5.6-terra", messages: [{ role: "user", content: "hello" }] },
      new Headers(),
    );
    expect(parsed.turn.promptContractVersion).toBe(15);
  });
});
