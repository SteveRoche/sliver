import type { Extension } from '@codemirror/state';
import { ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { Position } from '../typst/protocol';

/** How long the cursor must rest before the preview follows it. */
const FOLLOW_DELAY_MS = 150;

/**
 * Tells `follow` where the cursor rests (line and UTF-16 column), so the
 * preview can scroll to the same place. Only cursor moves count, not typing,
 * and only while `enabled()`.
 */
export function followCursor(
  enabled: () => boolean,
  follow: (position: Position) => void,
): Extension {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | undefined;

      update(update: ViewUpdate) {
        if (!update.selectionSet || update.docChanged || !enabled()) return;
        if (!update.view.hasFocus) return;
        clearTimeout(this.timer);
        const view = update.view;
        this.timer = setTimeout(() => {
          const head = view.state.selection.main.head;
          const line = view.state.doc.lineAt(head);
          follow({ line: line.number - 1, column: head - line.from });
        }, FOLLOW_DELAY_MS);
      }

      destroy() {
        clearTimeout(this.timer);
      }
    },
  );
}
