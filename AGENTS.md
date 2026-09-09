# AGENTS.md — AIPass (aipass-browser-provider)

Browser-backed OpenAI-compatible provider on loopback. Prompts go to an upstream webchat via local Chrome; this is not a hosted inference service or a local model.

## Platform and toolchain

- Targets **macOS arm64** with separately installed Google Chrome and an authenticated webchat profile.
- Runtime/bundler is **Bun** (`bun@1.4.2`); only production dependency is `playwright-core`. Never add a dependency without explicit approval.
- TypeScript is `strict` with `module ESNext`, `moduleResolution Bundler`, `allowImportingTsExtensions` — import relative modules with explicit `.ts` extensions.
- Tests run from `./src` (`bunfig.toml`); executable entry is `src/index.ts` → `runCLI` with `serveProvider`/`loginProvider`.

## Commands

```sh
bun run typecheck        # tsc --noEmit, must pass
bun test                 # unfiltered; zero failures, no skips to obtain a pass
bun run build            # compile + ad-hoc codesign on macOS (not notarized)
bun run test:build       # isolated-binary check
bun run test:install     # installer fixtures
bun run test:release     # release preflight + binary-only packaging, no upstream downloads
```

- `bun scripts/live-smoke.ts --case <case> <model>` consumes authenticated provider quota, uses an in-memory dispatcher (no real filesystem/skill execution), and requires the provider stopped first. Same for `live-catalog-trace.ts --run/--provider` (needs `AIPASS_LIVE_SMOKE=1`, fixture dir, `yce2e` tmux session).
- `bun scripts/docs-site.ts` serves only the allowlisted docs on loopback; never expose raw output, credentials, or arbitrary repo files.

## Working conventions

- Keep the ownership boundary: webchat backend owns reasoning/answers; AIPass owns transport + structured-response validation; the calling client owns permissions, dispatch, and results. AIPass never loads another application's agent/workspace files — callers supply instructions per request.
- Model data: `src/model-catalog.ts` (`MODELS`) is master; `docs/model-matrix.md` is a review table and `src/model-catalog.test.ts` enforces ID/name/order/variant parity. Change the TS first, then the table.
- Config/state: XDG-based defaults (`aipass-browser-provider/config.json`, state root); env overrides `AIPASS_*`. Keep tokens, credentials, Chrome profiles, and screenshot output private. Server binds loopback only.
- Releases: `package.json` version, tag `v<version>`, and `docs/releases/v<version>.md` must agree (CI checks this). Record changed behavior, the validation actually run, and known limitations in the release note. Binaries are ad-hoc signed, not notarized.
- Public surface (`site/`, Pages docs built by `scripts/build-docs-site.ts` allowlist) excludes local recordings and private diagnostics.

## Evidence honesty (binding)

- Local tests validate provider and prompt-projection behavior only. Never claim live tool/skill/file/MCP execution, all-model reliability, or billing accuracy from them — usage is `estimated: true`.
- One bounded real-client pass is one data point, not a guarantee. Put new limitations in the current release note, not the quick-start README.
- Raw diagnostic reports, recordings, and identifiers stay local; do not distribute them with releases.

## Knowledge graph

- `docs/okf` is the agent knowledge bundle, maintained with the `aletheia` skill (helper only renders agent-authored payloads; never stage/commit from bundle work without a separate request).
- Update the affected concepts when API contracts, prompt-projection behavior, CLI/config surface, model catalog, or release/validation process change; re-run `indexes` and `validate` per the skill workflow.
