# Architecture

* [Browser transport](browser-transport.md) - Playwright-driven installed Chrome with a persistent profile, PID-identified lock, and temporary-chat entry.
* [Prompt projection](prompt-projection.md) - Separated client/harness initialization, exact declaration deduplication, delta-only bound turns, and checkpoint compaction.
* [Provider runtime](provider-runtime.md) - Loopback OpenAI-compatible provider that sends prompts to an upstream webchat through local Chrome.
