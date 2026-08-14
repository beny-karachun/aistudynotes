import { useCallback, useEffect, useState } from 'react';
import {
  Layers,
  Plus,
  Search,
  BarChart3,
  Settings as SettingsIcon,
  GraduationCap,
} from 'lucide-react';
import { getSettings } from './db';
import type { Settings } from './types';
import { DEFAULT_MODEL } from './lib/gemini';
import { DecksView } from './components/DecksView';
import { StudyView } from './components/StudyView';
import { AddNoteView } from './components/AddNoteView';
import { BrowserView } from './components/BrowserView';
import { StatsView } from './components/StatsView';
import { SettingsView } from './components/SettingsView';
import './app.css';

type View =
  | { name: 'decks' }
  | {
      name: 'study';
      deckId: string | null;
      /** Present for an explicit Browser selection; bypasses the normal due queue. */
      cardIds?: string[];
      returnTo?: 'decks' | 'browse';
    } // null deckId = whole collection
  | { name: 'add' }
  | { name: 'browse' }
  | { name: 'stats' }
  | { name: 'settings' };

const NAV: {
  view: Exclude<View['name'], 'study'>;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}[] = [
  { view: 'decks', label: 'Decks', icon: Layers },
  { view: 'add', label: 'Add', icon: Plus },
  { view: 'browse', label: 'Browse', icon: Search },
  { view: 'stats', label: 'Stats', icon: BarChart3 },
  { view: 'settings', label: 'Settings', icon: SettingsIcon },
];

export default function App() {
  const [view, setView] = useState<View>({ name: 'decks' });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastDeckId, setLastDeckId] = useState<string>('');
  /** current folder open on the Decks desktop (null = Home) */
  const [deckFolderId, setDeckFolderId] = useState<string | null>(null);
  /** folder the user came from via "Add note here" — shows a Go-back button in the Add view */
  const [addOrigin, setAddOrigin] = useState<string | null>(null);

  const reloadSettings = useCallback(async () => {
    const s = await getSettings();
    if (!s.model) s.model = DEFAULT_MODEL;
    // migrate legacy mode names from earlier builds
    const legacy = s.deckViewMode as string;
    if (legacy === 'manager') s.deckViewMode = 'desktop';
    if (legacy === 'simple') s.deckViewMode = 'list';
    setSettings(s);
  }, []);

  useEffect(() => {
    void reloadSettings();
  }, [reloadSettings]);

  // Theme: follow the setting, tracking the OS when set to "system"
  useEffect(() => {
    if (!settings) return;
    const apply = () => {
      const dark =
        settings.theme === 'dark' ||
        (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings]);

  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  // Stable identity: StudyView's queue-building effect depends on this — an
  // inline arrow would silently rebuild the study queue on every re-render.
  const exitStudy = useCallback(
    () =>
      setView((current) =>
        current.name === 'study' && current.returnTo === 'browse'
          ? { name: 'browse' }
          : { name: 'decks' },
      ),
    [],
  );

  if (!settings) {
    return (
      <div className="app-loading">
        <GraduationCap size={32} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <GraduationCap size={20} />
          </span>
          <span className="brand-name">AIstudynotes</span>
        </div>
        <nav aria-label="Main navigation">
          {NAV.map(({ view: v, label, icon: Icon }) => (
            <button
              key={v}
              className={`nav-item ${
                view.name === v ||
                (view.name === 'study' && (view.returnTo ?? 'decks') === v)
                  ? 'nav-active'
                  : ''
              }`}
              onClick={() => {
                if (v === 'add') setAddOrigin(null); // generic entry: no folder to go back to
                setView({ name: v } as View);
              }}
              aria-current={view.name === v ? 'page' : undefined}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot tooltip-hint">All data stays in this browser.</div>
      </aside>

      <main className="main-area">
        {view.name === 'decks' && (
          <DecksView
            onStudy={(deckId) => {
              if (deckId !== null) setLastDeckId(deckId);
              setView({ name: 'study', deckId });
            }}
            onStudyCards={(cardIds) =>
              setView({
                name: 'study',
                deckId: null,
                cardIds,
                returnTo: 'decks',
              })
            }
            onAddHere={(deckId) => {
              setLastDeckId(deckId);
              setAddOrigin(deckId);
              setView({ name: 'add' });
            }}
            settings={settings}
            refreshKey={refreshKey}
            onSettingsChanged={() => void reloadSettings()}
            folderId={deckFolderId}
            onNavigate={setDeckFolderId}
          />
        )}
        {view.name === 'study' && (
          <StudyView
            deckId={view.deckId}
            selectedCardIds={view.cardIds}
            settings={settings}
            onExit={exitStudy}
            exitLabel={
              view.cardIds ? (view.returnTo === 'browse' ? 'Browse' : 'Decks') : undefined
            }
            onChanged={bumpRefresh}
            onSettingsChanged={() => void reloadSettings()}
          />
        )}
        {view.name === 'add' && (
          <AddNoteView
            defaultDeckId={lastDeckId}
            onDeckUsed={setLastDeckId}
            onAdded={bumpRefresh}
            originDeckId={addOrigin}
            onBack={(deckId) => {
              setDeckFolderId(deckId);
              setView({ name: 'decks' });
            }}
          />
        )}
        {view.name === 'browse' && (
          <BrowserView
            initialQuery=""
            dayStartHour={settings.dayStartHour}
            onChanged={bumpRefresh}
            onStudyCards={(cardIds) =>
              setView({
                name: 'study',
                deckId: null,
                cardIds,
                returnTo: 'browse',
              })
            }
          />
        )}
        {view.name === 'stats' && <StatsView dayStartHour={settings.dayStartHour} />}
        {view.name === 'settings' && (
          <SettingsView settings={settings} onSettingsChanged={() => void reloadSettings()} />
        )}
      </main>
    </div>
  );
}
