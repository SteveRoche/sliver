import { createEffect, createRoot, untrack } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { NoteId } from '../vault/api';
import { findPane, paneNote, panes } from './layout';
import {
  inZettelkasten,
  layout,
  navigate,
  noteById,
  parentNote,
  sequenceNotes,
  sequenceOf,
} from './workspace';

/**
 * Moving between notes in a pane: back and forward through the notes it
 * showed, and along the Folgezettel (parent, first next note, asides).
 * Moves replace the pane's active note rather than open tabs (`navigate`).
 */

interface History {
  notes: NoteId[];
  /** Index of the note shown now. */
  at: number;
}

/** Each pane's history, by pane id; not persisted. */
const [histories, setHistories] = createStore<Record<string, History>>({});

// Every note a pane comes to show joins its history, however it got there
// (sidebar, link, tab switch), dropping what was ahead of it.
createRoot(() =>
  createEffect(() => {
    for (const pane of panes(layout.root)) {
      const note = paneNote(pane);
      if (!note) continue;
      untrack(() => {
        const h = histories[pane.id] ?? { notes: [], at: -1 };
        if (h.notes[h.at] === note) return;
        const notes = [...h.notes.slice(0, h.at + 1), note];
        setHistories(pane.id, { notes, at: notes.length - 1 });
      });
    }
  }),
);

/** Where going back (`-1`) or forward (`1`) in pane `paneId` lands, skipping deleted notes. */
function historyStep(paneId: string, direction: -1 | 1) {
  const h = histories[paneId];
  if (!h) return undefined;
  for (
    let at = h.at + direction;
    at >= 0 && at < h.notes.length;
    at += direction
  ) {
    if (noteById(h.notes[at])) return at;
  }
  return undefined;
}

export const canGo = (paneId: string, direction: -1 | 1) =>
  historyStep(paneId, direction) !== undefined;

export function go(paneId: string, direction: -1 | 1) {
  const at = historyStep(paneId, direction);
  if (at === undefined) return;
  // Moved first, so the note showing up isn't recorded as a new step.
  setHistories(paneId, 'at', at);
  void navigate(paneId, histories[paneId].notes[at]);
}

export type FolgezettelMove = 'parent' | 'next' | 'previousAside' | 'nextAside';

/**
 * Where a Folgezettel move from note `id` goes: its parent, its first next
 * note (one level deeper), or its previous or next aside (sibling). Only
 * Zettelkasten notes have any.
 */
export function folgezettelTarget(
  id: NoteId | null,
  move: FolgezettelMove,
): NoteId | undefined {
  if (!id || !inZettelkasten(id)) return undefined;
  const parent = parentNote(id);
  if (move === 'parent') return parent?.id;
  if (move === 'next') return noteById(id)?.children[0]?.id;
  const sequence = sequenceOf(noteById(id)?.address ?? null);
  const siblings =
    parent?.children ?? (sequence === undefined ? [] : sequenceNotes(sequence));
  const i = siblings.findIndex(n => n.id === id);
  return siblings[i + (move === 'nextAside' ? 1 : -1)]?.id;
}

const paneNoteOf = (paneId: string) => {
  const pane = findPane(layout.root, paneId);
  return pane ? paneNote(pane) : null;
};

export const canMove = (paneId: string, move: FolgezettelMove) =>
  folgezettelTarget(paneNoteOf(paneId), move) !== undefined;

export function moveAlong(paneId: string, move: FolgezettelMove) {
  const target = folgezettelTarget(paneNoteOf(paneId), move);
  if (target) void navigate(paneId, target);
}
