import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Dumbbell,
  Eye,
  EyeOff,
  ImageIcon,
  Lightbulb,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Target,
  XCircle,
} from 'lucide-react';
import type {
  AiCardExercise,
  AiExerciseGradeResult,
  AiGradeResult,
  CardRecord,
  Note,
  Rating,
  Settings,
} from '../types';
import {
  generateCardExercise,
  GeminiError,
  gradeCardExercise,
} from '../lib/gemini';
import { FieldContent, InlineContent } from './FieldContent';

type ExercisePhase = 'idle' | 'generating' | 'ready' | 'grading' | 'evaluated' | 'error';

const pendingInitialExercises = new Map<string, Promise<AiCardExercise>>();

const RATING_LABELS: Record<Rating, string> = {
  1: 'Again',
  2: 'Hard',
  3: 'Good',
  4: 'Easy',
};

export function ExerciseMode({
  card,
  note,
  settings,
  frontText,
  backText,
  onComplete,
  onBusyChange,
}: {
  card: CardRecord;
  note: Note;
  settings: Settings;
  frontText: string;
  backText: string;
  onComplete: (rating: Rating, result: AiGradeResult) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [phase, setPhase] = useState<ExercisePhase>('idle');
  const [exercise, setExercise] = useState<AiCardExercise | null>(null);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<AiExerciseGradeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCard, setShowCard] = useState(false);
  const [visibleHints, setVisibleHints] = useState(0);
  const [previousTasks, setPreviousTasks] = useState<string[]>([]);
  const requestToken = useRef(0);
  const gradingRef = useRef(false);
  const answerBox = useRef<HTMLTextAreaElement>(null);

  const busy = phase === 'generating' || phase === 'grading';

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  useEffect(
    () => () => {
      requestToken.current += 1;
      onBusyChange(false);
    },
    [onBusyChange],
  );

  const loadExercise = useCallback(
    async (usedTasks: string[]) => {
      if (!settings.apiKey) {
        setExercise(null);
        setError('Add your Gemini API key in Settings to generate an exercise.');
        setPhase('error');
        return;
      }

      const token = ++requestToken.current;
      setExercise(null);
      setAnswer('');
      setResult(null);
      setError(null);
      setShowCard(false);
      setVisibleHints(0);
      setPhase('generating');
      const request = {
        note,
        previousTasks: usedTasks,
        apiKey: settings.apiKey,
        model: settings.model,
        language: settings.aiLanguage,
      };

      try {
        let pending: Promise<AiCardExercise>;
        if (usedTasks.length === 0) {
          const cacheKey = [card.id, note.updatedAt, settings.model, settings.aiLanguage].join(':');
          const existing = pendingInitialExercises.get(cacheKey);
          if (existing) {
            pending = existing;
          } else {
            pending = generateCardExercise(request);
            pendingInitialExercises.set(cacheKey, pending);
            void pending.then(
              () => pendingInitialExercises.delete(cacheKey),
              () => pendingInitialExercises.delete(cacheKey),
            );
          }
        } else {
          pending = generateCardExercise(request);
        }
        const generated = await pending;
        if (requestToken.current !== token) return;
        setExercise(generated);
        setPreviousTasks((tasks) =>
          tasks.includes(generated.task) ? tasks : [...tasks, generated.task].slice(-6),
        );
        setPhase('ready');
      } catch (cause) {
        if (requestToken.current !== token) return;
        setError(
          cause instanceof GeminiError
            ? cause.message
            : 'Could not generate an applied exercise. Try again.',
        );
        setPhase('error');
      }
    },
    [card.id, note, settings.apiKey, settings.model, settings.aiLanguage],
  );

  useEffect(() => {
    if (phase === 'idle') void loadExercise([]);
  }, [phase, loadExercise]);

  useEffect(() => {
    if (phase === 'ready') answerBox.current?.focus();
  }, [phase, exercise]);

  const revealHint = useCallback(() => {
    if (!exercise || phase !== 'ready') return;
    setVisibleHints((count) => Math.min(count + 1, exercise.hints.length));
  }, [exercise, phase]);

  const submit = useCallback(async () => {
    if (!exercise || !answer.trim() || gradingRef.current || phase !== 'ready') return;
    if (!settings.apiKey) {
      setError('Add your Gemini API key in Settings to evaluate the exercise.');
      return;
    }

    gradingRef.current = true;
    const token = requestToken.current;
    setError(null);
    setPhase('grading');
    try {
      const grade = await gradeCardExercise({
        note,
        exercise,
        userAnswer: answer,
        hintsUsed: visibleHints,
        apiKey: settings.apiKey,
        model: settings.model,
        strictness: settings.aiStrictness,
        language: settings.aiLanguage,
      });
      if (requestToken.current !== token) return;
      setAnswer((value) => value.trim());
      setResult(grade);
      setPhase('evaluated');
    } catch (cause) {
      if (requestToken.current !== token) return;
      setError(cause instanceof GeminiError ? cause.message : 'AI evaluation failed. Try again.');
      setPhase('ready');
    } finally {
      gradingRef.current = false;
    }
  }, [answer, exercise, note, phase, settings, visibleHints]);

  const createAnother = useCallback(() => {
    if (busy) return;
    void loadExercise(previousTasks);
  }, [busy, loadExercise, previousTasks]);

  const finish = useCallback(() => {
    if (!result || busy) return;
    onComplete(result.suggestedRating, result);
  }, [busy, onComplete, result]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLButtonElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if ((event.key === 'c' || event.key === 'C') && exercise) {
        event.preventDefault();
        setShowCard((shown) => !shown);
        return;
      }
      if ((event.key === 'i' || event.key === 'I') && phase === 'ready') {
        event.preventDefault();
        revealHint();
        return;
      }
      if (result && (event.key === 'n' || event.key === 'N')) {
        event.preventDefault();
        createAnother();
        return;
      }
      if (result && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        finish();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [createAnother, exercise, finish, phase, result, revealHint]);

  if (phase === 'generating') {
    return (
      <div className="exercise-loading" role="status">
        <span className="exercise-icon-wrap">
          <Loader2 size={21} className="spin" />
        </span>
        <div>
          <span className="exercise-eyebrow">Applied practice</span>
          <strong>Designing a challenging exercise…</strong>
          <p>Turning this card’s knowledge into a problem to solve.</p>
        </div>
      </div>
    );
  }

  if (phase === 'error' || !exercise) {
    return (
      <div className="exercise-error-state">
        <div className="ai-error" role="alert">{error}</div>
        <button className="btn btn-secondary" onClick={() => void loadExercise(previousTasks)}>
          <RefreshCw size={15} /> Try again
        </button>
      </div>
    );
  }

  return (
    <div className="exercise-mode">
      <header className="exercise-header anim-in">
        <div className="exercise-identity">
          <span className="exercise-icon-wrap" aria-hidden="true">
            <Dumbbell size={21} />
          </span>
          <div>
            <span className="exercise-eyebrow">AI applied exercise</span>
            <span className="exercise-depth-label">Reason, decide, and explain</span>
          </div>
        </div>
        <button
          className={`question-card-toggle ${showCard ? 'is-open' : ''}`}
          onClick={() => setShowCard((shown) => !shown)}
          aria-expanded={showCard}
          aria-controls="exercise-source-card"
        >
          <span className="question-toggle-icons" aria-hidden="true">
            <Eye size={16} className="question-toggle-show" />
            <EyeOff size={16} className="question-toggle-hide" />
          </span>
          {showCard ? 'Hide card' : 'Show card'} <kbd>C</kbd>
        </button>
      </header>

      {exercise.usesSourceVisual && (
        <div className="exercise-visual-note anim-in">
          <ImageIcon size={16} />
          This challenge uses the source visual. Reveal the card when you’re ready to inspect it.
        </div>
      )}

      {showCard && (
        <div id="exercise-source-card" className="question-card-content exercise-source-card anim-in">
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

      <article className="exercise-challenge anim-in">
        <div className="exercise-challenge-heading">
          <span className="exercise-eyebrow">Challenge</span>
          <h2>{exercise.title}</h2>
        </div>
        <section className="exercise-scenario">
          <span className="field-label">Scenario</span>
          <p><InlineContent text={exercise.scenario} /></p>
        </section>
        <section className="exercise-task">
          <Target size={19} aria-hidden="true" />
          <div>
            <span className="field-label">Your task</span>
            <p><InlineContent text={exercise.task} /></p>
          </div>
        </section>
      </article>

      {!result && (
        <section className="exercise-workspace anim-in">
          <div className="exercise-answer-heading">
            <div>
              <span className="field-label">Your solution</span>
              <p>Show the reasoning, intermediate steps, and final conclusion.</p>
            </div>
            <button
              className="btn btn-ghost exercise-hint-button"
              onClick={revealHint}
              disabled={phase !== 'ready' || visibleHints >= exercise.hints.length}
            >
              <Lightbulb size={16} />
              {visibleHints >= exercise.hints.length
                ? 'All hints shown'
                : visibleHints === 0
                  ? 'Reveal a hint'
                  : 'Next hint'}
              <kbd>I</kbd>
            </button>
          </div>

          {visibleHints > 0 && (
            <ol className="exercise-hints" aria-label="Revealed hints">
              {exercise.hints.slice(0, visibleHints).map((hint, index) => (
                <li
                  key={`${index}-${hint}`}
                  className="anim-in"
                  style={{ animationDelay: `${index * 70}ms` }}
                >
                  <span>Hint {index + 1}</span>
                  <p><InlineContent text={hint} /></p>
                </li>
              ))}
            </ol>
          )}

          <textarea
            ref={answerBox}
            className="textarea exercise-answer-box"
            placeholder="Work through the problem in your own words…"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.ctrlKey) {
                event.preventDefault();
                void submit();
              }
            }}
            disabled={phase === 'grading'}
            rows={8}
          />
          {error && <div className="ai-error" role="alert">{error}</div>}
          <div className="exercise-submit-row">
            {visibleHints > 0 && (
              <span className="exercise-assist-note">
                {visibleHints} hint{visibleHints === 1 ? '' : 's'} used · Easy is disabled
              </span>
            )}
            <button
              className="btn btn-primary"
              onClick={() => void submit()}
              disabled={phase === 'grading' || !answer.trim()}
            >
              {phase === 'grading' ? (
                <>
                  <Loader2 size={16} className="spin" /> Evaluating reasoning…
                </>
              ) : (
                <>
                  <Sparkles size={16} /> Evaluate solution
                </>
              )}
            </button>
          </div>
        </section>
      )}

      {result && (
        <section className="exercise-result anim-in">
          <div className={`ai-result ai-${result.verdict}`}>
            <div className="ai-result-head">
              <div className="ai-score-ring" style={{ ['--score' as string]: result.score }}>
                <span>{result.score}</span>
              </div>
              <div>
                <div className="ai-verdict">
                  {result.verdict === 'correct'
                    ? 'Applied correctly'
                    : result.verdict === 'partially_correct'
                      ? 'Good reasoning with gaps'
                      : 'The application needs another pass'}
                </div>
                <p className="ai-feedback"><InlineContent text={result.feedback} /></p>
                {result.keyPointsMissed.length > 0 && (
                  <ul className="ai-missed">
                    {result.keyPointsMissed.map((point, index) => (
                      <li key={`${index}-${point}`}><InlineContent text={point} /></li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>

          <div className="exercise-rubric">
            <div className="exercise-section-head">
              <div>
                <span className="exercise-eyebrow">Reasoning coverage</span>
                <h3>How your solution met the rubric</h3>
              </div>
              <strong>
                {result.criterionResults.filter((criterion) => criterion.met).length}/
                {result.criterionResults.length}
              </strong>
            </div>
            <ul className="exercise-criteria-list">
              {result.criterionResults.map((criterion, index) => (
                <li
                  key={`${index}-${criterion.criterion}`}
                  className={criterion.met ? 'criterion-met' : 'criterion-missed'}
                >
                  {criterion.met
                    ? <CheckCircle2 size={18} aria-label="Met" />
                    : <XCircle size={18} aria-label="Not met" />}
                  <div>
                    <strong><InlineContent text={criterion.criterion} /></strong>
                    <p><InlineContent text={criterion.feedback} /></p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="exercise-solution-comparison">
            <div>
              <span className="field-label">Your solution</span>
              <p><InlineContent text={answer} /></p>
            </div>
            <div>
              <span className="field-label">Worked solution</span>
              <p><InlineContent text={exercise.referenceSolution} /></p>
            </div>
          </div>

          <footer className="exercise-result-footer">
            <div>
              <span className="exercise-result-label">
                {RATING_LABELS[result.suggestedRating]} scheduling result
              </span>
              <p>
                {visibleHints > 0
                  ? `Based on the rubric and ${visibleHints} revealed hint${visibleHints === 1 ? '' : 's'}.`
                  : 'Based on the complete applied response.'}
              </p>
            </div>
            <div className="exercise-result-actions">
              <button className="btn btn-secondary" onClick={createAnother} disabled={busy}>
                <RotateCcw size={16} /> New exercise <kbd>N</kbd>
              </button>
              <button className="btn btn-primary" onClick={finish} disabled={busy}>
                Next card <ArrowRight size={16} /> <kbd>Enter</kbd>
              </button>
            </div>
          </footer>
        </section>
      )}
    </div>
  );
}
