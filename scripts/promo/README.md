# Promo assets generator

Produces a ~104s feature-tour video plus a set of marketing screenshots/images for
AIstudynotes. No API key and no manual clicking required.

Outputs (`out/`):
- `aistudynotes-promo.mp4` — silent feature tour (1920×1200, 30 fps, H.264)
- `aistudynotes-promo-music.mp4` — same video with the licensed background track (see Audio)
- `shots/raw/*.png` — clean 2× screenshots of every view (light + dark)
- `shots/marketing/*.png` — branded images: `hero`, `social-og`, and 5 `feature-*` cards

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

## Screenshots & marketing images

```bash
node scripts/promo/shots.mjs                 # capture screenshots + compose marketing images
SHOTS_MKT_ONLY=1 node scripts/promo/shots.mjs  # only recompose marketing images (reuse raw shots)
```

## Audio

`music.mp3` is the licensed background track (Pixabay Content License — "Corporate Upbeat" by
nastelbom; license certificate at repo root, commercial use, no attribution required). To (re)mux
it onto the video with fade-in/out + loudness normalization:

```bash
ffmpeg -y -i out/aistudynotes-promo.mp4 -i music.mp3 \
  -filter_complex "[1:a]atrim=0:104,afade=t=in:st=0:d=1.5,afade=t=out:st=101.5:d=2.5,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -ar 48000 -movflags +faststart -shortest \
  out/aistudynotes-promo-music.mp4
```

## Storyboard

intro · decks (desktop + nested folders) · classic study (FSRS interval previews) ·
AI grading (score / feedback / suggested rating) · create-notes-with-AI · add note (cloze + math) ·
browser search · stats (heatmap, retention, AI-graded avg) · dark mode · outro.
