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
        if (hidden()) dropFocus(el);
      });
      return <NoteTab id={id} hidden={hidden()} />;
    }, el);
    host = { el, dispose };
    hosts.set(id, host);
  }
  return host.el;
}

/**
 * Takes focus and the text selection out of an editor being hidden. WebKit
 * keeps the selection in its (now hidden) content, and once the editor
 * shows again, typing goes straight into that content as a native edit
 * that neither Vim nor the keymaps see: in Vim's normal mode, a key would
 * be inserted instead of acting.
 */
function dropFocus(el: HTMLElement) {
  if (el.contains(document.activeElement)) {
    (document.activeElement as HTMLElement).blur();
  }
  const selection = document.getSelection();
  if (selection?.anchorNode && el.contains(selection.anchorNode)) {
    selection.removeAllRanges();
  }
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
