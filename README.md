# AnkiAI

A local-first spaced-repetition study app (Anki-style) with **AI grading of your understanding** via the Gemini API. Instead of only flipping cards and self-grading, you can type an answer in your own words — including for cards that contain **pasted screenshots** — and the AI scores how well you actually understand the material, then suggests the Again/Hard/Good/Easy rating.

Everything is stored locally in your browser (IndexedDB — the browser's high-capacity local storage; screenshots and decks stay on your machine). The only network calls are to the Gemini API with your own key.

## Run it

```bash
npm install
npm run dev        # then open the printed http://localhost:5173
```

Production build: `npm run build`, then `npm run preview` (or serve `dist/` with any static server).

## Set up AI grading

1. Get a free API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. In the app: **Settings → AI grading** — paste the key, press **Test**.
3. Pick a model:
   - **Gemini 3.1 Flash-Lite** (default) — fastest/cheapest, great for everyday grading
   - **Gemini 3.5 Flash** — stronger reasoning
   - **Gemini 3.5 Flash — Thinking (high)** — same model with `thinkingLevel: "high"` for the deepest reasoning
4. Choose grading strictness (lenient / moderate / strict) and your default answer mode.

The key is stored only in this browser's database and is sent only to `generativelanguage.googleapis.com`. It is deliberately excluded from exports.

## Features

- **Scheduling: FSRS-6** (the algorithm modern Anki uses) via `ts-fsrs` — learning steps (default 1m → 10m), relearning steps, per-deck daily new/review limits, desired-retention slider, 4 AM day rollover (configurable), learn-ahead, leech detection (auto-suspend + `leech` tag), exact interval previews on the answer buttons.
- **Desktop-style deck browser (default)** — the Decks page works like a computer desktop: each folder is a **2D grid of icons**. Folder tiles show rolled-up due counts (with a hover ▶ to study); notes appear as file tiles inside their deck (image notes show a thumbnail of the screenshot). Double-click opens a folder, the breadcrumb bar navigates back up (Backspace too) and carries Add note/Study for the open folder. Full file-system interactions: click/Ctrl/Shift select, **rubber-band box selection** on empty space, **drag & drop** tiles onto folders or breadcrumb segments to move them (notes can move between decks this way), **Ctrl+X/C/V** cut/copy/paste (copying a folder deep-clones its notes and cards; copying notes duplicates them; review history stays with originals), F2 inline rename, Del delete, Enter open/edit, right-click context menus. A **List** toggle switches to a plain tree list where clicking a deck studies it. Studying a folder always includes its whole subtree.
- **Note types** — Basic, Basic + reversed, Cloze (`{{c1::text}}` / `{{c1::text::hint}}`, one card per cloze index, editor button or Ctrl+Shift+C).
- **Screenshots as content** — get images into any field four ways: Ctrl+V paste (routed to the last-focused field even if your cursor is elsewhere on the page), the clipboard toolbar button (reads the clipboard directly — the fallback if your system's paste event misbehaves), drag & drop, or the attach button. They're compressed to WebP, stored locally, rendered on cards, and sent to the AI as part of the card when grading.
- **Math** — TeX between `$…$` (inline) or `$$…$$` (display) renders via MathJax (bundled — works offline, follows light/dark theme). Works inside cloze deletions and in AI feedback too. `\$` escapes a literal dollar sign, and money like "$5 and $10" is left alone.
- **Study** — classic flip mode or AI mode; keyboard-first (Space/Enter flip, 1–4 rate, U undo, E edit, `-` bury, `@` suspend, Ctrl+1–4 flags, `?` help); edit-during-review; multi-step undo.
- **Browser** — search syntax: free text, `deck:`, `tag:`, `is:new/learn/review/due/suspended/buried`, `flag:1-4`, `note:basic/cloze`, `prop:reps>3`, `"quoted phrases"`, `-negation`. Bulk suspend/bury/move/flag/reset/delete.
- **Stats** — today's summary, future-due forecast, year review heatmap with streaks, answer-button breakdown by maturity, card counts, true retention, AI-graded average.
- **Import/export** — full-collection or per-deck JSON backups (images included), TSV/CSV text import, "clean unused media" tool.
- Light/dark/system theme, responsive down to phone width.

## Storage notes

Data lives in IndexedDB under this origin. The app requests persistent storage so the browser won't evict it; current usage is shown in Settings. Export a JSON backup before clearing browser data — "site data" wipes include IndexedDB.

## Testing

`scripts/e2e.mjs` is a puppeteer-core smoke test (uses your installed Chrome) covering deck creation, note adding, image paste/drop, MathJax rendering, study/rating/undo, search, stats, settings, persistence, and the Gemini error path:

```bash
npm run dev -- --port 5199 --strictPort   # in one terminal
node scripts/e2e.mjs                      # in another
```
