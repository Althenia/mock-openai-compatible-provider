---
type: Interface
title: Configuration and state
description: File-owned runtime configuration, native macOS account defaults, loopback
  binding, and private state handling.
tags:
- config
- state
- loopback
sources:
- id: operations
  resource: repo:///docs/operations.md
  title: Operations and client setup
- id: configuration
  resource: repo:///docs/configuration.md
  title: Runtime configuration
- id: config
  resource: repo:///src/config.ts
  title: Configuration
- id: runtime
  resource: repo:///src/runtime.ts
  title: Provider runtime wiring
---

# Paths

Runtime config defaults to `<native-account-home>/.config/aipass-browser-provider/config.json`, while state defaults to `<native-account-home>/.local/state/aipass-browser-provider`.[^operations] The provider resolves that home from the process UID through the macOS account database and validates one absolute result; `HOME`, XDG variables, and former provider `AIPASS_*` variables do not select defaults.[^config] Existing files under former environment-selected paths are not migrated automatically.[^configuration]

# File ownership and precedence

One selected version-one JSON file owns runtime settings for stateful commands. Supported explicit CLI options override file values, which override built-in defaults.[^configuration][^config] Help and version do not read configuration or initialize state. A minimal version-one file receives native-account defaults, and selected-port persistence reuses the resolved configuration without environment reinterpretation.[^config]

The provider `update` command accepts installation destination through `--install-dir` or the file's `installDir`. Source execution otherwise resolves `<native-account-home>/.local/bin`, and the updater passes the fully resolved destination to the embedded installer; former installer environment names have no provider configuration role.[^configuration][^config][^operations]

# Binding and secrecy

The server binds loopback only and serves the OpenAI-compatible endpoint under `/v1`.[^runtime] Credentials, bindings, lock, and browser-profile files live under the resolved state root; configuration, token, Chrome profile data, and screenshot output stay private.[^operations][^configuration]

See also: [CLI lifecycle](cli-lifecycle.md) and [Provider runtime](../architecture/provider-runtime.md).

[^operations]: Operations and client setup
[^config]: Configuration
[^configuration]: Runtime configuration
[^runtime]: Provider runtime wiring
