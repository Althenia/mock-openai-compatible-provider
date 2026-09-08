# Webchat user journeys

This is the behavior reference to establish **before** changing provider event
handling. It records direct webchat use, not an assumption that automation or
the OpenAI-compatible client already works.

## Evidence and scope

- Direct browser run: September 8, 2026, English UI, an initially empty
  temporary chat. No navigation or new chat occurred between its three messages.
- [Video review page](../output/playwright/direct-processing/review.html) and
  [direct-run recording](../output/playwright/direct-processing/review.webm)
  contains both successful interactions and a failed mid-session click attempt.
- Review copies crop the sidebar. The direct run is 6 minutes 23.2 seconds;
  capture is sampled at 5 fps, not frame-accurate click evidence.
- [Model/variant matrix](model-matrix.md) separates current provider catalog
  values from capabilities verified in the live UI.
- Earlier English/Thai observations and limitations:
  [webchat observations](webchat-observations.md).
- These checks do not establish actual-client tool execution, quota accounting,
  all-model chat reliability, or remote retention/deletion behavior.
- Account, billing, deletion, and other destructive actions are not exercised.

## 1. Select a model with a Processing variant

1. Open the model picker from the composer.
2. Locate the requested model's card by its exact model name.
3. If the card is collapsed, open **More settings**. If already expanded, do
   not toggle another control just because it occupies a particular index.
4. Bring the whole **Processing** row into view and let scrolling finish before
   opening it: the live picker dismisses popovers when the surrounding container
   scrolls. Click that card's **Processing** row. Its English accessible button name
   is **Thinking**, not Processing; the visible row shows Processing and its
   current value.
5. Wait for that trigger's dropdown to open. In the recorded English run,
   `aria-controls` identified its popup, and the popup had
   `data-slot="popover-content"` and `data-open`.
6. Read the current value before changing it. If already correct, do not select
   it again: the live component toggles the current option off on reselection.
   Otherwise select the requested option by its visible label, not its button index.
7. Verify the **Processing display inside the same model card** shows the
   requested option. Merely observing a click or a closed dropdown is insufficient.
8. Click **Confirm** inside that model card.
9. Wait until the main model picker is hidden/removed. Verify the composer
   model name is the requested model before beginning the next chat turn.

**Observed:** GPT-5.6 Terra offered Low, Medium, High. Selecting Low produced
`Processing Low`; Confirm closed the picker. The subsequent prompt received
`DIRECT-LOW-OK`.

## 2. Change a variant in the middle of a conversation

Use the same sequence above without navigating away or creating a new chat.
Reopen the current model card, read the existing Processing value, choose the
new value, verify it, Confirm, and verify picker closure before sending.

**Observed:** in the same temporary conversation, Terra's display initially
showed Low. A native High click first failed because the option became unstable,
was obstructed, and detached. Inspection afterward showed Low still selected,
the main picker open, no popup, and an empty composer. No second prompt was sent
on that failed attempt.

After inspecting state, clicking the visible Low value opened the dropdown.
A subsequent native High click changed the display to `Processing High`.
Confirm closed the picker. Asked for the word from the first message, the
webchat replied `orchard`.

This proves the successful sampled journey with conversation continuity, not
that rapid automation is reliable. The later implementation investigation found
a live scroll-dismissal handler and reproduced a clipped-row failure. This does
not prove every earlier disappearance had the same cause. Do not blindly retry a
toggle after a timeout: inspect current state.

## 3. Select a model without Processing

Do not require or invent a Processing dropdown for every model.

- **Collapsed card:** use that model's **Select** action, then verify picker
  closure and the composer's model name.
- **Expanded settings:** inspect the controls. If there is no Processing row,
  do not wait for one or select a positional substitute. Use the card's
  **Confirm** action, then verify closure and the selected model.

**Observed:** Llama 4 Scout's expanded settings contained Output Style and
Output Format but zero `thinking-level-trigger` controls. Confirm closed the
picker and the composer showed Llama 4 Scout. A later collapsed-card Select
also closed the picker and selected Llama 4 Scout.

## 4. Change models in the middle of a conversation

Open the picker in the existing chat and use the new model's applicable
Processing or no-Processing journey. Confirm/Select and closure checks are
required on every change, not only the first turn. Do not carry the previous
model's variant into a model that does not support it.

**Observed:** Terra/High was changed to Llama 4 Scout without creating a new
chat. After Confirm and picker closure, the next reply was
`orchard MODEL-SWITCH-OK`, retaining the earlier synthetic word.

## 5. Inspecting settings is not necessarily side-effect free

While inspecting Sol and Opus, More settings was opened without sending a
message. After dismissing the Opus dropdown and closing the main picker with
Close, the composer showed **Claude Opus 5**, despite no Opus Confirm click in
that inspection sequence. Therefore **Close is not proven to cancel/revert a
model choice**, and the composer model name alone does not prove that the
requested Processing value was applied or that Confirm occurred.

The direct run subsequently selected Llama 4 Scout normally and verified closure.

## 6. Chat after selection

Only proceed after the requested setting and picker closure are verified.
Fill the composer, explicitly send, and observe the resulting reply. A filled
composer is not a submitted message; a successful selection is not a reply.

The direct run sent three synthetic messages and observed these replies:

| Turn | Model / Processing | Observed reply |
|---|---|---|
| 1 | GPT-5.6 Terra / Low | `DIRECT-LOW-OK` |
| 2 | GPT-5.6 Terra / High | `orchard` |
| 3 | Llama 4 Scout / no Processing | `orchard MODEL-SWITCH-OK` |

This was direct webchat interaction, **not YCoding or a tool-call test**.

## Production selection validation after the fix

The [33-second cropped recording](../output/playwright/selection-activation/review.html)
and [stage results](../output/playwright/selection-activation/result.json) cover
the production `selectModel` and `PlaywrightModelSelectionSurface` on Bun 1.4.2.
The harness used the existing temporary conversation without navigation. Older
synthetic messages remain visible; it waited for a **new** matching reply after
each send, not a matching response left by an earlier attempt.

| Step | Verified outcome |
|---|---|
| Terra blank Processing → Low | Low verified, Confirm, picker closed; new `FIXED-LOW-OK` reply |
| Terra Low → High | High verified, Confirm, picker closed; new `orchard FIXED-HIGH-OK` reply |
| Terra → Llama 4 Scout | No Processing popup; Select and picker closure; new `orchard FIXED-MODEL-OK` reply |
| Llama → Terra High | High applied, verified, Confirm, picker closed; no fourth prompt |
| Terra High → High | Existing correct value retained without clicking the option again; Confirm and closure |
| Terra High → `none` | Current High option toggled off; blank Processing verified; Confirm and closure |

The option is found by its exact master-data label inside the popup identified
by the requested card's expanded trigger. The provider waits for visibility and
uses a guarded DOM `HTMLButtonElement.click()` on that enabled option. This is
**programmatic button activation, not a trusted native pointer click**. The
Processing trigger and Confirm/Select still use native pointer actions. Display
verification remains mandatory; no application state is assigned directly.

This choice follows failed native-pointer attempts that scrolled the picker and
dismissed the popup before option activation, plus native Enter/Space attempts
that left the value unchanged. Full-row scrolling and geometry-settling alone
did not resolve every recorded failure. The final implementation does not retain
the experimental delay, keyboard path, or automatic retries.

This proves the sampled production-selection journey and direct replies, **not
an actual YCoding/provider API/tool-call round trip**. The adapter's retained-session
fixture separately checks that prompt filling and sending occur only after
verified selection and closure. Cancellation blocks subsequent stages and the
adapter retires failed/cancelled pages; an already-dispatched atomic browser
activation cannot be recalled once it executes.

## Journey coverage still required

| Journey | Status |
|---|---|
| Initial model + Low selection, Confirm, closure, reply | Observed directly |
| Same-model Low → High mid-conversation | Observed after a failed native attempt and state inspection |
| Mid-conversation switch to model without Processing | Observed directly with recalled context |
| No-Processing collapsed Select and expanded Confirm | Both observed on Llama 4 Scout |
| All configured models' Processing capability/options | All twenty inspected in English; nine with Processing, eleven without; see model matrix |
| Model switch between two Processing-capable models with a reply | Not exercised in this run |
| Clear an already-set Processing value / explicit API `none` on a thinking model | Terra High → blank Processing observed in the later production-selection run; blank display is not proof of backend reasoning internals |
| English/Thai variant labels for every model, including Max | Partially observed; not a complete bilingual matrix |
| New temporary chat resets versus reopened existing chat | Earlier observations only; not repeated in this run |
| Output Style / Output Format changes and persistence | Earlier observations only; not repeated in this run |
| Stop generation, retry/regenerate, and error recovery | Not exercised in this run |
| Actual YCoding conversation and tool calls after the fix | Not yet validated |

Implementation and master data must not label these remaining journeys as
verified merely because a fixture passes.
