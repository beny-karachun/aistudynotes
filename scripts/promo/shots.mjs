// Promotional screenshot & marketing-image generator for AIstudynotes.
// 1) Seeds the demo collection, drives each view into a photogenic state, and
//    captures clean 2x screenshots (no cursor/caption overlay) in light & dark.
// 2) Composes branded marketing images (hero, App-Store-style feature cards, and
//    a social/OG card) by rendering the screenshots inside a styled HTML "studio".
//
// Usage:  node scripts/promo/shots.mjs   (dev server must be on :5199)

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedInPage } from './seed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:5199/aistudynotes/';
const CHROME = '/usr/bin/google-chrome';
const OUT = path.join(__dirname, 'out', 'shots');
const RAW = path.join(OUT, 'raw');
const MKT = path.join(OUT, 'marketing');
for (const d of [OUT, RAW, MKT]) fs.mkdirSync(d, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function geminiStub() {
  const orig = window.fetch.bind(window);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.includes('generativelanguage')) return orig(url, opts);
    const body = opts && opts.body ? String(opts.body) : '';
    const send = (obj, ms) =>
      delay(ms).then(
        () =>
          new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      );
    if (body.includes('grading a flashcard'))
      return send(
        {
          score: 84,
          verdict: 'partially_correct',
          feedback:
            "Exactly right that ribosomes build proteins — that's the core function, nicely put. To be fully precise, note how: they read the codons of messenger RNA and translate them into a chain of amino acids.",
          keyPointsMissed: ['Ribosomes translate mRNA codons into amino acids'],
          suggestedRating: 3,
        },
        700,
      );
    if (body.includes('SAME ORDER'))
      return send(
        {
          notes: [
            { type: 'basic', front: 'What is the resting membrane potential of a typical neuron?', back: 'About −70 mV, maintained by the sodium–potassium pump and selective ion permeability.' },
            { type: 'basic', front: 'What must happen for an action potential to fire?', back: 'The membrane must depolarize to threshold (~ −55 mV), opening voltage-gated Na⁺ channels.' },
            { type: 'cloze', front: 'During depolarization, voltage-gated {{c1::sodium}} channels open and Na⁺ rushes {{c2::into}} the cell.', back: '' },
            { type: 'basic', front: 'What causes the membrane to repolarize?', back: 'Voltage-gated K⁺ channels open and K⁺ flows out, restoring the negative interior.' },
            { type: 'basic', front: 'What is the refractory period?', back: 'A brief interval after an action potential during which the neuron cannot readily fire again.' },
          ],
        },
        700,
      );
    return send({ ok: true }, 300);
  };
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb', '--window-size=1280,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
await page.evaluateOnNewDocument(geminiStub);

// ---------- helpers ----------
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
async function byRe(sel, src) {
  const h = await page.evaluateHandle(
    (sel, s) => {
      const re = new RegExp(s);
      return [...document.querySelectorAll(sel)].find((e) => re.test(e.textContent.trim())) || null;
    },
    sel,
    src,
  );
  const el = h.asElement();
  if (!el) throw new Error(`no <${sel}> ~ /${src}/`);
  return el;
}
const click = async (sel, text, count = 1) => (await byText(sel, text)).click({ count });
async function waitText(t, timeout = 9000) {
  await page.waitForFunction((t) => document.body && document.body.innerText.includes(t), { timeout }, t);
}
async function waitSelText(sel, text, timeout = 8000) {
  await page.waitForFunction((sel, text) => [...document.querySelectorAll(sel)].some((e) => e.textContent.includes(text)), { timeout }, sel, text);
}
const nav = async (label) => {
  await click('.nav-item', label);
  await sleep(500);
};
async function openFolder(name) {
  (await byText('.deck-tile', name)).click({ count: 2 });
  await page.waitForSelector('.folder-head-actions', { timeout: 8000 });
  await waitSelText('.folder-head-actions', 'Add note');
  await sleep(350);
}
async function goHome() {
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('.crumb')].find((x) => /Home/.test(x.textContent));
    if (c && !c.classList.contains('crumb-current')) c.click();
  });
  await sleep(400);
}
async function setTheme(theme) {
  await nav('Settings');
  await waitText('Appearance');
  await click('.seg-control button', theme === 'dark' ? 'Dark' : 'Light');
  await sleep(450);
}
async function shot(name) {
  await sleep(250);
  const file = path.join(RAW, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('  📸', name);
  return file;
}

// Static paths so a marketing-only rerun (SHOTS_MKT_ONLY=1) can skip the capture pass.
const rawFiles = {
  decksLight: path.join(RAW, 'decks-light.png'),
  deckOpen: path.join(RAW, 'deck-open-light.png'),
  studyClassic: path.join(RAW, 'study-classic-light.png'),
  aiGrading: path.join(RAW, 'ai-grading-light.png'),
  createAi: path.join(RAW, 'create-ai-light.png'),
  addNote: path.join(RAW, 'add-note-light.png'),
  browserLight: path.join(RAW, 'browser-light.png'),
  statsLight: path.join(RAW, 'stats-light.png'),
  statsDark: path.join(RAW, 'stats-dark.png'),
  settingsDark: path.join(RAW, 'settings-dark.png'),
  decksDark: path.join(RAW, 'decks-dark.png'),
};

if (!process.env.SHOTS_MKT_ONLY) {
// ---------- seed ----------
console.log('· seeding…');
await page.goto(BASE, { waitUntil: 'networkidle0' });
await waitText('Decks');
await page.evaluate(seedInPage);
await page.reload({ waitUntil: 'networkidle0' });
await waitText('Biology');
await sleep(400);

// ---------- raw captures (light) ----------
console.log('· capturing light views…');
await nav('Decks');
await goHome();
rawFiles.decksLight = await shot('decks-light');

await openFolder('Biology');
rawFiles.deckOpen = await shot('deck-open-light');

await click('.folder-head-actions button', 'Study');
await page.waitForSelector('.study-card');
await click('.mode-toggle button', 'Classic');
await click('button', 'Show answer');
await page.waitForSelector('.rating-row');
rawFiles.studyClassic = await shot('study-classic-light');

// AI grading (advance to ribosome card via keyboard rate, then AI mode)
await page.keyboard.press('3');
await sleep(700);
await click('.mode-toggle button', 'AI');
await page.waitForSelector('.ai-answer-box');
await (await page.$('.ai-answer-box')).type('Ribosomes build proteins from amino acids.', { delay: 8 });
await click('button', 'Grade my answer');
await page.waitForSelector('.ai-result', { timeout: 8000 });
await sleep(600);
rawFiles.aiGrading = await shot('ai-grading-light');

// Create with AI
await nav('Decks');
await goHome();
await openFolder('Neuroscience');
await click('.folder-head-actions button', 'Create with AI');
await page.waitForSelector('.ai-notes-drop');
await page.evaluate(() => {
  const dz = document.querySelector('.ai-notes-drop');
  const dt = new DataTransfer();
  dt.items.add(new File(['%PDF-1.4 action potentials'], 'action-potentials.pdf', { type: 'application/pdf' }));
  dz.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
});
await waitText('action-potentials.pdf');
await click('.modal-panel button', 'Generate notes');
await waitText('resting membrane potential', 12000);
await sleep(500);
rawFiles.createAi = await shot('create-ai-light');
await page.keyboard.press('Escape').catch(() => {});
await sleep(200);

// Add note (cloze + math)
await nav('Add');
await page.waitForSelector('.add-view textarea');
await page.evaluate(() => {
  const s = document.querySelectorAll('.add-selectors select')[0];
  s.value = 'cloze';
  s.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(200);
await (await page.$('.add-view textarea')).type("Newton's second law states that $F = ma$, where the {{c1::force}} equals mass times {{c2::acceleration}}.", { delay: 6 });
await waitText('cloze deletion');
await sleep(400);
rawFiles.addNote = await shot('add-note-light');

// Browser
await nav('Browse');
await page.waitForSelector('.browser-table');
await sleep(400);
rawFiles.browserLight = await shot('browser-light');

// Stats (light)
await nav('Stats');
await waitText('Statistics');
await page.waitForSelector('.heatmap-svg');
await page.evaluate(() => (document.querySelector('.main-area').scrollTop = 250));
await sleep(500);
rawFiles.statsLight = await shot('stats-light');

// ---------- dark variants ----------
console.log('· capturing dark views…');
await setTheme('dark');
await nav('Stats');
await waitText('Statistics');
await page.waitForSelector('.heatmap-svg');
await page.evaluate(() => (document.querySelector('.main-area').scrollTop = 250));
await sleep(500);
rawFiles.statsDark = await shot('stats-dark');

await nav('Settings');
await waitText('Appearance');
await sleep(300);
rawFiles.settingsDark = await shot('settings-dark');

await nav('Decks');
await goHome();
rawFiles.decksDark = await shot('decks-dark');
} // end capture pass

// ---------- marketing composites ----------
console.log('· composing marketing images…');
const dataUri = (file) => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');

const CAP_SVG =
  '<svg width="46" height="46" viewBox="0 0 24 24" fill="none"><path d="M12 3L1 9l11 6 9-4.9V17h2V9L12 3z" fill="#fff"/><path d="M5 12.5V16c0 1.7 3.1 3 7 3s7-1.3 7-3v-3.5l-7 3.8-7-3.8z" fill="#a7f3e6"/></svg>';

const STUDIO_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  .stage{width:100%;height:100vh;display:flex;overflow:hidden;position:relative}
  .frame{border-radius:16px;overflow:hidden;box-shadow:0 40px 120px rgba(0,0,0,.42),0 0 0 1px rgba(255,255,255,.08);background:#0c1211}
  .frame .bar{height:40px;background:#1b2b28;display:flex;align-items:center;gap:9px;padding:0 16px}
  .frame .bar .d{width:13px;height:13px;border-radius:50%}
  .frame .bar .r{background:#ff5f57}.frame .bar .y{background:#febc2e}.frame .bar .g{background:#28c840}
  .frame .bar .url{margin-left:14px;flex:1;height:24px;border-radius:7px;background:rgba(255,255,255,.08);
    display:flex;align-items:center;padding:0 12px;color:#8fb8b1;font-size:13px;font-weight:500}
  .frame img{display:block;width:100%}
  .logo{display:flex;align-items:center;gap:14px}
  .logo .mark{width:64px;height:64px;border-radius:17px;background:linear-gradient(150deg,#2dd4bf,#0d9488);
    display:flex;align-items:center;justify-content:center;box-shadow:0 12px 34px rgba(45,212,191,.4)}
  .logo .wm{font-size:40px;font-weight:800;letter-spacing:-.03em;color:#fff}
  .logo .wm b{color:#5eead4;font-weight:800}
  .chip{color:#d7fff7;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.16);
    padding:9px 17px;border-radius:999px;font-size:17px;font-weight:600;display:inline-flex;gap:8px;align-items:center}
`;

async function render(name, w, h, inner, extraCss = '') {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><html><head><meta charset="utf8"><style>${STUDIO_CSS}${extraCss}</style></head><body>${inner}</body></html>`, {
    waitUntil: 'load',
    timeout: 15000,
  });
  // wait for webfonts but never hang on them
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 4000))]));
  await sleep(400);
  const file = path.join(MKT, `${name}.png`);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: w, height: h } });
  console.log('  🎨', name, `${w}x${h}`);
}

const win = (img, url = 'aistudynotes — spaced repetition with AI grading') =>
  `<div class="frame"><div class="bar"><span class="d r"></span><span class="d y"></span><span class="d g"></span><div class="url">${url}</div></div><img src="${dataUri(img)}"></div>`;

// HERO — 1600x900 (left text / right screenshot bleeding off the edge)
await render(
  'hero',
  1600,
  900,
  `<div class="stage" style="align-items:center;gap:56px;padding:0 0 0 96px;overflow:hidden;
      background:radial-gradient(130% 130% at 0% 0%,#0f766e 0%,#0b3b39 52%,#071c1c 100%)">
     <div style="flex:0 0 40%;display:flex;flex-direction:column;gap:26px">
       <div class="logo"><div class="mark">${CAP_SVG}</div><div class="wm">AI<b>study</b>notes</div></div>
       <div style="font-size:50px;font-weight:800;color:#fff;letter-spacing:-.03em;line-height:1.06">Spaced repetition,<br><span style="color:#5eead4">supercharged by AI grading</span></div>
       <div style="font-size:21px;color:#a7f3e6;font-weight:500;line-height:1.5">Type your answer in your own words — the AI scores your understanding, explains what you missed, and picks when you review next.</div>
       <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px"><span class="chip">🔒 100% local</span><span class="chip">✨ AI grading</span><span class="chip">📈 FSRS</span></div>
     </div>
     <div style="flex:1;transform:translateX(40px)">${win(rawFiles.aiGrading)}</div>
   </div>`,
);

// OG / social card — 1200x630
await render(
  'social-og',
  1200,
  630,
  `<div class="stage" style="align-items:center;gap:52px;padding:64px;
      background:radial-gradient(120% 140% at 0% 0%,#0f766e 0%,#0b3b39 55%,#071c1c 100%)">
     <div style="flex:0 0 44%;display:flex;flex-direction:column;gap:22px">
       <div class="logo"><div class="mark" style="width:56px;height:56px">${CAP_SVG}</div><div class="wm" style="font-size:34px">AI<b>study</b>notes</div></div>
       <div style="font-size:40px;font-weight:800;color:#fff;letter-spacing:-.03em;line-height:1.08">Study smarter,<br>not harder.</div>
       <div style="font-size:19px;color:#a7f3e6;font-weight:500;line-height:1.5">AI-graded flashcards with FSRS scheduling. 100% local — your data never leaves the browser.</div>
       <div style="display:flex;gap:10px;flex-wrap:wrap"><span class="chip" style="font-size:14px">🔒 Local-first</span><span class="chip" style="font-size:14px">✨ AI grading</span><span class="chip" style="font-size:14px">📈 FSRS</span></div>
     </div>
     <div style="flex:1;transform:translateY(6px)">${win(rawFiles.decksLight)}</div>
   </div>`,
);

// FEATURE CARDS — 1500x1000 each
const feature = (name, eyebrow, head, sub, img, grad) =>
  render(
    name,
    1500,
    1000,
    `<div class="stage" style="flex-direction:column;align-items:center;justify-content:center;gap:28px;padding:50px 70px;background:${grad}">
       <div style="text-align:center;max-width:1080px">
         <div style="font-size:16px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#5eead4">${eyebrow}</div>
         <div style="font-size:44px;font-weight:800;color:#fff;letter-spacing:-.03em;margin-top:10px;line-height:1.08">${head}</div>
         <div style="font-size:20px;color:#bfeae2;font-weight:500;margin-top:12px">${sub}</div>
       </div>
       <div style="width:1040px">${win(img)}</div>
     </div>`,
  );

const G_TEAL = 'radial-gradient(120% 130% at 50% -10%,#0f766e 0%,#0b3b39 52%,#071c1c 100%)';
const G_DEEP = 'radial-gradient(120% 130% at 50% -10%,#155e63 0%,#0a3540 52%,#06181d 100%)';
const G_PLUM = 'radial-gradient(120% 130% at 50% -10%,#3b3170 0%,#241d47 52%,#120f24 100%)';

await feature('feature-1-ai-grading', 'AI grading', 'Answer in your own words', 'Gemini scores your understanding, explains what you missed, and suggests a rating.', rawFiles.aiGrading, G_TEAL);
await feature('feature-2-create-ai', 'Create with AI', 'Turn any PDF into flashcards', 'Drop a document — the AI writes a full, ordered deck for you to review and add.', rawFiles.createAi, G_DEEP);
await feature('feature-3-desktop', 'Organize', 'A familiar desktop for your decks', 'Folders, drag-and-drop, and due counts at a glance — nest decks however you like.', rawFiles.decksLight, G_TEAL);
await feature('feature-4-study', 'Spaced repetition', 'Study with the FSRS algorithm', 'Every answer previews your next interval, so reviews land right when you need them.', rawFiles.studyClassic, G_DEEP);
await feature('feature-5-stats', 'Insights', 'See your progress in depth', 'Streaks, forecast, true retention, and your average AI-graded understanding.', rawFiles.statsDark, G_PLUM);

await browser.close();

// summary
const rawList = fs.readdirSync(RAW).filter((f) => f.endsWith('.png'));
const mktList = fs.readdirSync(MKT).filter((f) => f.endsWith('.png'));
console.log(`\n✓ ${rawList.length} raw screenshots → ${RAW}`);
console.log(`✓ ${mktList.length} marketing images → ${MKT}`);
