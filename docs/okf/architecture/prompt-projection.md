---
type: Architecture
title: Prompt projection
description: Direct instruction and effective-schema initialization, delta-only bound
  turns, and checkpoint compaction.
tags:
- prompt
- initialization
- tools
- compaction
sources:
- id: runtime-guide
  resource: repo:///docs/runtime-guide.md
  title: Runtime guide
- id: context
  resource: repo:///src/context.ts
  title: Context helpers
- id: releases
  resource: repo:///docs/releases/v0.1.3.md
  title: v0.1.3 release notes
- id: projection
  resource: repo:///src/http.ts
  title: Request projection
- id: protocol
  resource: repo:///src/protocol.ts
  title: Response protocol
- id: submission
  resource: repo:///src/browser-turn-flow.ts
  title: Keyed submission
---

# Definition

For both APIs, one keyed initialization supplies the response type enum, response matrix, payload examples, numbered working flow, ordered caller system/developer bodies, and every complete effective offered-tool schema. CLIENT INSTRUCTIONS owns the response protocol, while HARNESS INSTRUCTIONS carries caller rules, skill and MCP descriptions, and offered schemas.[^projection][^protocol]

# Declaration ownership

Caller instruction bodies and effective offered schemas are forwarded directly during initialization; there is no configuration or request switch that replaces them with provider discovery actions. AIPass does not inspect caller files, load installed skill content, or connect to MCP servers.[^runtime-guide][^projection] Exact complete instruction-body repeats and exact available_skills/mcp_instructions blocks share one declaration through references at their original role positions. Matching lowered system-update content is omitted from task projection without removing distinct progress, ordinary user quotations, or tool-result bodies.[^projection]

# Replay and effective actions

Unchanged bound turns send only the latest task/result delta with a fresh turn key and the short every-turn guard. Initialization replays after recovery, changed instruction or effective schema content, model or reasoning-variant switches, compaction, and newly opened pages. Per-turn tool choice defines the effective schema set, and session affinity controls routing rather than instruction omission.[^runtime-guide][^projection][^submission] Serial startup delivery was introduced in v0.1.3.[^releases]

# Compaction and estimate

Callers compact with an exact conversation-checkpoint message that rotates the remote epoch; without a checkpoint the provider does not silently discard canonical history.[^runtime-guide] The token estimate is ceil(UTF-8 byte length / 3), and provider-known correction prompts and actions are included while remaining explicitly estimated rather than claimed as billing data.[^context][^runtime-guide]

See also: [Provider runtime](provider-runtime.md) and [Request session contract](../runtime/request-session-contract.md).

[^projection]: Request projection
[^protocol]: Response protocol
[^runtime-guide]: Runtime guide
[^submission]: Keyed submission
[^releases]: v0.1.3 release notes
[^context]: Context helpers
