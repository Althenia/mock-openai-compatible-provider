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
---

# Definition

Webchat has no native function-calling API, so AIPass supplies offered tool names and complete schemas during combined initialization, validates returned envelopes, and converts valid actions to OpenAI-compatible calls; only the calling client executes them and returns tool results.[^runtime-guide]

# Envelope rules

Action envelopes carry the current submission turn key, a unique call ID, an offered name, and schema-conforming input; chat envelopes stay text, thinking envelopes become reasoning, and quoted action JSON inside chat is not executed.[^runtime-guide] Every initialization, task, result, repair, and correction submission carries its current TURN KEY, while the envelope guard is declared only in initialization.[^runtime-guide] The initialization response matrix defines chat, thinking, tool, plan, subagent, skill, question, and permission, with example payloads and a working flow that waits for actual client results before continuing or finalizing.[^protocol]

# Repair paths

Complete bare and TURN KEY-prefixed envelope chains are validated before single-envelope malformed-text recovery. After reasoning progress, strict runtime validation rejects invalid trailing actions instead of absorbing them into chat prose. Single chat/thinking envelopes retain narrow recovery for unescaped prose quotes; non-strict fallback behavior is unchanged.[^runtime-guide]

An object missing type is recognized as an answer only with a nonempty key, answer_* ID, nonempty text, and no name, input, or steps fields. It becomes chat text while remaining subject to turn-key matching; arbitrary JSON without that bounded shape is not unwrapped.[^protocol]

Automatic capability-only refusals can trigger one corrective turn and missing required arguments can trigger one targeted argument-correction turn referencing the initialization schema. Corrections carry guidance and the latest task/result delta without repeating the role, full schemas, or full conversation; neither path invents results.[^runtime-guide] The recognized Thai webchat guardrail notice terminates immediately, including split stream text, before turn-key retry, refusal repair, or argument correction.[^runtime-guide]

See also: [Provider runtime](../architecture/provider-runtime.md) and [Prompt projection](../architecture/prompt-projection.md).

[^runtime-guide]: Runtime guide
[^protocol]: Protocol envelopes
