---
type: Workflow
title: Client action loop
description: Turn-key action envelopes that convert validated webchat output into
  client-executed tool calls.
tags:
- envelopes
- turn-key
- tools
sources:
- id: runtime-guide
  resource: repo:///docs/runtime-guide.md
  title: Runtime guide
- id: protocol
  resource: repo:///src/protocol.ts
  title: Protocol envelopes
- id: runtime
  resource: repo:///src/runtime.ts
  title: Runtime validation and repair
- id: tool-named-tests
  resource: repo:///src/tool-named-envelope.test.ts
  title: Tool-named envelope regression tests
- id: lifecycle-tests
  resource: repo:///src/browser-lifecycle.test.ts
  title: Browser attempt lifecycle tests
---

# Definition

Webchat has no native function-calling API, so AIPass supplies offered tool names and complete schemas during combined initialization, validates returned envelopes, and converts valid actions to OpenAI-compatible calls; only the calling client executes them and returns tool results.[^runtime-guide]

# Envelope rules

Action envelopes carry the current submission turn key, a unique call ID, an offered name, and schema-conforming input; chat envelopes stay text, thinking envelopes become reasoning, and quoted action JSON inside chat is not executed.[^runtime-guide] Every initialization, task, result, repair, and correction submission carries its current TURN KEY, with the short every-turn guard added by submission wrapping when absent; the full initialization is not prepended to each task.[^runtime-guide] The initialization response matrix defines chat, thinking, tool, plan, subagent, skill, question, and permission, with example payloads and a working flow that waits for actual client results before continuing or finalizing.[^protocol]

# Request-driven tool normalization

The canonical tool envelope remains type tool with name and object input. A non-reserved type matching an exact offered tool name can also identify a call, with a current key, valid call ID, and either nested input or flattened arguments. Unoffered names and conflicting argument representations raise protocol errors rather than being guessed or converted into executable calls.[^protocol] Normalized tool-named arguments bypass provider argument provisioning and capability-refusal repair; the harness owns schema validation, permissions, execution, and results.[^runtime] Regression tests cover arbitrary offered names, nested and flattened arguments, character-split tagged and bare chains, reasoning preservation, attribution, atomic runtime rejection, and both HTTP APIs.[^tool-named-tests]

Browser completion recognizes complete tool-named chains independently from dispatch validation. A fixture verifies that a completed thinking-plus-tool-named response moves the browser attempt from pending to complete after one submission, without waiting for DOM fallback; cancellation and uncertain-submission safeguards remain separate.[^lifecycle-tests]

# Repair paths

Complete bare and TURN KEY-prefixed envelope chains are validated before single-envelope malformed-text recovery. After reasoning progress, strict runtime validation rejects invalid trailing actions instead of absorbing them into chat prose. Single chat/thinking envelopes retain narrow recovery for unescaped prose quotes; legacy non-strict fallback behavior is unchanged, while tool-named envelope validation errors propagate even in non-strict bare chains.[^protocol]

An object missing type is recognized as an answer only with a nonempty key, answer_* ID, nonempty text, and no name, input, or steps fields. It becomes chat text while remaining subject to turn-key matching; arbitrary JSON without that bounded shape is not unwrapped.[^protocol]

Automatic capability-only refusals can trigger one corrective turn and missing required arguments in canonical actions can trigger one targeted argument-correction turn referencing the initialization schema. Corrections carry guidance and the latest task/result delta without repeating the role, full schemas, or full conversation; neither path invents results.[^runtime-guide] The recognized Thai webchat guardrail notice terminates immediately, including split stream text, before turn-key retry, refusal repair, or argument correction.[^runtime-guide]

See also: [Provider runtime](../architecture/provider-runtime.md) and [Prompt projection](../architecture/prompt-projection.md).

[^runtime-guide]: Runtime guide
[^protocol]: Protocol envelopes
[^runtime]: Runtime validation and repair
[^tool-named-tests]: Tool-named envelope regression tests
[^lifecycle-tests]: Browser attempt lifecycle tests
