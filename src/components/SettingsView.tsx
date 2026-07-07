import { useEffect, useRef, useState } from 'react';
import {
  KeyRound,
  Loader2,
  CheckCircle2,
  Download,
  Upload,
  HardDrive,
  Trash2,
  FileText,
  Eye,
  EyeOff,
} from 'lucide-react';
import { db, initDB, saveSettings, storageEstimate } from '../db';
import type { Settings } from '../types';
import { GEMINI_MODELS, testApiKey, GeminiError } from '../lib/gemini';
import { exportCollection, importCollection, importTSV, downloadBlob } from '../lib/importExport';
import { pruneOrphanMedia } from '../lib/media';
import { Modal, useConfirm, useToast } from './ui';
import { DeckPicker } from './DeckPicker';

const AI_LANGUAGES: { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto — match the card’s language' },
  { value: 'English', label: 'English' },
  { value: 'Hebrew', label: 'עברית (Hebrew)' },
  { value: 'Arabic', label: 'العربية (Arabic)' },
  { value: 'Spanish', label: 'Español (Spanish)' },
  { value: 'French', label: 'Français (French)' },
  { value: 'German', label: 'Deutsch (German)' },
  { value: 'Italian', label: 'Italiano (Italian)' },
  { value: 'Portuguese', label: 'Português (Portuguese)' },
  { value: 'Russian', label: 'Русский (Russian)' },
  { value: 'Ukrainian', label: 'Українська (Ukrainian)' },
  { value: 'Polish', label: 'Polski (Polish)' },
  { value: 'Dutch', label: 'Nederlands (Dutch)' },
  { value: 'Turkish', label: 'Türkçe (Turkish)' },
  { value: 'Hindi', label: 'हिन्दी (Hindi)' },
  { value: 'Chinese (Simplified)', label: '简体中文 (Chinese, Simplified)' },
  { value: 'Japanese', label: '日本語 (Japanese)' },
  { value: 'Korean', label: '한국어 (Korean)' },
];

function AiLanguageField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isPreset = AI_LANGUAGES.some((l) => l.value === value);
  const [otherMode, setOtherMode] = useState(!isPreset);
  const showInput = otherMode || !isPreset;

  const commitCustom = (raw: string) => {
    const v = raw.trim();
    if (v) {
      onChange(v);
    } else {
      setOtherMode(false);
      onChange('auto');
    }
  };

  return (
    <label className="settings-field">
      <span className="field-label">AI feedback language</span>
      <select
        className="select"
        value={showInput ? '__other__' : value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__other__') {
            setOtherMode(true);
          } else {
            setOtherMode(false);
            onChange(v);
          }
        }}
      >
        {AI_LANGUAGES.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
        <option value="__other__">Other…</option>
      </select>
      {showInput && (
        <input
          className="input"
          style={{ marginTop: 8 }}
          placeholder="Type any language, e.g. Yiddish"
          defaultValue={isPreset ? '' : value}
          autoFocus={otherMode && isPreset}
          onBlur={(e) => commitCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitCustom((e.target as HTMLInputElement).value);
          }}
        />
      )}
      <span className="tooltip-hint">
        The AI writes its feedback in this language. “Auto” answers in whatever language the card is
        written in.
      </span>
    </label>
  );
}

export function SettingsView({
  settings,
  onSettingsChanged,
}: {
  settings: Settings;
  onSettingsChanged: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'ok' | string | null>(null);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [tsvOpen, setTsvOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void storageEstimate().then(setStorage);
  }, []);

  const patch = async (p: Partial<Settings>) => {
    await saveSettings(p);
    onSettingsChanged();
  };

  const saveKey = async () => {
    await patch({ apiKey: apiKey.trim() });
    toast.push('success', 'API key saved (stored only in this browser).');
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const model = await testApiKey(apiKey.trim(), settings.model);
      setTestResult('ok');
      toast.push('success', `Connected — ${model} responded.`);
      await patch({ apiKey: apiKey.trim() });
    } catch (e) {
      setTestResult(e instanceof GeminiError ? e.message : 'Connection failed.');
    } finally {
      setTesting(false);
    }
  };

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const res = await importCollection(text);
      toast.push('success', `Imported ${res.decks} decks, ${res.notes} notes, ${res.cards} cards, ${res.media} images.`);
      onSettingsChanged();
    } catch (e) {
      toast.push('error', e instanceof Error ? e.message : 'Import failed.');
    }
  };

  const wipe = async () => {
    const ok = await confirm({
      title: 'Delete ALL data?',
      message: 'This permanently deletes every deck, note, card, review, and image in this browser. Export first if you want a backup.',
      confirmLabel: 'Delete everything',
      danger: true,
    });
    if (!ok) return;
    await db.transaction('rw', db.decks, db.notes, db.cards, db.revlog, db.media, async () => {
      await Promise.all([
        db.decks.clear(),
        db.notes.clear(),
        db.cards.clear(),
        db.revlog.clear(),
        db.media.clear(),
      ]);
    });
    await initDB();
    toast.push('success', 'All data deleted.');
    onSettingsChanged();
  };

  return (
    <div className="view-pad settings-view anim-in">
      <div className="view-head">
        <h2>Settings</h2>
      </div>

      <section className="card-panel settings-section">
        <h3>
          <KeyRound size={17} /> AI grading — Gemini API
        </h3>
        <p className="tooltip-hint">
          Get a free API key at{' '}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            aistudio.google.com/apikey
          </a>
          . The key is stored only in this browser's local database and is sent only to Google's API.
        </p>
        <label className="settings-field">
          <span className="field-label">API key</span>
          <div className="key-row">
            <input
              className="input"
              type={showKey ? 'text' : 'password'}
              placeholder="AIza…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
            <button
              className="icon-btn"
              onClick={() => setShowKey(!showKey)}
              aria-label={showKey ? 'Hide key' : 'Show key'}
              title={showKey ? 'Hide key' : 'Show key'}
            >
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
            <button className="btn btn-secondary" onClick={() => void saveKey()}>
              Save
            </button>
            <button className="btn btn-primary" onClick={() => void runTest()} disabled={!apiKey.trim() || testing}>
              {testing ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />}
              Test
            </button>
          </div>
          {testResult && testResult !== 'ok' && (
            <div className="ai-error" role="alert">
              {testResult}
            </div>
          )}
        </label>

        <label className="settings-field">
          <span className="field-label">Model</span>
          <select
            className="select"
            value={settings.model}
            onChange={(e) => void patch({ model: e.target.value })}
          >
            {GEMINI_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="tooltip-hint">
            {GEMINI_MODELS.find((m) => m.id === settings.model)?.description}
          </span>
        </label>

        <AiLanguageField value={settings.aiLanguage} onChange={(v) => void patch({ aiLanguage: v })} />

        <label className="settings-field">
          <span className="field-label">Grading strictness</span>
          <div className="seg-control" role="group" aria-label="Grading strictness">
            {(['lenient', 'moderate', 'strict'] as const).map((s) => (
              <button
                key={s}
                className={settings.aiStrictness === s ? 'active' : ''}
                onClick={() => void patch({ aiStrictness: s })}
              >
                {s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </label>

        <label className="settings-field">
          <span className="field-label">Default answer mode when studying</span>
          <div className="seg-control" role="group" aria-label="Default study mode">
            <button
              className={settings.defaultStudyMode === 'classic' ? 'active' : ''}
              onClick={() => void patch({ defaultStudyMode: 'classic' })}
            >
              Classic flip
            </button>
            <button
              className={settings.defaultStudyMode === 'ai' ? 'active' : ''}
              onClick={() => void patch({ defaultStudyMode: 'ai' })}
            >
              AI grading
            </button>
          </div>
        </label>
      </section>

      <section className="card-panel settings-section">
        <h3>Appearance & scheduling</h3>
        <label className="settings-field">
          <span className="field-label">Theme</span>
          <div className="seg-control" role="group" aria-label="Theme">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <button
                key={t}
                className={settings.theme === t ? 'active' : ''}
                onClick={() => void patch({ theme: t })}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </label>
        <label className="settings-field">
          <span className="field-label">Next day starts at</span>
          <select
            className="select"
            style={{ maxWidth: 140 }}
            value={settings.dayStartHour}
            onChange={(e) => void patch({ dayStartHour: parseInt(e.target.value) })}
          >
            {[0, 1, 2, 3, 4, 5, 6].map((h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </select>
          <span className="tooltip-hint">
            Reviews after midnight count toward the previous day until this hour (Anki default: 04:00).
          </span>
        </label>
      </section>

      <section className="card-panel settings-section">
        <h3>
          <HardDrive size={17} /> Data
        </h3>
        {storage && storage.quota > 0 && (
          <p className="tooltip-hint">
            Using {formatBytes(storage.usage)} of ~{formatBytes(storage.quota)} available local storage
            (IndexedDB) — persistent storage {typeof navigator.storage?.persist === 'function' ? 'requested' : 'unavailable'}.
          </p>
        )}
        <div className="settings-btn-row">
          <button
            className="btn btn-secondary"
            onClick={async () => {
              const blob = await exportCollection();
              downloadBlob(blob, `ankiai-backup-${new Date().toISOString().slice(0, 10)}.json`);
              toast.push('success', 'Collection exported.');
            }}
          >
            <Download size={15} /> Export everything
          </button>
          <button className="btn btn-secondary" onClick={() => fileInput.current?.click()}>
            <Upload size={15} /> Import backup
          </button>
          <button className="btn btn-secondary" onClick={() => setTsvOpen(true)}>
            <FileText size={15} /> Import text (TSV/CSV)
          </button>
          <button
            className="btn btn-secondary"
            onClick={async () => {
              const n = await pruneOrphanMedia();
              toast.push('success', `Cleaned up ${n} unused image${n === 1 ? '' : 's'}.`);
            }}
          >
            Clean unused media
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImportFile(f);
            e.target.value = '';
          }}
        />
      </section>

      <section className="card-panel settings-section danger-zone">
        <h3>
          <Trash2 size={17} /> Danger zone
        </h3>
        <button className="btn btn-danger" onClick={() => void wipe()}>
          Delete all data
        </button>
      </section>

      {tsvOpen && <TsvImportModal onClose={() => setTsvOpen(false)} onDone={onSettingsChanged} />}
    </div>
  );
}

function TsvImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [deckId, setDeckId] = useState('');
  const [type, setType] = useState<'basic' | 'basicReversed'>('basic');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void db.decks.toArray().then((d) => d[0] && setDeckId((prev) => prev || d[0].id));
  }, []);

  const run = async () => {
    setBusy(true);
    try {
      const res = await importTSV(text, deckId, type);
      toast.push('success', `Imported ${res.added} notes (${res.skipped} skipped).`);
      onDone();
      onClose();
    } catch {
      toast.push('error', 'Import failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Import text" onClose={onClose} wide>
      <p className="tooltip-hint" style={{ marginTop: 0 }}>
        One note per line: <code>front [TAB] back [TAB] tags</code> (semicolons also work as separators).
        Duplicates by front field are skipped.
      </p>
      <textarea
        className="textarea"
        rows={8}
        placeholder={'What is the capital of France?\tParis\tgeography'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="add-selectors" style={{ marginTop: 12 }}>
        <label>
          <span className="field-label">Into deck</span>
          <DeckPicker value={deckId} onChange={setDeckId} />
        </label>
        <label>
          <span className="field-label">Note type</span>
          <select className="select" value={type} onChange={(e) => setType(e.target.value as 'basic' | 'basicReversed')}>
            <option value="basic">Basic</option>
            <option value="basicReversed">Basic (and reversed card)</option>
          </select>
        </label>
      </div>
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!text.trim() || !deckId || busy} onClick={() => void run()}>
          {busy ? <Loader2 size={15} className="spin" /> : <Upload size={15} />} Import
        </button>
      </div>
    </Modal>
  );
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
