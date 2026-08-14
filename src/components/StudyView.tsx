import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft,
  BrainCircuit,
  Dumbbell,
  ChevronLeft,
  ChevronRight,
  Undo2,
  Pencil,
  EyeOff,
  Eye,
  PauseCircle,
  Flag,
  Sparkles,
  Keyboard,
  PartyPopper,
  Clock,
  Loader2,
  ListPlus,
  MessageCircleQuestion,
  RefreshCw,
} from 'lucide-react';
import { db, saveSettings } from '../db';
import type {
  AiCardQuestion,
  AiGradeResult,
  CardRecord,
  ExerciseTextDirection,
  Note,
  Rating,
  Settings,
  StudyMode,
} from '../types';
import { CardState } from '../types';
import {
  answerCard,
  buildQueue,
  buildSelectedQueue,
  buryCard,
  dayEnd,
  intervalPreviews,
  nextCard,
  setSuspended,
  undoAnswer,
  type AnswerResult,
  type StudyQueue,
} from '../lib/scheduler';
import { renderClozeBack, renderClozeFront } from '../lib/cloze';
import {
  generateCardQuestions,
  gradeAnswer,
  gradeCardQuestion,
  GeminiError,
} from '../lib/gemini';
import { FieldContent, InlineContent } from './FieldContent';
import { Modal, useToast } from './ui';
import { NoteEditModal } from './NoteEditModal';
import { ExerciseMode } from './ExerciseMode';

type Phase = 'question' | 'grading' | 'answer';
type QuestionPhase = 'idle' | 'loading' | 'ready' | 'error';

interface QuestionAttempt {
  question: AiCardQuestion;
  answer: string;
  result: AiGradeResult;
}

interface QuestionItem {
  id: string;
  question: AiCardQuestion;
  answer: string;
  result: AiGradeResult | null;
  grading: boolean;
  error: string | null;
}

const RATING_META: { rating: Rating; label: string; className: string; key: string }[] = [
  { rating: 1, label: 'Again', className: 'rate-again', key: '1' },
  { rating: 2, label: 'Hard', className: 'rate-hard', key: '2' },
  { rating: 3, label: 'Good', className: 'rate-good', key: '3' },
  { rating: 4, label: 'Easy', className: 'rate-easy', key: '4' },
];

const FLAG_COLORS = ['transparent', '#ef4444', '#f97316', '#22c55e', '#3b82f6'];

// React StrictMode mounts effects twice in development. Share an in-flight
// first-question request so that this never spends a user's quota twice.
const pendingInitialQuestions = new Map<string, Promise<AiCardQuestion[]>>();

function aggregateQuestionAttempts(
  attempts: QuestionAttempt[],
  totalQuestions: number,
): AiGradeResult | null {
  if (attempts.length === 0) return null;
  const score = Math.round(
    attempts.reduce((sum, attempt) => sum + attempt.result.score, 0) / attempts.length,
  );
  let rating = Math.max(
    1,
    Math.min(
      4,
      Math.round(
        attempts.reduce((sum, attempt) => sum + attempt.result.suggestedRating, 0) /
          attempts.length,
      ),
    ),
  ) as Rating;
  const allAnswered = totalQuestions >= 2 && attempts.length === totalQuestions;
  const allCorrect = allAnswered && attempts.every((attempt) => attempt.result.verdict === 'correct');
  if (!allCorrect) rating = Math.min(rating, 3) as Rating;
  if (attempts.some((attempt) => attempt.result.verdict === 'incorrect')) {
    rating = Math.min(rating, 2) as Rating;
  }
  return {
    score,
    verdict: allCorrect
      ? 'correct'
      : attempts.some((attempt) => attempt.result.verdict === 'incorrect')
        ? 'incorrect'
        : 'partially_correct',
    feedback: `Coverage result across ${attempts.length} of ${totalQuestions} AI-generated questions.`,
    keyPointsMissed: attempts.flatMap((attempt) => attempt.result.keyPointsMissed),
    suggestedRating: rating,
    model: attempts.at(-1)?.result.model ?? attempts.at(-1)?.question.model ?? '',
  };
}

/**
 * The session's cards in serving order — due learning first, then the main
 * queue, then learning cards due later today. Used by the free forward/back
 * navigation (browsing without answering).
 */
function orderedCandidates(q: StudyQueue, now: number): CardRecord[] {
  const dueLearn = q.learning.filter((c) => c.due <= now);
  const laterLearn = q.learning.filter((c) => c.due > now);
  return [...dueLearn, ...q.main, ...laterLearn];
}

export function StudyView({
  deckId,
  selectedCardIds,
  settings,
  onExit,
  exitLabel,
  onChanged,
  onSettingsChanged,
}: {
  /** null = study the whole collection */
  deckId: string | null;
  /** Explicit Browser selection; these cards are queued even when not due. */
  selectedCardIds?: string[];
  settings: Settings;
  onExit: () => void;
  exitLabel?: string;
  onChanged: () => void;
  onSettingsChanged: () => void;
}) {
  const toast = useToast();
  const decks = useLiveQuery(() => db.decks.toArray(), []);
  const [queue, setQueue] = useState<StudyQueue | null>(null);
  const [card, setCard] = useState<CardRecord | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [phase, setPhase] = useState<Phase>('question');
  const [mode, setMode] = useState<StudyMode>(settings.defaultStudyMode);
  const [typedAnswer, setTypedAnswer] = useState('');
  const [aiResult, setAiResult] = useState<AiGradeResult | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [exerciseBusy, setExerciseBusy] = useState(false);
  const [exerciseTextDirection, setExerciseTextDirection] = useState<ExerciseTextDirection>(
    settings.exerciseTextDirection,
  );
  const [questionItems, setQuestionItems] = useState<QuestionItem[]>([]);
  const [questionPhase, setQuestionPhase] = useState<QuestionPhase>('idle');
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [showQuestionCard, setShowQuestionCard] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [finished, setFinished] = useState(false);
  const [waitingUntil, setWaitingUntil] = useState<number | null>(null);
  const undoStack = useRef<AnswerResult[]>([]);
  const cardStart = useRef(Date.now());
  const answerBox = useRef<HTMLTextAreaElement>(null);
  const firstQuestionBox = useRef<HTMLTextAreaElement>(null);
  const busyRef = useRef(false);
  const gradingQuestionIds = useRef(new Set<string>());
  const questionRequestToken = useRef(0);

  const deckById = useMemo(() => new Map((decks ?? []).map((d) => [d.id, d])), [decks]);
  const rootDeck = deckId !== null ? deckById.get(deckId) : undefined;

  const resetQuestionSession = useCallback(() => {
    questionRequestToken.current += 1;
    gradingQuestionIds.current.clear();
    setQuestionItems([]);
    setQuestionPhase('idle');
    setQuestionError(null);
    setShowQuestionCard(false);
  }, []);

  const presentFrom = useCallback(
    (q: StudyQueue) => {
      const now = Date.now();
      resetQuestionSession();
      const next = nextCard(q, now);
      if (next) {
        setCard(next);
        setPhase('question');
        setTypedAnswer('');
        setAiResult(null);
        setAiError(null);
        setFinished(false);
        setWaitingUntil(null);
        cardStart.current = now;
      } else if (q.learning.length > 0) {
        setCard(null);
        setWaitingUntil(q.learning[0].due);
        setFinished(false);
      } else {
        setCard(null);
        setFinished(true);
        setWaitingUntil(null);
      }
    },
    [resetQuestionSession],
  );

  const loadQueue = useCallback(async () => {
    const allDecks = await db.decks.toArray();
    if (deckId !== null && !allDecks.some((d) => d.id === deckId)) {
      onExit();
      return;
    }
    const q = selectedCardIds
      ? await buildSelectedQueue(selectedCardIds)
      : await buildQueue(allDecks, deckId, Date.now(), settings.dayStartHour);
    setQueue(q);
    presentFrom(q);
  }, [deckId, selectedCardIds, settings.dayStartHour, presentFrom, onExit]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  // Load the current card's note
  useEffect(() => {
    if (!card) {
      setNote(null);
      return;
    }
    let alive = true;
    db.notes.get(card.noteId).then((n) => {
      if (alive) setNote(n ?? null);
    });
    return () => {
      alive = false;
    };
  }, [card]);

  // Wake up when the next learning card becomes due
  useEffect(() => {
    if (waitingUntil == null || !queue) return;
    const delay = Math.max(250, waitingUntil - Date.now() + 50);
    const t = window.setTimeout(() => presentFrom(queue), delay);
    return () => window.clearTimeout(t);
  }, [waitingUntil, queue, presentFrom]);

  const remaining = useMemo(() => {
    if (!queue) return { newCount: 0, learnCount: 0, reviewCount: 0 };
    return {
      newCount: queue.main.filter((c) => c.state === CardState.New).length,
      learnCount:
        queue.learning.length +
        queue.main.filter(
          (c) => c.state === CardState.Learning || c.state === CardState.Relearning,
        ).length,
      reviewCount: queue.main.filter((c) => c.state === CardState.Review).length,
    };
  }, [queue]);

  const config = card ? (deckById.get(card.deckId)?.config ?? rootDeck?.config) : rootDeck?.config;
  const previews = useMemo(
    () => (card && config ? intervalPreviews(card, config) : null),
    [card, config],
  );
  const questionAttempts = useMemo<QuestionAttempt[]>(
    () =>
      questionItems.flatMap((item) =>
        item.result
          ? [{ question: item.question, answer: item.answer.trim(), result: item.result }]
          : [],
      ),
    [questionItems],
  );
  const questionSummary = useMemo(
    () => aggregateQuestionAttempts(questionAttempts, questionItems.length),
    [questionAttempts, questionItems.length],
  );
  const allQuestionsAnswered =
    questionItems.length >= 2 && questionItems.every((item) => item.result !== null);
  const allQuestionsCorrect =
    allQuestionsAnswered && questionItems.every((item) => item.result?.verdict === 'correct');
  const questionBusy =
    questionPhase === 'loading' || questionItems.some((item) => item.grading);

  const reversed = card?.ord === 1 && note?.type === 'basicReversed';

  useEffect(() => {
    setExerciseTextDirection(settings.exerciseTextDirection);
  }, [settings.exerciseTextDirection]);

  const changeExerciseTextDirection = useCallback(
    (direction: ExerciseTextDirection) => {
      setExerciseTextDirection(direction);
      void saveSettings({ exerciseTextDirection: direction }).then(onSettingsChanged);
    },
    [onSettingsChanged],
  );

  const rate = useCallback(
    async (rating: Rating, ai?: AiGradeResult) => {
      if (!card || !config || !queue || busyRef.current) return;
      busyRef.current = true;
      try {
        const duration = Date.now() - cardStart.current;
        const result = await answerCard(
          card,
          rating,
          config,
          duration,
          ai ? { score: ai.score, verdict: ai.verdict, model: ai.model } : undefined,
        );
        undoStack.current.push(result);
        if (result.becameLeech) {
          toast.push('info', 'This card became a leech and was suspended.');
        }
        // Update the local queue
        const q: StudyQueue = {
          learning: queue.learning.filter((c) => c.id !== card.id),
          main: queue.main.filter((c) => c.id !== card.id),
          counts: queue.counts,
        };
        const end = dayEnd(Date.now(), settings.dayStartHour);
        const after = result.after;
        if (
          (after.state === CardState.Learning || after.state === CardState.Relearning) &&
          after.due < end &&
          !after.suspended
        ) {
          q.learning = [...q.learning, after].sort((a, b) => a.due - b.due);
        }
        setQueue(q);
        presentFrom(q);
        onChanged();
      } finally {
        busyRef.current = false;
      }
    },
    [card, config, queue, settings.dayStartHour, presentFrom, onChanged, toast],
  );

  const undo = useCallback(async () => {
    const entry = undoStack.current.pop();
    if (!entry || !queue) {
      toast.push('info', 'Nothing to undo.');
      return;
    }
    await undoAnswer(entry);
    const q: StudyQueue = {
      learning: queue.learning.filter((c) => c.id !== entry.before.id),
      main: queue.main.filter((c) => c.id !== entry.before.id),
      counts: queue.counts,
    };
    if (entry.before.state === CardState.Learning || entry.before.state === CardState.Relearning) {
      q.learning = [entry.before, ...q.learning];
    } else {
      q.main = [entry.before, ...q.main];
    }
    setQueue(q);
    resetQuestionSession();
    setCard(entry.before);
    setPhase('question');
    setTypedAnswer('');
    setAiResult(null);
    setAiError(null);
    setFinished(false);
    setWaitingUntil(null);
    cardStart.current = Date.now();
    onChanged();
    toast.push('success', 'Review undone.');
  }, [queue, onChanged, resetQuestionSession, toast]);

  const skipCurrent = useCallback(
    (removeId: string) => {
      if (!queue) return;
      const q: StudyQueue = {
        learning: queue.learning.filter((c) => c.id !== removeId),
        main: queue.main.filter((c) => c.id !== removeId),
        counts: queue.counts,
      };
      setQueue(q);
      presentFrom(q);
      onChanged();
    },
    [queue, presentFrom, onChanged],
  );

  // Free navigation: browse the session's cards without answering.
  const skipBy = useCallback(
    (delta: number) => {
      if (!queue || aiBusy || questionBusy || exerciseBusy) return;
      const candidates = orderedCandidates(queue, Date.now());
      if (candidates.length === 0) return;
      const curIdx = card ? candidates.findIndex((c) => c.id === card.id) : -1;
      const base = curIdx >= 0 ? curIdx : delta > 0 ? -1 : 0;
      const next = (((base + delta) % candidates.length) + candidates.length) % candidates.length;
      resetQuestionSession();
      setCard(candidates[next]);
      setPhase('question');
      setTypedAnswer('');
      setAiResult(null);
      setAiError(null);
      setFinished(false);
      setWaitingUntil(null);
      cardStart.current = Date.now();
    },
    [queue, card, aiBusy, questionBusy, exerciseBusy, resetQuestionSession],
  );

  const navInfo = useMemo(() => {
    if (!queue) return { total: 0, idx: -1 };
    const candidates = orderedCandidates(queue, Date.now());
    return {
      total: candidates.length,
      idx: card ? candidates.findIndex((c) => c.id === card.id) : -1,
    };
  }, [queue, card]);

  const bury = useCallback(async () => {
    if (!card) return;
    await buryCard(card.id, Date.now(), settings.dayStartHour);
    toast.push('success', 'Card buried until tomorrow.');
    skipCurrent(card.id);
  }, [card, settings.dayStartHour, skipCurrent, toast]);

  const suspend = useCallback(async () => {
    if (!card) return;
    await setSuspended([card.id], true);
    toast.push('success', 'Card suspended.');
    skipCurrent(card.id);
  }, [card, skipCurrent, toast]);

  const setFlag = useCallback(
    async (flag: 0 | 1 | 2 | 3 | 4) => {
      if (!card) return;
      const next = card.flag === flag ? 0 : flag;
      await db.cards.update(card.id, { flag: next });
      setCard({ ...card, flag: next as CardRecord['flag'] });
    },
    [card],
  );

  const changeMode = useCallback(
    (nextMode: StudyMode) => {
      if (nextMode === mode) return;
      resetQuestionSession();
      setPhase('question');
      setTypedAnswer('');
      setAiResult(null);
      setAiError(null);
      setMode(nextMode);
    },
    [mode, resetQuestionSession],
  );

  const loadCardQuestions = useCallback(
    async (previousQuestions: string[], append = false) => {
      if (!card || !note || note.id !== card.noteId) return;
      if (!settings.apiKey) {
        setQuestionError('Add your Gemini API key in Settings to generate questions.');
        setQuestionPhase('error');
        return;
      }

      const token = ++questionRequestToken.current;
      if (!append) setQuestionItems([]);
      setQuestionError(null);
      setQuestionPhase('loading');
      const request = {
        note,
        previousQuestions,
        apiKey: settings.apiKey,
        model: settings.model,
        language: settings.aiLanguage,
      };

      try {
        let pending: Promise<AiCardQuestion[]>;
        if (previousQuestions.length === 0) {
          const cacheKey = [card.id, note.updatedAt, settings.model, settings.aiLanguage].join(':');
          const existing = pendingInitialQuestions.get(cacheKey);
          if (existing) {
            pending = existing;
          } else {
            pending = generateCardQuestions(request);
            pendingInitialQuestions.set(cacheKey, pending);
            void pending.then(
              () => pendingInitialQuestions.delete(cacheKey),
              () => pendingInitialQuestions.delete(cacheKey),
            );
          }
        } else {
          pending = generateCardQuestions(request);
        }
        const generated = await pending;
        if (questionRequestToken.current !== token) return;
        const batchId = crypto.randomUUID();
        const nextItems: QuestionItem[] = generated.map((question, index) => ({
          id: `${batchId}-${index}`,
          question,
          answer: '',
          result: null,
          grading: false,
          error: null,
        }));
        setQuestionItems((items) => (append ? [...items, ...nextItems] : nextItems));
        setQuestionPhase('ready');
      } catch (e) {
        if (questionRequestToken.current !== token) return;
        setQuestionError(
          e instanceof GeminiError ? e.message : 'Could not generate the question set. Try again.',
        );
        setQuestionPhase('error');
      }
    },
    [card, note, settings.apiKey, settings.model, settings.aiLanguage],
  );

  const updateQuestionAnswer = useCallback((itemId: string, answer: string) => {
    setQuestionItems((items) =>
      items.map((item) => (item.id === itemId ? { ...item, answer } : item)),
    );
  }, []);

  const submitQuestionAnswer = useCallback(async (itemId: string) => {
    const item = questionItems.find((candidate) => candidate.id === itemId);
    if (
      !item ||
      !note ||
      !item.answer.trim() ||
      item.result ||
      item.grading ||
      gradingQuestionIds.current.has(itemId)
    ) {
      return;
    }
    if (!settings.apiKey) {
      setQuestionItems((items) =>
        items.map((candidate) =>
          candidate.id === itemId
            ? { ...candidate, error: 'Add your Gemini API key in Settings to grade answers.' }
            : candidate,
        ),
      );
      return;
    }

    gradingQuestionIds.current.add(itemId);
    const sessionToken = questionRequestToken.current;
    setQuestionItems((items) =>
      items.map((candidate) =>
        candidate.id === itemId ? { ...candidate, grading: true, error: null } : candidate,
      ),
    );
    try {
      const result = await gradeCardQuestion({
        note,
        question: item.question,
        userAnswer: item.answer,
        apiKey: settings.apiKey,
        model: settings.model,
        strictness: settings.aiStrictness,
        language: settings.aiLanguage,
      });
      if (questionRequestToken.current !== sessionToken) return;
      setQuestionItems((items) =>
        items.map((candidate) =>
          candidate.id === itemId
            ? { ...candidate, answer: candidate.answer.trim(), result, grading: false, error: null }
            : candidate,
        ),
      );
    } catch (e) {
      if (questionRequestToken.current !== sessionToken) return;
      setQuestionItems((items) =>
        items.map((candidate) =>
          candidate.id === itemId
            ? {
                ...candidate,
                grading: false,
                error: e instanceof GeminiError ? e.message : 'AI grading failed. Try again.',
              }
            : candidate,
        ),
      );
    } finally {
      gradingQuestionIds.current.delete(itemId);
    }
  }, [note, questionItems, settings]);

  const askMoreQuestions = useCallback(() => {
    void loadCardQuestions(
      questionItems.map((item) => item.question.question),
      true,
    );
  }, [loadCardQuestions, questionItems]);

  const finishQuestionCard = useCallback((manualRating?: Rating) => {
    if (!questionSummary || !allQuestionsAnswered) return;
    void rate(manualRating ?? questionSummary.suggestedRating, questionSummary);
  }, [allQuestionsAnswered, questionSummary, rate]);

  // Invalidate late AI responses when the component unmounts (including the
  // development-only StrictMode remount).
  useEffect(
    () => () => {
      questionRequestToken.current += 1;
    },
    [],
  );

  // Entering the mode or advancing to a card automatically creates its coverage set.
  useEffect(() => {
    if (
      mode === 'questions' &&
      card &&
      note?.id === card.noteId &&
      questionPhase === 'idle' &&
      questionItems.length === 0
    ) {
      void loadCardQuestions([]);
    }
  }, [mode, card, note, questionPhase, questionItems.length, loadCardQuestions]);

  const submitAiAnswer = useCallback(async () => {
    if (!card || !note || aiBusy) return;
    if (!settings.apiKey) {
      setAiError('Add your Gemini API key in Settings to use AI grading.');
      return;
    }
    setAiBusy(true);
    setAiError(null);
    setPhase('grading');
    try {
      const result = await gradeAnswer({
        note,
        ord: card.ord,
        reversed: !!reversed,
        userAnswer: typedAnswer,
        apiKey: settings.apiKey,
        model: settings.model,
        strictness: settings.aiStrictness,
        language: settings.aiLanguage,
      });
      setAiResult(result);
      setPhase('answer');
    } catch (e) {
      setAiError(e instanceof GeminiError ? e.message : 'AI grading failed. Try again.');
      setPhase('question');
    } finally {
      setAiBusy(false);
    }
  }, [card, note, typedAnswer, settings, reversed, aiBusy]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField =
        e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      if (inField) {
        if (e.key === 'Enter' && e.ctrlKey) {
          if (mode === 'ai' && phase === 'question') {
            e.preventDefault();
            void submitAiAnswer();
          }
        }
        // arrows in an EMPTY answer box are a caret no-op — use them to navigate
        if (
          (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
          e.target instanceof HTMLTextAreaElement &&
          e.target.classList.contains('ai-answer-box') &&
          e.target.value === ''
        ) {
          e.preventDefault();
          skipBy(e.key === 'ArrowRight' ? 1 : -1);
        }
        return;
      }
      if (editing || showShortcuts) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        skipBy(e.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      if (e.key === '?') {
        setShowShortcuts(true);
        return;
      }
      if (e.key === 'u' || e.key === 'U') {
        void undo();
        return;
      }
      if (!card) return;
      if (e.key === 'e' || e.key === 'E') {
        setEditing(true);
        return;
      }
      if (e.key === '-') {
        void bury();
        return;
      }
      if (e.key === '@') {
        void suspend();
        return;
      }
      if (e.ctrlKey && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        void setFlag(parseInt(e.key) as 1 | 2 | 3 | 4);
        return;
      }
      if (mode === 'questions' && questionItems.length > 0 && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        setShowQuestionCard((shown) => !shown);
        return;
      }
      if (mode === 'questions' && allQuestionsAnswered) {
        if (e.key === 'n' || e.key === 'N') {
          e.preventDefault();
          askMoreQuestions();
        } else if (['1', '2', '3', '4'].includes(e.key)) {
          e.preventDefault();
          finishQuestionCard(parseInt(e.key) as Rating);
        } else if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          finishQuestionCard();
        }
        return;
      }
      if (phase === 'answer' && (e.key === 'h' || e.key === 'H')) {
        e.preventDefault();
        setPhase('question');
        return;
      }
      if (phase === 'question' && mode === 'classic' && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        setPhase('answer');
        return;
      }
      if (phase === 'answer') {
        if (['1', '2', '3', '4'].includes(e.key)) {
          e.preventDefault();
          void rate(parseInt(e.key) as Rating, aiResult ?? undefined);
        } else if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          void rate(aiResult ? aiResult.suggestedRating : 3, aiResult ?? undefined);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card, phase, mode, aiResult, questionItems.length, allQuestionsAnswered, editing, showShortcuts, rate, undo, bury, suspend, setFlag, submitAiAnswer, askMoreQuestions, finishQuestionCard, skipBy]);

  // Focus the AI answer box when a new question appears
  useEffect(() => {
    if (
      phase === 'question' && mode === 'ai'
    ) {
      answerBox.current?.focus();
    } else if (mode === 'questions' && questionPhase === 'ready') {
      firstQuestionBox.current?.focus();
    }
  }, [phase, mode, card, questionPhase, questionItems.length]);

  if (!queue || (deckId !== null && !rootDeck)) return <div className="view-pad">Loading…</div>;

  // ---------- render helpers ----------

  const frontText = (() => {
    if (!note || !card) return '';
    if (note.type === 'cloze') return renderClozeFront(note.front, card.ord);
    return reversed ? note.back : note.front;
  })();

  const backText = (() => {
    if (!note || !card) return '';
    if (note.type === 'cloze') {
      const main = renderClozeBack(note.front, card.ord);
      return note.back.trim() ? `${main}\n\n${note.back}` : main;
    }
    return reversed ? note.front : note.back;
  })();
  const firstUnansweredIndex = questionItems.findIndex((item) => !item.result);
  const questionRatingLabel = questionSummary
    ? RATING_META.find((item) => item.rating === questionSummary.suggestedRating)?.label
    : null;

  const stateLabel =
    card?.state === CardState.New
      ? 'new'
      : card?.state === CardState.Review
        ? 'review'
        : 'learn';

  return (
    <div className="study-view anim-in">
      <div className="study-topbar">
        <button className="btn btn-ghost btn-sm" onClick={onExit}>
          <ArrowLeft size={15} /> {exitLabel ?? rootDeck?.name ?? 'All decks'}
        </button>
        <div className="study-counts" aria-label="Remaining cards">
          <span className={`count-new ${stateLabel === 'new' ? 'count-active' : ''}`}>{remaining.newCount}</span>
          <span className={`count-learn ${stateLabel === 'learn' ? 'count-active' : ''}`}>{remaining.learnCount}</span>
          <span className={`count-due ${stateLabel === 'review' ? 'count-active' : ''}`}>{remaining.reviewCount}</span>
        </div>
        <div className="study-tools">
          <div className="mode-toggle" role="group" aria-label="Answer mode">
            <button
              className={mode === 'classic' ? 'active' : ''}
              onClick={() => changeMode('classic')}
              title="Flip and grade yourself"
            >
              Classic
            </button>
            <button
              className={mode === 'ai' ? 'active' : ''}
              onClick={() => changeMode('ai')}
              title="Type your answer, AI grades your understanding"
            >
              <Sparkles size={13} /> AI
            </button>
            <button
              className={mode === 'questions' ? 'active' : ''}
              onClick={() => changeMode('questions')}
              title="AI asks fresh questions about each card"
            >
              <BrainCircuit size={13} /> Questions
            </button>
            <button
              className={mode === 'exercise' ? 'active' : ''}
              onClick={() => changeMode('exercise')}
              title="Apply the card’s knowledge to a challenging problem"
            >
              <Dumbbell size={13} /> Exercise
            </button>
          </div>
          {navInfo.total > 1 && (
            <span className="card-nav" role="group" aria-label="Browse cards without answering">
              <button
                className="icon-btn"
                title="Previous card — no answer recorded (←)"
                aria-label="Previous card"
                onClick={() => skipBy(-1)}
                disabled={aiBusy || questionBusy || exerciseBusy}
              >
                <ChevronLeft size={17} />
              </button>
              <span className="card-nav-pos">
                {navInfo.idx >= 0 ? navInfo.idx + 1 : '–'}/{navInfo.total}
              </span>
              <button
                className="icon-btn"
                title="Next card — no answer recorded (→)"
                aria-label="Next card"
                onClick={() => skipBy(1)}
                disabled={aiBusy || questionBusy || exerciseBusy}
              >
                <ChevronRight size={17} />
              </button>
            </span>
          )}
          <button className="icon-btn" title="Undo last review (U)" aria-label="Undo" onClick={() => void undo()}>
            <Undo2 size={17} />
          </button>
          {card && (
            <>
              <button className="icon-btn" title="Edit note (E)" aria-label="Edit" onClick={() => setEditing(true)}>
                <Pencil size={16} />
              </button>
              <button className="icon-btn" title="Bury until tomorrow (-)" aria-label="Bury" onClick={() => void bury()}>
                <EyeOff size={16} />
              </button>
              <button className="icon-btn" title="Suspend (@)" aria-label="Suspend" onClick={() => void suspend()}>
                <PauseCircle size={16} />
              </button>
              <button
                className="icon-btn"
                title="Cycle flag (Ctrl+1…4)"
                aria-label="Flag"
                onClick={() => void setFlag(((card.flag + 1) % 5) as 0 | 1 | 2 | 3 | 4)}
              >
                <Flag size={16} fill={FLAG_COLORS[card.flag]} color={card.flag ? FLAG_COLORS[card.flag] : 'currentColor'} />
              </button>
            </>
          )}
          <button className="icon-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => setShowShortcuts(true)}>
            <Keyboard size={16} />
          </button>
        </div>
      </div>

      {finished && (
        <div className="study-done card-panel anim-in">
          <PartyPopper size={40} className="done-icon" />
          <h2>Congratulations!</h2>
          <p>
            {selectedCardIds
              ? `You've finished the ${selectedCardIds.length === 1 ? 'selected card' : `${selectedCardIds.length} selected cards`}.`
              : "You've finished this deck for now. Come back later for more reviews."}
          </p>
          <button className="btn btn-primary" onClick={onExit}>
            {exitLabel ? `Back to ${exitLabel}` : 'Back to decks'}
          </button>
        </div>
      )}

      {waitingUntil != null && !finished && !card && (
        <div className="study-done card-panel anim-in">
          <Clock size={36} className="done-icon" />
          <h2>Short break</h2>
          <p>
            The next learning card is due at{' '}
            {new Date(waitingUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. It
            will appear automatically.
          </p>
          <button className="btn btn-secondary" onClick={onExit}>
            {exitLabel ? `Back to ${exitLabel}` : 'Back to decks'}
          </button>
        </div>
      )}

      {card && note && (
        <div className="study-card card-panel" key={card.id + phase + mode}>
          <div
            className={`study-question ${mode === 'questions' || mode === 'exercise' ? 'generated-question' : ''}`}
          >
            {mode !== 'questions' && mode !== 'exercise' && <FieldContent text={frontText} />}

            {mode === 'exercise' && (
              <ExerciseMode
                key={`${card.id}:${cardStart.current}:${note.updatedAt}`}
                card={card}
                note={note}
                settings={settings}
                frontText={frontText}
                backText={backText}
                textDirection={exerciseTextDirection}
                onTextDirectionChange={changeExerciseTextDirection}
                onBusyChange={setExerciseBusy}
                onComplete={(rating, result) => void rate(rating, result)}
              />
            )}

            {mode === 'questions' && questionPhase === 'loading' && questionItems.length === 0 && (
              <div className="question-loading" role="status">
                <span className="question-icon-wrap">
                  <Loader2 size={20} className="spin" />
                </span>
                <div>
                  <span className="question-eyebrow">Coverage check</span>
                  <div className="question-loading-title">Building a question set…</div>
                  <p>Mapping the important facts in this card.</p>
                </div>
              </div>
            )}

            {mode === 'questions' && questionPhase === 'error' && questionItems.length === 0 && (
              <div className="question-error-state">
                <div className="ai-error" role="alert">{questionError}</div>
                <div className="question-error-actions">
                  <button
                    className="btn btn-secondary"
                    onClick={() => void loadCardQuestions([])}
                  >
                    <RefreshCw size={15} /> Try again
                  </button>
                </div>
              </div>
            )}

            {mode === 'questions' && questionItems.length > 0 && (
              <div className="question-prompt anim-in">
                <div className="question-prompt-head">
                  <div className="question-prompt-identity">
                    <span className="question-icon-wrap" aria-hidden="true">
                      <MessageCircleQuestion size={20} />
                    </span>
                    <div>
                      <span className="question-eyebrow">AI coverage check</span>
                      <strong className="question-batch-title">
                        {questionItems.length} questions for this card
                      </strong>
                    </div>
                  </div>
                  <button
                    className={`question-card-toggle ${showQuestionCard ? 'is-open' : ''}`}
                    onClick={() => setShowQuestionCard((shown) => !shown)}
                    aria-expanded={showQuestionCard}
                    aria-controls="question-card-content"
                  >
                    <span className="question-toggle-icons" aria-hidden="true">
                      <Eye size={16} className="question-toggle-show" />
                      <EyeOff size={16} className="question-toggle-hide" />
                    </span>
                    {showQuestionCard ? 'Hide card' : 'Show card'} <kbd>C</kbd>
                  </button>
                </div>
                <p className="question-batch-intro">
                  Submit each answer separately. Complete understanding requires the whole set.
                </p>
                {showQuestionCard && (
                  <div id="question-card-content" className="question-card-content anim-in">
                    <div className="question-card-field">
                      <span className="field-label">Card prompt</span>
                      <FieldContent text={frontText} />
                    </div>
                    <div className="question-card-divider" />
                    <div className="question-card-field">
                      <span className="field-label">Card answer</span>
                      <FieldContent text={backText} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {mode === 'questions' && questionItems.length > 0 && (
            <div className="question-batch-list">
              {questionItems.map((item, index) => (
                <section
                  className={`question-item anim-in ${item.result ? `question-item-${item.result.verdict}` : ''}`}
                  key={item.id}
                  style={{ animationDelay: `${Math.min(index, 4) * 60}ms` }}
                >
                  <div className="question-item-head">
                    <span className="question-item-number">Question {index + 1}</span>
                    {item.result ? (
                      <span className={`question-score-chip ai-${item.result.verdict}`}>
                        <strong>{item.result.score}</strong>
                      </span>
                    ) : (
                      <span className="question-item-status">Awaiting answer</span>
                    )}
                  </div>
                  <div className="question-item-text">
                    <InlineContent text={item.question.question} />
                  </div>

                  {!item.result ? (
                    <div className="question-item-answer">
                      <textarea
                        ref={index === firstUnansweredIndex ? firstQuestionBox : undefined}
                        className="textarea question-answer-box"
                        placeholder="Answer this question in your own words."
                        value={item.answer}
                        onChange={(e) => updateQuestionAnswer(item.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && e.ctrlKey) {
                            e.preventDefault();
                            void submitQuestionAnswer(item.id);
                          }
                        }}
                        disabled={item.grading}
                        rows={3}
                      />
                      {item.error && <div className="ai-error" role="alert">{item.error}</div>}
                      <div className="question-item-actions">
                        <button
                          className="btn btn-primary"
                          onClick={() => void submitQuestionAnswer(item.id)}
                          disabled={item.grading || !item.answer.trim()}
                        >
                          {item.grading ? (
                            <>
                              <Loader2 size={16} className="spin" /> Evaluating…
                            </>
                          ) : (
                            <>
                              <Sparkles size={16} /> Submit answer
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="question-item-feedback anim-in">
                      <div className={`question-feedback-copy ai-${item.result.verdict}`}>
                        <div className="ai-verdict">
                          {item.result.verdict === 'correct'
                            ? 'Correct'
                            : item.result.verdict === 'partially_correct'
                              ? 'Partially correct'
                              : 'Not quite'}
                        </div>
                        <p className="ai-feedback">
                          <InlineContent text={item.result.feedback} />
                        </p>
                        {item.result.keyPointsMissed.length > 0 && (
                          <ul className="ai-missed">
                            {item.result.keyPointsMissed.map((point, pointIndex) => (
                              <li key={pointIndex}>
                                <InlineContent text={point} />
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div className="question-answer-comparison">
                        <div>
                          <span className="field-label">Your answer</span>
                          <InlineContent text={item.answer} />
                        </div>
                        <div>
                          <span className="field-label">Reference answer</span>
                          <InlineContent text={item.question.expectedAnswer} />
                        </div>
                      </div>
                    </div>
                  )}
                </section>
              ))}
            </div>
          )}

          {phase === 'question' && mode === 'classic' && (
            <div className="study-actions">
              <button className="btn btn-primary btn-show" onClick={() => setPhase('answer')}>
                Show answer <kbd>Space</kbd>
              </button>
            </div>
          )}

          {(phase === 'question' || phase === 'grading') && mode === 'ai' && (
            <div className="ai-answer-zone">
              <textarea
                ref={answerBox}
                className="textarea ai-answer-box"
                placeholder="Answer in your own words — the AI grades understanding, not exact wording. Ctrl+Enter to submit."
                value={typedAnswer}
                onChange={(e) => setTypedAnswer(e.target.value)}
                disabled={aiBusy}
                rows={3}
              />
              {aiError && <div className="ai-error" role="alert">{aiError}</div>}
              <div className="study-actions">
                <button className="btn btn-ghost" onClick={() => setPhase('answer')} disabled={aiBusy}>
                  Show answer
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => void submitAiAnswer()}
                  disabled={aiBusy || !typedAnswer.trim()}
                >
                  {aiBusy ? (
                    <>
                      <Loader2 size={16} className="spin" /> Grading…
                    </>
                  ) : (
                    <>
                      <Sparkles size={16} /> Grade my answer
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {mode === 'questions' && questionItems.length > 0 && (
            <div className="question-batch-footer">
              <div className="question-progress-copy">
                <span>
                  {questionAttempts.length} of {questionItems.length} submitted
                </span>
                <strong>
                  {allQuestionsAnswered
                    ? allQuestionsCorrect
                      ? 'Complete coverage'
                      : 'Review needed'
                    : 'Finish every question'}
                </strong>
              </div>
              <div
                className="question-progress-track"
                role="progressbar"
                aria-label="Question set progress"
                aria-valuemin={0}
                aria-valuemax={questionItems.length}
                aria-valuenow={questionAttempts.length}
              >
                <span
                  style={{
                    width: `${Math.round((questionAttempts.length / questionItems.length) * 100)}%`,
                  }}
                />
              </div>

              {questionPhase === 'loading' && (
                <div className="question-more-loading" role="status">
                  <Loader2 size={15} className="spin" /> Creating another coverage set…
                </div>
              )}

              {questionPhase === 'error' && (
                <div className="question-more-error">
                  <div className="ai-error" role="alert">{questionError}</div>
                  <button className="btn btn-secondary" onClick={askMoreQuestions}>
                    <RefreshCw size={15} /> Try more questions again
                  </button>
                </div>
              )}

              {allQuestionsAnswered && questionSummary ? (
                <>
                  <div className={`question-mastery ${allQuestionsCorrect ? 'is-complete' : 'needs-review'}`}>
                    <div>
                      <span className="question-mastery-label">
                        {allQuestionsCorrect
                          ? 'Complete understanding demonstrated'
                          : 'Some facts still need practice'}
                      </span>
                      <p>
                        {questionSummary.score} average · AI suggests {questionRatingLabel}
                      </p>
                    </div>
                    <div className="question-next-actions">
                      <button
                        className="btn btn-secondary"
                        onClick={askMoreQuestions}
                        disabled={questionBusy}
                      >
                        <ListPlus size={16} /> More questions <kbd>N</kbd>
                      </button>
                    </div>
                  </div>
                  <div className="question-rating-choice anim-in">
                    <div className="question-rating-head">
                      <span className="question-rating-label">How difficult was this card?</span>
                      <span className="question-rating-hint">
                        Choose manually · <kbd>Enter</kbd> accepts the AI suggestion
                      </span>
                    </div>
                    <div className="rating-row question-rating-row" aria-label="Choose card rating">
                      {RATING_META.map((rating) => (
                        <button
                          key={rating.rating}
                          className={`rate-btn ${rating.className} ${
                            questionSummary.suggestedRating === rating.rating ? 'rate-suggested' : ''
                          }`}
                          onClick={() => finishQuestionCard(rating.rating)}
                          disabled={questionBusy}
                        >
                          <span className="rate-interval">
                            {previews?.[rating.rating] ?? ''}
                          </span>
                          <span className="rate-label">
                            {rating.label} <kbd>{rating.key}</kbd>
                          </span>
                          {questionSummary.suggestedRating === rating.rating && (
                            <span className="rate-ai-tag">
                              <Sparkles size={11} /> AI suggests
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <p className="question-finish-hint">
                  The card is rated only after every question has been submitted.
                </p>
              )}
            </div>
          )}

          {phase === 'answer' && (
            <div className="study-reveal anim-in">
              <div className="study-reveal-toolbar">
                <button className="btn btn-ghost" onClick={() => setPhase('question')}>
                  <EyeOff size={15} /> Hide answer <kbd>H</kbd>
                </button>
              </div>
              {aiResult && (
                <div className={`ai-result ai-${aiResult.verdict}`}>
                  <div className="ai-result-head">
                    <div className="ai-score-ring" style={{ ['--score' as string]: aiResult.score }}>
                      <span>{aiResult.score}</span>
                    </div>
                    <div>
                      <div className="ai-verdict">
                        {aiResult.verdict === 'correct'
                          ? 'Correct — you understand this'
                          : aiResult.verdict === 'partially_correct'
                            ? 'Partially correct'
                            : 'Not quite'}
                      </div>
                      <p className="ai-feedback">
                        <InlineContent text={aiResult.feedback} />
                      </p>
                      {aiResult.keyPointsMissed.length > 0 && (
                        <ul className="ai-missed">
                          {aiResult.keyPointsMissed.map((p, i) => (
                            <li key={i}>
                              <InlineContent text={p} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                  {typedAnswer.trim() && (
                    <div className="ai-your-answer">
                      <span className="field-label">Your answer</span>
                      <InlineContent text={typedAnswer} />
                    </div>
                  )}
                </div>
              )}
              <div className="study-divider" />
              <div className="study-answer">
                <FieldContent text={backText} />
              </div>
              <div className="rating-row">
                {RATING_META.map((r) => (
                  <button
                    key={r.rating}
                    className={`rate-btn ${r.className} ${aiResult?.suggestedRating === r.rating ? 'rate-suggested' : ''}`}
                    onClick={() => void rate(r.rating, aiResult ?? undefined)}
                  >
                    <span className="rate-interval">{previews?.[r.rating] ?? ''}</span>
                    <span className="rate-label">
                      {r.label} <kbd>{r.key}</kbd>
                    </span>
                    {aiResult?.suggestedRating === r.rating && (
                      <span className="rate-ai-tag">
                        <Sparkles size={11} /> AI suggests
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {editing && note && (
        <NoteEditModal
          noteId={note.id}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            const fresh = await db.notes.get(note.id);
            const freshCard = card ? await db.cards.get(card.id) : null;
            resetQuestionSession();
            setNote(fresh ?? null);
            if (!freshCard) {
              if (card) skipCurrent(card.id);
            } else {
              setCard(freshCard);
            }
            onChanged();
          }}
        />
      )}

      {showShortcuts && (
        <Modal title="Keyboard shortcuts" onClose={() => setShowShortcuts(false)}>
          <table className="shortcuts-table">
            <tbody>
              {[
                ['Space / Enter', 'Show answer · accept suggested rating'],
                ['1 2 3 4', 'Again · Hard · Good · Easy'],
                ['← →', 'Previous / next card without answering'],
                ['Ctrl+Enter', 'Submit the focused AI answer'],
                ['H', 'Hide a revealed answer'],
                ['C', 'Show or hide the source card in AI modes'],
                ['I', 'Reveal the next hint in Exercise mode'],
                ['N', 'Generate another question set or exercise'],
                ['U', 'Undo last review'],
                ['E', 'Edit current note'],
                ['-', 'Bury card until tomorrow'],
                ['@', 'Suspend card'],
                ['Ctrl+1…4', 'Toggle red / orange / green / blue flag'],
                ['?', 'This help'],
              ].map(([k, desc]) => (
                <tr key={k}>
                  <td>
                    <kbd>{k}</kbd>
                  </td>
                  <td>{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
