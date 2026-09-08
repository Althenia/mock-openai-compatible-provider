// Opt-in, quota-consuming checks against the authenticated webchat profile.
// Build first, then run: bun scripts/live-smoke.ts [--case lookup|chain|catalog|instruction-update|startup-context] [--instruction-mode action-only|preserve] [model-id ...]
import { MODELS } from "../src/config.ts"

type CaseName = "lookup" | "chain" | "catalog" | "instruction-update" | "startup-context"
type ChatCall = { readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
type ChainStep = { readonly name: string; readonly input: Record<string, string> }

const supportedModels = ["claude-sonnet-5@default", "gpt-5.6-terra", "gemini-3.1-flash-lite"]
const args = process.argv.slice(2)
let caseName: CaseName = "lookup"
let catalogMode: "action-only" | "preserve" | undefined
const selected: string[] = []
for (let index = 0; index < args.length; index++) {
  const value = args[index]!
  if (value === "--instruction-mode") {
    const next = args[++index]
    if (next !== "action-only" && next !== "preserve") throw new Error("--instruction-mode must be action-only or preserve")
    catalogMode = next
    continue
  }
  if (value === "--case") {
    const next = args[++index]
    if (next !== "lookup" && next !== "chain" && next !== "catalog" && next !== "instruction-update" && next !== "startup-context") throw new Error("--case must be lookup, chain, catalog, instruction-update, or startup-context")
    caseName = next
    continue
  }
  if (value.startsWith("--case=")) {
    const next = value.slice("--case=".length)
    if (next !== "lookup" && next !== "chain" && next !== "catalog" && next !== "instruction-update" && next !== "startup-context") throw new Error("--case must be lookup, chain, catalog, instruction-update, or startup-context")
    caseName = next
    continue
  }
  selected.push(value)
}
if (selected.some((id) => !supportedModels.includes(id))) throw new Error("unsupported live-check model")
if (catalogMode && caseName !== "catalog") throw new Error("--instruction-mode is only supported for the catalog comparison")
const models = selected.length ? selected : caseName === "catalog" || caseName === "instruction-update" ? ["gemini-3.1-flash-lite"] : supportedModels
const binary = new URL("../dist/aipass-browser-provider", import.meta.url).pathname
const REQUEST_TIMEOUT_MS = 100_000
const MAX_TURNS = 5

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`)
  return value
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function firstChoice(value: unknown): Record<string, unknown> | undefined {
  return record(arrayValue(record(value)?.choices)[0])
}

function parseCall(value: unknown): ChatCall {
  const call = record(value)
  const function_ = record(call?.function)
  const id = stringValue(call?.id, "tool call id")
  const name = stringValue(function_?.name, "tool call name")
  const arguments_ = stringValue(function_?.arguments, "tool call arguments")
  const input = record(JSON.parse(arguments_))
  if (!input) throw new Error("tool call arguments must be an object")
  return { id, name, input }
}

function equalInput(actual: Record<string, unknown>, expected: Record<string, string>) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

const chatTools = [
  { type: "function", function: {
    name: "read", description: "Read one in-memory synthetic fixture by path.",
    parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] },
  } },
  { type: "function", function: {
    name: "glob", description: "List in-memory synthetic fixtures by pattern.",
    parameters: { type: "object", additionalProperties: false, properties: { pattern: { type: "string" } }, required: ["pattern"] },
  } },
  { type: "function", function: {
    name: "skill", description: "Load one in-memory synthetic skill by id.",
    parameters: { type: "object", additionalProperties: false, properties: { id: { type: "string" } }, required: ["id"] },
  } },
] as const

const responsesTools = chatTools.map((tool) => ({ type: "function" as const, ...tool.function }))
const chainSteps: readonly ChainStep[] = [
  { name: "read", input: { path: "fixture-alpha.txt" } },
  { name: "glob", input: { pattern: "fixture-*.txt" } },
  { name: "skill", input: { id: "fixture-skill" } },
  { name: "read", input: { path: "fixture-beta.txt" } },
]

const chainRequest = "Use the external client dispatcher for this exact sequence, one action per turn: read fixture-alpha.txt, glob fixture-*.txt, skill fixture-skill, then read fixture-beta.txt. Do not answer before all four returned results. After the final result, respond with only the exact final result token and no other text."

function executeChainStep(index: number, call: ChatCall, finalToken: string, steps = chainSteps): string {
  const expected = steps[index]
  if (!expected || call.name !== expected.name || !equalInput(call.input, expected.input))
    throw new Error(`unexpected chain tool request at step ${index + 1}: name=${call.name}, inputMatches=${!!expected && equalInput(call.input, expected.input)}`)
  if (index === 0) return "ALPHA synthetic fixture read"
  if (index === 1) return "fixture-alpha.txt\nfixture-beta.txt"
  if (index === 2) return "fixture-skill loaded"
  return finalToken
}

async function request(endpoint: string, token: string, path: string, body: unknown): Promise<Response> {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`provider HTTP ${response.status}: ${await response.text()}`)
  return response
}

function chatCall(value: unknown, step?: number): ChatCall {
  const choice = firstChoice(value)
  const message = record(choice)?.message
  const calls = arrayValue(record(message)?.tool_calls)
  if (calls.length !== 1 || record(choice)?.finish_reason !== "tool_calls")
    throw new Error(`expected exactly one tool call${step === undefined ? "" : ` at step ${step}`}; received ${calls.length}, finish=${String(record(choice)?.finish_reason)}, text=${String(record(message)?.content ?? "").slice(0, 800)}`)
  return parseCall(calls[0])
}

function responsesCall(value: unknown): ChatCall {
  const output = record(value)?.output
  if (!Array.isArray(output)) throw new Error("responses output is missing")
  const calls = output.filter((item) => record(item)?.type === "function_call")
  if (calls.length !== 1) throw new Error("expected exactly one response function call")
  const call = record(calls[0])
  const id = stringValue(call?.call_id, "response call id")
  const name = stringValue(call?.name, "response call name")
  const arguments_ = stringValue(call?.arguments, "response call arguments")
  const input = record(JSON.parse(arguments_))
  if (!input) throw new Error("response call arguments must be an object")
  return { id, name, input }
}

function chatStream(text: string, finalToken: string) {
  const data = text.split("\n").flatMap((line) => line.startsWith("data: {") ? [JSON.parse(line.slice(6))] : [])
  const content = data.map((item) => firstChoice(item)?.delta)
    .map(record).map((delta) => typeof delta?.content === "string" ? delta.content : "").join("")
  const reasoning = data.map((item) => firstChoice(item)?.delta)
    .map(record).map((delta) => typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "").join("")
  const terminals = data.filter((item) => firstChoice(item)?.finish_reason != null)
  if (data.some((item) => record(item)?.error) || firstChoice(terminals[0])?.finish_reason !== "stop" ||
      content.trim() !== finalToken || terminals.length !== 1 || (reasoning && content.includes(reasoning)))
    throw new Error(`chat final stream mismatch: text=${JSON.stringify(content.slice(0, 800))}, expected=${finalToken}, terminals=${terminals.length}, reasoningChars=${reasoning.length}`)
  if (text.match(/data: \[DONE\]/g)?.length !== 1) throw new Error("chat final stream did not terminate once")
}

function responsesStream(text: string, finalToken: string) {
  const blocks = text.split("\n\n").filter(Boolean)
  const events = blocks.map((block) => ({
    name: /^event: ([^\n]+)/m.exec(block)?.[1],
    value: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "{}") as unknown,
  }))
  const content = events.filter((event) => event.name === "response.output_text.delta")
    .map((event) => record(event.value)?.delta).filter((value): value is string => typeof value === "string").join("")
  const reasoning = events.filter((event) => event.name === "response.reasoning_summary_text.delta")
    .map((event) => record(event.value)?.delta).filter((value): value is string => typeof value === "string").join("")
  const terminals = events.filter((event) => ["response.completed", "response.failed", "response.incomplete", "error"].includes(event.name ?? ""))
  if (terminals[0]?.name !== "response.completed" || content.trim() !== finalToken || terminals.length !== 1 || (reasoning && content.includes(reasoning)))
    throw new Error(`responses final stream mismatch: text=${JSON.stringify(content.slice(0, 800))}, expected=${finalToken}, terminals=${terminals.length}, reasoningChars=${reasoning.length}`)
}

async function runLookup(endpoint: string, token: string, model: string, effort: string | undefined) {
  const session = crypto.randomUUID()
  const tools = [{ type: "function", function: {
    name: "lookup_value", description: "Retrieve the current value for a named synthetic test fixture.",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  } }]
  const messages: unknown[] = [{ role: "user", content: "Call lookup_value with key test_fixture. After receiving its result, reply with only that result. Do not invent the result." }]
  const body = () => ({ model, reasoning: effort ? { effort } : undefined, messages, tools, stream: false, session_id: session })
  const first = await (await request(endpoint, token, "/chat/completions", body())).json()
  const call = chatCall(first)
  if (call.name !== "lookup_value" || call.input.key !== "test_fixture") throw new Error("unexpected lookup request")
  const result = `fixture-${crypto.randomUUID()}`
  const assistant = record(firstChoice(first)?.message)
  if (!assistant) throw new Error("lookup assistant message is missing")
  messages.push(assistant, { role: "tool", tool_call_id: call.id, content: result })
  const second = await (await request(endpoint, token, "/chat/completions", body())).json()
  const choice = firstChoice(second)
  const content = record(choice?.message)?.content
  if (choice?.finish_reason !== "stop" || typeof content !== "string" || content.trim() !== result)
    throw new Error("tool result continuation did not return the supplied value")
}

async function runStartupContext(endpoint: string, token: string, model: string, effort: string | undefined, api: "chat" | "responses") {
  const session = `startup-${crypto.randomUUID()}`
  const workspace = `fixture-root-${crypto.randomUUID()}`
  const prefix = `FOLDERS_${crypto.randomUUID()}`
  const startup = [
    { role: "system", content: `USER INSTRUCTIONS: For your final answer, respond with exactly ${prefix}: followed immediately by the returned folder name, without extra text.` },
    { role: "developer", content: "AGENT INSTRUCTIONS: You decide the next action and interpret results. The client only validates and dispatches your structured output. For a directory request, choose the offered read-only directory capability rather than a shell command. Wait for its result before answering." },
    { role: "developer", content: `WORKSPACE INSTRUCTIONS: The current repository path is ${workspace}. Use that exact path, not a guessed path or the adapter's working directory.` },
  ]
  const task = { role: "user", content: "List current repo folders." }
  const tools = [
    { name: "read", description: "List a directory by path, read-only.", parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "shell", description: "Execute a shell command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  ]
  const common = { model, reasoning: effort ? { effort } : undefined, session_id: session, stream: false }
  const messages: unknown[] = [...startup, task]
  const route = api === "chat" ? "/chat/completions" : "/responses"
  const first = await (await request(endpoint, token, route, api === "chat"
    ? { ...common, messages, tools: tools.map((tool) => ({ type: "function", function: tool })) }
    : { ...common, input: messages, tools: tools.map((tool) => ({ type: "function", ...tool })) })).json()
  const call = api === "chat" ? chatCall(first) : responsesCall(first)
  if (call.name !== "read" || !equalInput(call.input, { path: workspace }))
    throw new Error("startup instructions did not produce the exact read-only action and workspace-derived path")
  console.log(JSON.stringify({ model, check: `startup-context-${api}`, stage: "action", startupSections: ["user", "agent", "workspace"], passed: true }))
  // Handler-only fixture: dispatch the returned request, without choosing a next action.
  const folder = `folder-${crypto.randomUUID()}`
  const result = JSON.stringify({ folders: [folder] })
  let next: unknown
  if (api === "chat") {
    const assistant = record(firstChoice(first)?.message)
    if (!assistant) throw new Error("startup assistant message is missing")
    messages.push(assistant, { role: "tool", tool_call_id: call.id, content: result })
    next = { ...common, messages, tools: tools.map((tool) => ({ type: "function", function: tool })) }
  } else {
    next = { ...common, previous_response_id: stringValue(record(first)?.id, "response id"), input: [{ type: "function_call_output", call_id: call.id, output: result }], tools: tools.map((tool) => ({ type: "function", ...tool })) }
  }
  const final = await request(endpoint, token, route, { ...record(next), stream: true })
  const text = await final.text()
  if (api === "chat") chatStream(text, `${prefix}:${folder}`)
  else responsesStream(text, `${prefix}:${folder}`)
}

async function runChatChain(endpoint: string, token: string, model: string, effort: string | undefined, instructionMode?: "action-only" | "preserve", updateInstructions = false) {
  const session = `chain-chat-${crypto.randomUUID()}`
  // Catalog IDs are unpredictable and appear only in system context, not in
  // the user request or tool schema. This isolates instruction projection.
  const skillID = `fixture-doc-${crypto.randomUUID()}`
  const finalPath = `fixture-final-${crypto.randomUUID()}.txt`
  const catalogSteps = instructionMode
    ? chainSteps.map((step) => step.name === "skill" ? { name: "skill", input: { id: skillID } } : step)
    : chainSteps
  const steps = updateInstructions
    ? catalogSteps.map((step, index) => index === 3 ? { name: "read", input: { path: finalPath } } : step)
    : catalogSteps
  const userRequest = updateInstructions
    ? chainRequest.replace("read fixture-beta.txt", "read the final fixture path supplied in a subsequent client instruction update")
    : chainRequest
  const messages: unknown[] = instructionMode
    ? [
        { role: "system", content: `Available client skills:\n<available_skills>\n<skill><id>${skillID}</id><description>Review documentation in plain text fixtures.</description></skill>\n<skill><id>fixture-data-${crypto.randomUUID()}</id><description>Analyze numerical datasets; not documentation.</description></skill>\n</available_skills>` },
        { role: "user", content: userRequest.replace("skill fixture-skill", "load a suitable documentation skill from the available client skills") },
      ]
    : [{ role: "user", content: chainRequest }]
  const finalToken = `FINAL_${crypto.randomUUID()}`
  for (let index = 0; index < MAX_TURNS - 1; index++) {
    if (updateInstructions && index === 3) messages.push({ role: "developer", content: `Client instruction update: the final fixture path is ${finalPath}. Continue the pending read using this path, then return only its result as requested.` })
    const body = { model, reasoning: effort ? { effort } : undefined, messages, tools: chatTools, stream: false, session_id: session, instruction_mode: instructionMode }
    const value = await (await request(endpoint, token, "/chat/completions", body)).json()
    const call = chatCall(value, index + 1)
    const result = executeChainStep(index, call, finalToken, steps)
    if (instructionMode) console.log(JSON.stringify({ model, effort, check: updateInstructions ? "instruction-update" : `catalog-${instructionMode}`, step: index + 1, tool: call.name, inputMatches: true }))
    const assistant = record(firstChoice(value)?.message)
    if (!assistant) throw new Error("chain assistant message is missing")
    messages.push(assistant, { role: "tool", tool_call_id: call.id, content: result })
  }
  const final = await request(endpoint, token, "/chat/completions", {
    model, reasoning: effort ? { effort } : undefined, messages, tools: chatTools, stream: true, session_id: session, instruction_mode: instructionMode,
  })
  chatStream(await final.text(), finalToken)
}

async function runResponsesChain(endpoint: string, token: string, model: string, effort: string | undefined) {
  const session = `chain-responses-${crypto.randomUUID()}`
  const finalToken = `FINAL_${crypto.randomUUID()}`
  let previous: string | undefined
  let pendingOutput: unknown = chainRequest
  for (let index = 0; index < MAX_TURNS - 1; index++) {
    const value = await (await request(endpoint, token, "/responses", {
      model, reasoning: effort ? { effort } : undefined, input: pendingOutput, tools: responsesTools, session_id: session, stream: false,
      ...(previous ? { previous_response_id: previous } : {}),
    })).json()
    previous = stringValue(record(value)?.id, "response id")
    const call = responsesCall(value)
    const result = executeChainStep(index, call, finalToken)
    pendingOutput = [{ type: "function_call_output", call_id: call.id, output: result }]
  }
  if (!previous) throw new Error("response continuation id is missing")
  const final = await request(endpoint, token, "/responses", {
    model, reasoning: effort ? { effort } : undefined, input: pendingOutput, tools: responsesTools, session_id: session,
    previous_response_id: previous, stream: true,
  })
  responsesStream(await final.text(), finalToken)
}

const credentials = Bun.spawn([binary, "print-token"], { stdout: "pipe", stderr: "ignore" })
const token = (await new Response(credentials.stdout).text()).trim()
if (await credentials.exited !== 0 || !token) throw new Error("provider credential lookup failed")
const provider = Bun.spawn([binary, "start"], { env: { ...process.env, AIPASS_BROWSER_HEADED: "1" }, stdout: "pipe", stderr: "ignore" })
let startupTimer: ReturnType<typeof setTimeout> | undefined
let failures = 0
try {
  const reader = provider.stdout.getReader()
  const endpoint = await Promise.race([
    (async () => {
      let output = ""
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error("provider exited before readiness")
        output += new TextDecoder().decode(chunk.value)
        const match = output.match(/OpenAI-compatible endpoint: (http:\/\/127\.0\.0\.1:\d+\/v1)/)
        if (match) return match[1]!
      }
    })(),
    new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("provider readiness timed out")), 20_000) }),
  ])
  clearTimeout(startupTimer)
  reader.releaseLock()
  for (const model of models) {
    const effort = MODELS.find((item) => item.id === model)!.thinking.length ? "low" : undefined
    const checks: readonly (readonly [string, () => Promise<void>])[] = caseName === "startup-context"
      ? (["chat", "responses"] as const).map((api) => [`startup-context-${api}`, () => runStartupContext(endpoint, token, model, effort, api)] as const)
      : caseName === "lookup"
      ? [["lookup", () => runLookup(endpoint, token, model, effort)]] as const
      : caseName === "catalog"
        ? (catalogMode ? [catalogMode] : ["action-only", "preserve"] as const)
            .map((mode) => [`catalog-${mode}`, () => runChatChain(endpoint, token, model, effort, mode)] as const)
        : caseName === "instruction-update"
          ? [["instruction-update", () => runChatChain(endpoint, token, model, effort, "preserve", true)]]
        : [
          ["chain-chat", () => runChatChain(endpoint, token, model, effort)],
          ["chain-responses", () => runResponsesChain(endpoint, token, model, effort)],
        ] as const
    for (const [check, run] of checks) {
      try {
        await run()
        console.log(JSON.stringify({ model, effort: effort ?? null, check, passed: true }))
      } catch (error) {
        failures++
        console.log(JSON.stringify({ model, effort: effort ?? null, check, passed: false, error: error instanceof Error ? error.message : "live request failed" }))
      }
    }
  }
} finally {
  clearTimeout(startupTimer)
  provider.kill("SIGTERM")
  await provider.exited
}
if (failures) process.exitCode = 1
