---
type: Interface
title: Request session contract
description: Authenticated OpenAI-compatible endpoints, session routing, retained
  Responses continuations, and streaming failure semantics.
tags:
- api
- sessions
- responses
- streaming
sources:
- id: runtime-guide
  resource: repo:///docs/runtime-guide.md
  title: Runtime guide
- id: server
  resource: repo:///src/server.ts
  title: Request handler
- id: http
  resource: repo:///src/http.ts
  title: Request parsing
---

# Endpoints

Authenticated endpoints include health, model listing, single-model fetch, shutdown, Chat Completions, and Responses.[^runtime-guide] The handler enforces bearer auth, routes `/health`, `/v1/models`, `/v1/models/{id}`, `/shutdown`, `/v1/responses`, and `/v1/chat/completions`, and maps auth, missing, in-use, and upstream failures to typed API errors.[^server] Admitted streaming responses begin with standard protocol start records before browser work completes: a Chat assistant-role chunk or Responses `response.created` and `response.in_progress` events. Subsequent data is standard assistant output; no custom status data is emitted.[^runtime-guide]

# Guardrail failures

A recognized webchat safety block returns HTTP 422 with code `webchat_safety_block` for non-streaming requests. For admitted streaming requests, browser, authentication, and safety failures are terminal structured SSE errors after HTTP 200, without successful completion: Chat carries a nested `error` object, while Responses carries a typed, sequence-numbered error event. Responses history is not committed for the failed stream.[^server] The provider does not automatically retry or fall back after a safety block and records a definitive failed browser attempt.[^runtime-guide]

# Sessions

Chat Completions may bind to a client session through session headers, `session_id`, `prompt_cache_key`, or `user`; unaffiliated requests are stateless, while initial Responses requests receive a new response-ID session and `store: false` is ephemeral.[^runtime-guide] Header and body session markers are extracted during request parsing.[^http]

# Continuations

Stored Responses retain input, emitted output items, and initialization state in process memory, bounded to 1,000 records and 16 MiB, and never write message history to disk.[^runtime-guide] Omitted top-level instructions inherit retained initialization, while explicit replacement or an empty string updates or clears it.[^runtime-guide] The handler commits streamed history only at completion and can evict oldest unreserved entries to meet the bounds. Capacity exhaustion before submission returns HTTP 507; a late capacity failure discards the advanced browser session and consumes the predecessor instead of retaining incomplete history.[^server] A `previous_response_id` is single-use; unknown, consumed, evicted, or restarted history returns `previous_response_not_found`.[^runtime-guide] Request parsing rejects a `store: false` continuation.[^http]

See also: [Provider runtime](../architecture/provider-runtime.md) and [Prompt projection](../architecture/prompt-projection.md).

[^runtime-guide]: Runtime guide
[^server]: Request handler
[^http]: Request parsing
