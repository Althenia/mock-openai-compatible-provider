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

Webchat has no native function-calling API, so AIPass projects offered tool names and selected schemas, validates returned envelopes, and converts valid actions to OpenAI-compatible calls; only the calling client executes them and returns tool results.[^runtime-guide]

# Envelope rules

Every envelope carries the current submission turn key, a unique call ID, an offered name, and schema-conforming input; chat envelopes stay text, thinking envelopes become reasoning, and quoted action JSON inside chat is not executed.[^runtime-guide] The protocol defines `<aipass-envelope>` delimiters, a leading `TURN KEY` line, per-turn key matching, and a typed action chain of thinking, action group, and final chat or action envelopes.[^protocol]

# Repair paths

Automatic capability-only refusals can trigger one corrective turn and missing required arguments can trigger one targeted schema-provision turn; safety refusals, ordinary answers, existing actions, and oversized responses do not retry, and neither path invents results.[^runtime-guide]

See also: [Provider runtime](../architecture/provider-runtime.md) and [Prompt projection](../architecture/prompt-projection.md).

[^runtime-guide]: Runtime guide
[^protocol]: Protocol envelopes
