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

Webchat has no native function-calling API, so AIPass supplies offered tool names and complete schemas during startup, validates returned envelopes, and converts valid actions to OpenAI-compatible calls; only the calling client executes them and returns tool results.[^runtime-guide]

# Envelope rules

Action envelopes carry the current submission turn key, a unique call ID, an offered name, and schema-conforming input; chat envelopes stay text, thinking envelopes become reasoning, and quoted action JSON inside chat is not executed.[^runtime-guide] The protocol defines `<aipass-envelope>` delimiters, a leading `TURN KEY` line, per-turn key matching, and a typed action chain of thinking, action group, and final chat or action envelopes.[^protocol]

# Repair paths

Complete bare and `TURN KEY`-prefixed envelope chains are validated before single-envelope malformed-text recovery. After reasoning progress, strict runtime validation rejects invalid trailing actions instead of absorbing them into chat prose. Single chat/thinking envelopes retain narrow recovery for unescaped prose quotes; non-strict fallback behavior is unchanged.[^runtime-guide]

Automatic capability-only refusals can trigger one corrective turn and missing required arguments can trigger one targeted argument-correction turn referencing the startup schema. Corrections carry guidance and the latest task/result delta without repeating the role, full schemas, or full conversation; neither path invents results.[^runtime-guide] The recognized Thai webchat guardrail notice terminates immediately, including split stream text, before turn-key retry, refusal repair, or argument correction.[^runtime-guide]

See also: [Provider runtime](../architecture/provider-runtime.md) and [Prompt projection](../architecture/prompt-projection.md).

[^runtime-guide]: Runtime guide
[^protocol]: Protocol envelopes
