import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export const LINK_SCHEME = "sliver://";

const WIKILINK = /\[\[([^[\]\n]+)\]\]/g;

/** Cmd/Ctrl-click on `[[target]]` or `[[target|text]]` calls `open(target)`. */
export function wikilinkClick(open: (target: string) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
      const pos = view.posAtCoords(event);
      if (pos === null) return false;
      const line = view.state.doc.lineAt(pos);
      for (const match of line.text.matchAll(WIKILINK)) {
        const from = line.from + match.index;
        if (pos < from || pos > from + match[0].length) continue;
        const target = match[1].split("|")[0].trim();
        if (!target) return false;
        event.preventDefault();
        open(target);
        return true;
      }
      return false;
    },
  });
}
