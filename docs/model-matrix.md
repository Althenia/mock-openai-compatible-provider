# AIPass model and Processing matrix

## Source and verification rules

- Executable master data: [`MODELS` in src/model-catalog.ts](../src/model-catalog.ts).
  Existing `src/config.ts` consumers use the same exported catalog.
- The provider consumes that TypeScript master data, not this Markdown file.
  [`src/model-catalog.test.ts`](../src/model-catalog.test.ts) checks that this
  review table has exactly the same IDs, names, order, and configured variants.
  IDs below are existing provider IDs, not newly verified backend wire IDs.
- This table includes all twenty configured models. **Configured** capabilities
  are not automatically **live-verified** capabilities.
- Live checks below are from the English webchat on September 8, 2026. Expanded
  settings were inspected for all twenty models, and every available Processing
  dropdown was opened and its labels read. All twenty match the configured matrix:
  nine have Processing and eleven do not. This is capability inspection, not
  twenty-model chat acceptance.
- The catalog inspection recording is retained locally, not distributed with
  releases; no chat was submitted during that inspection pass.
- `—` means the provider catalog defines no Processing variants. Live absence
  is established only where the verification column explicitly says so.
- Selection must verify the requested Processing display, picker closure, and
  composer model before a prompt is submitted. See the
  [v0.1.2 release boundaries](releases/v0.1.2.md).

| Model ID | Model name | Configured Processing variants | Live UI verification |
|---|---|---|---|
| `gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | — | Expanded settings: no Processing |
| `gemini-3.7-flash` | Gemini 3.7 Flash | low, medium, high | Dropdown: Low, Medium, High |
| `gemini-3.1-pro-preview` | Gemini 3.1 Pro (Preview) | low, medium, high | Dropdown: Low, Medium, High |
| `claude-sonnet-5@default` | Claude Sonnet 5 | low, medium, high | Dropdown: Low, Medium, High |
| `claude-opus-5@azure` | Claude Opus 5 | low, medium, high, max | Dropdown observed: Low, Medium, High, Max; no chat sent |
| `gpt-5.6-terra` | GPT-5.6 Terra | low, medium, high | Dropdown observed; Low and High applied and chatted |
| `gpt-5.6-sol` | GPT-5.6 Sol | low, medium, high | Dropdown observed: Low, Medium, High; no chat sent |
| `DeepSeek-V3.2` | DeepSeek V3.2 | — | Expanded settings: no Processing |
| `grok-4.3` | Grok 4.3 | low, medium, high | Dropdown: Low, Medium, High |
| `qwen3-next-80b-a3b-instruct-maas` | Qwen3-Next | — | Expanded settings: no Processing |
| `glm-5.2` | GLM 5.2 | — | Expanded settings: no Processing |
| `Kimi-K2.7-Code` | Kimi K2.7 Code | — | Expanded settings: no Processing |
| `sonar` | Sonar | — | Expanded settings: no Processing |
| `sonar-reasoning-pro` | Sonar Reasoning Pro | low, medium, high | Dropdown: Low, Medium, High |
| `Llama-4-Maverick-17B-128E-Instruct-FP8-1` | Llama 4 Maverick | — | Expanded settings: no Processing |
| `Llama-4-Scout-17B-16E-Instruct-1` | Llama 4 Scout | — | Expanded settings inspected: no Processing; Select/Confirm and chat observed |
| `minimax-m2-maas` | MiniMax M2 | — | Expanded settings: no Processing |
| `Mistral-Large-3` | Mistral Large 3 | — | Expanded settings: no Processing |
| `Mistral-Medium-3` | Mistral Medium 3 | — | Expanded settings: no Processing |
| `pathumma-thaillm-8b` | Pathumma ThaiLLM 8B | low, medium, high | Dropdown: Low, Medium, High |

## UI label evidence

| Canonical value/control | English | Thai | Evidence boundary |
|---|---|---|---|
| Processing row | Processing | การประมวลผล | English direct run; earlier Thai inspection |
| Processing accessible button name | Thinking | คิดวิเคราะห์ | Name omits the selected value; verify visible text separately |
| `low` | Low | ต่ำ | Terra options observed in both locales |
| `medium` | Medium | ปกติ | Terra options observed in both locales |
| `high` | High | สูง | Terra options observed in both locales |
| `max` | Max | สูงที่สุด | English Opus dropdown observed; Thai label verified in the loaded webchat translation bundle, not a Thai Opus chat |
| Confirm | Confirm | ยืนยัน | Scoped to the requested model card |
| Select | Select | เลือก | Normal collapsed-card selection |
| More settings | More settings | ตั้งค่าเพิ่มเติม | Opens expanded model settings |

Do not derive capabilities from model-family names, assume Sol supports Max,
or treat an absent/late dropdown as a list of buttons from the main picker.
