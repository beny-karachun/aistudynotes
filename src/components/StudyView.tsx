import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft,
  Undo2,
  Pencil,
  EyeOff,
  PauseCircle,
  Flag,
  Sparkles,
  Keyboard,
  PartyPopper,
  Clock,
  Loader2,
} from 'lucide-react';
import { db } from '../db';
import type { AiGradeResult, CardRecord, Note, Rating, Settings } from '../types';
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
import { gradeAnswer, GeminiError } from '../lib/gemini';
import { FieldContent, InlineContent } from './FieldContent';
import { Modal, useToast } from './ui';
import { NoteEditModal } from './NoteEditModal';

type Phase = 'question' | 'grading' | 'answer';

const RATING_META: { rating: Rating; label: string; className: string; key: string }[] = [
  { rating: 1, label: 'Again', className: 'rate-again', key: '1' },
  { rating: 2, label: 'Hard', className: 'rate-hard', key: '2' },
  { rating: 3, label: 'Good', className: 'rate-good', key: '3' },
  { rating: 4, label: 'Easy', className: 'rate-easy', key: '4' },
];

const FLAG_COLORS = ['transparent', '#ef4444', '#f97316', '#22c55e', '#3b82f6'];

export function StudyView({
  deckId,
  settings,
  onExit,
  onChanged,
}: {
  deckId: string;
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
  const [mode, setMode] = useState<'classic' | 'ai'>(settings.defaultStudyMode);
  const [typedAnswer, setTypedAnswer] = useState('');
  const [aiResult, setAiResult] = useState<AiGradeResult | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [finished, setFinished] = useState(false);
  const [waitingUntil, setWaitingUntil] = useState<number | null>(null);
  const undoStack = useRef<AnswerResult[]>([]);
  const cardStart = useRef(Date.now());
  const answerBox = useRef<HTMLTextAreaElement>(null);
  const busyRef = useRef(false);

  const deckById = useMemo(() => new Map((decks ?? []).map((d) => [d.id, d])), [decks]);
  const rootDeck = deckById.get(deckId);

  const presentFrom = useCallback(
    (q: StudyQueue) => {
      const now = Date.now();
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
    [],
  );

  const loadQueue = useCallback(async () => {
    const allDecks = await db.decks.toArray();
    if (!allDecks.some((d) => d.id === deckId)) {
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
  }, [queue, card, phase]);

  const config = card ? (deckById.get(card.deckId)?.config ?? rootDeck?.config) : rootDeck?.config;
  const previews = useMemo(
    () => (card && config && phase !== 'question' ? intervalPreviews(card, config) : null),
    [card, config, phase],
  );

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
  }, [queue, onChanged, toast]);

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
        if (e.key === 'Enter' && e.ctrlKey && mode === 'ai' && phase === 'question') {
          e.preventDefault();
          void submitAiAnswer();
        }
        return;
      }
      if (editing || showShortcuts) return;
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
  }, [card, phase, mode, aiResult, editing, showShortcuts, rate, undo, bury, suspend, setFlag, submitAiAnswer]);

  // Focus the AI answer box when a new question appears
  useEffect(() => {
    if (phase === 'question' && mode === 'ai') {
      answerBox.current?.focus();
    }
  }, [phase, mode, card]);

  if (!rootDeck || !queue) return <div className="view-pad">Loading…</div>;

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
          <ArrowLeft size={15} /> {rootDeck.name}
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
              onClick={() => setMode('classic')}
              title="Flip and grade yourself"
            >
              Classic
            </button>
            <button
              className={mode === 'ai' ? 'active' : ''}
              onClick={() => setMode('ai')}
              title="Type your answer, AI grades your understanding"
            >
              <Sparkles size={13} /> AI
            </button>
          </div>
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
        <div className="study-card card-panel" key={card.id + phase}>
          <div className="study-question">
            <FieldContent text={frontText} />
          </div>

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

          {phase === 'answer' && (
            <div className="study-reveal anim-in">
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
                ['Ctrl+Enter', 'Submit answer for AI grading'],
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
