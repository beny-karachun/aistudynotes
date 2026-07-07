import type { AiGradeResult, AiStrictness, GeminiModelOption, Rating } from '../types';
import { mediaBase64, mediaIdsIn } from './media';
import { clozeAnswers } from './cloze';
import type { Note } from '../types';

// Model catalog — verified against the Gemini API docs (July 2026).
// "Flash Thinking" is gemini-3.5-flash with thinkingLevel "high"; there is no
// separate -thinking model id in the 3.x generation.
export const GEMINI_MODELS: GeminiModelOption[] = [
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash-Lite (default)',
    description: 'Fastest and cheapest; great for everyday grading.',
  },
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    description: 'Stronger reasoning for nuanced answers.',
  },
  {
    id: 'gemini-3.5-flash#thinking',
    label: 'Gemini 3.5 Flash — Thinking (high)',
    description: 'Deepest reasoning; slower. Uses thinkingLevel: high.',
    thinkingLevel: 'high',
  },
];

export const DEFAULT_MODEL = GEMINI_MODELS[0].id;

/** Resolve a settings model id to the actual API model + thinking config. */
function resolveModel(settingsId: string): { apiModel: string; thinkingLevel?: 'low' | 'high' } {
  const opt = GEMINI_MODELS.find((m) => m.id === settingsId) ?? GEMINI_MODELS[0];
  return { apiModel: opt.id.split('#')[0], thinkingLevel: opt.thinkingLevel };
}

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

async function partsForField(label: string, text: string): Promise<GeminiPart[]> {
  const parts: GeminiPart[] = [];
  const cleanText = text.replace(/\[img:[a-zA-Z0-9-]+\]/g, ' [see attached image] ').trim();
  parts.push({ text: `${label}:\n${cleanText || '(image only)'}` });
  for (const id of mediaIdsIn(text)) {
    const media = await mediaBase64(id);
    if (media) {
      parts.push({ inline_data: { mime_type: media.mime, data: media.base64 } });
    }
  }
  return parts;
}

const STRICTNESS_PROMPTS: Record<AiStrictness, string> = {
  lenient:
    'Be generous: accept answers that show the core idea even if phrased loosely or missing minor details.',
  moderate:
    'Be balanced: the answer must capture the essential meaning; minor omissions are acceptable, factual errors are not.',
  strict:
    'Be demanding: the answer must be complete, precise, and cover all key points to be considered correct.',
};

const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    score: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description: 'How well the student understands, 0-100',
    },
    verdict: { type: 'string', enum: ['correct', 'partially_correct', 'incorrect'] },
    feedback: {
      type: 'string',
      description:
        'Two or three sentences, addressed directly to the student: what they got right, what they got wrong or missed. Encouraging but honest.',
    },
    keyPointsMissed: {
      type: 'array',
      items: { type: 'string' },
      description: 'Key facts/concepts from the expected answer the student failed to demonstrate. Empty if none.',
    },
    suggestedRating: {
      type: 'integer',
      minimum: 1,
      maximum: 4,
      description:
        'Spaced-repetition rating: 1=Again (did not know it), 2=Hard (knew it with significant gaps/effort), 3=Good (knew it), 4=Easy (knew it perfectly and instantly)',
    },
  },
  required: ['score', 'verdict', 'feedback', 'keyPointsMissed', 'suggestedRating'],
};

export class GeminiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface GradeRequest {
  note: Note;
  /** cloze index for cloze cards, 0/1 for basic cards */
  ord: number;
  /** true when the card being studied is the reversed (back→front) card */
  reversed: boolean;
  userAnswer: string;
  apiKey: string;
  model: string;
  strictness: AiStrictness;
}

export async function gradeAnswer(req: GradeRequest): Promise<AiGradeResult> {
  if (!req.apiKey) {
    throw new GeminiError('No API key configured. Add your Gemini API key in Settings.');
  }
  const { apiModel, thinkingLevel } = resolveModel(req.model);

  const isCloze = req.note.type === 'cloze';
  const questionField = req.reversed ? req.note.back : req.note.front;
  const answerField = req.reversed ? req.note.front : req.note.back;

  const parts: GeminiPart[] = [];
  parts.push({
    text: `You are grading a flashcard review for understanding, not word-for-word recall. The student saw the QUESTION and typed their answer from memory. Compare it to the EXPECTED ANSWER. Judge whether the student genuinely understands the concept — accept synonyms, paraphrases and different orderings when the meaning is right. If images are attached, they are part of the card content and must be considered. Card text and student answers may contain TeX math between $ or $$ delimiters — read it as math notation. ${STRICTNESS_PROMPTS[req.strictness]}`,
  });

  if (isCloze) {
    const answers = clozeAnswers(req.note.front, req.ord);
    parts.push(
      ...(await partsForField(
        'QUESTION (cloze text with the tested part hidden)',
        stripClozeExcept(req.note.front, req.ord),
      )),
    );
    parts.push({ text: `EXPECTED ANSWER (the hidden part): ${answers.join('; ')}` });
    if (req.note.back.trim()) {
      parts.push(...(await partsForField('EXTRA CONTEXT', req.note.back)));
    }
  } else {
    parts.push(...(await partsForField('QUESTION', questionField)));
    parts.push(...(await partsForField('EXPECTED ANSWER', answerField)));
  }

  parts.push({ text: `STUDENT'S ANSWER:\n${req.userAnswer.trim() || '(blank)'}` });

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: GRADE_SCHEMA,
      ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
    },
  };

  const res = await fetch(`${API_BASE}/${apiModel}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': req.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const err = await res.json();
      detail = err?.error?.message ?? '';
    } catch {
      /* ignore */
    }
    if (res.status === 400 && /API key/i.test(detail)) {
      throw new GeminiError('Invalid API key. Check it in Settings.', res.status);
    }
    if (res.status === 429) {
      throw new GeminiError('Rate limit reached. Wait a moment and try again.', res.status);
    }
    throw new GeminiError(detail || `Gemini API error (HTTP ${res.status})`, res.status);
  }

  const data = await res.json();
  const text: string | undefined = data?.candidates?.[0]?.content?.parts
    ?.map((p: { text?: string }) => p.text ?? '')
    .join('');
  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new GeminiError(
      blockReason ? `Request blocked by safety filters (${blockReason}).` : 'Empty response from Gemini.',
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeminiError('Gemini returned malformed JSON. Try again.');
  }

  const score = clampInt(parsed.score, 0, 100, 0);
  const suggestedRating = clampInt(parsed.suggestedRating, 1, 4, score >= 60 ? 3 : 1) as Rating;
  const verdict = ['correct', 'partially_correct', 'incorrect'].includes(String(parsed.verdict))
    ? (parsed.verdict as AiGradeResult['verdict'])
    : score >= 80
      ? 'correct'
      : score >= 40
        ? 'partially_correct'
        : 'incorrect';

  return {
    score,
    verdict,
    feedback: String(parsed.feedback ?? ''),
    keyPointsMissed: Array.isArray(parsed.keyPointsMissed)
      ? parsed.keyPointsMissed.map(String)
      : [],
    suggestedRating,
    model: apiModel + (thinkingLevel ? ` (thinking: ${thinkingLevel})` : ''),
  };
}

/** Render cloze text with only the active index hidden, keeping others filled. */
function stripClozeExcept(text: string, activeIndex: number): string {
  return text.replace(
    /\{\{c(\d+)::((?:[^:]|:(?!:))*?)(?:::((?:[^:]|:(?!:))*?))?\}\}/g,
    (_all, idx: string, content: string, hint?: string) =>
      parseInt(idx, 10) === activeIndex ? `[${hint || '...'}]` : content,
  );
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.round(v) : parseInt(String(v), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Cheap connectivity/key test used by the Settings screen. */
export async function testApiKey(apiKey: string, model: string): Promise<string> {
  const { apiModel } = resolveModel(model);
  const res = await fetch(`${API_BASE}/${apiModel}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'minimal' } },
    }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error?.message ?? '';
    } catch {
      /* ignore */
    }
    throw new GeminiError(detail || `HTTP ${res.status}`, res.status);
  }
  return apiModel;
}
