// Promo-video director for AIstudynotes.
// Seeds a demo collection, stubs Gemini so the AI features work without a key,
// injects an animated cursor + caption layer, captures the app via Chrome's
// CDP screencast (real-time, smooth), then encodes an MP4 with ffmpeg.
//
// Usage:  node scripts/promo/record.mjs            (full promo)
//         PROMO_LIMIT=3 node scripts/promo/record.mjs   (first 3 scenes only, quick test)
//
// Requires the dev server running on http://localhost:5199 (base /aistudynotes/).

import puppeteer from 'puppeteer-core';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedInPage } from './seed.mjs';
import { installOverlay } from './overlay.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:5199/aistudynotes/';
const CHROME = '/usr/bin/google-chrome';
const OUT_DIR = process.env.PROMO_OUT || path.join(__dirname, 'out');
const FRAME_DIR = path.join(OUT_DIR, 'frames');
const LIMIT = process.env.PROMO_LIMIT ? parseInt(process.env.PROMO_LIMIT, 10) : Infinity;
const VW = 1920;
const VH = 1200;

fs.rmSync(FRAME_DIR, { recursive: true, force: true });
fs.mkdirSync(FRAME_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Gemini stub (installed on every document) ----------
function geminiStub() {
  const orig = window.fetch.bind(window);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.includes('generativelanguage')) return orig(url, opts);
    const body = opts && opts.body ? String(opts.body) : '';
    const reply = (obj, ms) =>
      delay(ms).then(
        () =>
          new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      );

    if (body.includes('grading a flashcard')) {
      return reply(
        {
          score: 84,
          verdict: 'partially_correct',
          feedback:
            "Exactly right that ribosomes build proteins — that's the core function, nicely put. To be fully precise, note *how*: they read the codons of messenger RNA and translate them into a chain of amino acids.",
          keyPointsMissed: ['Ribosomes translate mRNA codons into amino acids'],
          suggestedRating: 3,
        },
        1150,
      );
    }
    if (body.includes('SAME ORDER')) {
      return reply(
        {
          notes: [
            {
              type: 'basic',
              front: 'What is the resting membrane potential of a typical neuron?',
              back: 'About −70 mV, maintained by the sodium–potassium pump and selective ion permeability.',
            },
            {
              type: 'basic',
              front: 'What must happen for an action potential to fire?',
              back: 'The membrane must depolarize to threshold (~ −55 mV), opening voltage-gated Na⁺ channels.',
            },
            {
              type: 'cloze',
              front: 'During depolarization, voltage-gated {{c1::sodium}} channels open and Na⁺ rushes {{c2::into}} the cell.',
              back: '',
            },
            {
              type: 'basic',
              front: 'What causes the membrane to repolarize?',
              back: 'Voltage-gated K⁺ channels open and K⁺ flows out, restoring the negative interior.',
            },
            {
              type: 'basic',
              front: 'What is the refractory period?',
              back: 'A brief interval after an action potential during which the neuron cannot readily fire again.',
            },
          ],
        },
        1600,
      );
    }
    // key test / anything else
    return reply({ ok: true }, 500).then(
      () =>
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
  };
}

// ---------- boot ----------
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb', `--window-size=${VW},${VH}`],
});

const page = await browser.newPage();
await page.setViewport({ width: VW, height: VH, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument(geminiStub);

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

// director bridge
const promo = {
  caption: (html, sub) => page.evaluate(({ html, sub }) => window.__promo.caption(html, sub), { html, sub }),
  hideCaption: () => page.evaluate(() => window.__promo.hideCaption()),
  move: (x, y, ms) => page.evaluate(({ x, y, ms }) => window.__promo.moveCursor(x, y, ms), { x, y, ms }),
  clickFx: () => page.evaluate(() => window.__promo.clickFx()),
  setCursor: (x, y) => page.evaluate(({ x, y }) => window.__promo.setCursor(x, y), { x, y }),
  key: (label, x, y) => page.evaluate(({ label, x, y }) => window.__promo.key(label, x, y), { label, x, y }),
  showTitle: (html) => page.evaluate((html) => window.__promo.showTitle(html), html),
  hideTitle: () => page.evaluate(() => window.__promo.hideTitle()),
  scroll: (sel, top, ms) => page.evaluate(({ sel, top, ms }) => window.__promo.scrollEl(sel, top, ms), { sel, top, ms }),
  vignette: (on) => page.evaluate((on) => window.__promo.vignette(on), on),
};

async function inject() {
  await page.evaluate(installOverlay);
  await promo.setCursor(VW / 2, VH / 2 + 60);
}

// ---------- element helpers ----------
async function byText(sel, text) {
  const h = await page.evaluateHandle(
    (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(text)) || null,
    sel,
    text,
  );
  const el = h.asElement();
  if (!el) throw new Error(`no <${sel}> containing "${text}"`);
  return el;
}
async function byRe(sel, source) {
  const h = await page.evaluateHandle(
    (sel, src) => {
      const re = new RegExp(src);
      return [...document.querySelectorAll(sel)].find((e) => re.test(e.textContent.trim())) || null;
    },
    sel,
    source,
  );
  const el = h.asElement();
  if (!el) throw new Error(`no <${sel}> matching /${source}/`);
  return el;
}
async function center(handle) {
  const b = await handle.boundingBox();
  if (!b) throw new Error('no box');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function cursorTo(handle, ms = 620) {
  const c = await center(handle);
  await promo.move(c.x, c.y, ms);
  return c;
}
async function cursorClick(handle, { ms = 620, clickCount = 1, after = 320 } = {}) {
  await cursorTo(handle, ms);
  await promo.clickFx();
  await handle.click({ count: clickCount, delay: 40 }); // Puppeteer 25 option is `count`
  await sleep(after);
}
async function clickText(sel, text, opts) {
  await cursorClick(await byText(sel, text), opts);
}
async function waitForText2(sel, text, timeout = 8000) {
  await page.waitForFunction(
    (sel, text) => [...document.querySelectorAll(sel)].some((e) => e.textContent.includes(text)),
    { timeout },
    sel,
    text,
  );
}
// Double-click a deck tile to open it, waiting until the folder header actions appear.
async function openFolder(name) {
  await cursorClick(await byText('.deck-tile', name), { clickCount: 2, after: 250 });
  await page.waitForSelector('.folder-head-actions', { timeout: 8000 });
  await waitForText2('.folder-head-actions', 'Add note'); // present only inside a folder
  await sleep(250);
}
async function goHome() {
  const atHome = await page.evaluate(() => {
    const c = [...document.querySelectorAll('.crumb')].find((x) => /Home/.test(x.textContent));
    if (c && !c.classList.contains('crumb-current')) {
      c.click();
      return false;
    }
    return true;
  });
  if (!atHome) await sleep(400);
}
async function cursorType(handle, text, { perChar = 42, ms = 480 } = {}) {
  await cursorTo(handle, ms);
  await promo.clickFx();
  await handle.click();
  await handle.type(text, { delay: perChar });
}
async function waitText(text, timeout = 9000) {
  await page.waitForFunction((t) => document.body && document.body.innerText.includes(t), { timeout }, text);
}
async function pressKey(label, key, at) {
  await promo.key(label, at?.x, at?.y);
  await page.keyboard.press(key);
}

// ---------- seed & load ----------
console.log('· loading app…');
await page.goto(BASE, { waitUntil: 'networkidle0' });
await waitText('Decks');
console.log('· seeding demo collection…');
const stats = await page.evaluate(seedInPage);
console.log('  seeded', stats);
await page.reload({ waitUntil: 'networkidle0' });
await waitText('Biology');
await inject();
await sleep(400);

// ---------- screencast capture ----------
const client = await page.target().createCDPSession();
const frames = [];
let seq = 0;
client.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  const file = path.join(FRAME_DIR, `f${String(seq++).padStart(6, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ file, t: metadata.timestamp });
  try {
    await client.send('Page.screencastFrameAck', { sessionId });
  } catch {
    /* stopped */
  }
});
async function startCast() {
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1920, maxHeight: 1200, everyNthFrame: 1 });
}
async function stopCast() {
  await client.send('Page.stopScreencast');
  await sleep(300);
}

// ---------- brand marks ----------
const CAP = '<svg width="42" height="42" viewBox="0 0 24 24" fill="none"><path d="M12 3L1 9l11 6 9-4.9V17h2V9L12 3z" fill="#fff"/><path d="M5 12.5V16c0 1.7 3.1 3 7 3s7-1.3 7-3v-3.5l-7 3.8-7-3.8z" fill="#a7f3e6"/></svg>';

async function nav(label) {
  await clickText('.nav-item', label, { after: 550 });
}

// ---------- storyboard ----------
const scenes = [];
const scene = (name, fn) => scenes.push({ name, fn });

// 0 — intro
scene('intro', async () => {
  await promo.showTitle(
    `<div class="logo"><div class="mark">${CAP}</div><h1>AI<span class="b">study</span>notes</h1></div>` +
      `<p class="tag">Spaced repetition, supercharged by AI grading</p>` +
      `<div class="foot">A quick tour</div>`,
  );
  await sleep(2600);
  await promo.hideTitle();
  await sleep(700);
});

// 1 — decks desktop
scene('decks', async () => {
  await promo.vignette(true);
  await promo.caption('Organize everything like a <span class="accent">desktop</span>', 'Folders, decks & drag-and-drop — with due counts at a glance');
  await sleep(700);
  let t = await byText('.deck-tile', 'Biology');
  await cursorTo(t, 700);
  await sleep(600);
  t = await byText('.deck-tile', 'Chemistry');
  await cursorTo(t, 650);
  await sleep(500);
  // open a nested folder
  await openFolder('Languages');
  await promo.caption('Nest decks into <span class="accent">folders</span>', 'Spanish and French live inside “Languages”');
  await sleep(1900);
  await cursorClick(await byText('.crumb', 'Home'), { after: 700 });
  await sleep(500);
  await promo.hideCaption();
  await sleep(300);
});

// 2 — study classic
scene('study-classic', async () => {
  await goHome();
  await openFolder('Biology');
  await cursorClick(await byText('.folder-head-actions button', 'Study'), { after: 700 });
  await page.waitForSelector('.study-card');
  await clickText('.mode-toggle button', 'Classic', { after: 400 });
  await promo.caption('Study with the proven <span class="accent">FSRS</span> algorithm', 'The same spaced-repetition engine as modern Anki');
  await sleep(1500);
  const show = await byText('button', 'Show answer');
  await cursorTo(show, 600);
  await pressKey('Space', 'Space');
  await promo.clickFx();
  await page.waitForSelector('.rating-row');
  await sleep(700);
  await promo.caption('Each button <span class="accent">previews your next interval</span>', 'Rate how well you knew it — 1 · 2 · 3 · 4');
  await sleep(1900);
  const good = await byText('.rate-btn', 'Good');
  await cursorTo(good, 600);
  await promo.clickFx();
  await pressKey('3', '3'); // keyboard rating advances the card; don't also click (node detaches)
  await sleep(900);
});

// 3 — AI grading
scene('study-ai', async () => {
  await promo.hideCaption();
  await clickText('.mode-toggle button', 'AI', { after: 450 });
  await page.waitForSelector('.ai-answer-box');
  await promo.caption('Or answer <span class="accent">in your own words</span>', 'The AI grades your understanding, not exact wording');
  await sleep(1200);
  const box = await page.$('.ai-answer-box');
  await cursorType(box, 'Ribosomes build proteins from amino acids.', { perChar: 34 });
  await sleep(500);
  const grade = await byText('button', 'Grade my answer');
  await cursorClick(grade, { after: 300 });
  await page.waitForSelector('.ai-result', { timeout: 8000 });
  await sleep(600);
  await promo.caption('Instant <span class="accent">score, feedback & a suggested rating</span>', 'It even flags the key point you missed');
  await sleep(3000);
  const suggested = await page.$('.rate-btn.rate-suggested');
  if (suggested) await cursorClick(suggested, { after: 700 });
  await sleep(400);
  await promo.hideCaption();
  await nav('Decks');
});

// 4 — create notes with AI
scene('ai-notes', async () => {
  await goHome();
  await openFolder('Neuroscience');
  await cursorClick(await byText('.folder-head-actions button', 'Create with AI'), { after: 650 });
  await page.waitForSelector('.ai-notes-drop');
  await promo.caption('Turn any <span class="accent">PDF, image or notes</span> into flashcards', 'Drop a document — the AI writes the cards for you');
  await sleep(1400);
  // simulate dropping a file
  const drop = await page.$('.ai-notes-drop');
  const dc = await center(drop);
  await promo.move(dc.x, dc.y, 600);
  await promo.clickFx();
  await page.evaluate(() => {
    const dz = document.querySelector('.ai-notes-drop');
    const dt = new DataTransfer();
    dt.items.add(new File(['%PDF-1.4 action potentials'], 'action-potentials.pdf', { type: 'application/pdf' }));
    dz.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await waitText('action-potentials.pdf');
  await sleep(700);
  await cursorClick(await byText('.modal-panel button', 'Generate notes'), { after: 400 });
  await waitText('resting membrane potential', 12000);
  await sleep(600);
  await promo.caption('Review the cards, then <span class="accent">add them</span>', 'Generated in the same order as your source — cloze included');
  const gen = await page.$('.modal-panel');
  await promo.scroll('.modal-body', 220, 1100).catch(() => {});
  await sleep(1900);
  await cursorClick(await byRe('.modal-panel button', 'Add \\d+ note'), { after: 700 });
  await waitText('Added', 6000);
  await sleep(700);
  await promo.hideCaption();
});

// 5 — add note (cloze + math)
scene('add-note', async () => {
  await nav('Add');
  await page.waitForSelector('.add-view textarea');
  await promo.caption('Write rich notes — <span class="accent">cloze & LaTeX math</span>', 'Basic, reversed, or fill-in-the-blank cards');
  await page.evaluate(() => {
    const sel = document.querySelectorAll('.add-selectors select')[0];
    sel.value = 'cloze';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(400);
  const front = (await page.$$('.add-view textarea'))[0];
  await cursorType(front, 'Newton’s second law states that $F = ma$, where the {{c1::force}} equals mass times {{c2::acceleration}}.', { perChar: 20 });
  await waitText('cloze deletion');
  await sleep(1500);
  await cursorClick(await byText('button', 'Add note'), { after: 700 });
  await waitText('Added', 5000);
  await sleep(600);
  await promo.hideCaption();
});

// 6 — browser
scene('browser', async () => {
  await nav('Browse');
  await page.waitForSelector('.browser-table');
  await promo.caption('Find any card with <span class="accent">powerful search</span>', 'deck: · tag: · is:due · flag: · prop:reps>3 …');
  await sleep(900);
  const search = await page.$('.browser-search input');
  await cursorType(search, 'deck:biology', { perChar: 55 });
  await sleep(1400);
  await page.evaluate(() => {
    const i = document.querySelector('.browser-search input');
    i.value = '';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await cursorType(search, 'tag:cell-biology', { perChar: 45 });
  await sleep(1300);
  const row = await page.$('.browser-table tbody tr');
  await cursorClick(row, { after: 400 });
  await page.waitForSelector('.bulk-bar');
  await promo.caption('Then <span class="accent">bulk-edit</span> in one click', 'Suspend · move · flag · reset · delete');
  await sleep(2100);
  await promo.hideCaption();
});

// 7 — stats
scene('stats', async () => {
  await nav('Stats');
  await waitText('Statistics');
  await page.waitForSelector('.heatmap-svg');
  await promo.caption('See your <span class="accent">progress</span> in depth', 'Streaks, forecast, retention & AI-graded understanding');
  await sleep(1600);
  await promo.scroll('.main-area', 260, 1200);
  await sleep(1500);
  await promo.scroll('.main-area', 620, 1300);
  await sleep(1700);
  await promo.scroll('.main-area', 1080, 1300);
  await sleep(2000);
  await promo.scroll('.main-area', 0, 900);
  await promo.hideCaption();
  await sleep(300);
});

// 8 — dark mode
scene('dark', async () => {
  await nav('Settings');
  await waitText('Appearance');
  await promo.caption('Make it yours — <span class="accent">light or dark</span>', 'Plus API model, grading strictness & feedback language');
  await sleep(1200);
  const dark = await byText('.seg-control button', 'Dark');
  await cursorClick(dark, { after: 900 });
  await sleep(700);
  await nav('Stats');
  await sleep(400);
  await promo.scroll('.main-area', 300, 1100);
  await sleep(1600);
  await promo.hideCaption();
  await promo.vignette(false);
  await sleep(200);
});

// 9 — outro
scene('outro', async () => {
  await promo.showTitle(
    `<div class="logo"><div class="mark">${CAP}</div><h1>AI<span class="b">study</span>notes</h1></div>` +
      `<p class="tag">Study smarter — and it’s <b style="color:#fff">100% local</b>.</p>` +
      `<div class="rows"><span class="chip">🔒 Your data never leaves the browser</span><span class="chip">✨ AI grading & note generation</span><span class="chip">📈 FSRS scheduling</span></div>` +
      `<div class="foot">Open-source · free · offline-first</div>`,
  );
  await sleep(3600); // hold on the branded card; recording stops here so the video ends on it
});

// ---------- run ----------
await startCast();
await sleep(250);
let ok = true;
for (let i = 0; i < scenes.length && i < LIMIT; i++) {
  const s = scenes[i];
  const t0 = Date.now();
  try {
    console.log(`▶ scene ${i}: ${s.name}`);
    await s.fn();
  } catch (e) {
    ok = false;
    console.error(`  ✗ scene "${s.name}" failed:`, e.message);
  }
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
await sleep(300);
await stopCast();
await browser.close();

console.log(`· captured ${frames.length} frames`);
if (pageErrors.length) console.log('· page errors:', pageErrors.slice(0, 5));
if (!frames.length) {
  console.error('No frames captured.');
  process.exit(1);
}

// ---------- encode ----------
const t0 = frames[0].t;
const lines = [];
for (let i = 0; i < frames.length; i++) {
  const cur = frames[i];
  const next = frames[i + 1];
  let dur = next ? next.t - cur.t : 2.4; // tail hold on last frame
  dur = Math.max(0.012, Math.min(5, dur));
  lines.push(`file '${cur.file}'`);
  lines.push(`duration ${dur.toFixed(4)}`);
}
lines.push(`file '${frames[frames.length - 1].file}'`); // concat demuxer needs last file repeated
const listFile = path.join(OUT_DIR, 'frames.txt');
fs.writeFileSync(listFile, lines.join('\n'));

const outFile = path.join(OUT_DIR, 'aistudynotes-promo.mp4');
console.log('· encoding', outFile);
const ff = spawnSync(
  'ffmpeg',
  [
    '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', 'fps=30,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart',
    outFile,
  ],
  { stdio: 'inherit' },
);
if (ff.status !== 0) {
  console.error('ffmpeg failed');
  process.exit(1);
}
const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
console.log(`\n✓ ${outFile} (${kb} KB)  scenes ${Math.min(scenes.length, LIMIT)}/${scenes.length}  ${ok ? 'clean' : 'with warnings'}`);
