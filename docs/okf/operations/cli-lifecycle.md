---
type: Runbook
title: CLI lifecycle
description: File-configured foreground commands, authenticated shutdown, and locked
  atomic update with checksum verification.
tags:
- cli
- configuration
- lifecycle
- update
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
- id: cli
  resource: repo:///src/cli.ts
  title: CLI dispatch
---

# Commands

`start`/`serve` runs the provider in the foreground, `login` opens the persistent Chrome profile, `stop` requests authenticated shutdown, `update` installs a verified release, `endpoint` prints the base URL, and `print-token`, `version`, and `help` expose their named local outputs.[^operations]

# Configuration resolution

Runtime settings come from one validated JSON file selected at the native macOS account default path or through `--config`. Supported explicit CLI overrides take precedence over file values, which take precedence over defaults; `HOME`, XDG variables, and former AIPass runtime environment variables do not redirect either path or setting.[^configuration][^config] Help and version return before account lookup, configuration, state, or Chrome initialization. Other commands load the same resolved schema, and selected-port persistence atomically preserves validated settings with private permissions.[^config][^cli]

# Update safety

Stop the provider and close login before executable replacement; updating does not restart the service.[^operations] The updater holds the resolved state-root profile lock throughout installation and refuses while provider or login owns it. Download, metadata, checksum, or executable-check failures leave the existing binary unchanged.[^operations]

`--install-dir` overrides the file's updater destination. A standard compiled executable otherwise updates its own directory, while source execution uses the native account's `.local/bin` directory. The provider resolves and passes that destination explicitly, so a selected custom configuration without `installDir` cannot cause the embedded installer to consult another default file; former installer environment names are not provider configuration inputs.[^configuration][^config][^cli]

See also: [Configuration and state](config-state.md), [Release evidence](../delivery/release-evidence.md), and [Browser transport](../architecture/browser-transport.md).

[^operations]: Operations and client setup
[^configuration]: Runtime configuration
[^config]: Configuration
[^cli]: CLI dispatch
