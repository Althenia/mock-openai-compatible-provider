// Opt-in metadata-only observer for one isolated, serial YCoding workflow.
// --self-test is local-only; --run requires AIPASS_LIVE_SMOKE=1 and AIPASS_LIVE_FIXTURE.
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { chromium, type Request as NativeRequest } from "playwright-core"
import { parseCommand } from "../src/config.ts"
import { parseOpenAIChatRequest } from "../src/http.ts"
import { serveProvider } from "../src/runtime.ts"
import { readExistingToken } from "../src/state.ts"

type Trace = { index: number; prompt: string; seen: number; internal: number; mismatches: number; native: Promise<NativeReply>[]; wire?: InputTrace[]; comparison?: ReturnType<typeof compareSkillInputs> }
type InputTrace = { digest: string; bytes: number; keyCount: number }
type NativeReply = { complete: boolean; attributable: boolean; inputs: InputTrace[] }
const report = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`)

function inputTrace(input: unknown): InputTrace {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("skill input must be an object")
  const canonical = JSON.stringify(input, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)
  return { digest: createHash("sha256").update(canonical).digest("hex"), bytes: Buffer.byteLength(canonical), keyCount: Object.keys(input).length }
}

function nativeReply(body: string, submittedKey?: string): NativeReply {
  const incomplete: NativeReply = { complete: false, attributable: false, inputs: [] }
  try {
    let text = ""
    let finished = false
    for (const line of body.split("\n")) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (data === "[DONE]") continue
      const event = JSON.parse(data) as { type?: string; delta?: unknown }
      if (event.type === "text-delta" && typeof event.delta === "string") text += event.delta
      if (event.type === "finish") finished = true
    }
    const tagged = [...text.matchAll(/<aipass-envelope>([\s\S]*?)<\/aipass-envelope>/g)]
    let values: unknown[]
    if (tagged.length) {
      if (text.replace(/<aipass-envelope>[\s\S]*?<\/aipass-envelope>/g, "").trim()) return incomplete
      values = tagged.map((match) => JSON.parse(match[1]!))
    } else {
      const value: unknown = JSON.parse(text)
      values = Array.isArray(value) ? value : [value]
    }
    if (!values.length || !values.every((value) => value && typeof value === "object" && !Array.isArray(value))) return incomplete
    const envelopes = values as Record<string, unknown>[]
    const inputs = envelopes.flatMap((envelope) => {
      const calls = envelope.type === "plan" && Array.isArray(envelope.steps) ? envelope.steps : [envelope]
      return calls.flatMap((call: Record<string, unknown>) => {
        const name = call.name ?? call.type
        return name === "skill" ? [inputTrace(call.input)] : []
      })
    })
    return { complete: finished, attributable: !!submittedKey && envelopes.every((value) => value.key === submittedKey), inputs }
  } catch { return incomplete }
}

function compareSkillInputs(native: NativeReply[], wire: InputTrace[]): "matched" | "mismatched" | "indeterminate" {
  if (native.length !== 1 || !native[0]!.complete || !native[0]!.attributable) return "indeterminate"
  return JSON.stringify(native[0]!.inputs) === JSON.stringify(wire) ? "matched" : "mismatched"
}

function skillCaptureSummary(traces: Trace[]) {
  const wireCalls = traces.reduce((count, trace) => count + (trace.wire?.length ?? 0), 0)
  return { wireCalls, complete: wireCalls > 0 && traces.every((trace) => trace.native.length === 1 && trace.comparison === "matched") }
}

function addTrace(traces: Trace[], trace: Trace) {
  const overlapping = traces.some((item) => item.wire === undefined)
  traces.push(trace)
  return overlapping
}

function nativeOwner(trace?: Trace) {
  return trace?.wire === undefined ? trace : undefined
}

function captureSummary(traces: Trace[], nativeCount: number, inspectionFailed: boolean, normalConfigUnchanged: boolean) {
  return {
    normalConfigUnchanged, nativeCount, inspectionFailed,
    projection: traces.map((trace) => ({ request: trace.index, expectedChars: trace.prompt.length, observed: trace.seen, internal: trace.internal, mismatches: trace.mismatches })),
    captureComplete: normalConfigUnchanged && !inspectionFailed && nativeCount > 0 && traces.length > 0 &&
      traces.every((trace) => trace.prompt.length > 0 && trace.seen > 0 && trace.mismatches === 0),
  }
}

async function project(request: Request, index: number): Promise<Trace | undefined> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") return
  const parsed = parseOpenAIChatRequest(await request.clone().json(), request.headers)
  if (parsed.turn.primingPrompts.length || parsed.turn.initialPrompt !== parsed.turn.incrementalPrompt || parsed.turn.initialPrompt !== parsed.turn.recoveryPrompt)
    throw new Error("observer requires a self-contained request projection")
  return { index, prompt: parsed.turn.initialPrompt, seen: 0, internal: 0, mismatches: 0, native: [] }
}

function nativeSubmission(data: string, trace?: Trace) {
  const body = JSON.parse(data) as {
    isTemporary?: boolean
    messages?: { parts?: { type?: string; text?: unknown }[] }[]
  }
  if (!Array.isArray(body.messages)) return
  const texts = body.messages.flatMap((message) => Array.isArray(message.parts)
    ? message.parts.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []) : [])
  const keys = texts.flatMap((text) => /^TURN KEY: ([^\r\n]+)\r?\n/.exec(text)?.[1] ?? [])
  if (keys.length > 1) throw new Error("ambiguous submitted turn key")
  const submitted = texts.find((text) => text.startsWith("TURN KEY: "))?.replace(/^TURN KEY: [^\r\n]+\r?\n\r?\n/, "")
  const expected = trace?.prompt
  const exact = expected !== undefined ? expected === submitted : null
  const internal = expected !== undefined && submitted?.startsWith(expected + "\n\n") === true
  if (trace) {
    trace.seen++
    if (internal) trace.internal++
    if (!exact && !internal) trace.mismatches++
  }
  return {
    submittedKey: keys[0],
    check: "native-submission", request: trace?.index, exact, internal, fullContext: exact === true || internal,
    expectedChars: expected?.length, observedChars: submitted?.length,
    trailingWhitespaceOnly: exact === false && submitted === expected?.trimEnd(),
    lineEndingsOnly: exact === false && submitted === expected?.replace(/\r\n?/g, "\n"),
    messages: body.messages.length, temporary: body.isTemporary === true,
    catalog: texts.some((text) => text.includes("available_skills")),
    readme: texts.some((text) => text.includes("readme-writer")),
  }
}

function responseSummary(text: string, expected: string) {
  const chunks = text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)) as {
    choices?: { delta?: { content?: string; reasoning_content?: string; tool_calls?: { function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[]
  })
  const deltas = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta ? [chunk.choices[0].delta] : [])
  const content = deltas.map((delta) => delta.content ?? "").join("")
  const finish = chunks.map((chunk) => chunk.choices?.[0]?.finish_reason).filter(Boolean).at(-1)
  return {
    finish, tools: deltas.flatMap((delta) => delta.tool_calls ?? []).flatMap((call) => call.function?.name ? [call.function.name] : []),
    skillInputs: deltas.flatMap((delta) => delta.tool_calls ?? []).flatMap((call) => call.function?.name === "skill"
      ? [inputTrace(JSON.parse(call.function.arguments ?? ""))] : []),
    exactFinal: finish === "stop" && content === expected,
    trimmedFinal: finish === "stop" && content.trim() === expected.trim(),
    contentChars: content.length, reasoningChunks: deltas.filter((delta) => !!delta.reasoning_content).length,
  }
}

async function selfTest() {
  assert.equal(captureSummary([], 0, false, true).captureComplete, false, "empty observations must fail")
  const partial: Trace = { index: 1, prompt: "SYSTEM: context\n\nUSER: request", seen: 0, internal: 0, mismatches: 0, native: [] }
  assert.equal(captureSummary([partial], 1, false, true).captureComplete, false, "missing current-request submission must fail")
  const full: Trace = { ...partial, seen: 1 }
  assert.equal(captureSummary([full], 1, false, true).captureComplete, true)
  const bound: Trace = { ...full, index: 2, seen: 0 }
  assert.equal(captureSummary([full, bound], 1, false, true).captureComplete, false, "a prior exact submission cannot stand in for a bound request")
  assert.equal(captureSummary([full, { ...bound, seen: 1 }], 2, false, true).captureComplete, true)
  assert.equal(captureSummary([{ ...full, mismatches: 1 }], 3, false, true).captureComplete, false)
  assert.equal(captureSummary([full], 2, true, true).captureComplete, false)
  assert.equal(captureSummary([full], 2, false, false).captureComplete, false)
  const whitespaceTrace: Trace = { ...partial, prompt: "fixture \n" }
  const nativeBody = (text: string) => JSON.stringify({ isTemporary: true, messages: [{ parts: [{ type: "text", text: `TURN KEY: submitted-turn\n\n${text}` }] }] })
  const whitespace = nativeSubmission(nativeBody(whitespaceTrace.prompt.trimEnd()), whitespaceTrace)
  assert.equal(whitespace?.exact, false)
  assert.equal(whitespace?.trailingWhitespaceOnly, true)
  assert.equal(whitespaceTrace.seen, 1)
  assert.equal(whitespaceTrace.mismatches, 1)
  const repaired = { ...partial }
  assert.equal(nativeSubmission(nativeBody(repaired.prompt + "\n\nrepair instruction"), repaired)?.fullContext, true)
  assert.equal(repaired.internal, 1)
  assert.equal(nativeSubmission(nativeBody("repair instruction"), repaired)?.fullContext, false)
  assert.equal(captureSummary([repaired], 2, false, true).captureComplete, false, "contextless internal turns must fail")
  assert.equal(nativeSubmission(JSON.stringify({ messages: [{ parts: [{ type: "text", text: partial.prompt }] }] }), { ...partial })?.fullContext, false, "unkeyed submissions are not attributable")
  const body = JSON.stringify({ model: "gemini-3.1-flash-lite", instruction_mode: "preserve", messages: [
    { role: "system", content: "Synthetic instruction.\n".repeat(450) + "<available_skills>readme-writer</available_skills>" },
    { role: "user", content: "Reply ready." },
  ] })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const trace = await project(request, 1)
    assert(trace && trace.prompt.length > 8_000)
    assert(trace.prompt.includes("<available_skills>readme-writer</available_skills>"))
    assert.equal(await request.text(), body)
    assert.equal(nativeSubmission(nativeBody(trace.prompt), trace)?.exact, true)
    assert.equal(trace.seen, 1)
    assert.equal(trace.mismatches, 0)
    return new Response("ready")
  } })
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), { method: "POST", body })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), "ready")
    assert.equal(await project(new Request("http://localhost/shutdown", { method: "POST" }), 1), undefined)
    assert.equal(responseSummary('data: {"choices":[{"delta":{"content":"ready"},"finish_reason":"stop"}]}\n', "ready").exactFinal, true)
    assert.equal(responseSummary('data: {"choices":[{"delta":{"content":"ready\\n"},"finish_reason":"stop"}]}\n', "ready").exactFinal, false)
    const input = { id: "synthetic-skill_id" }
    const inputText = JSON.stringify(input)
    const expectedInput = { digest: createHash("sha256").update(inputText).digest("hex"), bytes: Buffer.byteLength(inputText), keyCount: 1 }
    const wire = responseSummary(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: "skill", arguments: inputText } }] } }] })}\n`, "")
    assert.deepEqual(wire.skillInputs, [expectedInput], "wire inspection must retain only input metadata")
    const envelope = (value: object) => `<aipass-envelope>${JSON.stringify(value)}</aipass-envelope>`
    const stream = (text: string, finish = true) => `data: ${JSON.stringify({ type: "text-delta", delta: text })}\n\n${finish ? 'data: {"type":"finish","finishReason":"stop"}\n\n' : ""}`
    const action = { type: "skill", key: "submitted-turn", input }
    const native = nativeReply(stream(envelope(action)), "submitted-turn")
    assert.deepEqual(native, { complete: true, attributable: true, inputs: [expectedInput] })
    assert.equal(compareSkillInputs([native], wire.skillInputs), "matched")
    assert.equal(compareSkillInputs([native], []), "mismatched", "dropped native skill input must fail")
    assert.equal(compareSkillInputs([], wire.skillInputs), "indeterminate", "missing native output is not a match")
    assert.equal(compareSkillInputs([native, native], wire.skillInputs), "indeterminate", "multiple attributable replies are ambiguous")
    assert.equal(compareSkillInputs([nativeReply(stream(envelope({ ...action, key: "old-turn" })), "submitted-turn"), native], wire.skillInputs), "indeterminate", "do not choose a native attempt from multiple captures")
    assert.equal(compareSkillInputs([nativeReply(stream(envelope(action), false), "submitted-turn")], wire.skillInputs), "indeterminate")
    assert.equal(compareSkillInputs([nativeReply(stream(envelope({ ...action, key: "old-turn" })), "submitted-turn")], wire.skillInputs), "indeterminate")
    assert.equal(compareSkillInputs([nativeReply(stream(envelope(action)))], wire.skillInputs), "indeterminate", "missing submitted key must not match")
    assert.equal(compareSkillInputs([nativeReply(stream(envelope({ ...action, input: { id: "different-skill" } })), "submitted-turn")], wire.skillInputs), "mismatched")
    assert.deepEqual(nativeReply(stream(envelope({ ...action, type: "tool", name: "skill" })), "submitted-turn"), native)
    assert.deepEqual(nativeReply(stream(envelope({ type: "plan", key: "submitted-turn", steps: [
      { id: "call_read", name: "read", input: { path: "fixture.txt" } },
      { id: "call_skill", name: "skill", input },
    ] })), "submitted-turn"), native, "plan steps must preserve native skill input metadata")
    assert.deepEqual(nativeReply(stream(JSON.stringify(action)), "submitted-turn"), native)
    assert.equal(compareSkillInputs([nativeReply(stream(envelope({ type: "tool", name: "read", key: "submitted-turn", input: { path: "notes.txt" } })), "submitted-turn")], []), "matched", "captured non-skill turns must not fail skill comparison")
    assert.equal(compareSkillInputs([nativeReply(stream(`unparsed ${envelope(action)}`), "submitted-turn")], wire.skillInputs), "indeterminate")
    assert.equal(compareSkillInputs([nativeReply(stream(envelope({ ...action, input: "invalid" })), "submitted-turn")], wire.skillInputs), "indeterminate")
    assert.deepEqual(inputTrace({ id: "fixture", options: { b: 2, a: 1 } }), inputTrace({ options: { a: 1, b: 2 }, id: "fixture" }))
    const submission = nativeSubmission(JSON.stringify({ messages: [{ parts: [{ type: "text", text: "TURN KEY: submitted-turn\n\nrequest" }] }] }))
    assert.equal(submission?.submittedKey, "submitted-turn", "use the actual submitted key, not a separately projected key")
    assert.throws(() => nativeSubmission(JSON.stringify({ messages: [{ parts: [
      { type: "text", text: "TURN KEY: one\n\nrequest" }, { type: "text", text: "TURN KEY: two\n\nrequest" },
    ] }] })))
    const inspected: Trace = { ...full, native: [Promise.resolve(native)], wire: wire.skillInputs, comparison: "matched" }
    assert.deepEqual(skillCaptureSummary([inspected]), { wireCalls: 1, complete: true })
    assert.equal(skillCaptureSummary([]).complete, false)
    assert.equal(skillCaptureSummary([{ ...inspected, wire: [] }]).complete, false)
    assert.equal(skillCaptureSummary([inspected, { ...full }]).complete, false)
    assert.equal(skillCaptureSummary([{ ...inspected, comparison: "mismatched" }]).complete, false)
    assert.equal(skillCaptureSummary([{ ...inspected, comparison: "indeterminate" }]).complete, false)
    assert.equal(skillCaptureSummary([{ ...inspected, native: [...inspected.native, Promise.resolve(native)] }]).complete, false, "a late additional native reply invalidates an earlier match")
    const serial: Trace[] = []
    assert.equal(addTrace(serial, full), false)
    assert.equal(addTrace(serial, bound), true, "overlapping requests make native ownership ambiguous")
    assert.equal(addTrace([inspected], bound), false, "a completed wire response permits the next serial request")
    assert.equal(nativeOwner(full), full)
    assert.equal(nativeOwner(undefined), undefined)
    assert.equal(nativeOwner(inspected), undefined, "late native traffic must not attach to a completed transaction")
    report({ selfTest: "passed" })
  } finally { await server.stop(true) }
}

async function run(managedClient = false) {
  const fixture = process.env.AIPASS_LIVE_FIXTURE
  if (process.env.AIPASS_LIVE_SMOKE !== "1" || !fixture) throw new Error("explicit live opt-in and fixture required")
  const command = parseCommand(["start"], { ...process.env, AIPASS_BROWSER_HEADED: "1" })
  if (command.type !== "serve") throw new Error("settings unavailable")
  const expected = await Bun.file(join(fixture, "notes.txt")).text()
  const root = join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME!, ".config"), "ycoding")
  const hash = async (name: string) => createHash("sha256").update(Buffer.from(await Bun.file(join(root, name)).arrayBuffer())).digest("hex")
  const originals = new Map<string, string>()
  for (const name of ["ycoding.json", "ycoding.jsonc", "config.json", "config.jsonc"])
    if (await Bun.file(join(root, name)).exists()) originals.set(name, await hash(name))
  if (!originals.size) throw new Error("normal configuration guard unavailable")
  const traces: Trace[] = []
  const checks: Promise<void>[] = []
  let current: Trace | undefined
  let nativeCount = 0
  let inspectionFailed = false
  let firstNativeTarget: string | undefined
  const launch = chromium.launchPersistentContext.bind(chromium)
  chromium.launchPersistentContext = async (...args: Parameters<typeof launch>) => {
    const context = await launch(...args)
    const owners = new WeakMap<NativeRequest, Trace>()
    context.on("request", (request) => {
      const trace = nativeOwner(current)
      if (trace) owners.set(request, trace)
    })
    context.on("response", (response) => {
      const request = response.request()
      if (request.method() !== "POST" || !response.headers()["content-type"]?.includes("text/event-stream")) return
      try {
        const trace = owners.get(request)
        const submission = nativeSubmission(request.postData() ?? "", trace)
        if (submission) {
          const { submittedKey, ...metadata } = submission
          firstNativeTarget ??= request.url()
          nativeCount++
          report({ sequence: nativeCount, sameTargetAsFirst: request.url() === firstNativeTarget, ...metadata })
          if (trace) trace.native.push(response.text().then((body) => nativeReply(body, submittedKey)).catch(() => {
            inspectionFailed = true
            return { complete: false, attributable: false, inputs: [] }
          }))
        }
      } catch { inspectionFailed = true; report({ nativeInspectionFailed: true }) }
    })
    return context
  }
  let ready!: (endpoint: string) => void
  const readiness = new Promise<string>((resolve) => { ready = resolve })
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    const endpoint = /^OpenAI-compatible endpoint: (.+)$/.exec(String(args[0]))?.[1]
    if (endpoint) ready(endpoint)
  }
  const serving = serveProvider(command.settings)
  let proxy: ReturnType<typeof Bun.serve> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let endpoint: string | undefined
  let token: string | undefined
  const stop = async () => {
    if (!endpoint || !token) return
    const response = await fetch(new URL("/shutdown", endpoint), { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error("provider shutdown rejected")
  }
  try {
    endpoint = await Promise.race([readiness, serving.then(() => { throw new Error("provider exited before ready") }),
      new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("startup timeout")), 20_000) })])
    clearTimeout(startupTimer)
    token = await readExistingToken(command.settings.paths)
    proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, async fetch(request) {
      let trace: Trace | undefined
      try {
        trace = await project(request, traces.length + 1)
        if (trace) {
          if (addTrace(traces, trace)) { inspectionFailed = true; report({ overlappingClientRequests: true }) }
          current = trace
          report({ check: "client-projection", request: trace.index, expectedChars: trace.prompt.length, catalog: trace.prompt.includes("available_skills"), readme: trace.prompt.includes("readme-writer") })
        }
      } catch { inspectionFailed = true; report({ projectionFailed: true }) }
      const response = await fetch(new URL(new URL(request.url).pathname, endpoint), { method: request.method, headers: request.headers, body: request.body, signal: request.signal })
      if (trace) {
        const item = trace
        checks.push(response.clone().text().then(async (text) => {
          const summary = responseSummary(text, expected)
          item.wire = summary.skillInputs
          const native = await Promise.all(item.native)
          item.comparison = compareSkillInputs(native, summary.skillInputs)
          report({ check: "native-client-skill-input", request: item.index, native, wire: summary.skillInputs, comparison: item.comparison })
          report({ check: "client-response", request: item.index, status: response.status, ...summary })
          if (summary.finish === "stop") await stop()
        }).catch(() => {
          if (current === item) current = undefined
          inspectionFailed = true
          report({ responseInspectionFailed: true, request: item.index })
        }))
      }
      return response
    } })
    if (managedClient) originalLog(`OpenAI-compatible endpoint: ${new URL("/v1", proxy.url).href}`)
    else {
      const overlay = JSON.stringify({ providers: { aipass: { body: { instruction_mode: "preserve" }, settings: { baseURL: new URL("/v1", proxy.url).href } } } })
      const client = Bun.spawn(["tmux", "new-window", "-d", "-t", "yce2e", "-n", "catalog-trace-checked", "env", `YCODING_CONFIG_CONTENT=${overlay}`, "ycoding", "--standalone", fixture], { stdout: "ignore", stderr: "ignore" })
      if (await client.exited !== 0) throw new Error("isolated client launch failed")
      report({ providerReady: true, isolatedClientCreated: true })
    }
    timer = setTimeout(() => { report({ deadlineReached: true }); void stop().catch(() => process.kill(process.pid, "SIGTERM")) }, 500_000)
    await serving
    await Promise.all(checks)
  } finally {
    clearTimeout(timer); clearTimeout(startupTimer)
    await stop().catch(() => undefined)
    await proxy?.stop(true)
    chromium.launchPersistentContext = launch
    console.log = originalLog
    let unchanged = true
    for (const [name, before] of originals) unchanged = (before === await hash(name)) && unchanged
    const summary = captureSummary(traces, nativeCount, inspectionFailed, unchanged)
    const skillInputCapture = skillCaptureSummary(traces)
    report({ ...summary, skillInputCapture })
    if (!summary.captureComplete || !skillInputCapture.complete) process.exitCode = 1
  }
}

if (Bun.argv[2] === "--self-test") await selfTest()
else if (Bun.argv[2] === "--run") await run()
else if (Bun.argv[2] === "--provider") await run(true)
else throw new Error("use --self-test, --run, or --provider")
