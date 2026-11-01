# Tuck and Whisper

**You missed the moment. You don't have to miss the story.**

*Bedtime, in the language your family speaks at home.*

A PWA bedtime handoff for families. The parent who spent the day with the child captures one photo and a ~10-second voice memo. Muse Spark proposes fact candidates with provenance (photo/memo) and risk grades; the capturing parent confirms or rejects each candidate (Gate 1). From confirmed facts only, the app composes:

1. A briefing for the parent who missed the day.
2. One question card built from an "Unknown" that the evidence could not settle.
3. An illustrated bedtime page (Muse Image restyles the family's real photo) whose sentences cite confirmed fact IDs.

The child's bedtime answer is written down by the parent and saved as testimony, never promoted to fact.

Built entirely during the Meta Global AI Developer Hackathon (Oct 30 – Nov 4, 2026). Vanilla JS, zero runtime dependencies.

## 60-Second Judge Path

**Live URL:** https://tuck-and-whisper.pages.dev

Sample mode requires **no API key of yours**. Extraction replays a real recorded Muse Spark run, and briefing/page composition still calls Muse Spark live through the project's Worker — so the whole flow is verifiable without any setup:

1. Open https://tuck-and-whisper.pages.dev.
2. Tap **Load sample day**.
3. Review the candidate facts at Gate 1: reject one candidate and confirm the rest.
4. Open the preview: the briefing and the question card cite confirmed facts only. The question card is manual — pick premise chips, then tap **Draft the question**.
5. View the bedtime page: sentences cite only confirmed fact IDs, and the rejected candidate never appears.

Note: sample mode carries **no photo and no stylization** — those need a real capture. The briefing, question card, and page sentences still run live through the project's Worker.

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

## Counterfactual harness

The confirmation boundary is not a prompt-time promise — it is re-verified on every build by a counterfactual harness (`node tests/harness.mjs`), built to be falsifiable: if the boundary were broken, the harness would FAIL. It drives the app with adversarial inputs — an extraction response reusing an old fact ID, NFD-normalized leak bypasses, sentences citing the rejected fact — and judges every served sentence and every synthesis request body against an independent oracle derived from the fixture, never from the app's own validator. On the current build:

- sentences citing unconfirmed facts: 0
- rejected text in model requests: 0

Scope notes: the harness checks the deterministic layer plus the render output it collects into the app's own containers; real-browser rendering is covered separately by device playback and E2E. The app keeps a single current record, so version-history preservation is not claimed anywhere.

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
