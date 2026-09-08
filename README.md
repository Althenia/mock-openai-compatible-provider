# AIPass browser provider

A standalone TypeScript provider compiled with Bun and backed by Playwright plus the installed Google Chrome. It exposes a loopback-only OpenAI-compatible endpoint while retaining a persistent browser profile and optional durable client-session bindings.

## Table of Contents

- [Requirements](#requirements)
- [Install or update](#install-or-update)
- [Build and test](#build-and-test)
- [Install from a source build](#install-from-a-source-build)
- [Release](#release)
- [Development](#development)
- [Setup](#setup)
- [CLI](#cli)
- [Preserved runtime contracts](#preserved-runtime-contracts)
- [Browser behavior](#browser-behavior)
- [Tool calls](#tool-calls)
- [Context estimation and compaction](#context-estimation-and-compaction)
- [Paths and environment](#paths-and-environment)

## Requirements

- Google Chrome (macOS default: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`)
- macOS on Apple silicon for the prebuilt executable
- Bun **1.4.2** only when building from source (not required for installation)

## Install or update

Install the latest release with one command. Run the same command to update:

```sh
curl -fsSL https://raw.githubusercontent.com/Althenia/mock-openai-compatible-provider/main/site/install.sh | sh
```

No repository clone, Bun installation, or GitHub login is required. The installer
uses macOS's built-in `plutil` and checks the executable against GitHub's SHA-256
asset metadata before running it. This trusts the public repository and GitHub
over HTTPS; it is not a separate publisher signature. If metadata is unavailable
or GitHub rate-limits the request, installation stops without replacing the
existing binary; retry later.

To select a specific version:

```sh
curl -fsSL https://raw.githubusercontent.com/Althenia/mock-openai-compatible-provider/main/site/install.sh | sh -s -- --version 0.1.2
```

The installer verifies the executable's SHA-256 checksum, runs its `help` check,
and atomically installs it as `~/.local/bin/aipass-browser-provider` with mode
`0700`. Set `AIPASS_INSTALL_DIR` or pass `--install-dir DIRECTORY` to choose
another destination. Updating the executable does not restart a running
provider. Stop it before replacing the binary. Check the installed version with
`aipass-browser-provider --version`; it must print `0.1.2` for this release.
The binaries are ad-hoc signed, not Developer ID signed or notarized.
Read [v0.1.2's known limitations](docs/releases/v0.1.2.md) before updating:
the repaired selection path passed a Terra Low YCoding smoke turn, but live
skill, file-operation, MCP execution, and all-model reliability remain unverified.

For offline installation or restoration, download the executable and complete
source archive into one directory, then run these commands there:

```sh
tar -xzf aipass-browser-provider-0.1.2-complete-source.tar.gz
shasum -a 256 -c checksums.txt
sh install.sh --version 0.1.2 --from-dir .
```

The archive contains the installer and checksums needed by `--from-dir`, plus
the licenses and corresponding source to keep when redistributing. Use the
matching directory/version for a restore. To restore the published `0.1.0`
binary, use `--version 0.1.0` with the online installer or that release's verified
offline directory. Stop the provider before replacement and preserve state/config
directories; process-memory Responses IDs do not survive a restart.

Then authenticate and start it:

```sh
export PATH="$HOME/.local/bin:$PATH"
aipass-browser-provider login
aipass-browser-provider start
```

## Build and test

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:install
bun run build
bun run test:build
bun run test:release
```

`bun test` discovers the maintained tests under `src/`; local diagnostic files
under `output/` are not part of the release suite. `test:release` also installs
the packaged executable through the archive's offline installer into a temporary
directory and checks its version, permissions, and exact bytes. Its component
source archives are inert fixtures, not upstream-source verification.

The compiled executable is written to:

```text
dist/aipass-browser-provider
```

The build bundles `playwright-core` and uses the system Chrome executable; it does not download a Playwright-managed browser. The unused optional Chromium BiDi modules are externalized because the normal Chrome CDP path does not load them.

## Install from a source build

Install the compiled binary for the current user:

```sh
mkdir -p "$HOME/.local/bin"
install -m 700 dist/aipass-browser-provider "$HOME/.local/bin/aipass-browser-provider"
export PATH="$HOME/.local/bin:$PATH"
```

Then authenticate and start it:

```sh
aipass-browser-provider login
aipass-browser-provider start
```

`start` stays in the foreground and is suitable for a process supervisor. A supervisor must preserve the same state/config environment and should use `aipass-browser-provider stop` for graceful shutdown before replacing the binary.

## Release

`.github/workflows/release.yml` validates and builds `main` and version tags using
Bun 1.4.2. It runs typechecking, the full test suite, installer checks, binary
help/version/architecture checks, and redistribution-file checks. It packages
the executable and one complete source archive containing the exact application
source, bundled-component sources, notices, installer, and offline checksums.
CI verifies an internal checksum manifest, but publishes only the executable and
complete source archive as release attachments. Only a `vX.Y.Z` tag publishes a
GitHub Release; the tag must equal `v` plus `package.json`'s version. Existing
releases are not overwritten. Review [v0.1.2's limitations](docs/releases/v0.1.2.md)
before use; a successful build does not erase the recorded live-model failures.

The project is **AGPL-3.0-only**; see [LICENSE](LICENSE),
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES), and [SOURCE.md](SOURCE.md) for
third-party licenses and rebuilding/relinking. Notices are generated from
identified upstream texts with
`bun scripts/sync-notices.ts --bun-source BUN_ARCHIVE --webkit-source WEBKIT_ARCHIVE`,
using the accompanying Bun and WebKit source archives; `--check` compares without
writing. Source archive checksums are pinned in
`third-party/sources.sha256`. Never replace failed retrievals with placeholders.

The raw GitHub installer URL above does not require GitHub Pages.
`.github/workflows/pages.yml` checks the installer on macOS; manual dispatch can
deploy it to Pages when Pages is configured. The published v0.1.0 tag and executable remain
unchanged by the packaging update; use the maintained URL above rather than a
saved old installer for online downloads.

## Development

Use an isolated state root so development does not contend with the installed service's profile lock:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:install

export AIPASS_STATE_ROOT="$PWD/.aipass-state"
export AIPASS_CONFIG_PATH="$PWD/.aipass-state/config.json"
bun src/index.ts login
bun src/index.ts start --port 43123
```

Run a focused test while iterating, then rerun the full checks and compiled build before installation:

```sh
bun test src/provider.test.ts
bun run typecheck
bun test
bun run test:install
bun run build
git diff --check
```

## Setup

```sh
# Opens headed Chrome using the provider profile. Sign in if required.
./dist/aipass-browser-provider login

# Foreground provider server (`serve` is an alias).
./dist/aipass-browser-provider start

# Run after the server starts.
export AIPASS_PROVIDER_BASE_URL="$(./dist/aipass-browser-provider endpoint)"
export AIPASS_PROVIDER_TOKEN="$(./dist/aipass-browser-provider print-token)"
```

OpenAI-compatible clients can use the exported base URL and bearer token directly. Discover the provider-owned model IDs instead of hardcoding them:

```sh
curl -sS \
  -H "Authorization: Bearer $AIPASS_PROVIDER_TOKEN" \
  "$AIPASS_PROVIDER_BASE_URL/models"
```

## CLI

```text
aipass-browser-provider start [--port PORT] [--config PATH] [--state-root PATH] [--chrome PATH]
aipass-browser-provider serve [--port PORT] [--config PATH] [--state-root PATH] [--chrome PATH]
aipass-browser-provider stop [--config PATH] [--state-root PATH]
aipass-browser-provider endpoint [--port PORT] [--config PATH] [--state-root PATH]
aipass-browser-provider login [--config PATH] [--state-root PATH] [--chrome PATH]
aipass-browser-provider print-token [--config PATH] [--state-root PATH]
aipass-browser-provider version
aipass-browser-provider --version
aipass-browser-provider help
```

`start` remains in the foreground. `stop` sends an authenticated loopback shutdown request; a keep-alive supervisor may restart the process.

## Preserved runtime contracts

- Authenticated `GET /health`, `GET /v1/models`, `GET /v1/models/{model}`, `POST /shutdown`, `POST /v1/chat/completions`, and `POST /v1/responses`.
- Optional Chat Completions affinity through `x-session-id`, `x-session-affinity`, `x-client-request-id`, `session_id`, `prompt_cache_key`, or `user`, bounded to 256 characters. Unaffiliated Chat Completions requests are stateless and open a fresh remote conversation. Initial Responses requests ignore Chat-affinity inputs: stored responses receive a new response-ID session, while `store: false` requests are ephemeral. A `previous_response_id` is single-use because the browser backend cannot branch from a prior turn; combining it with `store: false` is also rejected.
- Completed stored Responses retain their actual input and emitted output items in process memory. A continuation replays those items before the new input, including function-call IDs/results and separately labeled assistant reasoning summaries. Prior top-level `instructions` do not carry forward; supply current instructions on each request. Instructions supplied as actual input messages remain part of the history.
- Responses retention is bounded to 1,000 records and 16 MiB of serialized UTF-8 history payloads, not total JavaScript heap or an upstream context window. Oldest unreserved records are evicted first. A single history larger than the byte budget is not retained and does not evict unrelated records. Missing, consumed, evicted, oversized, or process-restarted IDs return `previous_response_not_found` rather than submitting partial history. The Responses cache writes no message history to disk; `store: false` retains none. Streamed history is committed only at `response.completed`; failed or cancelled streams invalidate their continuation.
- Streaming and non-streaming text, reasoning, and structured tool calls. Chat Completions streams end with one terminal finish and `[DONE]`; Responses streams emit ordered, numbered events through `response.completed` without a Chat sentinel.
- `tool_choice` values `auto`, `none`, `required`, and a named function. Named choices expose only the selected function to the browser model. Required and named choices are accepted for non-streaming requests; streaming requests receive an invalid-request error before browser submission because a required call cannot be validated safely after SSE starts.
- Estimated usage in non-streaming responses and in Chat Completions streams when `stream_options.include_usage` is true. Estimates are explicitly marked `estimated: true` and are not billing data.
- OpenAI-shaped JSON errors for invalid requests, authentication failures, browser-authentication requirements, upstream failures, and missing resources.
- Existing XDG config/state paths, version-one runtime config, credential, and binding schemas.
- Stable 64-character hex credential with private files (`0600`) and directories (`0700`).
- Same-hash ambiguous submissions fail closed; different-hash requests recover the previous pending attempt.
- Exact-origin remote-chat reuse and one serialized turn per local session.

## Browser behavior

Playwright locator auto-waits handle model and upload controls. Model selection re-resolves controls after React rerenders, handles collapsed/expanded thinking cards, and uses one 20-second cold-page safety deadline. Response capture uses a page binding, fetch wrapper, and DOM-completion observer. After matching the current submission, a 250 ms sampling tick streams new visible thinking-panel text from that turn through both APIs; Thai and English Processing/Processed/Thinking labels are not reasoning. Answers and tool requests remain buffered for turn-key and offered-action validation. If native completion arrives after DOM reasoning has started, terminal output waits for a four-second unchanged-panel window, capped by the stream idle timeout, while selected-stream errors and cancellation remain active. Unseen native suffixes are never substituted for DOM text. Repeated text, non-prefix rewrites, and duplicate native or envelope reasoning are not replayed after DOM reasoning starts. Extraction retains the existing limits of eight segments, 200 title characters, and 2,000 body characters per segment.

When an initial action-enabled submission produces verified background activity but no stream or assistant response, the provider marks that attempt failed and performs one bounded internal recovery in the same Playwright page. It reloads the durable conversation URL, re-arms a fresh capture generation, and resubmits a recovery-safe prompt inside the original HTTP request.

The provider uses one persistent Chrome context with one reusable page per explicit client session. Failed or cancelled pages are evicted. The browser profile is protected by a PID-identified lock file with stale-owner recovery.

## Tool calls

The AIPass website has no native function-calling API. The provider therefore projects a subset of the offered action schemas relevant to the request and asks the model to emit a host-orchestration control frame:

```text
<aipass-envelope>{"type":"tool","key":"current_turn_key","id":"call_unique","name":"read","input":{"path":"package.json"}}</aipass-envelope>
```

The `key` must copy the current submission's `TURN KEY` verbatim; `current_turn_key` above is an example value. The frame is never executed by the website. The provider validates attribution and the action against the complete set offered by the calling client and converts it to an OpenAI `tool_calls` delta. The client executes the call and sends its result in a subsequent `tool` message so the model can continue. Legacy `<aipass-action>` frames remain accepted by the parser, but are no longer the generated instruction format.

Recognized typed replies also accept bare JSON and a leading echoed `TURN KEY` line. The echoed key and envelope keys must agree with the current turn before conversion. `chat` becomes answer text, `thinking` becomes reasoning, and offered action types become client-dispatched function calls rather than visible JSON. MCP tools use this same path: their exact offered names and arguments are preserved, and results return through the client's normal tool-result continuation. Quoted JSON inside a chat envelope remains answer text, not another tool call.

Tool capability metadata describes the bridge's supported format, not a guarantee that a browser model will follow the dispatcher protocol. Live validation has encountered refusals, premature answers, and extra final-answer prose. A passing local test suite does not establish reliable live tool execution.

The opt-in live checks use the authenticated browser profile and consume provider quota. Stop any running provider first; the script starts and stops its own instance. After `bun run build`, run `bun scripts/live-smoke.ts --case lookup` for an unpredictable tool-result check or `bun scripts/live-smoke.ts --case chain` for an ordered synthetic tool/skill sequence through both endpoints. These checks use Sonnet low, Terra low, and Gemini Flash Lite without a variant, and exit nonzero on failure. Their in-memory dispatcher does not execute real filesystem operations or installed client skills.

Two targeted Chat Completions diagnostics default to Gemini Flash Lite without a variant:

- `bun scripts/live-smoke.ts --case catalog` compares `action-only` and `preserve` using unpredictable skill IDs supplied only in system context. Use `--instruction-mode preserve` or `--instruction-mode action-only` to select one side. Omitted IDs are expected to prevent successful skill selection in action-only mode; the check still reports that workflow as failed.
- `bun scripts/live-smoke.ts --case instruction-update` supplies an unpredictable final read path through a developer instruction added during the tool chain. It checks delivery of changed preserved instructions, all four tool calls, and an exact final streamed result. Explicit model IDs can select Sonnet or Terra at low. This diagnostic is not proof of native reasoning provenance or real client skill execution.

`bun scripts/live-catalog-trace.ts --self-test` validates the metadata observer locally. Its `--run` mode requires `AIPASS_LIVE_SMOKE=1`, `AIPASS_LIVE_FIXTURE` pointing to a plain-text fixture containing `notes.txt`, an existing `yce2e` tmux session, and a configured AIPass client route. It starts its own provider and an isolated standalone YCoding client with a process-local preserve-mode overlay; select the intended model and submit the read-only fixture workflow there. It compares each current-message submission with the complete projected request, including that prefix on internal repair/provision submissions, without logging prompt or response text. It also checks that existing normal configuration files remain unchanged. `captureComplete` means every observed request retained that projection; it does not establish successful skill execution, an exact final answer, or model compliance.

The observer's `--provider` mode uses the same opt-in and fixture guards but leaves client launch and interaction to a separately managed acceptance harness. It prints the loopback endpoint after readiness and needs no tmux session. An actual-client workflow pass does not override a failed native-capture gate.

Native skill-input comparisons report only canonical input hashes and byte/key counts, using native request ownership and the actual submitted turn key without logging it. `skillInputCapture.complete` additionally requires at least one wire skill call and an unambiguous match for every transaction. Missing, incomplete, or ambiguous native replies remain `indeterminate`; earlier skill-input matches do not make an unparsed final reply pass. The script exits nonzero when either capture gate fails. Neither gate establishes successful skill execution or workflow acceptance.

For automatic tool choice, the provider buffers at most 64 KiB before exposing a short response that explicitly claims it cannot access an available file, directory, workspace, tool, command, shell, web, or network resource. It can replace that capability-only refusal with one corrective turn. Normal answers, safety refusals, existing action frames, non-stop completions, and oversized output are not repaired. Tool-result continuations can also trigger this bounded repair when offered schemas are available. Repair and schema-provision submissions retain the recovery request context alongside their additional directive; they do not send a contextless schema-only request.

Preserve-mode requests carry the complete supplied system/developer instructions, supplied conversation in order, matched tool-call/result text, and the current bounded action contract in the current browser submission. Initial, bound, and recovery routes use that same self-contained projection: browser affinity and a current contract digest are not treated as evidence of retained model context. Tool names remain available through the complete name index; full schemas are selected and provisioned as needed. Prompt projection logs contain only action names and character counts, never prompt content.

Long instructions are no longer split into acknowledgement turns or reduced to a head/tail anchor. They stay inline without silent truncation. This preserves transmitted request content; it does not establish an upstream context limit or guarantee that every model will use large requests correctly. See the [release limitations](docs/releases/v0.1.2.md) for the observed compatibility boundaries. Raw local diagnostic reports are not distributed with the release.

Requests default to `instruction_mode: "preserve"`, including those carrying `x-session-affinity`: affinity controls session routing, not instruction omission. The non-standard request extension `instruction_mode: "action-only"` explicitly omits system/developer text and lowered system updates, and retains incremental-suffix routing for bound turns. An explicit `instruction_mode` always wins. Action-only mode is intended for orchestration clients that enforce their own instruction layer and need the browser model solely to select from the projected actions. Existing clients that need instruction omission must opt in explicitly. Switching an existing affinity from `preserve` to `action-only` starts a fresh remote conversation so previously projected instructions cannot remain active. Estimated API input usage describes the initial projected request, excluding omitted instructions; it is not native billing or a total of internal attempts.

This omission includes installed-skill catalogs carried in system/developer messages. A generic `skill` tool with only `id: string` does not tell the browser model which IDs exist. An action-only client must supply the required IDs through request/tool data or use the default preserve mode. The bridge does not invent skill IDs, rewrite them to application-specific values, or fabricate skill results. Skill content returned in a tool-result message is retained in either mode.

## Context estimation and compaction

The calling client remains the authority for deciding when to compact and should use its standard model catalog for context and output limits. `GET /v1/models` deliberately reports provider identity, text/tool capabilities, and reasoning variants without inventing an unverified context limit for the Passport website.

The provider also keeps a conservative estimate of website-visible context:

```text
estimated tokens = ceil(UTF-8 byte length / 3)
```

This estimate is deterministic and intentionally conservative for Thai, CJK, emoji, and mixed code. It is not billing, quota, or exact tokenizer usage.

When a client compacts, it can send an exact `<conversation-checkpoint>` user message containing the summary and retained tail. The provider hashes that checkpoint, atomically clears the old remote binding, increments the remote epoch, resets its estimate, closes the old page, and starts a new Passport conversation with the compacted transcript. Repeated delivery of the same checkpoint digest does not rotate again, and completed attempts are accounted once by attempt ID.

Without a checkpoint the provider does not guess a context limit or silently discard canonical history. A client should perform its own compaction from its standard model registry and send the checkpoint shape when it wants the provider to rotate the remote chat.

Stored Responses continuations append to retained history. To supply compacted replacement history, start a new Responses request without `previous_response_id`; otherwise the supplied checkpoint is appended to the earlier items rather than replacing them.

## Paths and environment

Runtime config:

- `$XDG_CONFIG_HOME/aipass-browser-provider/config.json`, or
- `~/.config/aipass-browser-provider/config.json`

Provider state:

- `$XDG_STATE_HOME/aipass-browser-provider`, or
- `~/.local/state/aipass-browser-provider`

Supported environment variables:

| Variable | Purpose |
| --- | --- |
| `AIPASS_CONFIG_PATH` | Runtime config path |
| `AIPASS_STATE_ROOT` | Credential, bindings, lock, and Chrome profile root |
| `AIPASS_PORT` | Explicit loopback port |
| `AIPASS_BROWSER_EXECUTABLE` | System Chrome executable |
| `AIPASS_CHAT_URL` | AIPass chat URL |
| `AIPASS_STREAM_URL_PATTERN` | Optional extra fetch-stream URL substring |
| `AIPASS_NAVIGATION_TIMEOUT_MS` | Navigation/login safety deadline (default `90000`) |
| `AIPASS_STREAM_IDLE_TIMEOUT_MS` | Stream inactivity safety deadline (default `120000`) |

Prompt text, credentials, URLs, browser response bodies, checkpoint summaries, and session identifiers are not logged. Selected action names and prompt character counts are logged for diagnostics. Chrome profile data remains sensitive local state. Durable binding state contains remote URLs, hashes, attempt metadata, context epochs, and estimated token counters, but not prompt or summary text.
