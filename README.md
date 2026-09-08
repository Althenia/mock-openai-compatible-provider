# AIPass

Use browser-based AI from an OpenAI-compatible client, through a local provider.

AIPass connects your client to an authenticated webchat in Google Chrome. It
exposes Chat Completions and Responses APIs on loopback—not a hosted inference
service or a local model. Prompts are sent to the upstream webchat.

## Quick start

You need **macOS on Apple silicon**, **Google Chrome**, and an account with access
to the configured webchat. The prebuilt executable does not require Bun.
It is ad-hoc signed, **not Developer ID signed or notarized**.

**1. Install the executable.**

```sh
curl -fsSL https://althenia.github.io/mock-openai-compatible-provider/install.sh | sh
```

The installer verifies GitHub's SHA-256 asset metadata and installs into
`~/.local/bin`. From v0.1.3 onward, stop the provider and run
`aipass-browser-provider update` to update; then start it again. Older versions
need the installer command above once. See [update and offline options](docs/operations.md#update-and-restore).

**2. Sign in through Chrome.**

```sh
export PATH="$HOME/.local/bin:$PATH"
aipass-browser-provider login
```

Complete sign-in in the opened window, verify that the chat input is visible,
then close the window or press Enter in the terminal to finish.

**3. Start the provider.**

```sh
aipass-browser-provider start
```

Leave this terminal running. In another terminal, query the model catalog:

```sh
export PATH="$HOME/.local/bin:$PATH"
export AIPASS_PROVIDER_BASE_URL="$(aipass-browser-provider endpoint)"
export AIPASS_PROVIDER_TOKEN="$(aipass-browser-provider print-token)"
curl -fsS -H "Authorization: Bearer $AIPASS_PROVIDER_TOKEN" \
  "$AIPASS_PROVIDER_BASE_URL/models"
```

Configure your client with that base URL, the token as its API key, and a model
ID returned by `/models`. Keep the token and Chrome profile private. Use the same
config/state settings across terminals; see [client setup](docs/operations.md#authenticate-and-connect).

## How it fits your client

- **Browser-backed transport.** Playwright drives installed Chrome; a persistent
  profile retains sign-in, with optional durable client-session bindings.
- **Client-owned actions.** AIPass translates validated action envelopes into tool
  requests. Your client owns permissions, execution, and returned results.
- **Client-supplied context.** Your client must send its instructions and history;
  AIPass does not load another application's agent or workspace files.

Live tool, skill, file-operation, MCP, and all-model reliability are **not
established by local tests**. Usage is estimated, not billing-accurate. Read the
[known limitations](docs/releases/v0.1.3.md#known-limitations) before relying on
these paths.

## Go deeper

- [Operations](docs/operations.md) — configuration, updates, diagnostic scripts, and local review.
- [Runtime guide](docs/runtime-guide.md) — API contracts, sessions, context, and recovery.
- [Model matrix](docs/model-matrix.md) — provider model IDs and Processing options.
- [Build and contribute](SOURCE.md#application-build) — source setup and checks with **Bun 1.4.2**.

Licensed under [AGPL-3.0-only](LICENSE). See [source and redistribution](SOURCE.md)
and [third-party notices](THIRD_PARTY_NOTICES).
