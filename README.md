# Tuck and Whisper

**You missed the moment. You don't have to miss the story.**

A bedtime handoff app for families: the parent who was with the child during the day captures a photo and a 10-second memo. The app turns that day into a short bedtime briefing, a question card, and an illustrated page — built **only from facts the capturing parent confirmed**. Nothing unconfirmed ever reaches the child.

Built for the Meta Global AI Developer Hackathon (submission deadline: Nov 4, 2026, 9:00 PM ET).

## How it works

1. **Capture** — photo + short voice memo (Muse Voice transcription).
2. **Candidates** — Muse Spark proposes fact candidates with provenance grades; anything it cannot ground becomes an *Unknown*.
3. **Gate 1** — the capturing parent confirms or rejects each candidate. Rejection is a first-class action.
4. **Briefing + question card** — the other parent previews confirmed facts and one question built from an Unknown before bedtime.
5. **Page** — a stylized page (Muse Image, from the real photo) whose sentences use confirmed facts only — enforced in code, with per-sentence provenance chips.
6. **Testimony** — what the child says at bedtime is stored as testimony, never auto-promoted to fact.

## Structure

- `web/` — the PWA (mobile-first; installable; later portable to native shells via Capacitor/TWA)
- `worker/` — a thin Cloudflare Worker proxy that holds the Meta Model API key server-side. The key never ships in client code.

## Honesty notes

- The demo runs on one device with an in-app role switch; that is **not** real two-parent sync.
- Sample data for the 60-second trial contains no real children's photos.
