import { createEffect, createRoot } from 'solid-js';
import { render } from 'solid-js/web';
import { allTabs, isEditorShown } from '../state/workspace';
import type { NoteId } from '../vault/api';
import { NoteTab } from './NoteTab';

/**
 * Each open note's editor lives outside the pane tree, in its own root, and
 * panes adopt its element. Splitting or moving a tab rebuilds panes; the
 * editor only moves in the DOM, keeping its cursor and undo history.
 */
const hosts = new Map<NoteId, { el: HTMLElement; dispose: () => void }>();

/** Note `id`'s editor element, created on first use. */
export function editorElement(id: NoteId): HTMLElement {
  let host = hosts.get(id);
  if (!host) {
    // Rendered into an element made here: what a component returns isn't
    // always a single node (in dev, hot reloading wraps it).
    const el = document.createElement('div');
    el.className = 'note-tab';
    const dispose = render(() => {
      const hidden = () => !isEditorShown(id);
      createEffect(() => {
        el.hidden = hidden();
      });
      return <NoteTab id={id} hidden={hidden()} />;
    }, el);
    host = { el, dispose };
    hosts.set(id, host);
  }
  return host.el;
}

// Editors of notes no longer in any tab are destroyed.
createRoot(() =>
  createEffect(() => {
    const open = new Set(allTabs().flatMap(t => (t.note ? [t.note] : [])));
    for (const [id, host] of hosts) {
      if (open.has(id)) continue;
      host.dispose();
      host.el.remove();
      hosts.delete(id);
    }
  }),
);
