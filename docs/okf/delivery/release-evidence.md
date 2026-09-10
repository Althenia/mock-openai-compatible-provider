---
type: Workflow
title: Release evidence
description: Version, tag, and release-note agreement with gated validation and documented
  known limitations.
tags:
- releases
- validation
- limitations
sources:
- id: release-ci
  resource: repo:///.github/workflows/release.yml
  title: Release workflow
- id: releases
  resource: repo:///docs/releases/v0.1.3.md
  title: v0.1.3 release notes
- id: operations
  resource: repo:///docs/operations.md
  title: Operations and client setup
- id: manifest
  resource: repo:///package.json
  title: Package manifest
- id: unit-boundary
  resource: repo:///docs/releases/v0.1.4.md
  title: v0.1.4 validation boundary
- id: current-release
  resource: repo:///docs/releases/v0.1.6.md
  title: v0.1.6 release scope and validation
---

# Agreement

The manifest version, release tag, and release note must agree before publication.[^release-ci] Release workflow details and known limitations belong in release documentation, not the quick-start README.[^operations]

# Validation boundary

The v0.1.3 note records the local checks actually run, the single bounded real-client read cycle, and the explicit statement that one case is not a reliability guarantee.[^releases] Beyond that case, live tools, skills, file operations, MCP, every-model reliability, large-context behavior, and billing-accurate usage remain unverified, and usage stays estimated.[^releases]

The v0.1.4 note separates selected local checks from its completed GitHub candidate workflow, which passed the full suite including browser fixtures; those results describe that historical release, not later changes.[^unit-boundary]

The v0.1.6 note records native-home file configuration, direct ordered caller instructions and effective offered schemas, and a key-referenced envelope-format correction that preserves authorization, safety, action authorization, and cancellation behavior. Its local checks do not establish live-model reliability or billing accuracy; publication still requires version/tag agreement and successful gated workflows.[^current-release][^release-ci]

# Rollback

Rollback stops the provider, reinstalls the pinned prior version, and restarts only after reviewing that version's configuration and default-path behavior; do not delete browser credentials or session state.[^current-release]

See also: [CLI lifecycle](../operations/cli-lifecycle.md) and [Model catalog](../runtime/model-catalog.md).

[^release-ci]: Release workflow
[^operations]: Operations and client setup
[^releases]: v0.1.3 release notes
[^unit-boundary]: v0.1.4 validation boundary
[^current-release]: v0.1.6 release scope and validation
