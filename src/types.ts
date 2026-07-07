// ---------- Notes & cards ----------

export type NoteType = 'basic' | 'basicReversed' | 'cloze';

export interface Note {
  id: string;
  deckId: string;
  type: NoteType;
  /** Front field (or cloze text for cloze notes). May contain [img:mediaId] tokens. */
  front: string;
  /** Back field (or "extra" for cloze notes). May contain [img:mediaId] tokens. */
  back: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

/** FSRS State enum values (mirrors ts-fsrs State) */
export const CardState = {
  New: 0,
  Learning: 1,
  Review: 2,
  Relearning: 3,
} as const;
export type CardStateValue = (typeof CardState)[keyof typeof CardState];

export type FlagColor = 0 | 1 | 2 | 3 | 4; // none, red, orange, green, blue

export interface CardRecord {
  id: string;
  noteId: string;
  deckId: string;
  /**
   * Which card of the note: 0 = front→back, 1 = back→front (basicReversed),
   * for cloze notes this is the cloze index (1-based, c1 → 1).
   */
  ord: number;
  // --- FSRS scheduling fields (dates as epoch ms) ---
  due: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: CardStateValue;
  last_review?: number;
  // --- app-level flags ---
  suspended: 0 | 1;
  /** epoch ms until which the card is buried (end of today), undefined = not buried */
  buriedUntil?: number;
  flag: FlagColor;
  createdAt: number;
}

export type Rating = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy

export interface ReviewLogRecord {
  id: string;
  cardId: string;
  noteId: string;
  deckId: string;
  rating: Rating;
  /** card state before the review */
  state: CardStateValue;
  /** scheduled interval in days resulting from this review */
  scheduled_days: number;
  stability: number;
  difficulty: number;
  /** when the review happened, epoch ms */
  review: number;
  /** how long the answer took, ms */
  durationMs: number;
  /** AI grading result, when the review was graded by AI */
  ai?: {
    score: number;
    verdict: string;
    model: string;
  };
}

// ---------- Decks ----------

export interface DeckConfig {
  newPerDay: number;
  reviewsPerDay: number;
  /** learning steps in minutes, e.g. [1, 10] */
  learningStepsMin: number[];
  /** relearning steps in minutes, e.g. [10] */
  relearningStepsMin: number[];
  desiredRetention: number; // 0.7 – 0.98
}

export const DEFAULT_DECK_CONFIG: DeckConfig = {
  newPerDay: 20,
  reviewsPerDay: 200,
  learningStepsMin: [1, 10],
  relearningStepsMin: [10],
  desiredRetention: 0.9,
};

export interface Deck {
  id: string;
  name: string;
  parentId: string | null;
  config: DeckConfig;
  collapsed: 0 | 1;
  createdAt: number;
}

// ---------- Media ----------

export interface MediaRecord {
  id: string;
  blob: Blob;
  mime: string;
  createdAt: number;
}

// ---------- Settings ----------

export type GeminiModelId = string;

export interface GeminiModelOption {
  id: GeminiModelId;
  label: string;
  description: string;
  /** thinking level to request, if the model supports it */
  thinkingLevel?: 'low' | 'high';
}

export type AiStrictness = 'lenient' | 'moderate' | 'strict';

export interface Settings {
  id: 'app';
  theme: 'light' | 'dark' | 'system';
  apiKey: string;
  model: GeminiModelId;
  aiStrictness: AiStrictness;
  /** default answer mode when studying */
  defaultStudyMode: 'classic' | 'ai';
  /** hour of day when the "day" rolls over (Anki default 4am) */
  dayStartHour: number;
  /** decks page behavior: desktop-style icon grid or simple list */
  deckViewMode: 'desktop' | 'list';
  /** language the AI writes feedback in — 'auto' = match the card's language, otherwise an English language name (e.g. 'Hebrew') */
  aiLanguage: string;
  lastDeckId?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  id: 'app',
  theme: 'system',
  apiKey: '',
  model: '', // filled with DEFAULT_MODEL at load
  aiStrictness: 'moderate',
  defaultStudyMode: 'ai',
  dayStartHour: 4,
  deckViewMode: 'desktop',
  aiLanguage: 'auto',
};

// ---------- AI grading ----------

export interface AiGradeResult {
  score: number; // 0-100
  verdict: 'correct' | 'partially_correct' | 'incorrect';
  feedback: string;
  keyPointsMissed: string[];
  suggestedRating: Rating;
  model: string;
}

// ---------- Study ----------

export interface StudyCounts {
  newCount: number;
  learnCount: number;
  reviewCount: number;
}

export interface DeckTreeNode {
  deck: Deck;
  children: DeckTreeNode[];
  depth: number;
  counts: StudyCounts;
  /** counts including all descendants */
  totalCounts: StudyCounts;
}
