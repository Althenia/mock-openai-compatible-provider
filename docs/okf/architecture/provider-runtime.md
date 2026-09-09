---
type: Architecture
title: Provider runtime
description: Loopback OpenAI-compatible provider that sends prompts to an upstream
  webchat through local Chrome.
tags:
- provider
- runtime
- browser-transport
sources:
- id: readme
  resource: repo:///README.md
  title: README
- id: runtime-guide
  resource: repo:///docs/runtime-guide.md
  title: Runtime guide
- id: entry
  resource: repo:///src/index.ts
  title: CLI entrypoint
- id: runtime
  resource: repo:///src/runtime.ts
  title: Provider runtime wiring
---

# Definition

AIPass exposes Chat Completions and Responses APIs on loopback; it is not a hosted inference service or a local model, and prompts are sent to the upstream webchat.[^readme]

# Wiring

The executable entrypoint delegates CLI dispatch to `runCLI` with `serveProvider` and `loginProvider` handlers.[^entry] Runtime wiring connects request handling, browser automation, session bindings, profile locking, and token auth.[^runtime]

# Ownership boundary

The webchat backend owns reasoning, planning, action selection, and answers; AIPass owns transport and structured-response validation; the calling client owns permissions, dispatch, and returned results.[^runtime-guide]

See also: [Browser transport](browser-transport.md), [Request session contract](../runtime/request-session-contract.md), and [Client action loop](../runtime/client-action-loop.md).

[^readme]: README
[^entry]: CLI entrypoint
[^runtime]: Provider runtime wiring
[^runtime-guide]: Runtime guide
