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
---

# Agreement

The manifest version, release tag, and release note must agree before publication.[^release-ci] Release workflow details and known limitations belong in release documentation, not the quick-start README.[^operations]

# Validation boundary

The v0.1.3 note records the local checks actually run, the single bounded real-client read cycle, and the explicit statement that one case is not a reliability guarantee.[^releases] Beyond that case, live tools, skills, file operations, MCP, every-model reliability, large-context behavior, and billing-accurate usage remain unverified, and usage stays estimated.[^releases]

# Rollback

Rollback stops the provider, reinstalls the pinned prior version, and restarts with the same configuration and state directories without deleting browser credentials or session state; in-memory Responses IDs do not survive a restart.[^releases]

See also: [CLI lifecycle](../operations/cli-lifecycle.md) and [Model catalog](../runtime/model-catalog.md).

[^release-ci]: Release workflow
[^operations]: Operations and client setup
[^releases]: v0.1.3 release notes
