import { useRef, useState } from 'react';
import { FileUp, Loader2, Sparkles, Trash2, ArrowLeft, Plus } from 'lucide-react';
import type { Deck, Settings } from '../types';
import {
  AI_NOTES_DEFAULT_MODEL,
  GEMINI_MODELS,
  GeminiError,
  generateNotes,
  type GeneratedNote,
} from '../lib/gemini';
import { addNote } from '../lib/notes';
import { FieldContent } from './FieldContent';
import { Modal, useToast } from './ui';

interface PickedFile {
  name: string;
  mime: string;
  size: number;
  base64?: string;
  text?: string;
}

// Gemini inline uploads cap around 20 MB per request (after base64 inflation),
// so keep the combined binary payload comfortably below that.
const MAX_TOTAL_BYTES = 13 * 1024 * 1024;

function guessMime(file: File): string {
  if (file.type) return file.type;
  if (/\.pdf$/i.test(file.name)) return 'application/pdf';
  if (/\.(md|txt)$/i.test(file.name)) return 'text/plain';
  return '';
}

async function readPicked(file: File): Promise<PickedFile> {
  const mime = guessMime(file);
  if (mime.startsWith('text/')) {
    return { name: file.name, mime, size: file.size, text: await file.text() };
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return { name: file.name, mime, size: file.size, base64: btoa(bin) };
}

function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AiNotesModal({
  deck,
  settings,
  onClose,
}: {
  deck: Deck;
  settings: Settings;
  onClose: () => void;
}) {
  const toast = useToast();
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [model, setModel] = useState<string>(AI_NOTES_DEFAULT_MODEL);
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<GeneratedNote[] | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFiles = async (list: FileList | File[]) => {
    setError(null);
    const next = [...files];
    for (const f of Array.from(list)) {
      const mime = guessMime(f);
      const supported = mime === 'application/pdf' || mime.startsWith('image/') || mime.startsWith('text/');
      if (!supported) {
        toast.push('error', `"${f.name}" is not supported — use a PDF, an image, or plain text (export documents to PDF first).`);
        continue;
      }
      try {
        next.push(await readPicked(f));
      } catch {
        toast.push('error', `Could not read "${f.name}".`);
      }
    }
    const total = next.reduce((s, f) => s + f.size, 0);
    if (total > MAX_TOTAL_BYTES) {
      setError(`Files are too large (${prettySize(total)} combined) — keep the total under ${prettySize(MAX_TOTAL_BYTES)}.`);
    }
    setFiles(next);
  };

  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const canGenerate =
    files.length > 0 && !!settings.apiKey && !busy && totalBytes <= MAX_TOTAL_BYTES;

  const generate = async () => {
    if (!canGenerate) return;
    setBusy(true);
    setError(null);
    try {
      const notes = await generateNotes({
        files,
        instructions,
        apiKey: settings.apiKey,
        model,
      });
      setGenerated(notes);
      setExcluded(new Set());
    } catch (e) {
      setError(e instanceof GeminiError ? e.message : 'Note generation failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const includedCount = generated ? generated.length - excluded.size : 0;

  const createAll = async () => {
    if (!generated || includedCount === 0 || adding) return;
    setAdding(true);
    try {
      // strictly-increasing createdAt keeps the study order = document order
      const base = Date.now();
      let i = 0;
      for (const [idx, n] of generated.entries()) {
        if (excluded.has(idx)) continue;
        await addNote(deck.id, n.type, n.front, n.back, ['ai-generated'], base + i++);
      }
      toast.push('success', `Added ${i} note${i === 1 ? '' : 's'} to "${deck.name}".`);
      onClose();
    } finally {
      setAdding(false);
    }
  };

  return (
    <Modal title={`Create notes with AI — ${deck.name}`} onClose={onClose} wide>
      {generated === null ? (
        <>
          <div
            className={`ai-notes-drop ${dragOver ? 'drag-over' : ''}`}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void addFiles(e.dataTransfer.files);
            }}
            role="button"
            aria-label="Upload source files"
          >
            <FileUp size={26} />
            <div>
              <strong>Drop a PDF, images, or a text file here</strong> — or click to browse.
              <div className="tooltip-hint">
                The AI reads it and writes flashcards in the order the material appears.
              </div>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.txt,.md,image/*,application/pdf,text/plain,text/markdown"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {files.length > 0 && (
            <ul className="ai-notes-files">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`}>
                  <span className="file-name">{f.name}</span>
                  <span className="tooltip-hint">{prettySize(f.size)}</span>
                  <button
                    className="icon-btn"
                    aria-label={`Remove ${f.name}`}
                    title="Remove"
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <label className="settings-field">
            <span className="field-label">Model</span>
            <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
              {GEMINI_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="tooltip-hint">
              Thinking (high) reads the material most carefully — recommended for whole PDFs.
            </span>
          </label>

          <label className="settings-field">
            <span className="field-label">Extra instructions (optional)</span>
            <textarea
              className="textarea"
              rows={2}
              placeholder='e.g. "Only chapter 2", "prefer cloze cards for formulas", "write the notes in Hebrew"'
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>

          {!settings.apiKey && (
            <div className="ai-error" role="alert">
              Add your Gemini API key in Settings first.
            </div>
          )}
          {error && (
            <div className="ai-error" role="alert">
              {error}
            </div>
          )}

          <div className="modal-actions">
            {busy && <span className="tooltip-hint">Reading the material and writing notes — thinking models can take a minute…</span>}
            <button className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!canGenerate} onClick={() => void generate()}>
              {busy ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} Generate notes
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="tooltip-hint">
            {generated.length} notes, in document order — untick any you don't want. They're tagged{' '}
            <code>ai-generated</code>.
          </p>
          <ul className="gen-notes">
            {generated.map((n, i) => (
              <li key={i} className={`gen-note ${excluded.has(i) ? 'gen-note-off' : ''}`}>
                <input
                  type="checkbox"
                  checked={!excluded.has(i)}
                  aria-label={`Include note ${i + 1}`}
                  onChange={() => {
                    const next = new Set(excluded);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    setExcluded(next);
                  }}
                />
                <div className="gen-note-body">
                  <span className={`badge gen-type-${n.type}`}>{n.type}</span>
                  <div className="gen-note-front">
                    <FieldContent text={n.front} />
                  </div>
                  {n.back && (
                    <div className="gen-note-back">
                      <FieldContent text={n.back} />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={() => setGenerated(null)} disabled={adding}>
              <ArrowLeft size={14} /> Back
            </button>
            <button className="btn btn-primary" disabled={includedCount === 0 || adding} onClick={() => void createAll()}>
              {adding ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} Add {includedCount} note
              {includedCount === 1 ? '' : 's'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
