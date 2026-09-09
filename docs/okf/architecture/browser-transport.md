---
type: Architecture
title: Browser transport
description: Playwright-driven installed Chrome with a persistent profile, PID-identified
  lock, and temporary-chat entry.
tags:
- playwright
- chrome
- profile-lock
sources:
- id: readme
  resource: repo:///README.md
  title: README
- id: runtime-guide
  resource: repo:///docs/runtime-guide.md
  title: Runtime guide
- id: config
  resource: repo:///src/config.ts
  title: Configuration
---

# Definition

Playwright drives installed Chrome, and a persistent profile retains sign-in with optional durable client-session bindings.[^readme]

# Safety properties

Same-hash ambiguous submissions fail closed; failed or cancelled pages are evicted; the persistent profile is protected by a PID-identified lock.[^runtime-guide]

# Configuration surface

Default Chrome paths are platform-specific and the chat URL defaults to a temporary-chat address.[^config]

See also: [Provider runtime](provider-runtime.md) and [CLI lifecycle](../operations/cli-lifecycle.md).

[^readme]: README
[^runtime-guide]: Runtime guide
[^config]: Configuration
