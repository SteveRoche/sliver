import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * Wraps each selection in `marker` (e.g. `*` for bold), or unwraps it when
 * it is wrapped already, inside or just outside the selection. An empty
 * selection gets an empty pair with the cursor between, or loses the empty
 * pair it's in.
 */
export function toggleWrap(view: EditorView, marker: string) {
  const { state } = view;
  const n = marker.length;
  view.dispatch(
    state.changeByRange(range => {
      const { from, to } = range;
      const inner = state.sliceDoc(from, to);
      if (
        inner.length >= 2 * n &&
        inner.startsWith(marker) &&
        inner.endsWith(marker)
      ) {
        return {
          changes: [
            { from, to: from + n },
            { from: to - n, to },
          ],
          range: EditorSelection.range(from, to - 2 * n),
        };
      }
      if (
        state.sliceDoc(from - n, from) === marker &&
        state.sliceDoc(to, to + n) === marker
      ) {
        return {
          changes: [
            { from: from - n, to: from },
            { from: to, to: to + n },
          ],
          range: EditorSelection.range(from - n, to - n),
        };
      }
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: EditorSelection.range(from + n, to + n),
      };
    }),
    { userEvent: 'input.format' },
  );
  view.focus();
}
