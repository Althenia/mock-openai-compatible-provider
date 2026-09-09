---
type: Interface
title: Request session contract
description: Authenticated loopback endpoints, session binding headers, and single-use
  stored Responses continuations.
tags:
- api
- sessions
- responses
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

Authenticated endpoints include health, model listing, single-model fetch, shutdown, Chat Completions, and Responses.[^runtime-guide] The handler enforces bearer auth, routes `/health`, `/v1/models`, `/v1/models/{id}`, `/shutdown`, `/v1/responses`, and `/v1/chat/completions`, and maps auth, missing, in-use, and upstream failures to typed API errors.[^server]

# Sessions

Chat Completions may bind to a client session through session headers, `session_id`, `prompt_cache_key`, or `user`; unaffiliated requests are stateless, while initial Responses requests receive a new response-ID session and `store: false` is ephemeral.[^runtime-guide] Header and body session markers are extracted during request parsing.[^http]

# Continuations

Stored Responses retain input and emitted output items in process memory, bounded to 1,000 records and 16 MiB, and never write message history to disk.[^runtime-guide] The handler commits streamed history only at completion and evicts oldest entries when either bound is exceeded.[^server] A `previous_response_id` is single-use, cannot combine with `store: false`, and unknown, consumed, evicted, oversized, or restarted history returns `previous_response_not_found` rather than submitting incomplete history.[^runtime-guide] Request parsing rejects a non-string continuation ID and a `store: false` continuation.[^http]

See also: [Provider runtime](../architecture/provider-runtime.md) and [Prompt projection](../architecture/prompt-projection.md).

[^runtime-guide]: Runtime guide
[^server]: Request handler
[^http]: Request parsing
