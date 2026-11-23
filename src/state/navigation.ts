import { createEffect, createRoot, untrack } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { NoteId } from '../vault/api';
import { findPane, paneNote, panes } from './layout';
import {
  activateTab,
  inZettelkasten,
  layout,
  navigate,
  noteById,
  parentNote,
  sequenceNotes,
  sequenceOf,
  tabOf,
} from './workspace';

/**
 * Moving between notes in a pane: back and forward through the notes its
 * active tab showed, and along the Folgezettel (parent, first next note,
 * asides). Moves replace the tab's note rather than open tabs (`navigate`).
 */

interface History {
  notes: NoteId[];
  /** Index of the note shown now. */
  at: number;
}

/**
 * Each tab's history, by tab key (so it moves with the tab between panes);
 * not persisted.
 */
const [histories, setHistories] = createStore<
  Record<string, History | undefined>
>({});

// Every note a tab comes to show joins its history, however it got there
// (sidebar, link, switcher), dropping what was ahead of it. Closed tabs'
// histories go.
createRoot(() =>
  createEffect(() => {
    const tabs = panes(layout.root).flatMap(pane => pane.tabs);
    const notes = tabs.map(tab => [tab.key, tab.note] as const);
    untrack(() => {
      const open = new Set(tabs.map(tab => tab.key));
      for (const key of Object.keys(histories)) {
        if (!open.has(key)) setHistories(key, undefined);
      }
      for (const [key, note] of notes) {
        if (!note) continue;
        const h = histories[key] ?? { notes: [], at: -1 };
        if (h.notes[h.at] === note) continue;
        const next = [...h.notes.slice(0, h.at + 1), note];
        setHistories(key, { notes: next, at: next.length - 1 });
      }
    });
  }),
);

/** The active tab of pane `paneId`. */
const activeTab = (paneId: string) => {
  const pane = findPane(layout.root, paneId);
  return pane?.tabs.find(t => t.key === pane.active);
};

/**
 * Where going back (`-1`) or forward (`1`) in the active tab of pane
 * `paneId` lands, skipping deleted notes.
 */
function historyStep(paneId: string, direction: -1 | 1) {
  const key = activeTab(paneId)?.key;
  const h = key === undefined ? undefined : histories[key];
  if (key === undefined || !h) return undefined;
  for (
    let at = h.at + direction;
    at >= 0 && at < h.notes.length;
    at += direction
  ) {
    if (noteById(h.notes[at])) return { key, at, note: h.notes[at] };
  }
  return undefined;
}

export const canGo = (paneId: string, direction: -1 | 1) =>
  historyStep(paneId, direction) !== undefined;

export function go(paneId: string, direction: -1 | 1) {
  const step = historyStep(paneId, direction);
  if (!step) return;
  const elsewhere = tabOf(step.note);
  // A note open in another tab is shown there; this tab stays as it is.
  if (elsewhere && elsewhere.key !== step.key) {
    activateTab(elsewhere.key);
    return;
  }
  // Moved first, so the note showing up isn't recorded as a new step.
  setHistories(step.key, 'at', step.at);
  void navigate(paneId, step.note);
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
