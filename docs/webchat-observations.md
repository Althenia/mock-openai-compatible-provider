# AIPass backend observations for a later client audit

Observed 2026-09-07. **This is an evidence handoff, not a claim that all client issues are fixed.** The observation phase used Playwright MCP after the browser-tool boundary was clarified. No client production code or user OpenCode configuration changed during that phase. The subsequently approved fix phase changed the default temporary-chat URL and repaired the local OpenCode catalog. Its OpenCode-specific configuration command was later removed at the user's request; model configuration remains in OpenCode, not the generic provider. See the [implementation ledger](../.memory/aipass-webchat/ledger.md#approved-fix-acceptance-and-ownership) and its reversal record. The picker is not fixed; the later post-login recording below isolates a wrong-control mechanism.

**September 8 follow-up:** a [fresh direct interaction run](../.memory/aipass-webchat/run-2026-09-08.md) exercised native English/Thai selection, Confirm, keyboard activation, settings re-entry, and two synthetic responses. Those interactions worked with a visible page. The existing production-shaped Confirm locator also succeeded; a rapid nested-menu sequence failed earlier at Low. These observations refine the earlier diagnostic contrast but do not establish the original timeout's cause. See E22–E27 in the ledger and the [reusable scenario design](../.memory/aipass-webchat/scenarios.toon).

**Post-login actual-client recording:** the rebuilt provider reached the picker and reproduced the confirmation deadline. A separate existing-code selection probe recorded trusted clicks on Terra, Thinking, then **Close**, with no Low or Confirm click. Its last-dialog lookup had selected the main picker's buttons before a Thinking popover was available. See the [recorded diagnosis](../.memory/aipass-webchat/run-2026-09-08-post-login.md), E28–E30, and the privacy-cropped video links there. The popover's absence remains unexplained; no production correction or live tool-flow pass is claimed.

Evidence IDs refer to the [observation ledger](../.memory/aipass-webchat/ledger.md). The [resume memo](../.memory/aipass-webchat/memory.md) is deliberately terse and must be revalidated on resume. Raw account data, credentials, conversation/message identifiers, encrypted provider metadata, and browser-profile contents are not retained here.

## 1. Terminology and trust boundary

- **Client:** this repository. It presents an OpenAI-compatible provider interface, translates requests, observes the backend, and returns responses to its caller. Real requested actions belong to the client-side dispatcher/calling harness, not to generated assistant prose.
- **Backend:** the AIPass webchat assistant surface used by the client. In this workflow it supplies assistant responses, including text that may request an action.
- An assistant JSON object naming a tool is **not evidence of execution**. Execution requires a valid request, an authorized client dispatch, an observed result, and correct continuation attribution.
- This is the intended boundary of the inspected text workflow, not a claim that every feature in the backend's broader UI is assistant-only. The picker also exposes image, video, music, and research products; they were not exercised.

The statement “the gaps are all in crawling” remains a hypothesis. The observations distinguish three layers: backend output, rendered DOM, and browser automation. Each can fail independently.

## 2. What was actually demonstrated

| Observation | Result | Evidence |
|---|---|---|
| Direct temporary-chat entry | Thai and English UI showed temporary mode without clicking the toggle | E06, E10, E16 |
| Profile language change | Thai → English persisted across navigation; Thai was restored afterward | E09, E16 |
| Exact Terra identity | Visible name `GPT-5.6 Terra`; accessible trigger name duplicates it because the image has the same name | E02, E10 |
| Reasoning selection for a sample | UI selected Low; native request contained `modelId: gpt-5.6-terra` and `thinkingLevel: low` | E11, E14 |
| Multiline composer input | Five lines, 499 characters; no pre-submit message; one explicit send produced one new user/assistant pair | E12, E14 |
| Strict action-envelope output | **Failed:** native response changed the synthetic correlation key; DOM also omitted the envelope delimiters | E13, E14 |
| Bilingual plain-text response | Paragraph `textContent` preserved English, Thai, and the newline; `innerText` collapsed that newline into a space | E15 |
| Completion evidence | Both observed native responses had terminal finish/stop and `[DONE]`; current assistant feedback controls were present | E14, E15 |
| Real client action or complete agent loop | **Not exercised.** No real tool was dispatched | E12–E15 |
| Production model-confirmation failure | Reproduced before this documentation phase; exact root cause remains open | E01 |

These are isolated observations, not reliability statistics or all-model acceptance.

## 3. Initialization and temporary mode

Direct navigation to `https://de.aipass.net/chat?temporary-chat=true` produced:

- `Temporary Chat` in English / `แชทชั่วคราว` in Thai;
- an available composer and model picker;
- native sample submission with `isTemporary: true`;
- a notice that the chat is absent from history, **but copies may be retained for up to 30 days**.

Do not document temporary chat as “no retention.” The UI and request flag were observed; server-side retention was not audited.

After the two synthetic turns, returning through profile settings to the direct temporary URL showed zero current user/assistant messages. This demonstrates a fresh UI entry in that sequence, not deletion or a retention guarantee. The address-bar route did not identify the native conversation: both sample requests used the same opaque conversation segment under `/actions/send-message/<conversation>`. Do not store that identifier in ordinary documentation.

**Later audit questions:**

1. Can new unbound turns land directly in temporary mode instead of clicking the toggle?
2. Does recovery distinguish a fresh temporary conversation from a bound continuation?
3. Are custom configured chat URLs and legitimate existing bindings preserved rather than blindly rewritten?
4. Is actual submission mode checked separately from an icon or URL-only heuristic?

Relevant client entry points: `src/config.ts` (`DEFAULT_CHAT_URL`, `parseCommand`), `src/browser.ts` (`ensureTempChat`, `PlaywrightBrowserAdapter` navigation/recovery), and `src/browser-setup.test.ts`. These are audit targets, not an approved change list.

## 4. Verified language and model controls

Profile path: `/settings/profile`. Open the profile through `user-menu-trigger`, then the language setting. The language dialog contains two visible radio choices plus aria-hidden native counterparts; counting all radios would overcount the choices. A confirmation action applies the chosen locale.

| Control/state | Thai UI | English UI |
|---|---|---|
| Profile language button | `ภาษา` | `Language` |
| Language dialog heading | `เลือกภาษา` | `Select language` |
| Locale choices | `ไทย`, `EN` | `ไทย`, `EN` |
| Confirm | `ยืนยัน` | `Confirm` |
| Temporary-mode heading | `แชทชั่วคราว` | `Temporary Chat` |
| Composer placeholder | `ถามได้เลย` | `Just ask` |
| More model settings | `ตั้งค่าเพิ่มเติม` | `More settings` |
| Select model | `เลือก` | `Select` |
| Thinking control | `คิดวิเคราะห์` | `Thinking` |
| Processing text inside thinking control | `การประมวลผล` | `Processing` |
| Thinking choices for Terra | `ต่ำ`, `ปกติ`, `สูง` | `Low`, `Medium`, `High` |
| Output style | `สไตล์การตอบ` | `Output Style` |
| Output format | `รูปแบบ` | `Output Format` |

Observed model identity is not localized: **`GPT-5.6 Terra`**, not a guessed model generation or another product's “Thinking” model. Its trigger accessibility snapshot reads `GPT-5.6 Terra GPT-5.6 Terra`: image alt text plus visible text. Matching only the single-name accessible string failed during inspection. The existing client accommodates a doubled model name; this is not itself a newly proven client defect.

Observed structural hooks:

| Hook | Observed purpose | Caution |
|---|---|---|
| `data-testid="model-selector-trigger"` | Composer model picker | Accessible name includes the model image |
| `data-testid="model-selector-modal"` | Main model dialog | Distinguish it from other dialogs |
| `data-testid="model-card"` | Model card | Aggregate accessible name includes settings and descriptive text |
| `data-testid="thinking-level-trigger"` | Expanded card's thinking control | Scope to the intended card |
| `data-slot="popover-content"`, `role="dialog"` | Thinking-choice popover | A closed/ending node remained in the DOM and CSS-visible |
| `data-testid="output-tone-trigger"` | Output-style control | Observed, not changed |
| `data-testid="output-format-trigger"` | Output-format control | Observed, not changed |
| `data-testid="user-menu-trigger"` | Profile menu | Avoid capturing account details |
| `data-testid="send-button"` | Composer send control | Disabled state alone is not a response identity check |

These are observed hooks, not a promised backend API. Verify both locales and UI states in fixtures before selecting a production locator. Avoid relying only on dialog order, nested-button index, aggregate accessible name, or one language's label.

The backend picker contains products beyond the client's text catalog. Image alt text also appeared more than once for some cards. Neither all image labels nor every visible product should automatically become a client model ID.

## 5. Hanging/actionability evidence

Two separate facts must not be conflated:

1. The production Terra/low selector reached `confirmation` at approximately 1.7 seconds, then hit its overall 20-second deadline (E01). The supplied diagnostics and reproduction locate the failure stage but do not establish its cause.
2. During MCP inspection, native clicks timed out while waiting for visible/enabled/stable. A separate probe found `document.visibilityState === "hidden"`, no focus, and zero animation-frame callbacks over a roughly 1.3-second timer window. Dialog transition-start markers remained. After selecting Low by an enabled-element DOM click, a closed/ending popover was still CSS-visible beside the open main dialog (E04, E05, E11).

A bounded DOM `.click()` successfully changed several controls when native click actionability stalled. **That is a diagnostic contrast, not an approved fix.** DOM activation does not prove pointer hit-testing, stable geometry, unobstructed controls, or correct native cancellation. Disabled checks were retained during those diagnostic activations.

For the later audit, reproduce the picker lifecycle in a controlled visible/hidden fixture and distinguish:

- control truly absent;
- wrong model/card/dialog scope;
- an ending popover still matching a generic dialog selector;
- paused animation frames or transition lifecycle;
- native actionability or transport callback delay.

Do not lengthen deadlines, force clicks, or replace native clicks globally merely to make a probe finish. After a timeout or interruption, inspect state before any repeat: launch/timeout does not prove either success or zero effects. Scoped MCP snapshots also invalidated older element refs; use the latest scoped ref or a newly verified unique selector.

## 6. Composer, wire text, DOM text, and action requests

### Synthetic action-envelope sample — negative acceptance

A five-line synthetic prompt asked the backend to emit a keyed `aipass-envelope` requesting a nonexistent read-only fixture tool. It explicitly did not ask the backend to access files. No real action dispatcher was connected.

Observed boundaries:

1. MCP `fill` preserved five composer lines and did not submit early.
2. An explicit send produced one native POST with one user message containing the intended multiline prompt and original synthetic key. The request selected Terra/low and temporary mode.
3. Native text deltas contained the opening and closing envelope tags, **but had already replaced the synthetic key's characters with asterisks**. The responsible backend layer is unknown; this observation does not distinguish model behavior from backend filtering.
4. Rendered assistant text contained neither literal envelope delimiter. Its synthetic key did not equal the original. The number/appearance of asterisks also differed from the native text representation.
5. Therefore strict request attribution failed **before any client action could legitimately execute**. Do not repair this by accepting a mismatched key or treating tool-shaped JSON as execution proof.

This separates a source-output problem from a rendering difference. It contradicts the stronger claim that every mismatch must originate in the crawler.

### Bilingual plain-text sample — extraction difference

The second, independent text-only prompt requested:

```text
English: 7
ไทย: เจ็ด
```

The newest assistant paragraph's `textContent` was exactly those two lines. Its `innerText` was `English: 7 ไทย: เจ็ด`, with a space instead of the newline. Extracting the whole assistant container also included feedback-control text, so it was not equivalent to answer content.

The MCP native-response export showed garbled Thai characters while the browser DOM showed correct Thai. **Raw-byte encoding was not verified.** Treat this as an observation/export ambiguity, not evidence that the backend transmitted invalid UTF-8. The native export still showed a newline between the two lines. Do not use a text export as byte-integrity proof.

### Completion and reasoning

For each of the two observed responses:

- a new user message and assistant message appeared;
- the composer cleared;
- current assistant controls contained Copy message, Like, Dislike, and Refresh;
- the native stream finished with `finishReason: "stop"` and one `[DONE]`;
- native reasoning start/end events were present, but **no plain reasoning-delta text was observed**. Encrypted provider metadata was not decoded or retained in these notes;
- no token-usage values were established. No cost, cache-hit, or quota exemption is inferred.

These controls and terminal events concern completion, not the correctness or provenance of an action envelope. The samples do not validate native reasoning display, Meta Llama reasoning, real tool execution, cancellation, or all-model behavior.

Later audit targets: `src/browser.ts` DOM readers/capture, `src/protocol.ts` text/envelope parsing, `src/runtime.ts` turn-key validation and action attribution, plus their existing DOM, response, reasoning, and envelope-chain tests. Preserve source-channel distinctions and required usage/reasoning reporting.

## 7. OpenCode: independent client configuration finding

OpenCode 1.18.29 builds a custom OpenAI-compatible provider catalog from `provider.<id>.models`; it does not automatically import this client's `/v1/models`. A two-entry configuration listed two models while the provider was offline. A nonpersistent overlay from the canonical client catalog listed twenty. An authenticated in-process `/v1/models` probe returned list/20; an unauthenticated probe returned 401 (E08).

This is not proof that the provider was offline during the original failure. Nor does it justify changing endpoint authentication or silently inventing context limits. No OpenCode configuration was edited in this phase.

Sources: [custom model construction](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/provider/provider.ts#L1477-L1571), [discovery invocation](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/provider/provider.ts#L1653-L1665), and [custom-provider documentation](https://opencode.ai/docs/providers/#custom-provider).

## 8. Rechecked reference: `chatgpt-use`

Rechecked reference commit: [`89634b2175ca6faafcfa3e6a8d9379bd95e9458d`](https://github.com/leeguooooo/chatgpt-use/tree/89634b2175ca6faafcfa3e6a8d9379bd95e9458d). The reference's “live-verified” claims were **not reproduced** here. Use its cases as audit inputs, not evidence that AIPass passes them.

| Useful case/example | Transfer to a later client audit | Reference |
|---|---|---|
| Insert `alpha\nbeta\nγ` without submitting individual lines | Assert exact payload integrity and exactly one explicit submit. The reference's normalized character-count check is weaker than byte equality. | [Insertion](https://github.com/leeguooooo/chatgpt-use/blob/89634b2175ca6faafcfa3e6a8d9379bd95e9458d/src/channel.rs#L143-L165), [verification](https://github.com/leeguooooo/chatgpt-use/blob/89634b2175ca6faafcfa3e6a8d9379bd95e9458d/src/channel.rs#L459-L475) |
| Parse JSON rendered from a code block, not only literal Markdown fences | Compare native text and rendered text; preserve the client's own strict envelope/key contract rather than copying permissive fallback behavior. | [Parser](https://github.com/leeguooooo/chatgpt-use/blob/89634b2175ca6faafcfa3e6a8d9379bd95e9458d/src/protocol.rs#L149-L235) |
| Enter was issued but receipt is ambiguous | Do not replay a potentially submitted prompt. A fallback must be conditional and cannot create duplicates. | [Submission](https://github.com/leeguooooo/chatgpt-use/blob/89634b2175ca6faafcfa3e6a8d9379bd95e9458d/src/channel.rs#L478-L510) |
| An old assistant reply exists while the new composer clears | Require current-turn evidence; never return the old answer as the new completion. | [Failure cases](https://github.com/leeguooooo/chatgpt-use/blob/89634b2175ca6faafcfa3e6a8d9379bd95e9458d/docs/failure-semantics-corpus.md#L33-L46) |
| A pinned conversation drifts or a tab disappears | Distinguish pre-submit fresh setup, post-submit observation, and recoverable identity; do not silently start a different conversation. | [Identity/reconnect](https://github.com/leeguooooo/chatgpt-use/blob/89634b2175ca6faafcfa3e6a8d9379bd95e9458d/src/channel.rs#L752-L805) |
| Two clients share one composer | Test serialization and lock failure explicitly. The reference proceeds without serialization on certain advisory-lock failures, so its guarantee is conditional. | [Turn boundary](https://github.com/leeguooooo/chatgpt-use/blob/89634b2175ca6faafcfa3e6a8d9379bd95e9458d/src/channel.rs#L628-L657), [lock behavior](https://github.com/leeguooooo/chatgpt-use/blob/89634b2175ca6faafcfa3e6a8d9379bd95e9458d/src/channel.rs#L1200-L1249) |
| Requested model selector is missing | Fail the requested selection rather than silently use the account default. Do not transplant the reference's legacy labels. | [Fail-closed caller](https://github.com/leeguooooo/chatgpt-use/blob/89634b2175ca6faafcfa3e6a8d9379bd95e9458d/src/channel.rs#L370-L390), [legacy selector](https://github.com/leeguooooo/chatgpt-use/blob/89634b2175ca6faafcfa3e6a8d9379bd95e9458d/src/channel.rs#L1024-L1098) |
| Provider-compatible serving around an assistant backend | Keep transport, assistant text, and client dispatch separate. Its `/v1/models` is a one-entry stub, not web-model discovery or an OpenCode solution. | [Models stub](https://github.com/leeguooooo/chatgpt-use/blob/89634b2175ca6faafcfa3e6a8d9379bd95e9458d/src/cmd/serve.rs#L478-L516) |

The reference explicitly reports its model picker broken after UI relabeling. Its source also contains an older “best-effort/default” comment contradicted by the fail-closed caller. Its serving PoC [retransmits the whole transcript](https://github.com/leeguooooo/chatgpt-use/blob/89634b2175ca6faafcfa3e6a8d9379bd95e9458d/src/cmd/serve.rs#L196-L204); that is not a verified replacement for this client's session/continuation design. Do not import its billing, quota, connector, UI, or provider-cache assumptions.

## 9. Audit acceptance cases to design next — not yet run

1. Thai/English model selection with exact model ID and supported thinking level; missing/disabled controls fail without late clicks.
2. Visible versus hidden page, paused transitions, ending popover, rerendered card, and duplicate accessible model name under one bounded selection deadline.
3. Direct temporary initialization, changed mode, bound continuation, and recovery without unintended history or wrong-conversation submission.
4. Multiline/Unicode composer payload, exact native bytes, current user receipt, and no duplicate submission after ambiguous failure.
5. Native text versus DOM text for angle-bracket envelopes, asterisks, code fences, literal newlines, feedback labels, and truncated output.
6. Correct/wrong/missing correlation key, offered/unoffered action, actual authorized client dispatch, result continuation, and final answer. Invalid native output must not be hidden by a “successful” DOM completion.
7. Per-model reasoning/usage channels, cancellation, stream termination, and resource cleanup. Start/end markers or encrypted metadata alone are not reasoning prose.
8. OpenCode configured catalog and provider readiness separately from backend selection and assistant-response quality.

No broad reliability, production-readiness, or completed-fix claim is supported by this observation set.

## 10. Serial-startup candidate — actual YCoding run, 8 September 2026

A later bounded run used installed YCoding `run --standalone`, AIPass 0.1.3
working source, and Terra/low. An isolated read-only agent could only read a
synthetic `notes.txt`; it could not edit files or delegate. Normal client/provider
configuration and installed executable hashes were unchanged.

| Approximate recording time | Native submission |
| --- | --- |
| 00:07.16 | Adapter role/protocol startup |
| 00:19.66 | Caller instruction startup, including supplied agent/workspace context |
| 00:33.99 | Task with current action schema and conversation |
| 00:44.20 | Continuation with the client's read result |

Both startup strings and the first task matched the request projection exactly.
All four native responses had terminal completion evidence. The client event
stream recorded a completed `read` of `notes.txt`, then final text matching its
synthetic content (ignoring surrounding whitespace); the client exited zero.
This establishes one real-client read/result/final cycle, not all-tool or
all-model reliability. The client bundled its supplied context in one instruction
message, so this run does not separately demonstrate multiple caller-message
boundaries; local regression tests cover that case.

Raw capture, client events, and uncensored video remain private local evidence.
The review copy removes the sidebar and masks outgoing prompt/composer regions
because those include local paths. Exact-content assertions come from the native
capture, not from legibility of masked text. No recording is included in public
documentation output.

After completing the regression-fixture fixes and an unfiltered 485-test passing
run, a fresh actual-client recording repeated this flow. Native submissions were
at approximately 00:06.06, 00:20.04, 00:34.84, and 00:47.20. Both startup payloads
and the first task again matched their projection; the read completed, final text
matched the synthetic fixture, all four responses completed, and YCoding exited
zero. The redacted review copy completed Chrome playback at 55.28 seconds with
1,386 decoded frames and no media error. This repeat does not broaden the tested
model, tool, or permission scope.
