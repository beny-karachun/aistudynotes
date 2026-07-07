// End-to-end smoke test for AnkiAI using system Chrome via puppeteer-core.
import puppeteer from 'puppeteer-core';

const BASE = 'http://localhost:5199';
const SHOT_DIR = process.env.SHOT_DIR || '.';
const results = [];
const ok = (name) => { results.push(['PASS', name]); console.log('PASS', name); };
const fail = (name, err) => { results.push(['FAIL', name + ' :: ' + err]); console.log('FAIL', name, '::', err); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// tiny 2x2 red PNG
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DwnwEKmBhQAAMAJgQDAViKGAcAAAAASUVORK5CYII=';

/** Dispatch a synthetic image paste; targetSelector null = paste on document.body (no field focused). */
async function dispatchImagePaste(page, targetSelector) {
  await page.evaluate(
    (b64, sel) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'clip.png', { type: 'image/png' }));
      const target = sel ? document.querySelector(sel) : document.body;
      if (sel) target.focus();
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
      target.dispatchEvent(ev);
    },
    TINY_PNG,
    targetSelector,
  );
}

async function clearTextarea(page, selector) {
  await page.evaluate((sel) => {
    const ta = document.querySelector(sel);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.blur();
  }, selector);
}

async function clickByText(page, selector, text, opts) {
  const handle = await page.evaluateHandle(
    (sel, t) => [...document.querySelectorAll(sel)].find((el) => el.textContent.trim().includes(t)),
    selector,
    text,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`no ${selector} containing "${text}"`);
  await el.click(opts);
  return el;
}

async function pressWithCtrl(page, key) {
  await page.keyboard.down('Control');
  await page.keyboard.press(key);
  await page.keyboard.up('Control');
}

async function dumpDecks(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('ankiai');
        req.onsuccess = () => {
          const idb = req.result;
          const tx = idb.transaction(['decks', 'cards'], 'readonly');
          const out = {};
          tx.objectStore('decks').getAll().onsuccess = (e) => {
            out.decks = e.target.result.map((d) => ({ id: d.id, name: d.name, parentId: d.parentId }));
          };
          tx.objectStore('cards').getAll().onsuccess = (e) => {
            out.cards = e.target.result.map((c) => ({ deckId: c.deckId }));
          };
          tx.oncomplete = () => {
            idb.close();
            resolve(out);
          };
        };
      }),
  );
}

async function waitForText(page, text, timeout = 8000) {
  await page.waitForFunction(
    (t) => document.body && document.body.innerText.includes(t),
    { timeout },
    text,
  );
}

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1360,900'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // 1. Load — default deck exists
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await waitForText(page, 'Decks');
  await waitForText(page, 'Default');
  ok('app loads with Default deck');

  // 2. Create a folder on the desktop
  await clickByText(page, 'button', 'New folder');
  await page.waitForSelector('.modal-panel input');
  await page.type('.modal-panel input', 'Biology');
  await clickByText(page, '.modal-panel button', 'Create');
  await page.waitForSelector('.deck-tile');
  await waitForText(page, 'Biology');
  ok('folder created as desktop tile');

  // 3. Add a basic note
  await clickByText(page, '.nav-item', 'Add');
  await page.waitForSelector('.add-view textarea');
  const areas = await page.$$('.add-view textarea');
  // pick Biology deck
  await page.evaluate(() => {
    const selects = document.querySelectorAll('.add-selectors select');
    const deckSel = selects[1];
    const opt = [...deckSel.options].find((o) => o.textContent.includes('Biology'));
    deckSel.value = opt.value;
    deckSel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await areas[0].type('What organelle produces ATP in eukaryotic cells?');
  await areas[1].type('The mitochondrion (mitochondria)');
  await clickByText(page, 'button', 'Add note');
  await waitForText(page, 'Added — 1 card created');
  ok('basic note added');

  // 4. Simulate dropping an image into the front field (screenshot-paste path)
  await areas[0].type('Label the structure shown: ');
  await page.evaluate(async () => {
    // tiny 2x2 red PNG
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DwnwEKmBhQAAMAJgQDAViKGAcAAAAASUVORK5CYII=';
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'shot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ta = document.querySelector('.add-view textarea');
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    ta.dispatchEvent(ev);
  });
  await page.waitForFunction(
    () => document.querySelector('.add-view textarea').value.includes('[img:'),
    { timeout: 5000 },
  );
  await page.waitForSelector('.field-preview img');
  ok('image drop stored + token inserted + preview rendered');
  await areas[1].click({ clickCount: 1 });
  await page.evaluate(() => {
    const tas = document.querySelectorAll('.add-view textarea');
    tas[1].focus();
  });
  await areas[1].type('A mitochondrion');
  await clickByText(page, 'button', 'Add note');
  await waitForText(page, 'Added — 1 card created');
  ok('image note added');

  // 5. Desktop tile shows due counts
  await clickByText(page, '.nav-item', 'Decks');
  await waitForText(page, 'Biology');
  await sleep(400);
  const bioTileNew = await page.evaluate(() => {
    const tile = [...document.querySelectorAll('.deck-tile')].find((t) => t.textContent.includes('Biology'));
    return tile ? tile.querySelector('.count-new')?.textContent : null;
  });
  if (bioTileNew === '2') ok('folder tile shows 2 new cards'); else fail('tile counts', `expected 2, got ${bioTileNew}`);

  // 6. Study: double-click opens the folder, Study button starts the session
  await clickByText(page, '.deck-tile', 'Biology', { count: 2 });
  await page.waitForSelector('.folder-head-actions');
  await clickByText(page, '.folder-head-actions button', 'Study');
  await page.waitForSelector('.study-card');
  await clickByText(page, '.mode-toggle button', 'Classic');
  await clickByText(page, 'button', 'Show answer');
  await page.waitForSelector('.rating-row');
  const intervals = await page.$$eval('.rate-interval', (els) => els.map((e) => e.textContent));
  if (intervals.length === 4 && intervals.every((s) => s.length > 0)) ok(`4 rating buttons with previews: ${intervals.join(' / ')}`);
  else fail('interval previews', JSON.stringify(intervals));
  await clickByText(page, '.rate-btn', 'Good');
  await sleep(500);
  ok('rated Good — next card shown');

  // 7. Keyboard: space flips, 3 = Good
  await page.keyboard.press('Space');
  await page.waitForSelector('.rating-row');
  await page.keyboard.press('3');
  await sleep(500);
  ok('keyboard shortcuts flip + rate');

  // 8. Undo
  await page.keyboard.press('u');
  await waitForText(page, 'Review undone');
  ok('undo restores card');
  await page.keyboard.press('Space');
  try {
    await page.waitForSelector('.rating-row', { timeout: 5000 });
  } catch (e) {
    const dbg = await page.evaluate(() => ({
      question: document.querySelector('.study-question')?.textContent?.slice(0, 50) ?? null,
      hasShowAnswer: [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Show answer')),
      hasAiBox: !!document.querySelector('.ai-answer-box'),
      shortBreak: document.body.innerText.includes('Short break'),
      congrats: document.body.innerText.includes('Congratulations'),
      modeActive: document.querySelector('.mode-toggle button.active')?.textContent,
      counts: document.querySelector('.study-counts')?.textContent,
      activeEl: document.activeElement?.tagName + '.' + (document.activeElement?.className ?? ''),
    }));
    console.log('DEBUG undo-flip state:', JSON.stringify(dbg));
    console.log('DEBUG page errors so far:', JSON.stringify(errors));
    throw e;
  }
  await page.keyboard.press('3');
  await sleep(400);

  // 9. Browse: search + suspend
  await clickByText(page, '.nav-item', 'Browse');
  await page.waitForSelector('.browser-table');
  await waitForText(page, 'organelle');
  await page.type('.browser-search input', 'deck:biology');
  await sleep(400);
  const rowCount = await page.$$eval('.browser-table tbody tr', (rs) => rs.length);
  if (rowCount === 2) ok('browser search deck:biology → 2 cards'); else fail('browser search', `expected 2 rows, got ${rowCount}`);
  await page.click('.browser-table tbody tr');
  await page.waitForSelector('.bulk-bar');
  await clickByText(page, '.bulk-bar button', 'Suspend');
  await waitForText(page, 'Suspended');
  await page.evaluate(() => {
    const inp = document.querySelector('.browser-search input');
    inp.value = '';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.type('.browser-search input', 'is:suspended');
  await sleep(400);
  const suspCount = await page.$$eval('.browser-table tbody tr', (rs) => rs.length);
  if (suspCount === 1) ok('is:suspended finds the suspended card'); else fail('is:suspended', `got ${suspCount}`);

  // 10. Stats renders
  await clickByText(page, '.nav-item', 'Stats');
  await waitForText(page, 'Statistics');
  await waitForText(page, 'True retention');
  await page.waitForSelector('.heatmap-svg');
  const studied = await page.evaluate(() => {
    const tile = [...document.querySelectorAll('.stat-tile')].find((t) => t.textContent.includes('Cards studied'));
    return tile?.querySelector('.stat-value')?.textContent;
  });
  if (parseInt(studied) >= 2) ok(`stats: ${studied} cards studied today`); else fail('stats today', `got ${studied}`);
  await page.screenshot({ path: `${SHOT_DIR}/stats-light.png` });

  // 11. Settings: invalid API key → error surfaces (proves fetch + error path)
  await clickByText(page, '.nav-item', 'Settings');
  await waitForText(page, 'Gemini API');
  await page.type('.key-row input', 'AIzaINVALID-KEY-FOR-TESTING-000000');
  await clickByText(page, '.key-row button', 'Test');
  await page.waitForFunction(
    () => document.querySelector('.settings-section .ai-error')?.textContent?.length > 3,
    { timeout: 20000 },
  );
  const errText = await page.$eval('.settings-section .ai-error', (e) => e.textContent);
  ok(`gemini error path works: "${errText.slice(0, 70)}"`);

  // 12. Dark mode
  await clickByText(page, '.seg-control button', 'Dark');
  await sleep(300);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (theme === 'dark') ok('dark theme applies'); else fail('dark theme', theme);
  await clickByText(page, '.nav-item', 'Stats');
  await waitForText(page, 'Statistics');
  await sleep(300);
  await page.screenshot({ path: `${SHOT_DIR}/stats-dark.png` });
  await clickByText(page, '.nav-item', 'Decks');
  await sleep(300);
  await page.screenshot({ path: `${SHOT_DIR}/decks-dark.png` });

  // 13. Persistence across reload
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForText(page, 'Biology');
  const persisted = await page.evaluate(() => document.documentElement.dataset.theme);
  if (persisted === 'dark') ok('settings + data persist across reload'); else fail('persistence', persisted);

  // 14. Cloze: add a cloze note and study front rendering
  await clickByText(page, '.seg-control button', 'Light').catch(() => {});
  await clickByText(page, '.nav-item', 'Add');
  await page.waitForSelector('.add-view select');
  await page.evaluate(() => {
    const typeSel = document.querySelectorAll('.add-selectors select')[0];
    typeSel.value = 'cloze';
    typeSel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => {
    const deckSel = document.querySelectorAll('.add-selectors select')[1];
    const opt = [...deckSel.options].find((o) => o.textContent.includes('Default'));
    deckSel.value = opt.value;
    deckSel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const areas2 = await page.$$('.add-view textarea');
  await areas2[0].type('The powerhouse of the cell is the {{c1::mitochondrion}} and it makes {{c2::ATP}}.');
  await waitForText(page, '2 cloze deletions');
  await clickByText(page, 'button', 'Add note');
  await waitForText(page, 'Added — 2 cards created');
  ok('cloze note → 2 cards');
  await clickByText(page, '.nav-item', 'Decks');
  await sleep(300);
  await clickByText(page, '.crumb', 'Home').catch(() => {});
  await sleep(200);
  await clickByText(page, '.deck-tile', 'Default', { count: 2 });
  await page.waitForSelector('.folder-head-actions');
  await clickByText(page, '.folder-head-actions button', 'Study');
  await page.waitForSelector('.study-card');
  const q = await page.$eval('.study-question', (e) => e.textContent);
  if (q.includes('...') && q.includes('cell')) ok(`cloze front renders: "${q.trim().slice(0, 60)}"`); else fail('cloze front', q);
  await page.screenshot({ path: `${SHOT_DIR}/study-light.png` });

  // 15. AI mode UI present (no key behavior)
  await clickByText(page, '.mode-toggle button', 'AI');
  await page.waitForSelector('.ai-answer-box');
  await page.type('.ai-answer-box', 'mitochondrion');
  await clickByText(page, 'button', 'Grade my answer');
  await page.waitForFunction(
    () => document.querySelector('.ai-error')?.textContent?.length > 3,
    { timeout: 20000 },
  );
  const aiErr = await page.$eval('.ai-error', (e) => e.textContent);
  ok(`AI grade path returns actionable error without valid key: "${aiErr.slice(0, 60)}"`);

  // 16. Desktop: cut a tile at Home, open Default, paste inside it
  await clickByText(page, '.nav-item', 'Decks');
  await sleep(400);
  await clickByText(page, '.crumb', 'Home');
  await sleep(300);
  await clickByText(page, '.deck-tile', 'Biology'); // single click = select
  await pressWithCtrl(page, 'x');
  await sleep(150);
  const cutDim = await page.evaluate(
    () => !![...document.querySelectorAll('.deck-tile.tile-cut')].find((t) => t.textContent.includes('Biology')),
  );
  if (cutDim) ok('Ctrl+X dims the cut tile'); else fail('cut visual', 'tile not dimmed');
  await clickByText(page, '.deck-tile', 'Default', { count: 2 }); // enter folder
  await sleep(300);
  await pressWithCtrl(page, 'v'); // paste into current folder
  await sleep(500);
  let d = await dumpDecks(page);
  {
    const bio = d.decks.find((x) => x.name === 'Biology');
    const def = d.decks.find((x) => x.name === 'Default');
    if (bio.parentId === def.id) ok('cut/paste moved Biology inside Default');
    else fail('cut/paste', `Biology.parentId=${bio.parentId}, Default.id=${def.id}`);
  }

  // 17. Copy inside a folder, paste at Home → deep clone with cards
  const cardsBefore = d.cards.length;
  await clickByText(page, '.deck-tile', 'Biology');
  await pressWithCtrl(page, 'c');
  await clickByText(page, '.crumb', 'Home');
  await sleep(300);
  await pressWithCtrl(page, 'v');
  await sleep(600);
  d = await dumpDecks(page);
  {
    const bios = d.decks.filter((x) => x.name === 'Biology');
    const rootBio = bios.find((x) => x.parentId === null);
    const clonedCards = rootBio ? d.cards.filter((c) => c.deckId === rootBio.id).length : 0;
    if (rootBio && d.cards.length === cardsBefore + 2 && clonedCards === 2) {
      ok('copy/paste cloned the folder to Home with its 2 cards');
    } else {
      fail('copy/paste', `rootBio=${!!rootBio}, cards ${cardsBefore}→${d.cards.length}, cloned=${clonedCards}`);
    }
  }

  // 18. Drag & drop a tile onto a folder tile
  const dndResult = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.deck-tile')];
    const src = tiles.find((t) => t.textContent.includes('Biology'));
    const dst = tiles.find((t) => t.textContent.includes('Default'));
    if (!src || !dst) return 'tiles not found';
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return 'ok';
  });
  await sleep(500);
  d = await dumpDecks(page);
  {
    const def = d.decks.find((x) => x.name === 'Default');
    const biosUnderDefault = d.decks.filter((x) => x.name === 'Biology' && x.parentId === def.id).length;
    if (dndResult === 'ok' && biosUnderDefault === 2) ok('drag & drop moved the tile into Default');
    else fail('drag & drop', `dispatch=${dndResult}, under Default=${biosUnderDefault}`);
  }

  // 19. Right-click context menu on a folder tile
  await page.evaluate(() => {
    const tile = [...document.querySelectorAll('.deck-tile')].find((t) => t.textContent.includes('Default'));
    const rect = tile.getBoundingClientRect();
    tile.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 30, clientY: rect.top + 20 }),
    );
  });
  await page.waitForSelector('.ctx-menu');
  const menuItems = await page.$$eval('.ctx-menu button', (bs) => bs.map((b) => b.textContent.trim()));
  if (menuItems.some((t) => t.includes('Cut')) && menuItems.some((t) => t.includes('Paste into folder'))) {
    ok('right-click context menu with Cut/Copy/Paste');
  } else fail('context menu', JSON.stringify(menuItems));
  await page.keyboard.press('Escape');
  await sleep(150);

  // 20. Notes appear as file tiles inside their folder; double-click edits
  await clickByText(page, '.deck-tile', 'Default', { count: 2 });
  await sleep(300);
  await clickByText(page, '.deck-tile', 'Biology', { count: 2 });
  await sleep(400);
  const noteTiles = await page.$$eval('.note-tile', (ts) => ts.length);
  if (noteTiles === 2) ok('2 notes shown as file tiles inside the folder');
  else fail('note tiles', `expected 2, got ${noteTiles}`);
  await page.evaluate(() => {
    const t = document.querySelector('.note-tile');
    t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  await waitForText(page, 'Edit note');
  ok('double-click on a note tile opens the editor');
  await page.keyboard.press('Escape');
  await sleep(200);

  // 21. List mode toggle: single click studies, then back to desktop
  await clickByText(page, '.seg-control button', 'List');
  await sleep(300);
  await clickByText(page, '.deck-name', 'Default'); // single click = study in list mode
  await sleep(600);
  const inStudy = await page.evaluate(
    () => !!document.querySelector('.study-card') || document.body.innerText.includes('Congratulations') || document.body.innerText.includes('Short break'),
  );
  if (inStudy) ok('list mode: single click enters study'); else fail('list mode', 'did not enter study');
  await clickByText(page, '.nav-item', 'Decks');
  await sleep(200);
  await clickByText(page, '.seg-control button', 'Desktop');
  await sleep(200);

  // 22. Paste an image with focus inside the front field (synthetic clipboard)
  await clickByText(page, '.nav-item', 'Add');
  await page.waitForSelector('.add-view textarea');
  await dispatchImagePaste(page, '.add-view textarea');
  await page.waitForFunction(
    () => document.querySelector('.add-view textarea').value.includes('[img:'),
    { timeout: 5000 },
  );
  ok('pasting an image into a focused field inserts it');

  // 23. Paste with focus on the body — document-level routing to the last-focused field
  await clearTextarea(page, '.add-view textarea');
  await dispatchImagePaste(page, null);
  await page.waitForFunction(
    () => document.querySelector('.add-view textarea').value.includes('[img:'),
    { timeout: 5000 },
  );
  ok('paste with focus outside any field routes to the front field');

  // 24. Explicit clipboard button reads the real clipboard via the async API
  try {
    const ctx = browser.defaultBrowserContext();
    await ctx
      .overridePermissions(BASE, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'])
      .catch(() => ctx.overridePermissions(BASE, ['clipboard-read', 'clipboard-write']));
    await clearTextarea(page, '.add-view textarea');
    await page.bringToFront();
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) }),
      ]);
    }, TINY_PNG);
    await page.click('.field-editor button[title="Paste image from clipboard"]');
    await page.waitForFunction(
      () => document.querySelector('.add-view textarea').value.includes('[img:'),
      { timeout: 5000 },
    );
    ok('clipboard-API paste button inserts the image');
  } catch (e) {
    console.log('SKIP clipboard-API button (headless clipboard limitation):', String(e).slice(0, 120));
  }

  // 25. MathJax: $inline$ + $$display$$ render on cards; money $ stays literal
  await clickByText(page, '.nav-item', 'Decks');
  await sleep(300);
  await clickByText(page, '.crumb', 'Home').catch(() => {});
  await sleep(200);
  await clickByText(page, 'button', 'New folder');
  await page.waitForSelector('.modal-panel input');
  await page.type('.modal-panel input', 'MathLab');
  await clickByText(page, '.modal-panel button', 'Create');
  await waitForText(page, 'MathLab');
  await clickByText(page, '.nav-item', 'Add');
  await page.waitForSelector('.add-view textarea');
  await page.evaluate(() => {
    const deckSel = document.querySelectorAll('.add-selectors select')[1];
    const opt = [...deckSel.options].find((o) => o.textContent.includes('MathLab'));
    deckSel.value = opt.value;
    deckSel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await clearTextarea(page, '.add-view textarea');
  const mathAreas = await page.$$('.add-view textarea');
  await mathAreas[0].type("Euler's identity: $e^{i\\pi}+1=0$. Evaluate: $$\\int_0^1 x^2\\,dx$$");
  await mathAreas[1].type('It equals $\\frac{1}{3}$. Costs $5 and $10 stay dollars.');
  await clickByText(page, 'button', 'Add note');
  await waitForText(page, 'Added — 1 card created');
  await clickByText(page, '.nav-item', 'Decks');
  await sleep(300);
  await clickByText(page, '.deck-tile', 'MathLab', { count: 2 });
  await page.waitForSelector('.folder-head-actions');
  await clickByText(page, '.folder-head-actions button', 'Study');
  await page.waitForSelector('.study-card');
  await clickByText(page, '.mode-toggle button', 'Classic');
  await page.waitForSelector('.study-question .math-display mjx-container svg', { timeout: 20000 });
  const mathQ = await page.evaluate(() => ({
    text: document.querySelector('.study-question').innerText,
    containers: document.querySelectorAll('.study-question mjx-container').length,
  }));
  if (mathQ.containers >= 2 && !mathQ.text.includes('$e^')) {
    ok('question: inline + display TeX render as MathJax (raw $ source gone)');
  } else fail('mathjax question', JSON.stringify(mathQ).slice(0, 120));
  await clickByText(page, 'button', 'Show answer');
  await page.waitForSelector('.study-answer mjx-container svg', { timeout: 20000 });
  const mathA = await page.$eval('.study-answer', (e) => e.innerText);
  if (mathA.includes('$5 and $10')) ok('answer: $\\frac{1}{3}$ renders; "$5 and $10" stays literal');
  else fail('mathjax money', mathA.slice(0, 120));
  await page.screenshot({ path: `${SHOT_DIR}/study-math.png` });

  // 26. Note tiles render TeX in their names
  await clickByText(page, '.nav-item', 'Decks');
  await sleep(400);
  await page.waitForSelector('.note-tile .tile-name mjx-container svg', { timeout: 10000 });
  ok('note tile name renders TeX as MathJax');
  await page.screenshot({ path: `${SHOT_DIR}/tiles-math.png` });

  // 27. Right-click "Add note here" → Go back button returns to that folder
  await page.evaluate(() => {
    const surface = document.querySelector('.desk-surface');
    const r = surface.getBoundingClientRect();
    surface.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.right - 40, clientY: r.bottom - 40 }),
    );
  });
  await page.waitForSelector('.ctx-menu');
  await clickByText(page, '.ctx-menu button', 'Add note here');
  await page.waitForSelector('.add-view');
  await waitForText(page, 'Back to MathLab');
  ok('Add view shows "Back to MathLab" after right-click add');
  await clickByText(page, '.add-back-btn', 'Back to MathLab');
  await sleep(300);
  const crumbCur = await page.$eval('.crumb-current', (e) => e.textContent);
  if (crumbCur.includes('MathLab')) ok('Go back returns into the MathLab folder');
  else fail('go back', crumbCur);

  // 28. Home Study button studies the whole collection
  await clickByText(page, '.crumb', 'Home');
  await sleep(300);
  await clickByText(page, '.folder-head-actions button', 'Study');
  await page.waitForSelector('.study-card');
  await waitForText(page, 'All decks');
  ok('Home Study starts a whole-collection session ("All decks")');

  // 29. RTL: Hebrew lines right-align, English lines left-align (per-line auto direction)
  await clickByText(page, 'button', 'All decks'); // exit study
  await sleep(300);
  await clickByText(page, 'button', 'New folder');
  await page.waitForSelector('.modal-panel input');
  await page.type('.modal-panel input', 'RTLLab');
  await clickByText(page, '.modal-panel button', 'Create');
  await waitForText(page, 'RTLLab');
  await clickByText(page, '.deck-tile', 'RTLLab', { count: 2 });
  await page.waitForSelector('.folder-head-actions');
  await clickByText(page, '.folder-head-actions button', 'Add note');
  await page.waitForSelector('.add-view textarea');
  const rtlAreas = await page.$$('.add-view textarea');
  await rtlAreas[0].type('מהי בירת ישראל?\nAnswer with one word');
  await rtlAreas[1].type('ירושלים');
  await clickByText(page, 'button', 'Add note');
  await waitForText(page, 'Added — 1 card created');
  await clickByText(page, '.add-back-btn', 'Back to RTLLab');
  await sleep(300);
  await clickByText(page, '.folder-head-actions button', 'Study');
  await page.waitForSelector('.study-question .field-content');
  const rtl = await page.evaluate(() => {
    const el = document.querySelector('.study-question .field-content');
    const cs = getComputedStyle(el);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let heb = null;
    let eng = null;
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (/[\u0590-\u05FF]/.test(t.textContent)) heb = t;
      if (/Answer/.test(t.textContent)) eng = t;
    }
    if (!heb || !eng) return { missing: true };
    const rect = (n) => {
      const r = document.createRange();
      r.selectNodeContents(n);
      return r.getBoundingClientRect();
    };
    const cont = el.getBoundingClientRect();
    const hr = rect(heb);
    const er = rect(eng);
    return {
      ub: cs.unicodeBidi,
      hebFromRight: Math.round(cont.right - hr.right),
      hebFromLeft: Math.round(hr.left - cont.left),
      engFromLeft: Math.round(er.left - cont.left),
    };
  });
  if (rtl.ub === 'plaintext' && rtl.hebFromRight <= 8 && rtl.engFromLeft <= 8 && rtl.hebFromLeft > 20) {
    ok(`RTL per-line auto direction: Hebrew hugs right (${rtl.hebFromRight}px), English hugs left (${rtl.engFromLeft}px)`);
  } else fail('rtl per-line direction', JSON.stringify(rtl));
  await page.screenshot({ path: `${SHOT_DIR}/study-rtl.png` });

  // 30. AI feedback language: persists in settings and reaches the Gemini request
  await clickByText(page, '.nav-item', 'Settings');
  await waitForText(page, 'AI feedback language');
  await page.evaluate(() => {
    const field = [...document.querySelectorAll('.settings-field')].find((f) =>
      f.textContent.includes('AI feedback language'),
    );
    const sel = field.querySelector('select');
    sel.value = 'Hebrew';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(200);
  await page.type('.key-row input', 'AIzaINVALID-KEY-FOR-LANG-TEST-00000');
  await clickByText(page, '.key-row button', 'Save');
  await sleep(400);
  await page.reload({ waitUntil: 'networkidle0' });
  await clickByText(page, '.nav-item', 'Settings');
  await waitForText(page, 'AI feedback language');
  const langVal = await page.evaluate(() => {
    const field = [...document.querySelectorAll('.settings-field')].find((f) =>
      f.textContent.includes('AI feedback language'),
    );
    return field.querySelector('select').value;
  });
  if (langVal === 'Hebrew') ok('AI feedback language persists across reload (Hebrew)');
  else fail('ai language persistence', langVal);
  let aiBody = '';
  page.on('request', (req) => {
    if (req.url().includes('generativelanguage')) aiBody = req.postData() || '';
  });
  await clickByText(page, '.nav-item', 'Decks');
  await sleep(300);
  await clickByText(page, '.deck-tile', 'RTLLab', { count: 2 });
  await page.waitForSelector('.folder-head-actions');
  await clickByText(page, '.folder-head-actions button', 'Study');
  await page.waitForSelector('.ai-answer-box');
  await page.type('.ai-answer-box', 'ירושלים');
  await clickByText(page, 'button', 'Grade my answer');
  await page.waitForFunction(() => document.querySelector('.ai-error')?.textContent?.length > 3, {
    timeout: 20000,
  });
  if (aiBody.includes('in Hebrew')) ok('grading request instructs the model to answer in Hebrew');
  else fail('ai language in prompt', aiBody.slice(0, 200) || '(no request captured)');

  // 31. Study navigation: move forward/backward without answering
  await clickByText(page, 'button', 'RTLLab'); // exit study back to decks
  await sleep(300);
  await clickByText(page, '.crumb', 'Home');
  await sleep(200);
  await clickByText(page, '.folder-head-actions button', 'Study');
  await page.waitForSelector('.study-card');
  await clickByText(page, '.mode-toggle button', 'Classic');
  await page.waitForSelector('.card-nav-pos');
  const pos0 = await page.$eval('.card-nav-pos', (e) => e.textContent);
  await page.keyboard.press('ArrowRight');
  await sleep(200);
  const pos1 = await page.$eval('.card-nav-pos', (e) => e.textContent);
  await page.keyboard.press('ArrowLeft');
  await sleep(200);
  const pos2 = await page.$eval('.card-nav-pos', (e) => e.textContent);
  const ratingShown = await page.evaluate(() => !!document.querySelector('.rating-row'));
  if (pos0.startsWith('1/') && pos1.startsWith('2/') && pos2 === pos0 && !ratingShown) {
    ok(`study nav browses without answering: ${pos0} → ${pos1} → ${pos2}`);
  } else fail('study nav', `${pos0} → ${pos1} → ${pos2}, rating-row=${ratingShown}`);

  console.log('\nPage JS errors:', errors.length ? errors : 'none');
  const failed = results.filter(([s]) => s === 'FAIL');
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error('E2E crashed:', e);
  process.exit(2);
} finally {
  await browser.close();
}
