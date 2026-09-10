# Operations and client setup

See [runtime configuration](configuration.md) and [runtime behavior](runtime-guide.md) for file settings, prompt fidelity, continuation, and compaction. The provider binds only to loopback; this is not a public hosted inference service.

## Authenticate and connect

After installing, run `aipass-browser-provider login` and finish sign-in in Chrome. Then run `aipass-browser-provider start` in a separate terminal. It prints the local endpoint and remains in the foreground.

```sh
export AIPASS_PROVIDER_BASE_URL="$(aipass-browser-provider endpoint)"
export AIPASS_PROVIDER_TOKEN="$(aipass-browser-provider print-token)"
curl -sS -H "Authorization: Bearer $AIPASS_PROVIDER_TOKEN" "$AIPASS_PROVIDER_BASE_URL/models"
```

Configure an OpenAI-compatible client with that base URL, bearer token, and an ID returned by `/models`. Keep the token private. Clients must supply their current instructions; AIPass does not load another application's agent or workspace files. Model capability metadata describes supported bridge formats, not verified live reliability or an upstream context limit.

## Commands

| Command | Purpose |
| --- | --- |
| `start` / `serve` | Run the provider in the foreground |
| `login` | Open the persistent Chrome profile for sign-in |
| `stop` | Request authenticated graceful shutdown |
| `update` | Install the latest verified release; provider/login must be stopped |
| `endpoint` | Print the configured OpenAI-compatible base URL |
| `print-token` | Print the local credential; never share its output |
| `version` / `--version` | Print the executable version |
| `help` | List supported options |

Runtime commands accept `--config PATH`, `--state-root PATH`, and `--chrome PATH`. `start`, `serve`, and `endpoint` also accept `--port PORT`. Use the same configuration file for login, start, endpoint, stop, and update.

## Paths and configuration

Runtime config defaults to `<native-account-home>/.config/aipass-browser-provider/config.json`, and state defaults to `<native-account-home>/.local/state/aipass-browser-provider`. The native home is resolved from the current process UID through the macOS account database; `HOME`, XDG variables, and former provider `AIPASS_*` variables do not redirect either path. No existing files are moved from former environment-selected paths. Credentials and files are private; Chrome profile data is sensitive. Runtime settings, defaults, and precedence are defined in the [configuration reference](configuration.md).

## Update and restore

Stop the provider before executable replacement. Updating does not restart it; a supervisor may restart a stopped process. Preserve configuration and browser state. Process-memory Responses IDs do not survive a restart.

From v0.1.3 onward:

```sh
aipass-browser-provider stop
aipass-browser-provider update
aipass-browser-provider --version
aipass-browser-provider start
```

`update --version 0.1.3` selects a specific release instead of the latest.
The command runs the installer embedded in the executable, not a downloaded
shell script. It retains GitHub SHA-256 verification, executable checks, and
atomic replacement. Download, metadata, checksum, or executable-check failures
leave the existing binary unchanged.

The standard-named compiled executable updates its own directory. Override it
with `--install-dir DIRECTORY` or the file's `installDir`. The provider updater
passes a fully resolved destination to the embedded installer. A renamed
executable requires an explicit destination. When run from source with Bun, the default is
`<native-account-home>/.local/bin`, as with the standalone installer; Bun itself
is never replaced.
The installed filename remains `aipass-browser-provider`.

Use the same configuration file or `--state-root PATH` as the running provider.
The updater holds that profile's lock throughout installation and refuses while
the provider or login owns it. `stop` may return before shutdown finishes; if the
lock is still held, wait for the provider to exit and retry. The guard covers only
the selected state root: stop other instances and disable automatic supervisor
restarts before updating a shared executable. There is no automatic stop/restart.
Versions before v0.1.3 need the README's installer command once to gain `update`.

The installer accepts `--version VERSION`, `--install-dir DIRECTORY`, `--config PATH`, and `--from-dir DIRECTORY` for verified offline artifacts. For a downloaded release directory containing the binary, checksums, and installer:

```sh
shasum -a 256 -c checksums.txt
sh install.sh --version 0.1.2 --from-dir .
```

For a source build, install `dist/aipass-browser-provider` to the desired executable directory with mode `0700`. Binaries are ad-hoc signed, not notarized. Read [0.1.3 candidate limitations](releases/v0.1.3.md) before use; the offline example above remains the published 0.1.2 route until 0.1.3 is released.

## Scripts and redistribution

- `bun run build` compiles and signs the executable on macOS; `bun run test:build` checks an isolated copy.
- `bun run test:install` validates installer behavior with local fixtures.
- `bun run test:release` validates release preflight and binary-only packaging; it does not download upstream sources.
- `bun scripts/live-smoke.ts --config PATH --case startup-context gpt-5.6-terra` checks synthetic startup instructions through both APIs. `lookup`, `chain`, `catalog`, and `instruction-update` cover other bounded diagnostics. These consume authenticated provider quota, use an in-memory dispatcher, and are not real-client execution proof. Stop a running provider before starting these scripts.
- `bun scripts/live-catalog-trace.ts --self-test` checks the metadata observer locally. Its live modes require explicit `--allow-live`, `--fixture PATH`, `--config PATH`, and `--client-config-dir PATH`. `--run` also requires the `yce2e` tmux session and a configured YCoding route; `--provider` leaves client launch to the operator. `YCODING_CONFIG_CONTENT` is injected only into that isolated external-client test process; it is not an AIPass setting or provider configuration path. Native context capture and skill-input matching are separate from successful task execution.
- `bun scripts/docs-site.ts` serves the allowlisted documentation and redacted review files on `127.0.0.1:8787`; `--port PORT` selects another port. It does not expose raw output, credentials, or arbitrary repository files.
- Public documentation and the installer are hosted on [GitHub Pages](https://althenia.github.io/mock-openai-compatible-provider/). The manually dispatched Pages workflow builds only the public allowlist with `scripts/build-docs-site.ts`; it never uploads the local review shell or recordings.

The license is [AGPL-3.0-only](../LICENSE). Release workflow details and known limitations belong in release documentation, not the quick-start README.
