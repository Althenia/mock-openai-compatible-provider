---
type: Interface
title: Model catalog
description: TypeScript-mastered provider model IDs with Processing variants, parity-tested
  against the review matrix.
tags:
- models
- processing
- catalog
sources:
- id: catalog
  resource: repo:///src/model-catalog.ts
  title: Model catalog master data
- id: config
  resource: repo:///src/config.ts
  title: Configuration
- id: catalog-test
  resource: repo:///src/model-catalog.test.ts
  title: Catalog parity tests
- id: matrix
  resource: repo:///docs/model-matrix.md
  title: Model and Processing matrix
---

# Master data

`MODELS` in the catalog module is the executable master data, defining twenty provider model IDs, display names, and configured Processing variants.[^catalog] The configuration module re-exports that same catalog identity for existing consumers.[^config] The provider consumes the TypeScript master data, not the Markdown review table.[^matrix]

# Parity and labels

Parity tests assert the config re-export identity, unique IDs and names, and exact ID, name, order, and variant agreement between the catalog and every matrix row.[^catalog-test] Canonical Processing labels cover English and Thai, including the `max` label whose Thai form was verified in the loaded webchat translation bundle rather than a Thai chat.[^matrix]

# Verification boundary

Configured capabilities are not automatically live-verified capabilities: the September 2026 pass inspected expanded settings and every available Processing dropdown for all twenty models without submitting twenty-model chat acceptance, and the inspection recording is retained locally, not distributed.[^matrix] Selection must verify the requested Processing display, picker closure, and composer model before a prompt is submitted.[^matrix]

See also: [Provider runtime](../architecture/provider-runtime.md) and [Request session contract](request-session-contract.md).

[^catalog]: Model catalog master data
[^config]: Configuration
[^matrix]: Model and Processing matrix
[^catalog-test]: Catalog parity tests
