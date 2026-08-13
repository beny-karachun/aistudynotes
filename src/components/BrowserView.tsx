import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Search,
  Trash2,
  PauseCircle,
  PlayCircle,
  FolderInput,
  Flag,
  RotateCcw,
  Tags,
  EyeOff,
  Play,
} from 'lucide-react';
import { db } from '../db';
import type { CardRecord, Note } from '../types';
import { CardState } from '../types';
import { compileSearch, buildDeckPaths } from '../lib/search';
import { dayEnd, formatInterval, forgetCards, setSuspended, buryCard } from '../lib/scheduler';
import { deleteNotes, moveCardsToDeck } from '../lib/notes';
import { stripCloze } from '../lib/cloze';
import { InlineContent } from './FieldContent';
import { NoteEditModal } from './NoteEditModal';
import { Modal, useConfirm, useToast } from './ui';
import { DeckPicker } from './DeckPicker';

const STATE_LABEL: Record<number, string> = {
  [CardState.New]: 'New',
  [CardState.Learning]: 'Learning',
  [CardState.Review]: 'Review',
  [CardState.Relearning]: 'Relearning',
};

const FLAG_COLORS = ['transparent', '#ef4444', '#f97316', '#22c55e', '#3b82f6'];

function cardTitle(note: Note, card: CardRecord): string {
  const src = card.ord === 1 && note.type === 'basicReversed' ? note.back : note.front;
  const plain = stripCloze(src).replace(/\[img:[a-zA-Z0-9-]+\]/g, '🖼').replace(/\s+/g, ' ').trim();
  const suffix = note.type === 'cloze' ? `  ·  c${card.ord}` : card.ord === 1 ? '  ·  reversed' : '';
  return (plain || '(image)') + suffix;
}

function dueText(card: CardRecord, now: number): string {
  if (card.suspended) return 'suspended';
  if (card.state === CardState.New) return 'new';
  const diff = card.due - now;
  if (diff <= 0) return 'due';
  return formatInterval(diff);
}

export function BrowserView({
  initialQuery,
  dayStartHour,
  onChanged,
  onStudyCards,
}: {
  initialQuery: string;
  dayStartHour: number;
  onChanged: () => void;
  onStudyCards: (cardIds: string[]) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [movePicker, setMovePicker] = useState(false);
  const [moveTarget, setMoveTarget] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    cardIds: string[];
  } | null>(null);
  const now = Date.now();

  const data = useLiveQuery(async () => {
    const [cards, notes, decks] = await Promise.all([
      db.cards.toArray(),
      db.notes.toArray(),
      db.decks.toArray(),
    ]);
    return { cards, notes, decks };
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    const noteById = new Map(data.notes.map((n) => [n.id, n]));
    const match = compileSearch(query, data.decks, now, dayEnd(now, dayStartHour));
    const paths = buildDeckPaths(data.decks);
    return data.cards
      .map((card) => ({ card, note: noteById.get(card.noteId)! }))
      .filter((r) => r.note && match(r))
      .map((r) => ({ ...r, deckPath: paths.get(r.card.deckId) ?? '?' }))
      .sort((a, b) => b.note.createdAt - a.note.createdAt || a.card.ord - b.card.ord);
  }, [data, query, now, dayStartHour]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  if (!data) return <div className="view-pad">Loading…</div>;

  const toggleRow = (id: string, e: React.MouseEvent) => {
    const next = new Set(selected);
    if (e.shiftKey && lastClicked) {
      const ids = rows.map((r) => r.card.id);
      const a = ids.indexOf(lastClicked);
      const b = ids.indexOf(id);
      if (a !== -1 && b !== -1) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(ids[i]);
      }
    } else if (e.ctrlKey || e.metaKey) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    } else {
      next.clear();
      next.add(id);
    }
    setSelected(next);
    setLastClicked(id);
  };

  const selectedCards = rows.filter((r) => selected.has(r.card.id));
  const selectedNoteIds = [...new Set(selectedCards.map((r) => r.card.noteId))];
  const anySuspended = selectedCards.some((r) => r.card.suspended);

  const bulk = {
    suspend: async () => {
      await setSuspended([...selected], !anySuspended);
      toast.push('success', anySuspended ? 'Unsuspended.' : 'Suspended.');
      onChanged();
    },
    bury: async () => {
      for (const id of selected) await buryCard(id, now, dayStartHour);
      toast.push('success', 'Buried until tomorrow.');
      onChanged();
    },
    flag: async (flag: number) => {
      await db.transaction('rw', db.cards, async () => {
        for (const r of selectedCards) {
          await db.cards.update(r.card.id, { flag: (r.card.flag === flag ? 0 : flag) as CardRecord['flag'] });
        }
      });
      onChanged();
    },
    forget: async () => {
      const ok = await confirm({
        title: 'Reset cards?',
        message: `Reset ${selected.size} card(s) back to new, clearing their scheduling history?`,
        confirmLabel: 'Reset',
        danger: true,
      });
      if (!ok) return;
      await forgetCards([...selected]);
      toast.push('success', 'Cards reset to new.');
      onChanged();
    },
    del: async () => {
      const ok = await confirm({
        title: 'Delete notes?',
        message: `Delete ${selectedNoteIds.length} note(s) and all their cards? This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      const n = await deleteNotes(selectedNoteIds);
      setSelected(new Set());
      toast.push('success', `Deleted ${selectedNoteIds.length} note(s), ${n} card(s).`);
      onChanged();
    },
    move: async () => {
      if (!moveTarget) return;
      await moveCardsToDeck([...selected], moveTarget);
      setMovePicker(false);
      toast.push('success', 'Cards moved.');
      onChanged();
    },
  };

  return (
    <div className="view-pad browser-view anim-in">
      <div className="view-head">
        <h2>Browse</h2>
        <span className="tooltip-hint">
          {rows.length} card{rows.length === 1 ? '' : 's'}
          {selected.size > 0 && ` · ${selected.size} selected`}
        </span>
      </div>

      <div className="browser-search">
        <Search size={16} className="browser-search-icon" />
        <input
          className="input"
          placeholder='Search…  e.g.  deck:Biology tag:hard is:due -is:suspended flag:1 "exact phrase"'
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(new Set());
          }}
        />
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar card-panel anim-in">
          <button className="btn btn-sm btn-secondary" onClick={() => void bulk.suspend()}>
            {anySuspended ? <PlayCircle size={14} /> : <PauseCircle size={14} />}
            {anySuspended ? 'Unsuspend' : 'Suspend'}
          </button>
          <button className="btn btn-sm btn-secondary" onClick={() => void bulk.bury()}>
            <EyeOff size={14} /> Bury
          </button>
          <button className="btn btn-sm btn-secondary" onClick={() => setMovePicker(true)}>
            <FolderInput size={14} /> Move to deck
          </button>
          <span className="bulk-flags">
            {[1, 2, 3, 4].map((f) => (
              <button
                key={f}
                className="icon-btn"
                title={`Flag ${f}`}
                aria-label={`Toggle flag ${f}`}
                onClick={() => void bulk.flag(f)}
              >
                <Flag size={15} fill={FLAG_COLORS[f]} color={FLAG_COLORS[f]} />
              </button>
            ))}
          </span>
          <button className="btn btn-sm btn-secondary" onClick={() => void bulk.forget()}>
            <RotateCcw size={14} /> Reset
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => void bulk.del()}>
            <Trash2 size={14} /> Delete notes
          </button>
        </div>
      )}

      <div className="card-panel browser-table-wrap">
        <table className="browser-table">
          <thead>
            <tr>
              <th>Card</th>
              <th>Deck</th>
              <th>State</th>
              <th>Due</th>
              <th>Reps</th>
              <th>Lapses</th>
              <th>
                <Tags size={14} />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 500).map(({ card, note, deckPath }) => (
              <tr
                key={card.id}
                className={`${selected.has(card.id) ? 'row-selected' : ''} ${card.suspended ? 'row-suspended' : ''}`}
                onClick={(e) => toggleRow(card.id, e)}
                onDoubleClick={() => setEditingNote(card.noteId)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const cardIds = selected.has(card.id)
                    ? selectedCards.map((row) => row.card.id)
                    : [card.id];
                  if (!selected.has(card.id)) {
                    setSelected(new Set([card.id]));
                    setLastClicked(card.id);
                  }
                  setContextMenu({ x: e.clientX, y: e.clientY, cardIds });
                }}
              >
                <td className="cell-question">
                  {card.flag > 0 && <Flag size={12} fill={FLAG_COLORS[card.flag]} color={FLAG_COLORS[card.flag]} />}
                  <InlineContent text={cardTitle(note, card)} flat />
                </td>
                <td className="cell-deck">{deckPath.replace(/::/g, ' › ')}</td>
                <td>
                  <span className={`badge state-${card.state}`}>{STATE_LABEL[card.state]}</span>
                </td>
                <td className="cell-num">{dueText(card, now)}</td>
                <td className="cell-num">{card.reps}</td>
                <td className="cell-num">{card.lapses}</td>
                <td className="cell-tags">{note.tags.join(' ')}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="browser-empty">
                  No cards match this search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {rows.length > 500 && (
          <div className="browser-more tooltip-hint">Showing first 500 of {rows.length} — narrow your search.</div>
        )}
      </div>
      <p className="tooltip-hint" style={{ marginTop: 10 }}>
        Click to select · Ctrl-click to multi-select · Shift-click for ranges · right-click to study ·
        double-click to edit
      </p>

      {contextMenu && (
        <BrowserStudyMenu
          x={contextMenu.x}
          y={contextMenu.y}
          count={contextMenu.cardIds.length}
          onStudy={() => onStudyCards(contextMenu.cardIds)}
        />
      )}

      {editingNote && (
        <NoteEditModal
          noteId={editingNote}
          onClose={() => setEditingNote(null)}
          onSaved={() => {
            setEditingNote(null);
            onChanged();
          }}
        />
      )}

      {movePicker && (
        <Modal title={`Move ${selected.size} card(s) to…`} onClose={() => setMovePicker(false)}>
          <DeckPicker value={moveTarget} onChange={setMoveTarget} />
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={() => setMovePicker(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!moveTarget} onClick={() => void bulk.move()}>
              Move
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function BrowserStudyMenu({
  x,
  y,
  count,
  onStudy,
}: {
  x: number;
  y: number;
  count: number;
  onStudy: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
    menu.querySelector<HTMLButtonElement>('button')?.focus();
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="ctx-menu browser-card-menu anim-in"
      style={{ left: position.x, top: position.y }}
      role="menu"
      aria-label="Selected card actions"
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        role="menuitem"
        onClick={(e) => {
          e.stopPropagation();
          onStudy();
        }}
      >
        <Play size={15} /> {count === 1 ? 'Study card now' : `Study ${count} cards now`}
      </button>
    </div>
  );
}
