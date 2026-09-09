# Architecture

* [Browser transport](browser-transport.md) - Playwright-driven installed Chrome with a persistent profile, PID-identified lock, and temporary-chat entry.
* [Prompt projection](prompt-projection.md) - Preserve-mode startup turns, action-only opt-out, checkpoint compaction, and token estimation.
* [Provider runtime](provider-runtime.md) - Loopback OpenAI-compatible provider that sends prompts to an upstream webchat through local Chrome.
