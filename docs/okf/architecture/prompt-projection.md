---
type: Architecture
title: Prompt projection
description: Preserve-mode startup turns, action-only opt-out, checkpoint compaction,
  and token estimation.
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

Preserve-mode startup submits the role/protocol turn, then each complete caller system/developer message in order, then the action contract and conversation; startup replies are consumed internally and never emitted as answers.[^runtime-guide]

# Replay and omission

Startup replays after recovery, changed instructions or contracts, model or reasoning-variant switches, compaction, and newly opened pages; unchanged bound turns send only the task projection.[^runtime-guide] Explicit `instruction_mode: "action-only"` omits caller instruction text, and switching an existing affinity from preserve to action-only starts a fresh remote conversation.[^runtime-guide] Startup delivery as separate submissions is a v0.1.3 behavior change.[^releases]

# Compaction and estimate

Callers compact with an exact `<conversation-checkpoint>` message that rotates the remote epoch; without a checkpoint the provider does not silently discard canonical history.[^runtime-guide] The token estimate is `ceil(UTF-8 byte length / 3)`.[^runtime-guide] Digest and estimate helpers live in the context module.[^context]

See also: [Provider runtime](provider-runtime.md) and [Request session contract](../runtime/request-session-contract.md).

[^runtime-guide]: Runtime guide
[^releases]: v0.1.3 release notes
[^context]: Context helpers
