import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ChevronDown,
  ChevronRight,
  ChevronRight as Crumb,
  ClipboardPaste,
  Copy,
  Download,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Home,
  Image as ImageIcon,
  LayoutGrid,
  List,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Scissors,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { db, saveSettings } from '../db';
import { AiNotesModal } from './AiNotesModal';
import { InlineContent } from './FieldContent';
import type { Deck, DeckConfig, DeckTreeNode, Note, Settings, StudyCounts } from '../types';
import {
  buildDeckTree,
  copyDeckSubtree,
  countCardsInSubtree,
  createDeck,
  deleteDeckSubtree,
  moveDeck,
  renameDeck,
  setDeckConfig,
} from '../lib/decks';
import { deleteNotes, duplicateNotes, moveNotes } from '../lib/notes';
import { allDeckCounts, descendantIds, isDescendant } from '../lib/scheduler';
import { exportCollection, downloadBlob } from '../lib/importExport';
import { stripCloze } from '../lib/cloze';
import { mediaIdsIn, mediaUrl } from '../lib/media';
import { Modal, useConfirm, useToast } from './ui';
import { NoteEditModal } from './NoteEditModal';

type Clip = { op: 'cut' | 'copy'; deckIds: string[]; noteIds: string[] } | null;

interface MenuItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
}

type CtxTarget = { kind: 'deck'; id: string } | { kind: 'note'; id: string } | { kind: 'bg' };
type Ctx = { x: number; y: number; target: CtxTarget } | null;

const deckKey = (id: string) => `d:${id}`;
const noteKey = (id: string) => `n:${id}`;
const NOTE_TILE_CAP = 96;

export function DecksView({
  onStudy,
  onAddHere,
  settings,
  refreshKey,
  onSettingsChanged,
  folderId,
  onNavigate,
}: {
  /** null = study the whole collection (Home) */
  onStudy: (deckId: string | null) => void;
  onAddHere: (deckId: string) => void;
  settings: Settings;
  refreshKey: number;
  onSettingsChanged: () => void;
  folderId: string | null;
  onNavigate: (folderId: string | null) => void;
}) {
  const mode = settings.deckViewMode === 'list' ? 'list' : 'desktop';

  const decks = useLiveQuery(() => db.decks.toArray(), []);
  const counts = useLiveQuery(async () => {
    const allDecks = await db.decks.toArray();
    return allDeckCounts(allDecks, Date.now(), settings.dayStartHour);
  }, [settings.dayStartHour, refreshKey]);

  const tree = useMemo(() => (decks && counts ? buildDeckTree(decks, counts) : null), [decks, counts]);
  const totalsById = useMemo(() => {
    const map = new Map<string, StudyCounts>();
    if (!tree) return map;
    const walk = (n: DeckTreeNode) => {
      map.set(n.deck.id, n.totalCounts);
      n.children.forEach(walk);
    };
    tree.forEach(walk);
    return map;
  }, [tree]);

  const [addingUnder, setAddingUnder] = useState<{ parentId: string | null } | null>(null);
  const [optionsFor, setOptionsFor] = useState<Deck | null>(null);
  const [renameModalDeck, setRenameModalDeck] = useState<Deck | null>(null);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [aiNotesDeck, setAiNotesDeck] = useState<Deck | null>(null);
  const toast = useToast();

  const setMode = async (m: 'desktop' | 'list') => {
    await saveSettings({ deckViewMode: m });
    onSettingsChanged();
  };

  // reset navigation if the current folder was deleted
  useEffect(() => {
    if (folderId && decks && !decks.some((d) => d.id === folderId)) {
      onNavigate(null);
    }
  }, [decks, folderId, onNavigate]);

  if (!decks || !counts || !tree) return <div className="view-pad">Loading…</div>;

  return (
    <div className="view-pad decks-view anim-in">
      <div className="view-head">
        <h2>Decks</h2>
        <div className="decks-toolbar">
          <div className="seg-control" role="group" aria-label="Decks view mode">
            <button
              className={mode === 'desktop' ? 'active' : ''}
              onClick={() => void setMode('desktop')}
              title="Desktop: folders as an icon grid — drag, drop, cut, copy, paste"
            >
              <LayoutGrid size={13} /> Desktop
            </button>
            <button
              className={mode === 'list' ? 'active' : ''}
              onClick={() => void setMode('list')}
              title="Simple list: click a deck to study"
            >
              <List size={13} /> List
            </button>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => setAddingUnder({ parentId: mode === 'desktop' ? folderId : null })}
          >
            <Plus size={16} /> {mode === 'desktop' ? 'New folder' : 'New deck'}
          </button>
        </div>
      </div>

      {mode === 'desktop' ? (
        <DesktopGrid
          decks={decks}
          totalsById={totalsById}
          folderId={folderId}
          onNavigate={onNavigate}
          onStudy={onStudy}
          onAddHere={onAddHere}
          onNewFolder={(parentId) => setAddingUnder({ parentId })}
          onOptions={setOptionsFor}
          onEditNote={setEditingNote}
          onAiNotes={setAiNotesDeck}
        />
      ) : (
        <ListRows
          tree={tree}
          onStudy={onStudy}
          onAddSub={(parentId) => setAddingUnder({ parentId })}
          onRename={setRenameModalDeck}
          onOptions={setOptionsFor}
        />
      )}

      {renameModalDeck && (
        <RenameModal
          deck={renameModalDeck}
          onClose={() => setRenameModalDeck(null)}
          onSave={async (name) => {
            await renameDeck(renameModalDeck.id, name);
            setRenameModalDeck(null);
          }}
        />
      )}
      {addingUnder && (
        <AddDeckModal
          parentId={addingUnder.parentId}
          decks={decks}
          onClose={() => setAddingUnder(null)}
          onCreate={async (name) => {
            await createDeck(name, addingUnder.parentId);
            setAddingUnder(null);
            toast.push('success', `Folder "${name}" created.`);
          }}
        />
      )}
      {optionsFor && (
        <DeckOptionsModal
          deck={optionsFor}
          onClose={() => setOptionsFor(null)}
          onSave={async (config, subtree) => {
            await setDeckConfig(optionsFor.id, config, subtree);
            setOptionsFor(null);
            toast.push('success', 'Deck options saved.');
          }}
        />
      )}
      {editingNote && (
        <NoteEditModal noteId={editingNote} onClose={() => setEditingNote(null)} onSaved={() => setEditingNote(null)} />
      )}
      {aiNotesDeck && (
        <AiNotesModal deck={aiNotesDeck} settings={settings} onClose={() => setAiNotesDeck(null)} />
      )}
    </div>
  );
}

// ============================================================
// Desktop grid
// ============================================================

function DesktopGrid({
  decks,
  totalsById,
  folderId,
  onNavigate,
  onStudy,
  onAddHere,
  onNewFolder,
  onOptions,
  onEditNote,
  onAiNotes,
}: {
  decks: Deck[];
  totalsById: Map<string, StudyCounts>;
  folderId: string | null;
  onNavigate: (id: string | null) => void;
  onStudy: (deckId: string | null) => void;
  onAddHere: (deckId: string) => void;
  onNewFolder: (parentId: string | null) => void;
  onOptions: (deck: Deck) => void;
  onEditNote: (noteId: string) => void;
  onAiNotes: (deck: Deck) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<Clip>(null);
  const [ctx, setCtx] = useState<Ctx>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null); // 'd:<id>' | 'crumb:<id|home>'
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragRef = useRef<{ deckIds: string[]; noteIds: string[] }>({ deckIds: [], noteIds: [] });
  const marqueeMoved = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const folder = folderId ? decks.find((d) => d.id === folderId) ?? null : null;
  const childFolders = useMemo(
    () => decks.filter((d) => d.parentId === folderId).sort((a, b) => a.name.localeCompare(b.name)),
    [decks, folderId],
  );
  const notes = useLiveQuery(
    async () => (folderId ? db.notes.where('deckId').equals(folderId).toArray() : []),
    [folderId],
  );
  const sortedNotes = useMemo(
    () => [...(notes ?? [])].sort((a, b) => b.createdAt - a.createdAt),
    [notes],
  );
  const shownNotes = sortedNotes.slice(0, NOTE_TILE_CAP);

  // Library size (all cards in the open subtree) — shown next to the today
  // counters so the daily-limited numbers aren't mistaken for the total.
  const totalCards = useLiveQuery(async () => {
    if (folderId) {
      return db.cards.where('deckId').anyOf(descendantIds(decks, folderId)).count();
    }
    return db.cards.count();
  }, [folderId, decks]);

  const orderedKeys = useMemo(
    () => [...childFolders.map((d) => deckKey(d.id)), ...shownNotes.map((n) => noteKey(n.id))],
    [childFolders, shownNotes],
  );

  const crumbs = useMemo(() => {
    const byId = new Map(decks.map((d) => [d.id, d]));
    const path: Deck[] = [];
    let cur = folder;
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) ?? null : null;
    }
    return path;
  }, [decks, folder]);

  const splitSelection = useCallback(
    (sel: Set<string>) => ({
      deckIds: [...sel].filter((k) => k.startsWith('d:')).map((k) => k.slice(2)),
      noteIds: [...sel].filter((k) => k.startsWith('n:')).map((k) => k.slice(2)),
    }),
    [],
  );

  const topMostDecks = useCallback(
    (ids: string[]) => ids.filter((id) => !ids.some((o) => o !== id && isDescendant(decks, id, o))),
    [decks],
  );

  // ---------- operations ----------

  const performDrop = useCallback(
    async (deckIds: string[], noteIds: string[], targetId: string | null) => {
      let moved = 0;
      let skipped = 0;
      for (const id of topMostDecks(deckIds)) {
        (await moveDeck(id, targetId)) ? moved++ : skipped++;
      }
      if (noteIds.length > 0) {
        if (targetId == null) {
          toast.push('info', 'Notes must live inside a deck — they were not moved to Home.');
        } else {
          await moveNotes(noteIds, targetId);
          moved += noteIds.length;
        }
      }
      if (moved) toast.push('success', `Moved ${moved} item${moved === 1 ? '' : 's'}.`);
      if (skipped) toast.push('info', `${skipped} skipped (a folder can't move into itself).`);
    },
    [topMostDecks, toast],
  );

  const paste = useCallback(
    async (targetId: string | null) => {
      if (!clipboard) return;
      const deckIds = clipboard.deckIds.filter((id) => decks.some((d) => d.id === id));
      const noteIds = clipboard.noteIds;
      if (clipboard.op === 'cut') {
        await performDrop(deckIds, noteIds, targetId);
        setClipboard(null);
      } else {
        for (const id of topMostDecks(deckIds)) {
          if (targetId && (id === targetId || isDescendant(decks, targetId, id))) {
            toast.push('info', 'Skipped copying a folder into itself.');
            continue;
          }
          await copyDeckSubtree(id, targetId);
        }
        if (noteIds.length > 0) {
          if (targetId == null) {
            toast.push('info', 'Notes must be pasted inside a deck.');
          } else {
            await duplicateNotes(noteIds, targetId);
          }
        }
        toast.push('success', 'Pasted.');
      }
    },
    [clipboard, decks, performDrop, topMostDecks, toast],
  );

  const removeSelection = useCallback(
    async (sel: Set<string>) => {
      const { deckIds, noteIds } = splitSelection(sel);
      const topDecks = topMostDecks(deckIds);
      if (topDecks.length === 0 && noteIds.length === 0) return;
      let cardCount = 0;
      for (const id of topDecks) cardCount += await countCardsInSubtree(id);
      const parts: string[] = [];
      if (topDecks.length) parts.push(`${topDecks.length} folder${topDecks.length === 1 ? '' : 's'} (${cardCount} cards)`);
      if (noteIds.length) parts.push(`${noteIds.length} note${noteIds.length === 1 ? '' : 's'}`);
      const ok = await confirm({
        title: 'Delete?',
        message: `This permanently deletes ${parts.join(' and ')}. This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      for (const id of topDecks) await deleteDeckSubtree(id);
      if (noteIds.length) await deleteNotes(noteIds);
      setSelected(new Set());
      toast.push('success', 'Deleted.');
    },
    [splitSelection, topMostDecks, confirm, toast],
  );

  const handleExport = useCallback(
    async (deckId: string) => {
      const ids = descendantIds(decks, deckId);
      const blob = await exportCollection(ids);
      const name = decks.find((d) => d.id === deckId)?.name ?? 'deck';
      downloadBlob(blob, `${name.replace(/[^\w-]+/g, '_')}.ankiai.json`);
      toast.push('success', 'Deck exported.');
    },
    [decks, toast],
  );

  // ---------- selection ----------

  const selectItem = (key: string, e: React.MouseEvent) => {
    const next = new Set(selected);
    if (e.shiftKey && lastClicked) {
      const a = orderedKeys.indexOf(lastClicked);
      const b = orderedKeys.indexOf(key);
      if (a !== -1 && b !== -1) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(orderedKeys[i]);
      }
    } else if (e.ctrlKey || e.metaKey) {
      if (next.has(key)) next.delete(key);
      else next.add(key);
    } else {
      next.clear();
      next.add(key);
    }
    setSelected(next);
    setLastClicked(key);
  };

  // ---------- marquee (rubber-band) selection ----------

  const onGridMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.tile')) return;
    const grid = gridRef.current;
    if (!grid) return;
    const gridRect = grid.getBoundingClientRect();
    const origin = { x: e.clientX, y: e.clientY };
    const base = e.ctrlKey || e.metaKey ? new Set(selected) : new Set<string>();
    marqueeMoved.current = false;

    const onMove = (ev: MouseEvent) => {
      const x = Math.min(origin.x, ev.clientX);
      const y = Math.min(origin.y, ev.clientY);
      const w = Math.abs(ev.clientX - origin.x);
      const h = Math.abs(ev.clientY - origin.y);
      if (w + h > 6) marqueeMoved.current = true;
      setMarquee({ x: x - gridRect.left, y: y - gridRect.top, w, h });
      const hits = new Set(base);
      grid.querySelectorAll<HTMLElement>('.tile[data-key]').forEach((el) => {
        const r = el.getBoundingClientRect();
        const overlap = r.left < x + w && r.right > x && r.top < y + h && r.bottom > y;
        if (overlap) hits.add(el.dataset.key!);
      });
      setSelected(hits);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setMarquee(null);
      // a plain click on empty space (no drag) clears the selection
      if (!marqueeMoved.current && !(e.ctrlKey || e.metaKey)) setSelected(new Set());
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ---------- keyboard ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      if (renamingId) return;
      if (document.querySelector('.modal-overlay')) return;
      const { deckIds, noteIds } = splitSelection(selected);

      if (e.key === 'Escape') {
        setCtx(null);
        if (clipboard) setClipboard(null);
        else setSelected(new Set());
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        if (folder) onNavigate(folder.parentId);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelected(new Set(orderedKeys));
        return;
      }
      if (selected.size > 0 && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        setClipboard({ op: 'cut', deckIds, noteIds });
        return;
      }
      if (selected.size > 0 && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        setClipboard({ op: 'copy', deckIds, noteIds });
        return;
      }
      if (clipboard && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        void paste(folderId);
        return;
      }
      if (selected.size > 0 && e.key === 'Delete') {
        e.preventDefault();
        void removeSelection(selected);
        return;
      }
      if (deckIds.length === 1 && noteIds.length === 0 && e.key === 'F2') {
        e.preventDefault();
        setRenamingId(deckIds[0]);
        return;
      }
      if (e.key === 'Enter' && selected.size === 1) {
        e.preventDefault();
        if (deckIds.length === 1) onNavigate(deckIds[0]);
        else if (noteIds.length === 1) onEditNote(noteIds[0]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, clipboard, orderedKeys, folder, folderId, renamingId, splitSelection, paste, removeSelection, onNavigate, onEditNote]);

  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [ctx]);

  // clear selection when navigating
  useEffect(() => {
    setSelected(new Set());
    setLastClicked(null);
  }, [folderId]);

  // ---------- drag & drop ----------

  const startDrag = (key: string, e: React.DragEvent) => {
    let sel = selected;
    if (!sel.has(key)) {
      sel = new Set([key]);
      setSelected(sel);
      setLastClicked(key);
    }
    const { deckIds, noteIds } = splitSelection(sel);
    dragRef.current = { deckIds: topMostDecks(deckIds), noteIds };
    e.dataTransfer.setData('text/plain', [...sel].join(','));
    e.dataTransfer.effectAllowed = 'move';
  };

  const dropAccepts = (targetDeckId: string): boolean => {
    const { deckIds, noteIds } = dragRef.current;
    if (deckIds.length === 0 && noteIds.length === 0) return false;
    if (deckIds.includes(targetDeckId)) return false;
    if (deckIds.some((id) => isDescendant(decks, targetDeckId, id))) return false;
    return true;
  };

  const finishDrop = (targetId: string | null) => {
    const { deckIds, noteIds } = dragRef.current;
    dragRef.current = { deckIds: [], noteIds: [] };
    setDropKey(null);
    void performDrop(deckIds, noteIds, targetId);
  };

  // ---------- context menu ----------

  const openCtx = (target: CtxTarget, x: number, y: number) => {
    if (target.kind === 'deck' && !selected.has(deckKey(target.id))) {
      setSelected(new Set([deckKey(target.id)]));
      setLastClicked(deckKey(target.id));
    }
    if (target.kind === 'note' && !selected.has(noteKey(target.id))) {
      setSelected(new Set([noteKey(target.id)]));
      setLastClicked(noteKey(target.id));
    }
    setCtx({ x, y, target });
  };

  const ctxItems = (target: CtxTarget): MenuItem[] => {
    const multi = selected.size > 1;
    const label = (base: string) => (multi ? `${base} ${selected.size} items` : base);
    if (target.kind === 'deck') {
      return [
        { key: 'open', label: 'Open', icon: <FolderOpen size={15} /> },
        { key: 'study', label: 'Study', icon: <Play size={15} /> },
        { key: 'rename', label: 'Rename', icon: <Pencil size={15} /> },
        { key: 'cut', label: label('Cut'), icon: <Scissors size={15} /> },
        { key: 'copy', label: label('Copy'), icon: <Copy size={15} /> },
        { key: 'pasteInto', label: 'Paste into folder', icon: <ClipboardPaste size={15} />, disabled: !clipboard },
        { key: 'aiNotes', label: 'Create notes with AI', icon: <Sparkles size={15} /> },
        { key: 'newInside', label: 'New subfolder', icon: <FolderPlus size={15} /> },
        { key: 'options', label: 'Options', icon: <Settings2 size={15} /> },
        { key: 'export', label: 'Export', icon: <Download size={15} /> },
        { key: 'delete', label: label('Delete'), icon: <Trash2 size={15} />, danger: true },
      ];
    }
    if (target.kind === 'note') {
      return [
        { key: 'edit', label: 'Edit', icon: <Pencil size={15} /> },
        { key: 'cut', label: label('Cut'), icon: <Scissors size={15} /> },
        { key: 'copy', label: label('Copy'), icon: <Copy size={15} /> },
        { key: 'delete', label: label('Delete'), icon: <Trash2 size={15} />, danger: true },
      ];
    }
    return [
      { key: 'newFolder', label: 'New folder', icon: <FolderPlus size={15} /> },
      ...(folder
        ? [
            { key: 'addNote', label: 'Add note here', icon: <Plus size={15} /> },
            { key: 'aiNotes', label: 'Create notes with AI', icon: <Sparkles size={15} /> },
          ]
        : []),
      { key: 'paste', label: 'Paste', icon: <ClipboardPaste size={15} />, disabled: !clipboard },
      { key: 'selectAll', label: 'Select all', icon: <Copy size={15} /> },
    ];
  };

  const onCtxAction = (action: string) => {
    const target = ctx!.target;
    setCtx(null);
    const { deckIds, noteIds } = splitSelection(selected);
    switch (action) {
      case 'open':
        if (target.kind === 'deck') onNavigate(target.id);
        break;
      case 'study':
        if (target.kind === 'deck') onStudy(target.id);
        break;
      case 'rename':
        if (target.kind === 'deck') setRenamingId(target.id);
        break;
      case 'cut':
        setClipboard({ op: 'cut', deckIds, noteIds });
        break;
      case 'copy':
        setClipboard({ op: 'copy', deckIds, noteIds });
        break;
      case 'paste':
        void paste(folderId);
        break;
      case 'pasteInto':
        if (target.kind === 'deck') void paste(target.id);
        break;
      case 'newFolder':
        onNewFolder(folderId);
        break;
      case 'newInside':
        if (target.kind === 'deck') onNewFolder(target.id);
        break;
      case 'addNote':
        if (folderId) onAddHere(folderId);
        break;
      case 'aiNotes': {
        const deck = decks.find((d) => d.id === (target.kind === 'deck' ? target.id : folderId));
        if (deck) onAiNotes(deck);
        break;
      }
      case 'selectAll':
        setSelected(new Set(orderedKeys));
        break;
      case 'options': {
        if (target.kind === 'deck') {
          const deck = decks.find((d) => d.id === target.id);
          if (deck) onOptions(deck);
        }
        break;
      }
      case 'export':
        if (target.kind === 'deck') void handleExport(target.id);
        break;
      case 'edit':
        if (target.kind === 'note') onEditNote(target.id);
        break;
      case 'delete':
        void removeSelection(selected);
        break;
    }
  };

  const folderCounts = folder ? totalsById.get(folder.id) : undefined;
  const homeTotals = useMemo(
    () =>
      decks
        .filter((d) => d.parentId === null)
        .reduce(
          (acc, d) => {
            const c = totalsById.get(d.id);
            return c
              ? {
                  newCount: acc.newCount + c.newCount,
                  learnCount: acc.learnCount + c.learnCount,
                  reviewCount: acc.reviewCount + c.reviewCount,
                }
              : acc;
          },
          { newCount: 0, learnCount: 0, reviewCount: 0 },
        ),
    [decks, totalsById],
  );

  const isCut = (key: string) => clipboard?.op === 'cut' && (clipboard.deckIds.includes(key.slice(2)) || clipboard.noteIds.includes(key.slice(2)));

  return (
    <>
      {/* breadcrumb bar */}
      <div className="crumb-bar" role="navigation" aria-label="Folder path">
        <button
          className={`crumb ${folderId === null ? 'crumb-current' : ''} ${dropKey === 'crumb:home' ? 'drop-target' : ''}`}
          onClick={() => onNavigate(null)}
          onDragOver={(e) => {
            if (dragRef.current.deckIds.length === 0 && dragRef.current.noteIds.length === 0) return;
            e.preventDefault();
            setDropKey('crumb:home');
          }}
          onDragLeave={() => setDropKey((k) => (k === 'crumb:home' ? null : k))}
          onDrop={(e) => {
            e.preventDefault();
            finishDrop(null);
          }}
        >
          <Home size={14} /> Home
        </button>
        {crumbs.map((c) => (
          <span key={c.id} className="crumb-seg">
            <Crumb size={13} className="crumb-sep" />
            <button
              className={`crumb ${c.id === folderId ? 'crumb-current' : ''} ${dropKey === `crumb:${c.id}` ? 'drop-target' : ''}`}
              onClick={() => onNavigate(c.id)}
              onDragOver={(e) => {
                if (!dropAccepts(c.id)) return;
                e.preventDefault();
                setDropKey(`crumb:${c.id}`);
              }}
              onDragLeave={() => setDropKey((k) => (k === `crumb:${c.id}` ? null : k))}
              onDrop={(e) => {
                e.preventDefault();
                finishDrop(c.id);
              }}
            >
              {c.name}
            </button>
          </span>
        ))}
        <span
          className="crumb-totals"
          title="New · learning · due cards available to study TODAY — capped by the deck's daily limits (right-click a folder → Options to change them). The total on the right is everything stored here."
        >
          Today:{' '}
          {folder && folderCounts ? (
            <>
              <span className="count-new">{folderCounts.newCount}</span> ·{' '}
              <span className="count-learn">{folderCounts.learnCount}</span> ·{' '}
              <span className="count-due">{folderCounts.reviewCount}</span>
            </>
          ) : (
            <>
              <span className="count-new">{homeTotals.newCount}</span> ·{' '}
              <span className="count-learn">{homeTotals.learnCount}</span> ·{' '}
              <span className="count-due">{homeTotals.reviewCount}</span>
            </>
          )}
          {totalCards != null && (
            <span className="crumb-total-all">
              {' '}
              — {totalCards} card{totalCards === 1 ? '' : 's'} total
            </span>
          )}
        </span>
        <span className="folder-head-actions">
          {folder && (
            <button className="btn btn-sm btn-secondary" onClick={() => onAddHere(folder.id)}>
              <Plus size={13} /> Add note
            </button>
          )}
          {folder && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => onAiNotes(folder)}
              title="Upload a PDF or images — the AI writes notes into this folder"
            >
              <Sparkles size={13} /> Create with AI
            </button>
          )}
          {(() => {
            // Study exactly what you're looking at: this folder's subtree, or
            // the whole collection at Home.
            const c = folder ? folderCounts : homeTotals;
            const empty = !c || c.newCount + c.learnCount + c.reviewCount === 0;
            return (
              <button
                className="btn btn-sm btn-primary"
                disabled={empty}
                onClick={() => onStudy(folder ? folder.id : null)}
                title={folder ? `Study "${folder.name}" and its subfolders` : 'Study all decks'}
              >
                <Play size={13} /> Study
              </button>
            );
          })()}
        </span>
      </div>

      <p className="tooltip-hint manager-hint">
        Double-click opens a folder · drag onto folders (or the path) to move · box-select on empty space ·
        Ctrl+X/C/V cut, copy, paste · F2 rename · Del delete · Backspace goes up · right-click for more
      </p>

      {/* the desktop surface */}
      <div
        ref={gridRef}
        className="card-panel desk-surface"
        onMouseDown={onGridMouseDown}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('.tile')) return;
          e.preventDefault();
          setCtx({ x: e.clientX, y: e.clientY, target: { kind: 'bg' } });
        }}
      >
        <div className="desk-grid">
          {childFolders.map((d) => {
            const c = totalsById.get(d.id) ?? { newCount: 0, learnCount: 0, reviewCount: 0 };
            const key = deckKey(d.id);
            const hasWork = c.newCount + c.learnCount + c.reviewCount > 0;
            return (
              <div
                key={key}
                data-key={key}
                className={`tile deck-tile ${selected.has(key) ? 'tile-selected' : ''} ${isCut(key) ? 'tile-cut' : ''} ${dropKey === key ? 'drop-target' : ''}`}
                draggable={renamingId !== d.id}
                onClick={(e) => {
                  e.stopPropagation();
                  selectItem(key, e);
                }}
                onDoubleClick={() => onNavigate(d.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openCtx({ kind: 'deck', id: d.id }, e.clientX, e.clientY);
                }}
                onDragStart={(e) => startDrag(key, e)}
                onDragOver={(e) => {
                  if (!dropAccepts(d.id)) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = 'move';
                  setDropKey(key);
                }}
                onDragLeave={() => setDropKey((k) => (k === key ? null : k))}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  finishDrop(d.id);
                }}
                onDragEnd={() => {
                  dragRef.current = { deckIds: [], noteIds: [] };
                  setDropKey(null);
                }}
              >
                <div className="tile-icon">
                  <Folder size={44} strokeWidth={1.4} />
                  {hasWork && (
                    <button
                      className="tile-play"
                      title="Study this folder"
                      aria-label={`Study ${d.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onStudy(d.id);
                      }}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      <Play size={13} />
                    </button>
                  )}
                </div>
                {hasWork ? (
                  <div
                    className="tile-counts"
                    title="New · learning · due available today (daily limits apply — not the total stored)"
                  >
                    <span className="count-new">{c.newCount}</span>
                    <span className="count-learn">{c.learnCount}</span>
                    <span className="count-due">{c.reviewCount}</span>
                  </div>
                ) : (
                  <div className="tile-counts tile-counts-empty">—</div>
                )}
                {renamingId === d.id ? (
                  <input
                    className="input rename-inline tile-rename"
                    defaultValue={d.name}
                    autoFocus
                    onFocus={(e) => e.target.select()}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const v = (e.target as HTMLInputElement).value;
                        if (v.trim() && v.trim() !== d.name) void renameDeck(d.id, v);
                        setRenamingId(null);
                      }
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onBlur={(e) => {
                      const v = e.target.value;
                      if (v.trim() && v.trim() !== d.name) void renameDeck(d.id, v);
                      setRenamingId(null);
                    }}
                  />
                ) : (
                  <div className="tile-name" title={d.name}>
                    {d.name}
                  </div>
                )}
              </div>
            );
          })}

          {shownNotes.map((n) => {
            const key = noteKey(n.id);
            return (
              <NoteTile
                key={key}
                note={n}
                selected={selected.has(key)}
                cut={isCut(key)}
                onClick={(e) => {
                  e.stopPropagation();
                  selectItem(key, e);
                }}
                onDoubleClick={() => onEditNote(n.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openCtx({ kind: 'note', id: n.id }, e.clientX, e.clientY);
                }}
                onDragStart={(e) => startDrag(key, e)}
                onDragEnd={() => {
                  dragRef.current = { deckIds: [], noteIds: [] };
                  setDropKey(null);
                }}
              />
            );
          })}

          {childFolders.length === 0 && shownNotes.length === 0 && (
            <div className="desk-empty">
              {folder ? 'Empty folder — add a note or create a subfolder.' : 'No decks yet — create one.'}
            </div>
          )}
        </div>
        {sortedNotes.length > NOTE_TILE_CAP && (
          <div className="tooltip-hint desk-more">
            Showing {NOTE_TILE_CAP} of {sortedNotes.length} notes — use Browse to see all.
          </div>
        )}
        {marquee && (
          <div
            className="marquee"
            style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
          />
        )}
      </div>

      {ctx && <PopMenu x={ctx.x} y={ctx.y} items={ctxItems(ctx.target)} onAction={onCtxAction} />}
    </>
  );
}

// ---------- note tile ----------

function noteTitle(note: Note): string {
  const plain = stripCloze(note.front).replace(/\[img:[a-zA-Z0-9-]+\]/g, '').replace(/\s+/g, ' ').trim();
  return plain || '(image)';
}

function NoteTile({
  note,
  selected,
  cut,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: {
  note: Note;
  selected: boolean;
  cut: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  const imgId = mediaIdsIn(note.front)[0] ?? mediaIdsIn(note.back)[0];

  useEffect(() => {
    let alive = true;
    if (imgId) {
      void mediaUrl(imgId).then((u) => alive && setThumb(u));
    } else {
      setThumb(null);
    }
    return () => {
      alive = false;
    };
  }, [imgId]);

  return (
    <div
      data-key={noteKey(note.id)}
      className={`tile note-tile ${selected ? 'tile-selected' : ''} ${cut ? 'tile-cut' : ''}`}
      draggable
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="tile-icon note-icon">
        {thumb ? (
          <img src={thumb} alt="" className="note-thumb" draggable={false} />
        ) : imgId ? (
          <ImageIcon size={34} strokeWidth={1.4} />
        ) : (
          <FileText size={34} strokeWidth={1.4} />
        )}
      </div>
      <div className="tile-name" title={noteTitle(note)}>
        <InlineContent text={noteTitle(note)} flat />
      </div>
    </div>
  );
}

// ---------- generic popup menu ----------

function PopMenu({
  x,
  y,
  items,
  onAction,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onAction: (key: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 8),
      y: Math.min(y, window.innerHeight - r.height - 8),
    });
  }, [x, y]);

  return (
    <div ref={ref} className="ctx-menu anim-in" style={{ left: pos.x, top: pos.y }} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {items.map((it) => (
        <button
          key={it.key}
          role="menuitem"
          className={it.danger ? 'menu-danger' : ''}
          disabled={it.disabled}
          onClick={(e) => {
            e.stopPropagation();
            if (!it.disabled) onAction(it.key);
          }}
        >
          {it.icon} {it.label}
        </button>
      ))}
    </div>
  );
}

// ============================================================
// Simple list mode (the optional toggle)
// ============================================================

function ListRows({
  tree,
  onStudy,
  onAddSub,
  onRename,
  onOptions,
}: {
  tree: DeckTreeNode[];
  onStudy: (deckId: string) => void;
  onAddSub: (parentId: string) => void;
  onRename: (deck: Deck) => void;
  onOptions: (deck: Deck) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [menu, setMenu] = useState<{ x: number; y: number; deck: Deck } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  const rows: DeckTreeNode[] = [];
  const walk = (n: DeckTreeNode) => {
    rows.push(n);
    if (!n.deck.collapsed) n.children.forEach(walk);
  };
  tree.forEach(walk);

  const totals = tree.reduce(
    (acc, n) => ({
      newCount: acc.newCount + n.totalCounts.newCount,
      learnCount: acc.learnCount + n.totalCounts.learnCount,
      reviewCount: acc.reviewCount + n.totalCounts.reviewCount,
    }),
    { newCount: 0, learnCount: 0, reviewCount: 0 },
  );

  const handleDelete = async (deck: Deck) => {
    const cardCount = await countCardsInSubtree(deck.id);
    const ok = await confirm({
      title: `Delete "${deck.name}"?`,
      message: `This deletes the deck, all its subdecks, and ${cardCount} card${cardCount === 1 ? '' : 's'}. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await deleteDeckSubtree(deck.id);
    toast.push('success', `Deleted "${deck.name}".`);
  };

  const handleExport = async (deck: Deck) => {
    const decks = await db.decks.toArray();
    const ids = descendantIds(decks, deck.id);
    const blob = await exportCollection(ids);
    downloadBlob(blob, `${deck.name.replace(/[^\w-]+/g, '_')}.ankiai.json`);
    toast.push('success', 'Deck exported.');
  };

  return (
    <div className="card-panel deck-table">
      <div className="deck-row deck-row-head" aria-hidden="true">
        <span />
        <span className="deck-count-head">New</span>
        <span className="deck-count-head">Learn</span>
        <span className="deck-count-head">Due</span>
        <span />
      </div>
      {rows.map(({ deck, children, depth, totalCounts }) => (
        <div className="deck-row" key={deck.id}>
          <span className="deck-name-cell" style={{ paddingLeft: depth * 22 }}>
            {children.length > 0 ? (
              <button
                className="icon-btn chevron-btn"
                aria-label={deck.collapsed ? 'Expand' : 'Collapse'}
                onClick={() => void db.decks.update(deck.id, { collapsed: deck.collapsed ? 0 : 1 })}
              >
                {deck.collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
              </button>
            ) : (
              <span className="chevron-spacer" />
            )}
            <button className="deck-name" onClick={() => onStudy(deck.id)} title="Study this deck">
              {deck.name}
            </button>
          </span>
          <span className={`deck-count count-new ${totalCounts.newCount ? '' : 'count-zero'}`}>
            {totalCounts.newCount}
          </span>
          <span className={`deck-count count-learn ${totalCounts.learnCount ? '' : 'count-zero'}`}>
            {totalCounts.learnCount}
          </span>
          <span className={`deck-count count-due ${totalCounts.reviewCount ? '' : 'count-zero'}`}>
            {totalCounts.reviewCount}
          </span>
          <span className="deck-actions">
            {totalCounts.newCount + totalCounts.learnCount + totalCounts.reviewCount > 0 && (
              <button className="btn btn-sm btn-primary" onClick={() => onStudy(deck.id)}>
                <Play size={13} /> Study
              </button>
            )}
            <button
              className="icon-btn"
              aria-label={`Options for ${deck.name}`}
              onClick={(e) => {
                e.stopPropagation();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMenu({ x: rect.left, y: rect.bottom + 4, deck });
              }}
            >
              <MoreHorizontal size={17} />
            </button>
          </span>
        </div>
      ))}
      <div className="deck-row deck-row-total">
        <span>Total</span>
        <span className="deck-count count-new">{totals.newCount}</span>
        <span className="deck-count count-learn">{totals.learnCount}</span>
        <span className="deck-count count-due">{totals.reviewCount}</span>
        <span />
      </div>
      {menu && (
        <PopMenu
          x={menu.x}
          y={menu.y}
          items={[
            { key: 'addSub', label: 'Add subdeck', icon: <FolderPlus size={15} /> },
            { key: 'rename', label: 'Rename', icon: <Pencil size={15} /> },
            { key: 'options', label: 'Options', icon: <Settings2 size={15} /> },
            { key: 'export', label: 'Export', icon: <Download size={15} /> },
            { key: 'delete', label: 'Delete', icon: <Trash2 size={15} />, danger: true },
          ]}
          onAction={(key) => {
            const deck = menu.deck;
            setMenu(null);
            if (key === 'addSub') onAddSub(deck.id);
            if (key === 'rename') onRename(deck);
            if (key === 'options') onOptions(deck);
            if (key === 'export') void handleExport(deck);
            if (key === 'delete') void handleDelete(deck);
          }}
        />
      )}
    </div>
  );
}

// ============================================================
// modals
// ============================================================

function RenameModal({
  deck,
  onClose,
  onSave,
}: {
  deck: Deck;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(deck.name);
  return (
    <Modal title="Rename deck" onClose={onClose}>
      <input
        className="input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSave(name.trim())}
        autoFocus
      />
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!name.trim()} onClick={() => onSave(name.trim())}>
          Rename
        </button>
      </div>
    </Modal>
  );
}

function AddDeckModal({
  parentId,
  decks,
  onClose,
  onCreate,
}: {
  parentId: string | null;
  decks: Deck[];
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const parent = parentId ? decks.find((d) => d.id === parentId) : null;
  return (
    <Modal title={parent ? `New folder inside "${parent.name}"` : 'New folder'} onClose={onClose}>
      <input
        className="input"
        placeholder="Folder name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && name.trim() && onCreate(name.trim())}
        autoFocus
      />
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!name.trim()} onClick={() => onCreate(name.trim())}>
          Create
        </button>
      </div>
    </Modal>
  );
}

function DeckOptionsModal({
  deck,
  onClose,
  onSave,
}: {
  deck: Deck;
  onClose: () => void;
  onSave: (config: DeckConfig, applyToSubtree: boolean) => void;
}) {
  const [cfg, setCfg] = useState<DeckConfig>({ ...deck.config });
  const [subtree, setSubtree] = useState(false);
  const [learningSteps, setLearningSteps] = useState(deck.config.learningStepsMin.join(' '));
  const [relearningSteps, setRelearningSteps] = useState(deck.config.relearningStepsMin.join(' '));

  const parseSteps = (s: string): number[] =>
    s
      .split(/[\s,]+/)
      .map((x) => parseFloat(x))
      .filter((n) => !Number.isNaN(n) && n > 0);

  const save = () => {
    const ls = parseSteps(learningSteps);
    const rs = parseSteps(relearningSteps);
    onSave(
      {
        ...cfg,
        learningStepsMin: ls.length ? ls : [1, 10],
        relearningStepsMin: rs.length ? rs : [10],
      },
      subtree,
    );
  };

  return (
    <Modal title={`Options — ${deck.name}`} onClose={onClose}>
      <div className="options-grid">
        <label>
          <span className="field-label">New cards / day</span>
          <input
            className="input"
            type="number"
            min={0}
            value={cfg.newPerDay}
            onChange={(e) => setCfg({ ...cfg, newPerDay: Math.max(0, parseInt(e.target.value) || 0) })}
          />
        </label>
        <label>
          <span className="field-label">Max reviews / day</span>
          <input
            className="input"
            type="number"
            min={0}
            value={cfg.reviewsPerDay}
            onChange={(e) => setCfg({ ...cfg, reviewsPerDay: Math.max(0, parseInt(e.target.value) || 0) })}
          />
        </label>
        <label>
          <span className="field-label">Learning steps (minutes)</span>
          <input
            className="input"
            value={learningSteps}
            onChange={(e) => setLearningSteps(e.target.value)}
            placeholder="1 10"
          />
        </label>
        <label>
          <span className="field-label">Relearning steps (minutes)</span>
          <input
            className="input"
            value={relearningSteps}
            onChange={(e) => setRelearningSteps(e.target.value)}
            placeholder="10"
          />
        </label>
        <label className="options-span">
          <span className="field-label">
            Desired retention — {Math.round(cfg.desiredRetention * 100)}%
          </span>
          <input
            type="range"
            min={0.7}
            max={0.98}
            step={0.01}
            value={cfg.desiredRetention}
            onChange={(e) => setCfg({ ...cfg, desiredRetention: parseFloat(e.target.value) })}
          />
          <span className="tooltip-hint">
            Higher retention = shorter intervals = more daily reviews. FSRS default is 90%.
          </span>
        </label>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={subtree} onChange={(e) => setSubtree(e.target.checked)} />
        Apply to all subdecks
      </label>
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  );
}
