import { type Extension, StateEffect } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import type { CitationRange } from '../vault/api';
import { citationsAt, syntaxField } from './analysis';

export interface CitationOptions {
  /** Whether the vault's references have an entry for `key`. */
  known(key: string): boolean;
  /** The tooltip shown over a citation. */
  card(key: string): HTMLElement;
  open(key: string): void;
}

/** Re-marks citations, e.g. after references were fetched. */
export const refreshCitations = StateEffect.define<null>();

const knownMark = Decoration.mark({ class: 'cm-citation' });
const unknownMark = Decoration.mark({ class: 'cm-citation unknown' });

function decorations(view: EditorView, options: CitationOptions) {
  return Decoration.set(
    citationsAt(view.state).map(c =>
      (options.known(c.key) ? knownMark : unknownMark).range(c.from, c.to),
    ),
    true,
  );
}

function citationAt(view: EditorView, pos: number, side = 0) {
  return citationsAt(view.state).find(
    (c: CitationRange) =>
      (c.from < pos || (c.from === pos && side >= 0)) &&
      (pos < c.to || (pos === c.to && side <= 0)),
  );
}

/**
 * Citation keys (`@key`, `cite(<key>)`): marked, unknown ones in red; a
 * hover shows the entry; Mod-click opens it in Zotero.
 */
export function citations(options: CitationOptions): Extension {
  const marks = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = decorations(view, options);
      }

      update(update: ViewUpdate) {
        if (
          update.startState.field(syntaxField) !==
            update.state.field(syntaxField) ||
          update.transactions.some(tr =>
            tr.effects.some(e => e.is(refreshCitations)),
          )
        ) {
          this.decorations = decorations(update.view, options);
        }
      }
    },
    { decorations: plugin => plugin.decorations },
  );

  const tooltip = hoverTooltip((view, pos, side) => {
    const citation = citationAt(view, pos, side);
    if (!citation) return null;
    return {
      pos: citation.from,
      end: citation.to,
      above: true,
      create: () => ({ dom: options.card(citation.key) }),
    };
  });

  const clicks = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
      const pos = view.posAtCoords(event);
      const citation = pos === null ? undefined : citationAt(view, pos);
      if (!citation || !options.known(citation.key)) return false;
      event.preventDefault();
      options.open(citation.key);
      return true;
    },
  });

  return [marks, tooltip, clicks];
}
