import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  GenSeedStrategyWithCardId,
  Rating as FsrsRating,
  StrategyMode,
  type Card as FsrsCard,
  type FSRS,
  type Grade,
  type RecordLogItem,
  type StepUnit,
} from 'ts-fsrs';
import { db, uid } from '../db';
import type {
  CardRecord,
  CardStateValue,
  Deck,
  DeckConfig,
  Rating,
  ReviewLogRecord,
  StudyCounts,
} from '../types';
import { CardState } from '../types';

// ---------- FSRS instances (one per deck config) ----------

const fsrsCache = new Map<string, FSRS>();

function schedulerFor(config: DeckConfig): FSRS {
  const key = JSON.stringify([
    config.desiredRetention,
    config.learningStepsMin,
    config.relearningStepsMin,
  ]);
  let f = fsrsCache.get(key);
  if (!f) {
    f = fsrs(
      generatorParameters({
        request_retention: config.desiredRetention,
        enable_fuzz: true,
        enable_short_term: true,
        learning_steps: config.learningStepsMin.map((m) => `${m}m` as StepUnit),
        relearning_steps: config.relearningStepsMin.map((m) => `${m}m` as StepUnit),
      }),
    );
    // Seed fuzz from the card id so the intervals previewed on the answer
    // buttons are exactly the intervals applied when the button is pressed.
    f.useStrategy(StrategyMode.SEED, GenSeedStrategyWithCardId('id'));
    fsrsCache.set(key, f);
  }
  return f;
}

// ---------- CardRecord <-> ts-fsrs Card conversion ----------

function toFsrsCard(rec: CardRecord): FsrsCard & { id: string } {
  return {
    id: rec.id,
    due: new Date(rec.due),
    stability: rec.stability,
    difficulty: rec.difficulty,
    elapsed_days: rec.elapsed_days,
    scheduled_days: rec.scheduled_days,
    learning_steps: rec.learning_steps,
    reps: rec.reps,
    lapses: rec.lapses,
    state: rec.state,
    last_review: rec.last_review != null ? new Date(rec.last_review) : undefined,
  };
}

function applyFsrsCard(rec: CardRecord, card: FsrsCard): CardRecord {
  return {
    ...rec,
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as CardStateValue,
    last_review: card.last_review ? card.last_review.getTime() : undefined,
  };
}

export function newCardRecord(noteId: string, deckId: string, ord: number): CardRecord {
  const empty = createEmptyCard(new Date());
  return applyFsrsCard(
    {
      id: uid(),
      noteId,
      deckId,
      ord,
      due: 0,
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      learning_steps: 0,
      reps: 0,
      lapses: 0,
      state: CardState.New,
      suspended: 0,
      flag: 0,
      createdAt: Date.now(),
    },
    empty,
  );
}

// ---------- Day boundaries (Anki-style rollover, default 4 AM) ----------

export function dayStart(now: number, dayStartHour: number): number {
  const d = new Date(now);
  d.setHours(dayStartHour, 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}

export function dayEnd(now: number, dayStartHour: number): number {
  return dayStart(now, dayStartHour) + 24 * 60 * 60 * 1000;
}

const LEARN_AHEAD_MS = 20 * 60 * 1000;

// ---------- Deck tree helpers ----------

export function descendantIds(decks: Deck[], rootId: string): string[] {
  const byParent = new Map<string | null, Deck[]>();
  for (const d of decks) {
    const list = byParent.get(d.parentId) ?? [];
    list.push(d);
    byParent.set(d.parentId, list);
  }
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    for (const child of byParent.get(id) ?? []) walk(child.id);
  };
  walk(rootId);
  return out;
}

export function isDescendant(decks: Deck[], candidateId: string, ancestorId: string): boolean {
  const byId = new Map(decks.map((d) => [d.id, d]));
  let cur = byId.get(candidateId);
  while (cur) {
    if (cur.id === ancestorId) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

// ---------- Availability predicates ----------

function isBuried(c: CardRecord, now: number): boolean {
  return c.buriedUntil != null && c.buriedUntil > now;
}

function available(c: CardRecord, now: number): boolean {
  return !c.suspended && !isBuried(c, now);
}

function isLearningState(c: CardRecord): boolean {
  return c.state === CardState.Learning || c.state === CardState.Relearning;
}

// ---------- Today's counters (from revlog) ----------

export interface TodayStudied {
  /** deckId -> number of NEW cards introduced today */
  newByDeck: Map<string, number>;
  /** deckId -> number of review answers today (reviews of Review-state cards) */
  reviewByDeck: Map<string, number>;
}

export async function todayStudied(now: number, dayStartHour: number): Promise<TodayStudied> {
  const start = dayStart(now, dayStartHour);
  const logs = await db.revlog.where('review').aboveOrEqual(start).toArray();
  const newByDeck = new Map<string, number>();
  const reviewByDeck = new Map<string, number>();
  for (const log of logs) {
    if (log.state === CardState.New) {
      newByDeck.set(log.deckId, (newByDeck.get(log.deckId) ?? 0) + 1);
    } else if (log.state === CardState.Review) {
      reviewByDeck.set(log.deckId, (reviewByDeck.get(log.deckId) ?? 0) + 1);
    }
  }
  return { newByDeck, reviewByDeck };
}

// ---------- Queue building ----------

export interface StudyQueue {
  /** intraday learning cards, sorted by due */
  learning: CardRecord[];
  /** review + new cards, interleaved, in serving order */
  main: CardRecord[];
  counts: StudyCounts;
}

/**
 * Build a one-off queue from cards chosen in the browser. Unlike the regular
 * deck queue, an explicit selection is intentional, so due dates, daily
 * limits, suspension, and burial do not filter it. Putting every selected
 * card in `main` also makes future learning cards immediately eligible.
 */
export async function buildSelectedQueue(cardIds: string[]): Promise<StudyQueue> {
  const uniqueIds = [...new Set(cardIds)];
  const found = await db.cards.bulkGet(uniqueIds);
  const main = found.filter((card): card is CardRecord => card !== undefined);

  return {
    learning: [],
    main,
    counts: {
      newCount: main.filter((card) => card.state === CardState.New).length,
      learnCount: main.filter((card) => isLearningState(card)).length,
      reviewCount: main.filter((card) => card.state === CardState.Review).length,
    },
  };
}

interface DeckBuckets {
  deck: Deck;
  newCards: CardRecord[];
  learnCards: CardRecord[];
  reviewCards: CardRecord[];
}

/**
 * Build per-deck buckets with each deck's own daily limits applied.
 * Follows Anki semantics: each subdeck's limits cap its own contribution,
 * and the clicked/root deck's limits cap the total.
 */
async function buildBuckets(
  decks: Deck[],
  deckIds: string[],
  now: number,
  dayStartHour: number,
  studied: TodayStudied,
): Promise<DeckBuckets[]> {
  const end = dayEnd(now, dayStartHour);
  const byId = new Map(decks.map((d) => [d.id, d]));
  const buckets: DeckBuckets[] = [];
  for (const deckId of deckIds) {
    const deck = byId.get(deckId);
    if (!deck) continue;
    const cards = await db.cards.where('deckId').equals(deckId).toArray();
    const avail = cards.filter((c) => available(c, now));
    const learnCards = avail
      .filter((c) => isLearningState(c) && c.due < end)
      .sort((a, b) => a.due - b.due);
    const newLimit = Math.max(0, deck.config.newPerDay - (studied.newByDeck.get(deckId) ?? 0));
    const newCards = avail
      .filter((c) => c.state === CardState.New)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, newLimit);
    const reviewLimit = Math.max(
      0,
      deck.config.reviewsPerDay - (studied.reviewByDeck.get(deckId) ?? 0),
    );
    const reviewCards = avail
      .filter((c) => c.state === CardState.Review && c.due < end)
      .sort((a, b) => a.due - b.due)
      .slice(0, reviewLimit);
    buckets.push({ deck, newCards, learnCards, reviewCards });
  }
  return buckets;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function buildQueue(
  decks: Deck[],
  rootDeckId: string | null,
  now: number,
  dayStartHour: number,
): Promise<StudyQueue> {
  // null = study the whole collection (Home): every deck, per-deck limits only
  const deckIds = rootDeckId === null ? decks.map((d) => d.id) : descendantIds(decks, rootDeckId);
  const studied = await todayStudied(now, dayStartHour);
  const buckets = await buildBuckets(decks, deckIds, now, dayStartHour, studied);
  const root = rootDeckId === null ? null : decks.find((d) => d.id === rootDeckId);
  const rootNewLimit =
    rootDeckId === null
      ? Infinity
      : Math.max(
          0,
          (root?.config.newPerDay ?? 0) -
            deckIds.reduce((sum, id) => sum + (studied.newByDeck.get(id) ?? 0), 0),
        );
  const rootReviewLimit =
    rootDeckId === null
      ? Infinity
      : Math.max(
          0,
          (root?.config.reviewsPerDay ?? 0) -
            deckIds.reduce((sum, id) => sum + (studied.reviewByDeck.get(id) ?? 0), 0),
        );

  const learning = buckets
    .flatMap((b) => b.learnCards)
    .sort((a, b) => a.due - b.due);
  const newCards = buckets.flatMap((b) => b.newCards).slice(0, rootNewLimit);
  const reviews = shuffle(buckets.flatMap((b) => b.reviewCards)).slice(0, rootReviewLimit);

  // Interleave new cards evenly among reviews.
  const main: CardRecord[] = [];
  if (newCards.length === 0) {
    main.push(...reviews);
  } else if (reviews.length === 0) {
    main.push(...newCards);
  } else {
    const gap = (reviews.length + 1) / newCards.length;
    let nextNewAt = gap / 2;
    let ni = 0;
    for (let ri = 0; ri < reviews.length; ri++) {
      while (ni < newCards.length && ri >= Math.floor(nextNewAt)) {
        main.push(newCards[ni++]);
        nextNewAt += gap;
      }
      main.push(reviews[ri]);
    }
    while (ni < newCards.length) main.push(newCards[ni++]);
  }

  return {
    learning,
    main,
    counts: {
      newCount: newCards.length,
      learnCount: learning.length,
      reviewCount: reviews.length,
    },
  };
}

/**
 * Pick the next card to show: learning cards whose due time has passed first,
 * then the main queue, then (if nothing else) learn-ahead within 20 minutes.
 */
export function nextCard(queue: StudyQueue, now: number): CardRecord | null {
  const dueLearning = queue.learning.find((c) => c.due <= now);
  if (dueLearning) return dueLearning;
  if (queue.main.length > 0) return queue.main[0];
  const ahead = queue.learning.find((c) => c.due <= now + LEARN_AHEAD_MS);
  if (ahead) return ahead;
  if (queue.learning.length > 0) return null; // learning cards remain, but later today
  return null;
}

// ---------- Counts for the deck tree display ----------

export async function allDeckCounts(
  decks: Deck[],
  now: number,
  dayStartHour: number,
): Promise<Map<string, StudyCounts>> {
  const end = dayEnd(now, dayStartHour);
  const studied = await todayStudied(now, dayStartHour);
  const all = await db.cards.toArray();
  const byDeck = new Map<string, CardRecord[]>();
  for (const c of all) {
    const list = byDeck.get(c.deckId) ?? [];
    list.push(c);
    byDeck.set(c.deckId, list);
  }
  const result = new Map<string, StudyCounts>();
  for (const deck of decks) {
    const cards = (byDeck.get(deck.id) ?? []).filter((c) => available(c, now));
    const newCount = Math.min(
      cards.filter((c) => c.state === CardState.New).length,
      Math.max(0, deck.config.newPerDay - (studied.newByDeck.get(deck.id) ?? 0)),
    );
    const learnCount = cards.filter((c) => isLearningState(c) && c.due < end).length;
    const reviewCount = Math.min(
      cards.filter((c) => c.state === CardState.Review && c.due < end).length,
      Math.max(0, deck.config.reviewsPerDay - (studied.reviewByDeck.get(deck.id) ?? 0)),
    );
    result.set(deck.id, { newCount, learnCount, reviewCount });
  }
  return result;
}

// ---------- Answering ----------

const LEECH_THRESHOLD = 8;

export interface AnswerResult {
  before: CardRecord;
  after: CardRecord;
  logId: string;
  becameLeech: boolean;
}

export async function answerCard(
  rec: CardRecord,
  rating: Rating,
  config: DeckConfig,
  durationMs: number,
  ai?: ReviewLogRecord['ai'],
): Promise<AnswerResult> {
  const f = schedulerFor(config);
  const now = new Date();
  const result: RecordLogItem = f.next(toFsrsCard(rec), now, rating as unknown as Grade);
  const after = applyFsrsCard(rec, result.card);
  const logId = uid();
  const log: ReviewLogRecord = {
    id: logId,
    cardId: rec.id,
    noteId: rec.noteId,
    deckId: rec.deckId,
    rating,
    state: rec.state,
    scheduled_days: result.card.scheduled_days,
    stability: result.card.stability,
    difficulty: result.card.difficulty,
    review: now.getTime(),
    durationMs: Math.min(durationMs, 60_000),
    ai,
  };

  // Leech detection: lapse count hits threshold (then every half-threshold after)
  let becameLeech = false;
  if (
    rating === 1 &&
    rec.state === CardState.Review &&
    after.lapses >= LEECH_THRESHOLD &&
    (after.lapses - LEECH_THRESHOLD) % Math.ceil(LEECH_THRESHOLD / 2) === 0
  ) {
    becameLeech = true;
    after.suspended = 1;
  }

  await db.transaction('rw', db.cards, db.revlog, db.notes, async () => {
    await db.cards.put(after);
    await db.revlog.add(log);
    if (becameLeech) {
      const note = await db.notes.get(rec.noteId);
      if (note && !note.tags.includes('leech')) {
        await db.notes.update(rec.noteId, { tags: [...note.tags, 'leech'] });
      }
    }
  });

  return { before: { ...rec }, after, logId, becameLeech };
}

export async function undoAnswer(entry: AnswerResult): Promise<void> {
  await db.transaction('rw', db.cards, db.revlog, async () => {
    await db.cards.put(entry.before);
    await db.revlog.delete(entry.logId);
  });
}

// ---------- Interval previews for the answer buttons ----------

export function intervalPreviews(
  rec: CardRecord,
  config: DeckConfig,
): Record<Rating, string> {
  const f = schedulerFor(config);
  const now = new Date();
  const preview = f.repeat(toFsrsCard(rec), now);
  const out = {} as Record<Rating, string>;
  for (const r of [1, 2, 3, 4] as Rating[]) {
    const due = preview[r as FsrsRating.Again | FsrsRating.Hard | FsrsRating.Good | FsrsRating.Easy].card.due;
    out[r] = formatInterval(due.getTime() - now.getTime());
  }
  return out;
}

/** Anki-style interval formatting: <1m, 10m, 2h, 1d, 26d, 3.2mo, 1.5yr */
export function formatInterval(ms: number): string {
  const min = ms / 60_000;
  if (min < 1) return '<1m';
  if (min < 60) return `${Math.round(min)}m`;
  const hours = min / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  const months = days / 30.44;
  if (days < 365) return `${months.toFixed(1)}mo`;
  return `${(days / 365.25).toFixed(1)}yr`;
}

// ---------- Bury / suspend / forget ----------

export async function buryCard(cardId: string, now: number, dayStartHour: number): Promise<void> {
  await db.cards.update(cardId, { buriedUntil: dayEnd(now, dayStartHour) });
}

export async function buryNote(noteId: string, now: number, dayStartHour: number): Promise<void> {
  const cards = await db.cards.where('noteId').equals(noteId).toArray();
  await db.cards.bulkPut(cards.map((c) => ({ ...c, buriedUntil: dayEnd(now, dayStartHour) })));
}

export async function setSuspended(cardIds: string[], suspended: boolean): Promise<void> {
  await db.transaction('rw', db.cards, async () => {
    for (const id of cardIds) {
      await db.cards.update(id, { suspended: suspended ? 1 : 0 });
    }
  });
}

/** Reset a card back to New (Anki's "Forget"). */
export async function forgetCards(cardIds: string[]): Promise<void> {
  await db.transaction('rw', db.cards, async () => {
    for (const id of cardIds) {
      const rec = await db.cards.get(id);
      if (!rec) continue;
      const fresh = applyFsrsCard(rec, createEmptyCard(new Date()));
      fresh.lapses = 0;
      fresh.reps = 0;
      await db.cards.put(fresh);
    }
  });
}

export function retrievability(rec: CardRecord, config: DeckConfig): number | null {
  if (rec.state === CardState.New) return null;
  const f = schedulerFor(config);
  return f.get_retrievability(toFsrsCard(rec), new Date(), false);
}
