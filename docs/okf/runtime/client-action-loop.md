---
type: Workflow
title: Client action loop
description: Turn-key envelopes with directly supplied schemas and client-executed
  offered actions.
tags:
- envelopes
- turn-key
- tools
- repair
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
- id: projection-tests
  resource: repo:///src/provider.test.ts
  title: Request boundary tests
- id: progressive-tests
  resource: repo:///src/progressive-streaming.test.ts
  title: Progressive streaming regressions
- id: tool-named-tests
  resource: repo:///src/tool-named-envelope.test.ts
  title: Tool-named envelope regression tests
- id: lifecycle-tests
  resource: repo:///src/browser-lifecycle.test.ts
  title: Browser attempt lifecycle tests
---

# Definition

Webchat has no native function-calling API, so AIPass directly initializes complete effective offered schemas, validates keyed envelopes, and converts only offered harness actions to OpenAI-compatible calls. Only the calling client grants permission, executes those actions, and returns results.[^runtime-guide][^runtime][^projection-tests]

# Envelope rules

Action envelopes carry the current turn key, a unique call ID, an authorized name, and object input; chat becomes answer text, thinking becomes reasoning, and quoted action JSON inside chat is not executed.[^runtime-guide] The initialization response matrix defines chat, thinking, tool, plan, subagent, skill, question, and permission and waits for actual client results before continuing.[^protocol]

# Request-driven tool normalization

The canonical tool envelope remains type tool with name and object input. A non-reserved type matching an exact offered tool name can also identify a call. Unoffered names and conflicting argument representations raise protocol errors rather than being guessed or converted.[^protocol] Normalized harness arguments pass unchanged to client schema validation, permissions, execution, and results.[^runtime]

Browser completion recognizes complete tool-named chains independently from dispatch validation; cancellation and uncertain-submission safeguards remain separate.[^lifecycle-tests] Regression coverage preserves arbitrary offered names, nested and flattened arguments, split tagged and bare chains, reasoning, attribution, atomic rejection, and both OpenAI APIs.[^tool-named-tests]

# Repair paths

Complete bare and TURN KEY-prefixed chains are validated before narrow low-level chat/thinking malformed-text recovery. Keyed production task turns require their entire non-whitespace response to be a semantically valid envelope chain ending in a terminal answer or action before publication.[^protocol][^runtime-guide] Prose, arbitrary JSON, incomplete or invalid payloads, literal text outside otherwise valid envelopes, and key mismatches share one bounded correction budget. The correction uses a fresh physical key, empty priming, and only the failed key reference plus an envelope-format reminder; it does not replay initialization, schemas, history, or rejected output. A second invalid result fails closed. The strict reader is opt-in at the keyed runtime boundary, so unkeyed serializers remain permissive and examples quoted inside validated chat text are not parsed again.[^runtime][^runtime-guide]

Capability-only refusals and missing required harness arguments retain their bounded corrective behavior, while authentication, cancellation, transport failures, and recognized webchat safety blocks do not enter format/key correction.[^runtime-guide][^runtime] Safely attributed reasoning can remain visible before format correction, but replacement reasoning is suppressed and foreign or mixed keys after progress still fail without retry.[^runtime][^progressive-tests] Estimated usage includes hidden correction prompts and completions without counting published reasoning twice.[^runtime-guide][^progressive-tests]

See also: [Provider runtime](../architecture/provider-runtime.md) and [Prompt projection](../architecture/prompt-projection.md).

[^runtime-guide]: Runtime guide
[^runtime]: Runtime validation and repair
[^projection-tests]: Request boundary tests
[^protocol]: Protocol envelopes
[^lifecycle-tests]: Browser attempt lifecycle tests
[^tool-named-tests]: Tool-named envelope regression tests
[^progressive-tests]: Progressive streaming regressions
