# Promo video generator

Produces `out/aistudynotes-promo.mp4` — a ~104s narrated feature tour of AIstudynotes
(1920×1200, 30 fps, H.264). No API key and no manual clicking required.

## How it works

- **`seed.mjs`** — populates IndexedDB (via the app's `ankiai` DB) with a realistic demo
  collection: nested decks, basic/cloze/image/math notes, a canvas-drawn cell diagram stored
  as media, and ~150 days of review history so the deck counters and stats look lived-in.
- **`overlay.mjs`** — the "director" layer injected on top of the app: an animated cursor,
  click ripples, caption pills, full-screen title cards, keycap pops, and smooth scrolling.
  Everything animates in real time so Chrome's screencast captures it as smooth video.
- **`record.mjs`** — the orchestrator. Stubs the Gemini endpoint (so AI grading and note
  generation return canned, on-topic responses), seeds the data, injects the overlay, runs a
  10-scene storyboard, captures frames via CDP `Page.startScreencast`, and encodes with ffmpeg
  (per-frame durations from screencast timestamps → constant 30 fps).

## Run it

```bash
npm run dev -- --port 5199 --strictPort   # in one terminal (base path is /aistudynotes/)
node scripts/promo/record.mjs             # in another → writes out/aistudynotes-promo.mp4
```

- `PROMO_LIMIT=3 node scripts/promo/record.mjs` records only the first 3 scenes (quick test).
- Requires system Chrome at `/usr/bin/google-chrome` and `ffmpeg` on PATH.

## Storyboard

intro · decks (desktop + nested folders) · classic study (FSRS interval previews) ·
AI grading (score / feedback / suggested rating) · create-notes-with-AI · add note (cloze + math) ·
browser search · stats (heatmap, retention, AI-graded avg) · dark mode · outro.
