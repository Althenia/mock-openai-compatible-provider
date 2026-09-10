# Runtime configuration

AIPass reads provider runtime settings from one JSON file. By default the path is
`<native-account-home>/.config/aipass-browser-provider/config.json`. AIPass
resolves the native macOS account home from the process UID through the macOS
account database. Use `--config PATH` to select another file.

## Precedence

1. Supported explicit CLI options: `--config`, `--state-root`, `--chrome`,
   `--port`, and update-only `--install-dir`.
2. Values in the selected configuration file.
3. Built-in defaults.

`HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and former provider `AIPASS_*`
variables do not select paths or runtime settings. The provider's `update`
command resolves its destination before invoking the embedded installer and
passes it explicitly; use the file's `installDir` or the command's
`--install-dir`. The standalone installer likewise uses its explicit
options, selected JSON file, and native-account defaults rather than provider or
installer environment overrides. Existing files under environment-selected old
paths are not moved automatically.

`help`, `--help`, `version`, and `--version` do not read the configuration file,
initialize state, or check Chrome.

## Example

This synthetic example uses local placeholder paths. Keep the real file and any
diagnostic screenshot directory private.

```json
{
  "version": 1,
  "host": "127.0.0.1",
  "port": 43123,
  "stateRoot": "/Users/example/.local/state/aipass-browser-provider",
  "chromeExecutable": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "chatURL": "https://de.aipass.net/chat?temporary-chat=true",
  "navigationTimeoutMs": 90000,
  "streamIdleTimeoutMs": 120000,
  "browserHeaded": true
}
```

## Fields

| Field | Type and default | Purpose |
| --- | --- | --- |
| `version` | integer, required: `1` | Configuration schema version |
| `host` | string, required: `127.0.0.1` | Fixed loopback bind host |
| `port` | integer `1..65535`, optional | Preferred loopback port. When the file's port cannot bind, AIPass selects and persists an available port; an explicit `--port` instead fails if it cannot bind. |
| `stateRoot` | non-empty string, `<native-account-home>/.local/state/aipass-browser-provider` | Credential, bindings, lock, and Chrome profile root |
| `chromeExecutable` | non-empty string, platform default | Google Chrome executable |
| `chatURL` | non-empty string, temporary-chat URL | Upstream webchat page |
| `navigationTimeoutMs` | positive integer, `90000` | Browser navigation deadline |
| `streamIdleTimeoutMs` | positive integer, `120000` | Upstream stream inactivity deadline |
| `streamURLPattern` | non-empty string, optional | Additional stream URL substring |
| `browserHeaded` | boolean, `true` | Show the user-owned Chrome window |
| `screenshotDir` | non-empty string, optional | Private diagnostic screenshot destination |
| `installDir` | non-empty string, optional | Destination used by the provider `update` command; source execution otherwise uses `<native-account-home>/.local/bin` |

Known malformed fields fail the command with the field name and expected type or
range. Existing version-one files containing only `version`, `host`, and `port`
remain valid because other fields use defaults. When AIPass selects or changes a
port it atomically rewrites the private file while preserving all other validated
settings.
