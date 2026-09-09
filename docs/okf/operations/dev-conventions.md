---
type: Repository Preference
title: Development conventions
description: Bun-only strict TypeScript workflow with unfiltered tests, TypeScript-mastered
  catalog, and evidence-honest release notes.
tags:
- bun
- typescript
- tests
- conventions
sources:
- id: agents
  resource: repo:///AGENTS.md
  title: Agent conventions
- id: manifest
  resource: repo:///package.json
  title: Package manifest
- id: tsconfig
  resource: repo:///tsconfig.json
  title: TypeScript config
- id: bunfig
  resource: repo:///bunfig.toml
  title: Bun test config
- id: operations
  resource: repo:///docs/operations.md
  title: Operations and client setup
---

# Toolchain

Bun is the runtime, bundler, and test runner, with `playwright-core` as the only production dependency and no dependency added without explicit approval.[^agents] The manifest pins the package manager, license, module type, binary entry, and check, test, typecheck, and release scripts.[^manifest] Strict TypeScript uses explicit `.ts` relative imports, tests run from `./src`, and the executable entry delegates to `runCLI` with provider handlers.[^agents]

# Checks

Typecheck must pass, tests run unfiltered with zero failures and no skips to obtain a pass, and build, isolated-binary, installer, and release-packaging fixture checks cover distribution paths.[^agents] Live smoke and catalog-trace scripts consume authenticated provider quota with an in-memory dispatcher and require the provider stopped first; the docs server stays allowlisted on loopback.[^agents]

# Data and evidence rules

The TypeScript catalog is master and the Markdown matrix is a parity-tested review table, changed TS-first.[^agents] Release version, tag, and note must agree with behavior, validation, and limitations recorded in the note.[^agents] Local tests validate provider and prompt-projection behavior only and never support live-execution, all-model, or billing claims.[^agents] Operations records the same script and target boundaries for builds, installers, release preflight, live diagnostics, and the docs allowlist.[^operations]

See also: [Model catalog](../runtime/model-catalog.md), [Release evidence](../delivery/release-evidence.md), and [CLI lifecycle](cli-lifecycle.md).

[^agents]: Agent conventions
[^manifest]: Package manifest
[^operations]: Operations and client setup
