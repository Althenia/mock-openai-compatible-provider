# Runtime guide

This guide retains the provider runtime contract that was previously expanded in
the repository README. It is a behavior reference, not evidence of live-model
reliability.

## Runtime configuration boundary

Stateful commands load one selected version-one JSON file. Without `--config`,
the file and state defaults are rooted in the current UID's validated native
macOS account home; `HOME`, XDG variables, and former provider `AIPASS_*`
variables do not redirect them. Supported explicit CLI values override the
selected file. Existing files under former environment-selected paths are not
migrated automatically. See the [configuration reference](configuration.md).

## Request and session contract

- Authenticated endpoints include `GET /health`, `GET /v1/models`,
  `GET /v1/models/{model}`, `POST /shutdown`, `POST /v1/chat/completions`, and
  `POST /v1/responses`.
- Chat Completions may bind to a client session through `x-session-id`,
  `x-session-affinity`, `x-client-request-id`, `session_id`,
  `prompt_cache_key`, or `user`. Unaffiliated Chat Completions requests are
  stateless. Initial Responses requests receive a new response-ID session;
  `store: false` is ephemeral.
- Stored Responses retain actual input, emitted output items, and initialization
  state in process memory. A continuation replays retained items before new
  input, including function-call IDs/results and separately labeled assistant
  reasoning summaries. Omitted top-level `instructions` inherit retained
  initialization; an explicit replacement or empty string updates or clears it.
- Responses retention is bounded to 1,000 records and 16 MiB of serialized
  UTF-8 history and retained-initialization payloads. It does not write message
  history to disk.
- `previous_response_id` is single-use and cannot be combined with `store: false`.
  Missing, consumed, evicted, oversized, or restarted history returns
  `previous_response_not_found` rather than submitting incomplete history.
  Streamed history is committed only at `response.completed`.
- `tool_choice` supports automatic, disabled, required, and named choices.
  Required/named calls must be non-streaming; invalid combinations fail before
  browser submission. Estimated usage is marked `estimated: true`, not billing.
- Same-hash ambiguous submissions fail closed. A recognized webchat safety
  block records a definitive failed attempt rather than an ambiguous pending
  submission. The persistent profile is protected by a PID-identified lock.
- Admitted and validated streaming requests return HTTP 200 and their standard
  stream-start record before browser work completes. Authorization, request
  validation, reservation, and capacity preflight failures remain normal HTTP
  errors before SSE starts. Browser/auth/safety failures after streaming starts
  are terminal API-compatible error records, never successful completion records
  (a nested `error` object for Chat; a typed, sequenced `error` event for Responses);
  non-streaming requests retain their HTTP error responses. Recognized webchat
  safety blocks stop immediately, without automatic retry, repair, or fallback.

## Client action loop

Webchat has no native function-calling API. AIPass supplies offered tool names
and complete schemas during initialization, validates returned envelopes, and
converts valid actions to OpenAI-compatible calls. Only the calling client
executes them and returns tool results. MCP actions use their exact offered
names through the same path.

```text
<aipass-envelope>{"type":"tool","key":"current_turn_key","id":"call_unique","name":"read","input":{"path":"package.json"}}</aipass-envelope>
```

The key must match the current submission's `TURN KEY`; the value above is only
an example. Chat envelopes remain text, thinking envelopes become reasoning,
and quoted action JSON inside chat is not executed. Automatic capability-only
refusals can trigger one corrective turn; safety refusals, ordinary answers,
existing actions, and oversized responses do not. Missing required arguments
can trigger one targeted argument-correction turn using the startup schema.
Corrections carry guidance and the latest request/result delta, not repeated
role instructions, full schemas, or full conversation history. Neither path
invents results. The recognized Thai webchat guardrail notice takes precedence
over these paths and over turn-key mismatch recovery, including when its text
arrives across multiple stream chunks.

A completed keyed task turn receives at most one shared format/key correction
unless its entire non-whitespace response is a semantically valid envelope chain
ending in a terminal answer or action. Prose, arbitrary JSON, incomplete or invalid
envelopes, literal text between otherwise valid envelopes, and missing terminals
all qualify. That submission has a fresh physical turn key and empty priming;
its body contains only `RETRY OF: <failed-key>` plus a short instruction to return
proper `<aipass-envelope>` JSON with the new key. It does not repeat startup
instructions, skills, schemas, task/history text, or the rejected draft. A second
invalid result fails closed. Authentication, cancellation, transport failures,
and recognized webchat safety blocks do not enter this correction path. The
format reminder asks only for compliant representation and never asks the
backend to override a refusal or upstream policy.

Complete bare and `TURN KEY`-prefixed envelope chains are validated before
single-envelope malformed-text recovery. After reasoning progress, strict
runtime validation rejects invalid trailing actions rather than absorbing them
into chat prose. Single chat/thinking envelopes with unescaped prose quotes
retain narrow low-level text recovery for compatibility; keyed production task
turns use opt-in whole-response validation before publication. Unkeyed serializer
consumers retain their permissive text behavior, and JSON or envelope examples
inside a validated chat envelope remain literal chat text rather than being
parsed a second time.
Tool names are supplied by the calling harness, not a provider-maintained list.
The canonical action shape remains `type: "tool"`, `name`, and object-valued
`input`. A model response may also use an exact offered tool name as `type`,
with the current `key`, a valid call `id`, and either object-valued `input` or
flattened arguments. AIPass normalizes that shape into a standard tool call;
it rejects unoffered names, invalid transport fields, and mixed nested/flattened
arguments rather than guessing. Reserved envelope types keep their existing
meaning; a tool sharing a reserved name must use the canonical tool shape.
Normalized tool-named arguments pass unchanged to the harness for schema
validation, permissions, execution, and results, without a provider argument-
correction submission. Receiving a call is not evidence of successful execution.
Completed tool-named chains are recognized by browser completion tracking before
runtime validation; they do not wait for DOM fallback solely because their type
is a tool name. Ambiguous submitted attempts still fail closed.

An answer-shaped object that omits only `type` is decoded as chat text when it
has a nonempty turn key, an `answer_*` ID, nonempty text, and no action fields.
Turn-key validation still applies; arbitrary JSON is not treated as an answer
envelope solely because it has a `text` field.

## Prompt contract

For both APIs, a new initialization submits one keyed webchat turn containing
the AIPass role/action protocol, ordered caller system/developer or Responses
instructions, and every complete effective offered-tool schema. `CLIENT
INSTRUCTIONS` contains the AIPass response protocol:
the complete `type` enum, response matrix with payload examples, and working
flow from task evaluation through client actions/results to the final answer.
`HARNESS INSTRUCTIONS` separately contains caller-owned agent/workspace rules,
skill/MCP descriptions, and offered tool schemas. Identical complete instruction
bodies and exact `available_skills`/`mcp_instructions` blocks are declared once,
with references preserving their original role positions. Exact repeats in lowered
`system-update` messages are omitted from task projection; distinct progress,
ordinary user quotations, and tool-result bodies are preserved. This is exact
deduplication, not semantic rewriting of similar rules.
Its internal `READY` reply is never emitted as a client answer or action.
Subsequent task and action-result turns send only the keyed latest delta.
Per-turn `tool_choice` determines the effective schema set for that turn.
Explicit `tools: []` clears the active offered set; omitted tools retain it.

Unchanged bound turns send only the latest task/result delta; recovery, changed
initialization/contracts, model or reasoning-variant switches, compaction, and
newly opened pages require initialization again before the task. This relies on
the webchat retaining initialization context; it is not a guarantee of model
compliance. Each initialization, task, result, repair, and correction submission
carries its current `TURN KEY` and the short every-turn envelope guard. Submission
wrapping adds the guard when absent without repeating the full initialization.
Prompt projection logs contain only action names and character counts, never
prompt content.

Session affinity controls routing, not instruction omission. Caller instructions
are projected consistently with and without affinity; tool results and distinct
client instruction updates remain in the task history. The former
`instruction_mode` request extension is no longer supported. Like other unknown
request fields, it is ignored rather than interpreted as a forwarding policy.

Streaming clients first receive the standard Chat Completions assistant-role
chunk or Responses `response.created` and `response.in_progress` events. The
provider forwards actual assistant output through those APIs, not custom
provider-status data. Initialization/setup status is not fabricated as model
reasoning or answer text. The harness continues to own tool dispatch and the
agent loop; no harness changes are needed to consume the standard stream.

Agent-turn progression preserves whole-response validation: attributed DOM
reasoning and complete, current-key thinking envelopes can stream while the
backend turn is still open. Answers and tool calls wait for the entire response
to pass validation. A later error can terminate already-visible reasoning, but
it must not publish an invalid answer/action or a successful completion. Raw,
unattributed reasoning and incomplete or mismatched envelopes are not trusted
as progressive output. Safely attributed reasoning may remain visible while a
malformed terminal answer receives the one format correction; reasoning from
that replacement is suppressed so drafts are not mixed or duplicated. Foreign
or mixed keys after visible progress still fail without correction. Estimated
usage includes the hidden correction prompt, rejected completion, and suppressed
replacement reasoning without charging already-published reasoning twice.

The webchat backend owns reasoning, planning, action selection, and answers.
AIPass owns transport and structured-response validation. The calling client
owns permissions, dispatch, and returned results. User, agent, and workspace
instructions must be supplied in request system/developer messages (or Responses
instructions/input messages); AIPass does not infer them or load caller
workspace files. These are ordinary webchat submissions, not native system-role
messages; upstream rules remain authoritative. Chat bound initialization and
Responses continuation state are bounded and process-local; after restart or
eviction callers must supply initialization again. Each initialization and
provider-owned repair submission adds latency and consumes provider quota. Usage
remains explicitly estimated and includes provider-known hidden repair prompt
and completion work; it is not an upstream billing measurement.

## Compaction and recovery

Long instruction messages remain intact in the combined initialization without
silent truncation. This preserves transmitted request content; it does not
establish an upstream context limit or guarantee that every model uses large
requests correctly.

The caller decides when to compact using its model catalog. The provider keeps a
conservative website-visible estimate:

```text
estimated tokens = ceil(UTF-8 byte length / 3)
```

When the caller supplies an exact `<conversation-checkpoint>` user message, the
provider hashes it, clears the old remote binding, increments the remote epoch,
resets its estimate, closes the old page, and begins a new conversation with the
compacted transcript. Repeating the same checkpoint digest does not rotate
again. A supplied compaction summary remains in conversation history and stays
separate from current instructions; AIPass does not reconstruct instructions
that the caller omitted.

Without a checkpoint, the provider does not guess a context limit or silently
discard canonical history. Stored Responses continuations append to retained
history; to replace history with a compacted form, start a new Responses request
without `previous_response_id`.

## Diagnostics and reliability boundary

The opt-in live checks use the authenticated browser profile and consume provider
quota. Build first, then use `bun scripts/live-smoke.ts` with an explicit case.
Its in-memory dispatcher does not execute real filesystem operations or installed
client skills. Raw local diagnostic reports are not distributed.

Local tests validate provider and prompt-projection behavior, not a live action,
skill, file-operation, MCP execution, or all-model reliability. See the
[release limitations](releases/v0.1.3.md) for observed compatibility
boundaries.
