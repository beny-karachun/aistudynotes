import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft,
  ArrowRight,
  BrainCircuit,
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
import { db } from '../db';
import type {
  AiCardQuestion,
  AiGradeResult,
  CardRecord,
  Note,
  Rating,
  Settings,
  StudyMode,
} from '../types';
import { CardState } from '../types';
import {
  answerCard,
  buildQueue,
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
  generateCardQuestion,
  gradeAnswer,
  gradeCardQuestion,
  GeminiError,
} from '../lib/gemini';
import { FieldContent, InlineContent } from './FieldContent';
import { Modal, useToast } from './ui';
import { NoteEditModal } from './NoteEditModal';

type Phase = 'question' | 'grading' | 'answer';
type QuestionPhase = 'idle' | 'loading' | 'question' | 'grading' | 'result' | 'error';

interface QuestionAttempt {
  question: AiCardQuestion;
  answer: string;
  result: AiGradeResult;
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
const pendingInitialQuestions = new Map<string, Promise<AiCardQuestion>>();

function aggregateQuestionAttempts(attempts: QuestionAttempt[]): AiGradeResult | null {
  if (attempts.length === 0) return null;
  const score = Math.round(
    attempts.reduce((sum, attempt) => sum + attempt.result.score, 0) / attempts.length,
  );
  const rating = Math.max(
    1,
    Math.min(
      4,
      Math.round(
        attempts.reduce((sum, attempt) => sum + attempt.result.suggestedRating, 0) /
          attempts.length,
      ),
    ),
  ) as Rating;
  return {
    score,
    verdict: score >= 80 ? 'correct' : score >= 40 ? 'partially_correct' : 'incorrect',
    feedback: `Average across ${attempts.length} AI-generated question${attempts.length === 1 ? '' : 's'}.`,
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
  settings,
  onExit,
  onChanged,
}: {
  /** null = study the whole collection */
  deckId: string | null;
  settings: Settings;
  onExit: () => void;
  onChanged: () => void;
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
  const [cardQuestion, setCardQuestion] = useState<AiCardQuestion | null>(null);
  const [questionAnswer, setQuestionAnswer] = useState('');
  const [questionResult, setQuestionResult] = useState<AiGradeResult | null>(null);
  const [questionAttempts, setQuestionAttempts] = useState<QuestionAttempt[]>([]);
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
  const busyRef = useRef(false);
  const questionRequestToken = useRef(0);

  const deckById = useMemo(() => new Map((decks ?? []).map((d) => [d.id, d])), [decks]);
  const rootDeck = deckId !== null ? deckById.get(deckId) : undefined;

  const resetQuestionSession = useCallback(() => {
    questionRequestToken.current += 1;
    setCardQuestion(null);
    setQuestionAnswer('');
    setQuestionResult(null);
    setQuestionAttempts([]);
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
    const q = await buildQueue(allDecks, deckId, Date.now(), settings.dayStartHour);
    setQueue(q);
    presentFrom(q);
  }, [deckId, settings.dayStartHour, presentFrom, onExit]);

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
      learnCount: queue.learning.length,
      reviewCount: queue.main.filter((c) => c.state !== CardState.New).length,
    };
  }, [queue]);

  const config = card ? (deckById.get(card.deckId)?.config ?? rootDeck?.config) : rootDeck?.config;
  const previews = useMemo(
    () => (card && config && phase !== 'question' ? intervalPreviews(card, config) : null),
    [card, config, phase],
  );
  const questionSummary = useMemo(
    () => aggregateQuestionAttempts(questionAttempts),
    [questionAttempts],
  );
  const questionBusy = questionPhase === 'loading' || questionPhase === 'grading';

  const reversed = card?.ord === 1 && note?.type === 'basicReversed';

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
      if (!queue || aiBusy || questionPhase === 'loading' || questionPhase === 'grading') return;
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
    [queue, card, aiBusy, questionPhase, resetQuestionSession],
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

  const loadCardQuestion = useCallback(
    async (previousQuestions: string[]) => {
      if (!card || !note || note.id !== card.noteId) return;
      if (!settings.apiKey) {
        setQuestionError('Add your Gemini API key in Settings to generate questions.');
        setQuestionPhase('error');
        return;
      }

      const token = ++questionRequestToken.current;
      setCardQuestion(null);
      setQuestionResult(null);
      setQuestionAnswer('');
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
        let pending: Promise<AiCardQuestion>;
        if (previousQuestions.length === 0) {
          const cacheKey = [card.id, note.updatedAt, settings.model, settings.aiLanguage].join(':');
          const existing = pendingInitialQuestions.get(cacheKey);
          if (existing) {
            pending = existing;
          } else {
            pending = generateCardQuestion(request);
            pendingInitialQuestions.set(cacheKey, pending);
            void pending.then(
              () => pendingInitialQuestions.delete(cacheKey),
              () => pendingInitialQuestions.delete(cacheKey),
            );
          }
        } else {
          pending = generateCardQuestion(request);
        }
        const generated = await pending;
        if (questionRequestToken.current !== token) return;
        setCardQuestion(generated);
        setQuestionPhase('question');
      } catch (e) {
        if (questionRequestToken.current !== token) return;
        setQuestionError(
          e instanceof GeminiError ? e.message : 'Could not generate a question. Try again.',
        );
        setQuestionPhase('error');
      }
    },
    [card, note, settings.apiKey, settings.model, settings.aiLanguage],
  );

  const submitQuestionAnswer = useCallback(async () => {
    if (
      !cardQuestion ||
      !note ||
      !questionAnswer.trim() ||
      questionPhase !== 'question'
    ) {
      return;
    }
    if (!settings.apiKey) {
      setQuestionError('Add your Gemini API key in Settings to grade answers.');
      return;
    }

    const token = ++questionRequestToken.current;
    setQuestionError(null);
    setQuestionPhase('grading');
    try {
      const result = await gradeCardQuestion({
        note,
        question: cardQuestion,
        userAnswer: questionAnswer,
        apiKey: settings.apiKey,
        model: settings.model,
        strictness: settings.aiStrictness,
        language: settings.aiLanguage,
      });
      if (questionRequestToken.current !== token) return;
      setQuestionResult(result);
      setQuestionAttempts((attempts) => [
        ...attempts,
        { question: cardQuestion, answer: questionAnswer.trim(), result },
      ]);
      setQuestionPhase('result');
    } catch (e) {
      if (questionRequestToken.current !== token) return;
      setQuestionError(e instanceof GeminiError ? e.message : 'AI grading failed. Try again.');
      setQuestionPhase('question');
    }
  }, [cardQuestion, note, questionAnswer, questionPhase, settings]);

  const askAnotherQuestion = useCallback(() => {
    void loadCardQuestion(questionAttempts.map((attempt) => attempt.question.question));
  }, [loadCardQuestion, questionAttempts]);

  const finishQuestionCard = useCallback(() => {
    if (!questionSummary) return;
    void rate(questionSummary.suggestedRating, questionSummary);
  }, [questionSummary, rate]);

  // Invalidate late AI responses when the component unmounts (including the
  // development-only StrictMode remount).
  useEffect(
    () => () => {
      questionRequestToken.current += 1;
    },
    [],
  );

  // Entering the mode or advancing to a card automatically asks the first question.
  useEffect(() => {
    if (
      mode === 'questions' &&
      card &&
      note?.id === card.noteId &&
      questionPhase === 'idle' &&
      !cardQuestion
    ) {
      void loadCardQuestion([]);
    }
  }, [mode, card, note, questionPhase, cardQuestion, loadCardQuestion]);

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
          } else if (mode === 'questions' && questionPhase === 'question') {
            e.preventDefault();
            void submitQuestionAnswer();
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
      if (mode === 'questions' && cardQuestion && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        setShowQuestionCard((shown) => !shown);
        return;
      }
      if (mode === 'questions' && questionPhase === 'result') {
        if (e.key === 'n' || e.key === 'N') {
          e.preventDefault();
          askAnotherQuestion();
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
  }, [card, phase, mode, aiResult, cardQuestion, questionPhase, editing, showShortcuts, rate, undo, bury, suspend, setFlag, submitAiAnswer, submitQuestionAnswer, askAnotherQuestion, finishQuestionCard, skipBy]);

  // Focus the AI answer box when a new question appears
  useEffect(() => {
    if (
      (phase === 'question' && mode === 'ai') ||
      (mode === 'questions' && questionPhase === 'question')
    ) {
      answerBox.current?.focus();
    }
  }, [phase, mode, card, questionPhase, cardQuestion]);

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
  const currentQuestionNumber =
    questionPhase === 'result' ? questionAttempts.length : questionAttempts.length + 1;
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
          <ArrowLeft size={15} /> {rootDeck?.name ?? 'All decks'}
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
          </div>
          {navInfo.total > 1 && (
            <span className="card-nav" role="group" aria-label="Browse cards without answering">
              <button
                className="icon-btn"
                title="Previous card — no answer recorded (←)"
                aria-label="Previous card"
                onClick={() => skipBy(-1)}
                disabled={aiBusy || questionBusy}
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
                disabled={aiBusy || questionBusy}
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
          <p>You've finished this deck for now. Come back later for more reviews.</p>
          <button className="btn btn-primary" onClick={onExit}>
            Back to decks
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
            Back to decks
          </button>
        </div>
      )}

      {card && note && (
        <div className="study-card card-panel" key={card.id + phase + mode}>
          <div className={`study-question ${mode === 'questions' ? 'generated-question' : ''}`}>
            {mode !== 'questions' && <FieldContent text={frontText} />}

            {mode === 'questions' && questionPhase === 'loading' && (
              <div className="question-loading" role="status">
                <span className="question-icon-wrap">
                  <Loader2 size={20} className="spin" />
                </span>
                <div>
                  <span className="question-eyebrow">Question {currentQuestionNumber}</span>
                  <div className="question-loading-title">Creating a fresh question…</div>
                  <p>Finding a new angle grounded in this card.</p>
                </div>
              </div>
            )}

            {mode === 'questions' && questionPhase === 'error' && (
              <div className="question-error-state">
                <div className="ai-error" role="alert">{questionError}</div>
                <div className="question-error-actions">
                  <button
                    className="btn btn-secondary"
                    onClick={() =>
                      void loadCardQuestion(
                        questionAttempts.map((attempt) => attempt.question.question),
                      )
                    }
                  >
                    <RefreshCw size={15} /> Try again
                  </button>
                  {questionSummary && (
                    <button className="btn btn-primary" onClick={finishQuestionCard}>
                      Next card <ArrowRight size={15} />
                    </button>
                  )}
                </div>
              </div>
            )}

            {mode === 'questions' && cardQuestion && questionPhase !== 'loading' && (
              <div className="question-prompt anim-in" key={cardQuestion.question}>
                <div className="question-prompt-head">
                  <div className="question-prompt-identity">
                    <span className="question-icon-wrap" aria-hidden="true">
                      <MessageCircleQuestion size={20} />
                    </span>
                    <span className="question-eyebrow">AI question {currentQuestionNumber}</span>
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
                <div className="question-text">
                  <InlineContent text={cardQuestion.question} />
                </div>
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

          {mode === 'questions' && questionAttempts.length > 0 && (
            <div className="question-attempts" aria-label="Scores for this card">
              {questionAttempts.map((attempt, index) => (
                <span
                  key={`${index}-${attempt.question.question}`}
                  className={`question-score-chip ai-${attempt.result.verdict}`}
                  title={attempt.question.question}
                >
                  <span>Q{index + 1}</span>
                  <strong>{attempt.result.score}</strong>
                </span>
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

          {mode === 'questions' &&
            cardQuestion &&
            (questionPhase === 'question' || questionPhase === 'grading') && (
              <div className="ai-answer-zone question-answer-zone">
                <textarea
                  ref={answerBox}
                  className="textarea ai-answer-box question-answer-box"
                  placeholder="Answer this question in your own words. Ctrl+Enter to submit."
                  value={questionAnswer}
                  onChange={(e) => setQuestionAnswer(e.target.value)}
                  disabled={questionPhase === 'grading'}
                  rows={3}
                />
                {questionError && <div className="ai-error" role="alert">{questionError}</div>}
                <div className="study-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => void submitQuestionAnswer()}
                    disabled={questionPhase === 'grading' || !questionAnswer.trim()}
                  >
                    {questionPhase === 'grading' ? (
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
            )}

          {mode === 'questions' &&
            questionPhase === 'result' &&
            cardQuestion &&
            questionResult &&
            questionSummary && (
              <div className="question-result-stack anim-in">
                <div className={`ai-result ai-${questionResult.verdict}`}>
                  <div className="ai-result-head">
                    <div
                      className="ai-score-ring"
                      style={{ ['--score' as string]: questionResult.score }}
                    >
                      <span>{questionResult.score}</span>
                    </div>
                    <div>
                      <div className="ai-verdict">
                        {questionResult.verdict === 'correct'
                          ? 'Correct — you understand this'
                          : questionResult.verdict === 'partially_correct'
                            ? 'Partially correct'
                            : 'Not quite'}
                      </div>
                      <p className="ai-feedback">
                        <InlineContent text={questionResult.feedback} />
                      </p>
                      {questionResult.keyPointsMissed.length > 0 && (
                        <ul className="ai-missed">
                          {questionResult.keyPointsMissed.map((point, index) => (
                            <li key={index}>
                              <InlineContent text={point} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                  <div className="ai-your-answer">
                    <span className="field-label">Your answer</span>
                    <InlineContent text={questionAnswer} />
                  </div>
                </div>

                <div className="question-reference">
                  <span className="field-label">Reference answer</span>
                  <InlineContent text={cardQuestion.expectedAnswer} />
                </div>

                <div className="question-session-summary">
                  <span>
                    {questionAttempts.length} question{questionAttempts.length === 1 ? '' : 's'} on
                    this card
                  </span>
                  <strong>{questionSummary.score} average · {questionRatingLabel}</strong>
                </div>

                <div className="question-next-actions">
                  <button className="btn btn-secondary" onClick={askAnotherQuestion}>
                    <ListPlus size={16} /> Another question <kbd>N</kbd>
                  </button>
                  <button className="btn btn-primary" onClick={finishQuestionCard}>
                    Next card <ArrowRight size={16} /> <kbd>Enter</kbd>
                  </button>
                </div>
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
                ['Ctrl+Enter', 'Submit answer for AI grading'],
                ['H', 'Hide a revealed answer'],
                ['C', 'Show or hide card content in AI Questions'],
                ['N', 'Ask another AI question on this card'],
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
