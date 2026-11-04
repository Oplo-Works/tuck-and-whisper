# Tuck and Whisper

**You missed the moment. You don't have to miss the story.**

*Bedtime, in the language your family speaks at home.*

A PWA bedtime handoff for families. A parent adds a memo and an optional photo or voice recording, reviews source passages, and chooses which confirmed details to use. From those selected details, the app prepares:

1. A short briefing for the parent who missed the day.
2. A contextual recall question that the parent can edit.
3. A reading page that preserves the selected memo wording, with optional parent-reviewed artwork.

The child's bedtime answer is written down by the parent and saved as testimony, never promoted to fact.

Built entirely during the Meta Global AI Developer Hackathon (Oct 30 – Nov 4, 2026). Vanilla JS, zero runtime dependencies.

## UI update — mobile whisper (shell v33)

The phone layout keeps the night sky, moon logo, reading typography, and generous memo field while removing redundant rows. Language/theme controls now live in an accessible settings sheet beside the brand. Draft save status sits beside the screen heading; book-save feedback stays beside the save action. Review metadata shares a row, selected decisions no longer glow, and the smaller review action bar sits outside the content card. Question fields grow with their text. Photo-free reading has one explanation instead of a disabled illustration button and repeated notices. The library uses full-width rows with small saved-artwork covers, an empty-state capture action, and collapsed record management. Saved-reading dialogs put export details after the story and keep their close control accessible.

Mobile sizing supports 320/360/390/430 CSS-pixel widths, safe-area insets, dynamic viewport heights, and a shortened viewport while typing. Dialogs restore focus explicitly across Chromium and WebKit. No storage schema, model request, confirmation/inclusion contract, or export content contract changed. Release: `taw-shell-v33`, footer `build: mobile-whisper (shell v33)`.

Validation: 48 core + 39 Node + 68 Chrome browser checks passed. `npm run test:mobile` runs eight additional mobile-emulation cases across Chromium and WebKit; install WebKit first with `npx playwright install webkit`. The suite checks settings focus, four phone widths, touch-target sizes, growing question fields, text-only reading, single-column library rows, and reachable dialog controls. These are browser-engine/emulation checks, not physical iPhone/Android device certification; model responses are mocked. At 390px the first card starts at 233px instead of 382px, with the memo height and reading line spacing retained.

## Previous UI update — moonlit whisper (shell v32)

The default for a first visit is now Dusk: a static starry navy sky, a soft rose/lavender horizon, a warm moon logo, opaque violet cards, and softly glowing pastel action buttons. Active navigation has a matching glow and underline; disabled actions have no glow. The background uses CSS only, with no new assets, runtime dependencies, or animation. Existing Paper/Dusk preferences are respected, and the manual switch remains available. The installed-app colors and offline shell are updated together (`taw-shell-v32`).

The capture, review, reading, and library screens share the palette. Workflow logic, source passages, model requests, and stored records are unchanged.

Validation: `npm test` passed 48 core checks, 39 Node integration checks, and 64 browser checks. Browser checks cover both themes' selected AA text-color pairs, 320/390/1280px layouts, manual-theme persistence, and the existing reading/storage workflow with mocked model responses. Capture, reading, and library screenshots were also visually reviewed.

## Previous UI update — warm paper (shell v28)

The design update adds warm paper and manually selected dusk themes, labeled line icons, a four-step navigation bar, explicit review/inclusion states, larger reading typography, and library covers drawn only from artwork already saved with a book. The selected theme is a browser preference; time and workflow navigation never change it automatically. Fact selection, literal source passages, briefing content, model requests, and the storage schema are unchanged.

Capture labels and next actions are shorter. The audio replacement warning stays visible, photo-free reading remains explicit, and clearing a draft distinguishes the complete current draft from all saved books that remain. Library thumbnails do not persist original photos. Privacy details and audit history remain available in expandable sections.

Validation: 48 core checks + 39 Node integration checks + 64 browser checks passed. The final library button-color adjustment was followed by a passing rerun of the five v28 browser cases. New checks cover manual-theme persistence during an in-flight extraction, four review states, saved-artwork covers after reload, selected AA text-color combinations, and 320/390/1280px layouts. Browser model responses are mocked; these results do not certify live model quality or a complete accessibility audit. The release is identified by cache `taw-shell-v28` and footer `build: warm-paper (shell v28)`.

## Reviewed workflow (v17)

The new workflow separates confirmation from story inclusion. Confirm only the memo passages you need; unopened photo observations remain unused. Confirmed cards have a **Use in this story** checkbox. Photo observations, when explicitly used, appear separately in a collapsed source section, not woven into the memoir.

1. Enter a memo (photo optional), or explore the synthetic sample.
2. Confirm source passages; skip anything you do not want to review.
3. Prepare the selected details. The briefing selector proposes IDs only. Story text preserves all selected memo excerpts in source order; no model-written causal links or emotions are accepted.
4. Edit the contextual recall question if desired, then read together.
5. To illustrate a photo, confirm its people/animal connections and review the generated image before using it. Partial identity confirmation does not enable the whole image.

Original photos remain session-only. Text records use transactional IndexedDB, with explicit cross-tab conflict recovery. v1 localStorage is read without overwriting it: prior decisions survive, all new inclusion choices start off, and old generated prose is historical only. New UI copy is reviewed in Korean and English; other languages fall back to English. This is a change to the v15 generation/data contracts, not a cosmetic patch.

### Local books and reading exports (v17)

Use **Save this book on this device** to store a completed text/approved-artwork snapshot. Saved books are explicitly dated snapshots; editing the current day never silently rewrites them. Original photos remain session-only. Individual deletion preserves the current day; delete-all also removes the preserved v1 record. Storage is local to this browser and can be lost through browser cleanup.

**Export reading HTML** previews the exact reading copy, with an optional text-only choice. The self-contained file has no scripts, tracking, or external assets. It includes only the selected story, question and approved artwork, not the original photo, standalone original memo, audit history or child responses. Story excerpts can naturally contain words from the memo. The recipient receives a reading copy, not a complete audit record.

Dependent memo openings such as “왜냐하면” are joined to an adjacent literal source passage before confirmation. This is a narrow, tested Korean/English grouping rule, not a universal semantic classifier. The initial reading mode preserves the parent's wording, including typos; general creative paraphrasing is deliberately deferred.

### Validation

Run `npm ci` then `npm test` (Chrome installed), or `node tests/harness.mjs`. Browser tests stub model calls; they do not certify live model quality, accessibility with a screen reader, or actual parent/child usability. `node tests/ds1-concurrency.test.mjs` runs the five DS-1 concurrency scenarios against the new browser UI. Original v15 harnesses are retained in `tests/legacy-v15/` solely as historical baselines; they are not v2 release evidence.

The older design/cost notes below describe v15 unless explicitly updated. v16/v17 use different requests, so v15 per-night prices are not measurements of this version.

## What It Is & The Problem

A working parent arrives home having missed the day. Asking "How was your day?" usually gets a one-word answer or a shrug. Meanwhile, the parent who was there is exhausted and lacks the energy to write a detailed recap.

Tuck and Whisper creates an intentional bedtime handoff between parents:

- **Low capture burden:** One photo and a ~10-second voice memo from the daytime parent.
- **Grounded conversation:** The returning parent gets a short briefing and exactly one targeted question to ask the child.
- **Shared memory:** The child sees their real day restyled into a bedtime page, and their answer is preserved as testimony.

## How It Works

1. **Capture:** The daytime parent takes one photo and records a ~10-second voice memo. Muse Voice Transcribe 1.0 transcribes the audio.
2. **Fact Candidate Extraction:** Muse Spark 1.3 evaluates the photo and transcript, extracting candidate facts tagged with provenance sources (photo or memo) and risk grades. Unverifiable details are placed into an Unknowns list.
3. **Gate 1 (Parent Triage):** The capturing parent confirms or rejects each fact candidate individually or in batches.
4. **Briefing & Question Card:** From confirmed facts only, the app generates a briefing for the other parent and selects one question card derived from an item the evidence left unresolved (Unknown).
5. **Bedtime Page:** Muse Image 1.0 restyles the real family photo into story art. The accompanying sentences cite confirmed fact IDs.
6. **Child Testimony:** At bedtime, the returning parent asks the question card and writes the child's answer into a one-line testimony note. The child's voice is never recorded by the app, and testimony is never promoted to fact.

## The Confirmation Boundary

Unconfirmed facts cannot reach the child. This guarantee is enforced in deterministic application code, not through model prompts:

- The composition step receives only parent-confirmed facts — the input boundary is a code-level filter, not an instruction to the model.
- Deterministic validation checks every composed sentence: each must cite at least one fact ID, and every cited ID must belong to the confirmed set. A leak-word filter screens for content no confirmed fact supports. Failures retry once, then fall back to rendering the confirmed facts verbatim.
- Flipping any decision (confirm → reject) invalidates the composed briefing and page immediately, and entry guards discard stale compositions — an outdated page is never served as current.

## Counterfactual harness & Verification

The confirmation boundary is not a prompt-time promise — it is re-verified on every build by an automated test harness (`node tests/harness.mjs`), built to be falsifiable: if the boundary were broken, the suite would FAIL. It drives the app with adversarial inputs — an extraction response reusing an old fact ID, NFD-normalized leak bypasses, sentences citing the rejected fact — and judges every served sentence and every synthesis request body against an independent oracle derived from the fixture, never from the app's own validator.

On the recorded v26 baseline (`a0d8f8a`):

- **Test Suite Total: 146/146 PASS**
  - Core unit tests (`node tests/core.test.mjs`): 48/48 PASS
  - Node integration tests (`tests/workflow`, `storage`, `cache`, `mutations`, `books`): 39/39 PASS
  - Browser tests (`tests/browser/workflow.spec.cjs`): 59/59 PASS (measured on laptop physical Chrome 156, viewport 418×900)
- Shell: `taw-shell-v26`, footer `build: order-clarity (shell v26)`

Historical baseline (v15 build `e65659e`, preserved in `tests/legacy-v15/`):

- Core tests: 48/48 PASS
- DS-1 concurrency regression: 68/68 PASS
- Harness v2: 3/3 PASS, live Worker requests 4, cumulative violations 0
- Fixture SHA-256: `bd22e9c1…` (unchanged)
- Shell: `taw-shell-v15`, footer `build: ui-polish (shell v15)`

The historical v15 harness run confirmed:

- sentences citing unconfirmed facts: 0
- rejected text in model requests: 0

*Source limitation note on these metrics:* These two counters were measured at the v15 harness boundary (`tests/legacy-v15/harness.mjs`). In v26, the updated assert test suite (`tests/harness.mjs` and `tests/mutations.test.mjs`) maintains that confirmation boundary, but these are not newly generated live counters from v26.

Scope notes: The harness verifies structural citation integrity and the model-request boundary. It does not claim semantic entailment. It checks the deterministic layer plus the render output it collects into the app's own containers; real-browser rendering is covered separately by device playback and E2E. The app keeps a single current record, so version-history preservation is not claimed anywhere.

Builder-reported manual/browser checks (not re-runnable from this commit alone): 54 browser UI checks at 320/390/1280px PASS; v14 cache removal and offline loading PASS. These are builder reports, not independently re-run from the repository at this commit.

## Models & Measured Costs

All runtime AI calls use Meta models through the Meta Model API:

| Task | Model | Role | Measured | Cost / Night |
|---|---|---|---|---|
| Transcription | Muse Voice Transcribe 1.0 | Scribe | per memo (seconds of audio) | ~$0.001 |
| Fact Extraction | Muse Spark 1.3 | Witness | 4,418 input tokens; 1,235 output tokens (reasoning_effort=low) | ~$0.011 |
| Briefing Composition | Muse Spark 1.3 | Witness | live run, 2026-11-01 (12 confirmed sample facts) | ~$0.0065 |
| Page Composition | Muse Spark 1.3 | Witness | live run, 2026-11-01 (12 confirmed sample facts) | ~$0.0061 |
| Question Draft | Muse Spark 1.3 | Witness | live run, 2026-11-01 (12 confirmed sample facts) | ~$0.0027 |
| Photo Restyling | Muse Image 1.0 | Illustrator | img2img restyling from real photo | $0.010 (flat) |
| **Total per night** | | | | **≈ $0.037** |

### Reasoning Effort Measurement

Live spikes against the production Cloudflare Worker measured Muse Spark 1.3 on identical inputs (4,418 tokens):

- reasoning_effort=low: 1,235 output tokens.
- reasoning_effort=medium: 3,408 output tokens.

Both efforts passed every abstention check (breed, sex, ownership, and the child's feelings all stayed in Unknowns). Both initially missed one observation class — child–animal interaction (gaze/contact). After one prompt rule was added for it, the low-effort run recovered the candidate with all traps still abstained. The app therefore ships reasoning_effort=low: the same verified quality at roughly one-third of the output tokens.

### Non-Model Processing

The following operations run locally without external API calls:

- In-browser audio conversion to WAV via WebAudio.
- Deterministic citation and leak verification in code.
- Offline caching and resource delivery via the Service Worker.

## Try It / Setup

### 1. Keyless Sample Mode

Visit https://tuck-and-whisper.pages.dev and tap **Load sample day**. No key, no install — the full flow (triage, briefing, question card, page, testimony) runs immediately.

### 2. Live Mode with Your Own Meta API Key

The PWA talks to a thin Cloudflare Worker that holds the key server-side (the key never ships in client code):

1. Clone the repository:
   ```
   git clone https://github.com/Oplo-Works/tuck-and-whisper.git
   ```
2. Deploy the Worker and add your key as a secret — full steps in [worker/README.md](worker/README.md). Verify with `GET /api/health` → `{"ok": true}`.
3. Point the PWA's API base at your Worker URL (see `WORKER_URL` in `web/app.js`).
4. Run the core unit tests (48 passing):
   ```
   node tests/core.test.mjs
   ```

## Safety & Privacy

- **No children's photos in repository:** Real family photos are never committed to this repository.
- **Session-only photos:** Photos exist only in runtime memory for extraction and restyling; they are never persisted. Browser localStorage holds only normalized text and parent confirmation decisions.
- **Sample data permissions:** The names used in the sample day appear with the parent's permission.

## Honesty Notes

- **Single-device role switch:** The demo runs on one device with an in-app role switch between the daytime parent and the bedtime parent. It is **not** real two-parent sync, and nothing in the app or this README should be read as claiming it is.
- **UI translations:** English and Korean are maintained by hand. The other 23 interface languages are machine-generated (Muse Spark) and **unreviewed** — machine translation only.

## License

This project is licensed under the MIT License.
