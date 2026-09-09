---
type: Architecture
title: Prompt projection
description: Startup-only instructions and tool schemas, delta-only bound turns, checkpoint
  compaction, and token estimation.
tags:
- prompt
- startup
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
---

# Definition

Preserve-mode startup submits the role/action protocol and startup control once, then each complete caller system/developer message in order, then each offered tool's complete schema in its own block. Startup replies are consumed internally and never emitted as client answers or actions.[^runtime-guide]

# Replay and omission

Unchanged bound turns send only the latest task/result delta with a turn key, every-turn envelope guard, and any required tool-choice constraint. Startup replays after recovery, changed instructions or schemas, model or reasoning-variant switches, compaction, and newly opened pages; task and correction prompts do not repeat the role or schema catalog.[^runtime-guide] Explicit `instruction_mode: "action-only"` omits caller instruction text, and switching an existing affinity from preserve to action-only starts a fresh remote conversation.[^runtime-guide] Serial startup delivery was introduced in v0.1.3.[^releases]

# Compaction and estimate

Callers compact with an exact `<conversation-checkpoint>` message that rotates the remote epoch; without a checkpoint the provider does not silently discard canonical history. Startup retention is an upstream dependency, not a guarantee of model compliance.[^runtime-guide] The token estimate is `ceil(UTF-8 byte length / 3)`.[^runtime-guide] Digest and estimate helpers live in the context module.[^context]

See also: [Provider runtime](provider-runtime.md) and [Request session contract](../runtime/request-session-contract.md).

[^runtime-guide]: Runtime guide
[^releases]: v0.1.3 release notes
[^context]: Context helpers
