---
type: Architecture
title: Prompt projection
description: Separated client/harness initialization, exact declaration deduplication,
  delta-only bound turns, and checkpoint compaction.
tags:
- prompt
- initialization
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

For both APIs, one keyed initialization puts the response type enum, response matrix, payload examples, and numbered working flow under CLIENT INSTRUCTIONS. HARNESS INSTRUCTIONS separately retains caller role order, agent/workspace rules, skill/MCP catalogs, and complete offered tool schemas; the internal READY reply is not a client answer or action.[^projection][^protocol]

# Declaration ownership

Exact complete instruction-body repeats and exact available_skills/mcp_instructions blocks share one declaration through references at their original role positions. Matching lowered system-update content is omitted from task projection without removing distinct progress, ordinary user quotations, or tool-result bodies. This is exact deduplication, not semantic rewriting of similar prose.[^projection]

# Replay and omission

Unchanged bound turns send only the latest task/result delta with a fresh turn key, the short every-turn guard, and any required tool-choice constraint. Submission wrapping adds the guard when absent and does not repeat the full initialization.[^runtime-guide][^submission] Initialization replays after recovery, changed instructions or schemas, model or reasoning-variant switches, compaction, and newly opened pages; task and correction prompts do not repeat the role or schema catalog.[^runtime-guide] Explicit instruction_mode: action-only omits caller instruction text, and switching an existing affinity from preserve to action-only starts a fresh remote conversation.[^runtime-guide] Serial startup delivery was introduced in v0.1.3.[^releases]

# Compaction and estimate

Callers compact with an exact conversation-checkpoint message that rotates the remote epoch; without a checkpoint the provider does not silently discard canonical history. Initialization retention is an upstream dependency, not a guarantee of model compliance.[^runtime-guide] The token estimate is ceil(UTF-8 byte length / 3).[^context]

See also: [Provider runtime](provider-runtime.md) and [Request session contract](../runtime/request-session-contract.md).

[^projection]: Request projection
[^protocol]: Response protocol
[^runtime-guide]: Runtime guide
[^submission]: Keyed submission
[^releases]: v0.1.3 release notes
[^context]: Context helpers
