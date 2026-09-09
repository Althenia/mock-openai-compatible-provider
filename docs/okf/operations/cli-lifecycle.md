---
type: Runbook
title: CLI lifecycle
description: Foreground provider commands, authenticated shutdown, and locked atomic
  update with checksum verification.
tags:
- cli
- lifecycle
- update
sources:
- id: operations
  resource: repo:///docs/operations.md
  title: Operations and client setup
- id: config
  resource: repo:///src/config.ts
  title: Configuration
- id: cli
  resource: repo:///src/cli.ts
  title: CLI dispatch
---

# Commands

`start`/`serve` runs the provider in the foreground, `login` opens the persistent Chrome profile for sign-in, `stop` requests authenticated graceful shutdown, `update` installs the latest verified release, `endpoint` prints the base URL, `print-token` prints the local credential, and `version` and `help` report the release and usage.[^operations] Command parsing accepts `--config`, `--state-root`, `--chrome`, and `--port` for `start`, `serve`, and `endpoint`, with `update` additionally accepting `--version`, `--install-dir`, and `--state-root`.[^config] Dispatch resolves the command and delegates serving and login to the injected runtime handlers.[^cli]

# Update safety

Stop the provider and close login before executable replacement; updating does not restart the service and a supervisor may restart a stopped process.[^operations] The updater holds the selected state-root profile lock throughout installation and refuses while the provider or login owns it; `stop` may return before shutdown finishes, so waiting for provider exit and retrying is required when the lock is still held.[^operations] The guard covers only the selected state root, so other instances sharing the executable must be stopped and automatic supervisor restarts disabled first.[^operations] Download, metadata, checksum, or executable-check failures leave the existing binary unchanged.[^operations]

See also: [Configuration and state](config-state.md), [Release evidence](../delivery/release-evidence.md), and [Browser transport](../architecture/browser-transport.md).

[^operations]: Operations and client setup
[^config]: Configuration
[^cli]: CLI dispatch
