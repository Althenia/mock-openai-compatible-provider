---
type: Interface
title: Configuration and state
description: XDG-based config and state roots, environment overrides, loopback binding,
  and private credential handling.
tags:
- config
- state
- loopback
sources:
- id: operations
  resource: repo:///docs/operations.md
  title: Operations and client setup
- id: config
  resource: repo:///src/config.ts
  title: Configuration
- id: runtime
  resource: repo:///src/runtime.ts
  title: Provider runtime wiring
---

# Paths

Runtime config defaults to `$XDG_CONFIG_HOME/aipass-browser-provider/config.json` (otherwise `~/.config/aipass-browser-provider/config.json`) and state defaults to `$XDG_STATE_HOME/aipass-browser-provider` (otherwise `~/.local/state/aipass-browser-provider`).[^operations] Path resolution prefers explicit `XDG_CONFIG_HOME`/`XDG_STATE_HOME` values and falls back to home-relative defaults.[^config]

# Overrides

`AIPASS_CONFIG_PATH`, `AIPASS_STATE_ROOT`, `AIPASS_PORT`, `AIPASS_BROWSER_EXECUTABLE`, `AIPASS_CHAT_URL`, `AIPASS_STREAM_URL_PATTERN`, timeout, headed-mode, screenshot-directory, and install-directory variables override the corresponding defaults.[^operations] The parser applies config path, state root, Chrome executable, port, chat URL, timeouts, headed flag, and screenshot directory from the environment.[^config]

# Binding and secrecy

The server binds loopback only and serves the OpenAI-compatible endpoint under `/v1`.[^runtime] Credentials, bindings, lock, and browser-profile files live under the state root; the token, Chrome profile data, and screenshot output stay private and the token output is never shared.[^operations]

See also: [CLI lifecycle](cli-lifecycle.md) and [Provider runtime](../architecture/provider-runtime.md).

[^operations]: Operations and client setup
[^config]: Configuration
[^runtime]: Provider runtime wiring
