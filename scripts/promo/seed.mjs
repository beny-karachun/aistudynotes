// Seed the AIstudynotes IndexedDB with a rich, realistic demo collection for the
// promo video: nested decks, notes (basic / cloze / image / math), a drawn cell
// diagram stored as media, and ~150 days of review history so the stats page and
// deck counters look like a real long-term study collection.
//
// Runs entirely inside the page (passed to page.evaluate). Uses real Date.now()
// so revlog timestamps land correctly on the heatmap relative to "today".

export const seedInPage = async () => {
  const DAY = 86_400_000;
  const now = Date.now();
  const uid = () => crypto.randomUUID();
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const weighted = (pairs) => {
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [v, w] of pairs) {
      if ((r -= w) <= 0) return v;
    }
    return pairs[0][0];
  };

  const DEFAULT_CONFIG = {
    newPerDay: 20,
    reviewsPerDay: 200,
    learningStepsMin: [1, 10],
    relearningStepsMin: [10],
    desiredRetention: 0.9,
  };

  // ---------- draw a labeled cell diagram as media ----------
  async function drawCellDiagram() {
    const c = document.createElement('canvas');
    c.width = 720;
    c.height = 440;
    const x = c.getContext('2d');
    x.fillStyle = '#f2f7f6';
    x.fillRect(0, 0, c.width, c.height);
    // cell membrane
    x.save();
    x.translate(360, 220);
    x.beginPath();
    x.ellipse(0, 0, 320, 190, 0, 0, Math.PI * 2);
    x.fillStyle = '#d7efe9';
    x.strokeStyle = '#0d9488';
    x.lineWidth = 6;
    x.fill();
    x.stroke();
    // nucleus
    x.beginPath();
    x.ellipse(-40, -10, 92, 78, 0, 0, Math.PI * 2);
    x.fillStyle = '#7c5cff';
    x.globalAlpha = 0.85;
    x.fill();
    x.globalAlpha = 1;
    x.beginPath();
    x.ellipse(-40, -10, 34, 30, 0, 0, Math.PI * 2);
    x.fillStyle = '#4c33cc';
    x.fill();
    // mitochondria
    const mito = (cx, cy, rot) => {
      x.save();
      x.translate(cx, cy);
      x.rotate(rot);
      x.beginPath();
      x.ellipse(0, 0, 62, 30, 0, 0, Math.PI * 2);
      x.fillStyle = '#ea580c';
      x.fill();
      x.strokeStyle = '#b8460b';
      x.lineWidth = 4;
      x.stroke();
      x.beginPath();
      for (let i = -44; i <= 44; i += 18) {
        x.moveTo(i, -24);
        x.quadraticCurveTo(i + 9, 0, i, 24);
      }
      x.strokeStyle = '#fff';
      x.globalAlpha = 0.7;
      x.lineWidth = 3;
      x.stroke();
      x.restore();
    };
    mito(150, -80, -0.4);
    mito(120, 90, 0.5);
    // ER around nucleus
    x.globalAlpha = 0.9;
    x.strokeStyle = '#0ea5a0';
    x.lineWidth = 5;
    for (let r = 118; r <= 150; r += 16) {
      x.beginPath();
      x.arc(-40, -10, r, -0.6, 2.2);
      x.stroke();
    }
    x.globalAlpha = 1;
    x.restore();
    // labels + leader lines
    x.font = '600 22px Inter, system-ui, sans-serif';
    x.textBaseline = 'middle';
    const label = (text, tx, ty, lx, ly) => {
      x.strokeStyle = '#334155';
      x.lineWidth = 2;
      x.beginPath();
      x.moveTo(tx, ty);
      x.lineTo(lx, ly);
      x.stroke();
      x.fillStyle = '#0f172a';
      const w = x.measureText(text).width;
      const bx = tx > lx ? tx : tx - w;
      x.fillStyle = '#ffffff';
      x.fillRect(bx - 6, ty - 15, w + 12, 30);
      x.fillStyle = '#0f172a';
      x.fillText(text, bx, ty);
    };
    label('Nucleus', 40, 40, 300, 205);
    label('Mitochondrion', 560, 120, 470, 150);
    label('Endoplasmic reticulum', 250, 400, 300, 300);
    const blob = await new Promise((res) => c.toBlob(res, 'image/webp', 0.9));
    return blob;
  }

  const cellBlob = await drawCellDiagram();
  const cellMediaId = uid();

  // ---------- deck tree ----------
  const decks = [];
  const mkDeck = (name, parentId = null, createdAt = now - 120 * DAY) => {
    const d = { id: uid(), name, parentId, config: { ...DEFAULT_CONFIG }, collapsed: 0, createdAt };
    decks.push(d);
    return d;
  };

  const biology = mkDeck('Biology');
  const languages = mkDeck('Languages');
  const spanish = mkDeck('Spanish', languages.id);
  const french = mkDeck('French', languages.id);
  const chemistry = mkDeck('Chemistry');
  const neuro = mkDeck('Neuroscience');
  const history = mkDeck('World History');

  const notes = [];
  const cards = [];

  // Add a NEW card (state 0) — used for the deterministic study demo & tile badges.
  const addNewNote = (deck, type, front, back, tags, order) => {
    const createdAt = now - 60 * DAY + order * 1000; // stable ordering within a deck
    const note = { id: uid(), deckId: deck.id, type, front, back, tags: tags || [], createdAt, updatedAt: createdAt };
    notes.push(note);
    const ords = type === 'cloze' ? clozeOrds(front) : type === 'basicReversed' ? [0, 1] : [0];
    for (const ord of ords) {
      cards.push(newCard(note.id, deck.id, ord, createdAt));
    }
    return note;
  };

  // Add a mature/review note (state 2) with history — feeds stats & forecast.
  const addReviewNote = (deck, front, back, tags, ageDays) => {
    const createdAt = now - ageDays * DAY;
    const note = { id: uid(), deckId: deck.id, type: 'basic', front, back, tags: tags || [], createdAt, updatedAt: createdAt };
    notes.push(note);
    const sched = randInt(4, 70);
    const mature = sched >= 21;
    const card = {
      id: uid(),
      noteId: note.id,
      deckId: deck.id,
      ord: 0,
      due: now + randInt(1, 75) * DAY, // spread into the future for the forecast
      stability: mature ? rand(25, 130) : rand(4, 20),
      difficulty: rand(4.5, 7.5),
      elapsed_days: randInt(1, sched),
      scheduled_days: sched,
      learning_steps: 0,
      reps: randInt(3, 32),
      lapses: randInt(0, 3),
      state: 2,
      last_review: now - randInt(1, sched) * DAY,
      suspended: Math.random() < 0.04 ? 1 : 0,
      flag: Math.random() < 0.08 ? pick([1, 2, 3]) : 0,
      createdAt,
    };
    cards.push(card);
    return { note, card, sched };
  };

  function newCard(noteId, deckId, ord, createdAt) {
    return {
      id: uid(),
      noteId,
      deckId,
      ord,
      due: createdAt,
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      learning_steps: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      suspended: 0,
      flag: 0,
      createdAt,
    };
  }
  function clozeOrds(text) {
    const set = new Set();
    for (const m of text.matchAll(/\{\{c(\d+)::/g)) set.add(parseInt(m[1], 10));
    return set.size ? [...set].sort((a, b) => a - b) : [1];
  }

  // ---------- Biology: the deterministic study-demo deck (NEW cards, ordered) ----------
  addNewNote(
    biology,
    'basic',
    'Which organelle is known as the powerhouse of the cell?',
    'The **mitochondrion**. It generates most of the cell\'s ATP through aerobic respiration (oxidative phosphorylation).',
    ['cell-biology'],
    0,
  );
  addNewNote(
    biology,
    'basic',
    'What is the primary function of ribosomes?',
    'Protein synthesis. Ribosomes read the codons of messenger RNA (mRNA) and translate them into a chain of amino acids, building a polypeptide.',
    ['cell-biology'],
    1,
  );
  addNewNote(
    biology,
    'cloze',
    'The {{c1::nucleus}} stores the cell\'s genetic material as {{c2::DNA}}, which is transcribed into {{c3::mRNA}} before leaving the nucleus.',
    'The central control center of a eukaryotic cell.',
    ['cell-biology'],
    2,
  );
  addNewNote(
    biology,
    'basic',
    `Identify the organelle wrapped around the nucleus in this diagram:\n[img:${cellMediaId}]`,
    'The **endoplasmic reticulum** (ER) — rough ER (studded with ribosomes) makes proteins; smooth ER makes lipids.',
    ['cell-biology', 'diagram'],
    3,
  );
  addNewNote(
    biology,
    'basic',
    'What process do plants use to convert light energy into chemical energy?',
    'Photosynthesis: $6CO_2 + 6H_2O \\xrightarrow{light} C_6H_{12}O_6 + 6O_2$.',
    ['cell-biology'],
    4,
  );

  // ---------- Languages ----------
  const es = [
    ['la biblioteca', 'the library'],
    ['aprender', 'to learn'],
    ['el conocimiento', 'knowledge'],
    ['la memoria', 'memory / remembrance'],
    ['repasar', 'to review / revise'],
    ['el examen', 'the exam'],
  ];
  es.forEach(([f, b], i) => addNewNote(spanish, 'basic', f, b, ['spanish'], i));
  const fr = [
    ['la connaissance', 'knowledge'],
    ['apprendre', 'to learn'],
    ['se souvenir', 'to remember'],
    ['réviser', 'to revise'],
    ['la bibliothèque', 'the library'],
  ];
  fr.forEach(([f, b], i) => addNewNote(french, 'basic', f, b, ['french'], i));

  // ---------- Chemistry (math) ----------
  addNewNote(
    chemistry,
    'basic',
    'State the ideal gas law and define each term.',
    'Ideal gas law: $PV = nRT$ — where $P$ is pressure, $V$ volume, $n$ moles, $R$ the gas constant, and $T$ absolute temperature.',
    ['chemistry'],
    0,
  );
  addNewNote(
    chemistry,
    'cloze',
    'The equilibrium constant is written $K_{eq} = \\dfrac{[\\text{products}]}{[\\text{reactants}]}$ and depends only on {{c1::temperature}}.',
    '',
    ['chemistry'],
    1,
  );
  addNewNote(
    chemistry,
    'basic',
    'What is the pH of a solution with $[H^+] = 10^{-4}\\,M$?',
    '$pH = -\\log_{10}[H^+] = 4$.',
    ['chemistry'],
    2,
  );

  // ---------- Neuroscience & History: a few NEW cards so their tiles show due counts ----------
  [
    ['What is the function of the myelin sheath?', 'It insulates axons and speeds up nerve-impulse conduction (saltatory conduction).'],
    ['Name the three main parts of a neuron.', 'The dendrites, the cell body (soma), and the axon.'],
    ['What neurotransmitter is most associated with reward?', 'Dopamine.'],
    ['What is long-term potentiation (LTP)?', 'A lasting strengthening of synapses — a cellular basis of learning and memory.'],
  ].forEach(([f, b], i) => addNewNote(neuro, 'basic', f, b, ['neuroscience'], i));
  [
    ['In what year did the Berlin Wall fall?', '1989.'],
    ['Who wrote the *Declaration of Independence* (primary author)?', 'Thomas Jefferson.'],
    ['What ancient civilization built Machu Picchu?', 'The Inca.'],
    ['What was the Magna Carta (1215)?', 'A charter limiting the English king’s power — a foundation of constitutional law.'],
  ].forEach(([f, b], i) => addNewNote(history, 'basic', f, b, ['history'], i));

  // ---------- big pool of review notes for stats depth ----------
  const bioReview = [
    ['What is diffusion?', 'Net movement of particles from high to low concentration until equilibrium.'],
    ['Define osmosis.', 'Diffusion of water across a semi-permeable membrane toward higher solute concentration.'],
    ['What is the role of chlorophyll?', 'A pigment that absorbs light (mainly red & blue) to drive photosynthesis.'],
    ['What are enzymes?', 'Biological catalysts (usually proteins) that lower activation energy of reactions.'],
    ['What is mitosis?', 'Cell division producing two genetically identical diploid daughter cells.'],
    ['What is meiosis?', 'Division producing four genetically distinct haploid gametes.'],
    ['What does DNA polymerase do?', 'Synthesizes new DNA strands during replication.'],
    ['Define homeostasis.', 'Maintenance of a stable internal environment despite external change.'],
  ];
  const chemReview = [
    ['What is an exothermic reaction?', 'A reaction that releases energy, usually as heat (ΔH < 0).'],
    ['Define electronegativity.', "An atom's tendency to attract shared electrons in a bond."],
    ['What is Avogadro\'s number?', '$6.022 \\times 10^{23}$ particles per mole.'],
    ['What is a catalyst?', 'A substance that speeds a reaction without being consumed.'],
    ['Define oxidation.', 'Loss of electrons (increase in oxidation state).'],
  ];
  const neuroReview = [
    ['What is a neuron?', 'The basic signaling cell of the nervous system.'],
    ['What is an action potential?', 'A rapid rise and fall in membrane voltage that propagates a signal.'],
    ['What is a synapse?', 'The junction where one neuron communicates with another.'],
    ['What is a neurotransmitter?', 'A chemical messenger released across a synapse (e.g. dopamine).'],
    ['What is myelin?', 'A fatty sheath that insulates axons and speeds conduction.'],
    ['What does the hippocampus do?', 'Central to forming new long-term memories.'],
    ['What is neuroplasticity?', "The brain's ability to reorganize connections with experience."],
  ];
  const histReview = [
    ['When did WWII end?', '1945.'],
    ['What was the Renaissance?', 'A 14th–17th c. European revival of art, science and learning.'],
    ['Who was the first Roman emperor?', 'Augustus (Octavian).'],
    ['What was the Silk Road?', 'A network of trade routes linking East and West.'],
    ['What sparked the Industrial Revolution?', 'Mechanization, steam power, and factory production in 18th c. Britain.'],
  ];
  const addPool = (deck, pool, tag) =>
    pool.forEach(([f, b], i) => addReviewNote(deck, f, b, [tag], randInt(30, 110) - i));
  addPool(biology, bioReview, 'cell-biology');
  addPool(chemistry, chemReview, 'chemistry');
  addPool(neuro, neuroReview, 'neuroscience');
  addPool(history, histReview, 'history');
  // extra volume for a fuller card-counts chart — kept off the decks shown as
  // tile grids on camera (Biology, Neuroscience) so their folders stay tidy
  for (let i = 0; i < 24; i++) addReviewNote(pick([chemistry, history]), `Review fact #${i + 1}`, 'Consolidated knowledge from earlier study.', ['review'], randInt(25, 115));

  // ---------- ~150 days of review history (heatmap, retention, AI-graded avg) ----------
  const revlog = [];
  const reviewCards = cards.filter((c) => c.state === 2);
  const AI_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];
  for (let d = 150; d >= 0; d--) {
    // recent ~45 days almost always studied (streak); older days patchier
    const recent = d < 45;
    if (!recent && Math.random() < 0.32) continue; // some skipped days further back
    if (recent && d !== 0 && Math.random() < 0.05) continue;
    const count = recent ? randInt(18, 55) : randInt(8, 40);
    const dayBase = now - d * DAY;
    for (let i = 0; i < count; i++) {
      const src = pick(reviewCards);
      // keep TODAY's reviews off the Biology deck so its study-demo queue stays full
      if (d === 0 && src.deckId === biology.id) continue;
      const rating = weighted([[3, 56], [4, 20], [2, 14], [1, 10]]);
      const stateBefore = weighted([[2, 82], [1, 10], [0, 8]]);
      const sched = stateBefore === 2 ? randInt(2, 80) : 0;
      const reviewAt = dayBase - randInt(0, 20) * 3_600_000 + i * 1000;
      const isAi = stateBefore === 2 && Math.random() < 0.42;
      revlog.push({
        id: uid(),
        cardId: src.id,
        noteId: src.noteId,
        deckId: src.deckId,
        rating,
        state: stateBefore,
        scheduled_days: sched,
        stability: rand(5, 120),
        difficulty: rand(4, 8),
        review: reviewAt,
        durationMs: randInt(2600, 16000),
        ...(isAi
          ? {
              ai: {
                score: rating === 1 ? randInt(28, 55) : rating === 2 ? randInt(58, 74) : randInt(78, 99),
                verdict: rating === 1 ? 'incorrect' : rating === 2 ? 'partially_correct' : 'correct',
                model: pick(AI_MODELS),
              },
            }
          : {}),
      });
    }
  }

  const settings = {
    id: 'app',
    theme: 'light',
    apiKey: 'AIzaSyD3moK3y-promo-video-not-a-real-key-000',
    model: 'gemini-3.1-flash-lite',
    aiStrictness: 'moderate',
    defaultStudyMode: 'classic',
    dayStartHour: 4,
    deckViewMode: 'desktop',
    aiLanguage: 'auto',
  };

  // ---------- write everything to IndexedDB ----------
  await new Promise((resolve, reject) => {
    const open = indexedDB.open('ankiai');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const idb = open.result;
      const tx = idb.transaction(['decks', 'notes', 'cards', 'revlog', 'media', 'settings'], 'readwrite');
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      for (const s of ['decks', 'notes', 'cards', 'revlog', 'media', 'settings']) tx.objectStore(s).clear();
      decks.forEach((r) => tx.objectStore('decks').put(r));
      notes.forEach((r) => tx.objectStore('notes').put(r));
      cards.forEach((r) => tx.objectStore('cards').put(r));
      revlog.forEach((r) => tx.objectStore('revlog').put(r));
      tx.objectStore('media').put({ id: cellMediaId, blob: cellBlob, mime: 'image/webp', createdAt: now });
      tx.objectStore('settings').put(settings);
      tx.oncomplete = () => {
        idb.close();
        resolve();
      };
    };
  });

  return { decks: decks.length, notes: notes.length, cards: cards.length, revlog: revlog.length };
};
