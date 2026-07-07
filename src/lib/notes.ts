import { db, uid } from '../db';
import type { Note, NoteType } from '../types';
import { clozeIndices } from './cloze';
import { newCardRecord } from './scheduler';
import { pruneOrphanMedia } from './media';

/** Which card ordinals a note should have, given its type and content. */
function expectedOrds(type: NoteType, front: string): number[] {
  switch (type) {
    case 'basic':
      return [0];
    case 'basicReversed':
      return [0, 1];
    case 'cloze': {
      const idx = clozeIndices(front);
      return idx.length > 0 ? idx : [1];
    }
  }
}

export async function addNote(
  deckId: string,
  type: NoteType,
  front: string,
  back: string,
  tags: string[],
  /** override for batch creation: strictly-increasing values keep the new-card queue in insertion order */
  createdAt?: number,
): Promise<Note> {
  const now = createdAt ?? Date.now();
  const note: Note = {
    id: uid(),
    deckId,
    type,
    front,
    back,
    tags,
    createdAt: now,
    updatedAt: now,
  };
  const cards = expectedOrds(type, front).map((ord) => ({
    ...newCardRecord(note.id, deckId, ord),
    createdAt: now,
  }));
  await db.transaction('rw', db.notes, db.cards, async () => {
    await db.notes.add(note);
    await db.cards.bulkAdd(cards);
  });
  return note;
}

/**
 * Update a note's fields/tags/deck. For cloze notes, cards are synced with the
 * cloze indices present: new indices get new cards, removed indices lose their
 * cards. Existing cards keep their scheduling untouched.
 */
export async function updateNote(
  noteId: string,
  patch: { front: string; back: string; tags: string[]; deckId?: string },
): Promise<void> {
  await db.transaction('rw', db.notes, db.cards, async () => {
    const note = await db.notes.get(noteId);
    if (!note) return;
    const updated: Note = {
      ...note,
      front: patch.front,
      back: patch.back,
      tags: patch.tags,
      deckId: patch.deckId ?? note.deckId,
      updatedAt: Date.now(),
    };
    await db.notes.put(updated);

    const cards = await db.cards.where('noteId').equals(noteId).toArray();
    const wanted = new Set(expectedOrds(updated.type, updated.front));
    const existing = new Set(cards.map((c) => c.ord));
    // add cards for new ordinals
    for (const ord of wanted) {
      if (!existing.has(ord)) {
        await db.cards.add(newCardRecord(noteId, updated.deckId, ord));
      }
    }
    // remove cards for ordinals that no longer exist
    const toDelete = cards.filter((c) => !wanted.has(c.ord)).map((c) => c.id);
    if (toDelete.length) await db.cards.bulkDelete(toDelete);
    // deck move: move all cards along
    if (patch.deckId && patch.deckId !== note.deckId) {
      const remaining = await db.cards.where('noteId').equals(noteId).toArray();
      await db.cards.bulkPut(remaining.map((c) => ({ ...c, deckId: patch.deckId! })));
    }
  });
}

export async function deleteNotes(noteIds: string[]): Promise<number> {
  let cardCount = 0;
  await db.transaction('rw', db.notes, db.cards, db.revlog, async () => {
    for (const id of noteIds) {
      const cards = await db.cards.where('noteId').equals(id).toArray();
      cardCount += cards.length;
      await db.cards.bulkDelete(cards.map((c) => c.id));
      await db.revlog.where('cardId').anyOf(cards.map((c) => c.id)).delete();
      await db.notes.delete(id);
    }
  });
  pruneOrphanMedia().catch(() => {});
  return cardCount;
}

export async function moveCardsToDeck(cardIds: string[], deckId: string): Promise<void> {
  await db.transaction('rw', db.cards, async () => {
    for (const id of cardIds) {
      await db.cards.update(id, { deckId });
    }
  });
}

/** Move whole notes (and all their cards) to another deck. */
export async function moveNotes(noteIds: string[], deckId: string): Promise<void> {
  await db.transaction('rw', db.notes, db.cards, async () => {
    for (const id of noteIds) {
      await db.notes.update(id, { deckId });
      const cards = await db.cards.where('noteId').equals(id).toArray();
      await db.cards.bulkPut(cards.map((c) => ({ ...c, deckId })));
    }
  });
}

/** Duplicate notes (and their cards, scheduling preserved) into a deck. */
export async function duplicateNotes(noteIds: string[], targetDeckId: string): Promise<number> {
  let n = 0;
  const now = Date.now();
  await db.transaction('rw', db.notes, db.cards, async () => {
    for (const id of noteIds) {
      const note = await db.notes.get(id);
      if (!note) continue;
      const newId = uid();
      await db.notes.add({
        ...note,
        id: newId,
        deckId: targetDeckId,
        tags: [...note.tags],
        createdAt: now,
        updatedAt: now,
      });
      const cards = await db.cards.where('noteId').equals(id).toArray();
      await db.cards.bulkAdd(cards.map((c) => ({ ...c, id: uid(), noteId: newId, deckId: targetDeckId })));
      n++;
    }
  });
  return n;
}

/** Non-blocking duplicate check: same type + same first field (trimmed). */
export async function findDuplicate(type: NoteType, front: string, excludeNoteId?: string): Promise<Note | undefined> {
  const target = front.trim();
  if (!target) return undefined;
  let dup: Note | undefined;
  await db.notes.each((n) => {
    if (!dup && n.type === type && n.id !== excludeNoteId && n.front.trim() === target) {
      dup = n;
    }
  });
  return dup;
}

export async function allTags(): Promise<string[]> {
  const tags = new Set<string>();
  await db.notes.each((n) => n.tags.forEach((t) => tags.add(t)));
  return [...tags].sort();
}
