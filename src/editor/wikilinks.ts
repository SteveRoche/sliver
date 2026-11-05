import { type Extension, StateEffect } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import type { LinkRange } from '../vault/api';
import { linksAt, syntaxField } from './analysis';

export interface WikilinkOptions {
  /** The linked note's title, or null when the target doesn't resolve. */
  title(target: string): string | null;
  open(target: string): void;
}

/** Re-renders link labels, e.g. after a note was renamed. */
export const refreshWikilinks = StateEffect.define<null>();

class LinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly target: string,
    readonly broken: boolean,
  ) {
    super();
  }

  eq(other: LinkWidget) {
    return (
      other.label === this.label &&
      other.target === this.target &&
      other.broken === this.broken
    );
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = this.broken ? 'cm-wikilink broken' : 'cm-wikilink';
    span.textContent = this.label;
    span.title = this.broken ? `No note "${this.target}"` : this.target;
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

const sourceMark = Decoration.mark({ class: 'cm-wikilink-source' });

/**
 * Shows each wikilink as its target's title (or its custom text) until the
 * cursor enters it, when the source comes back for editing.
 */
function decorations(
  view: EditorView,
  options: WikilinkOptions,
): DecorationSet {
  const { selection } = view.state;
  const ranges = linksAt(view.state).map((link: LinkRange) => {
    const editing = selection.ranges.some(
      (r) => r.from <= link.to && r.to >= link.from,
    );
    if (editing) return sourceMark.range(link.from, link.to);
    const title = options.title(link.target);
    const widget = new LinkWidget(
      link.text ?? title ?? link.target,
      link.target,
      title === null,
    );
    return Decoration.replace({ widget }).range(link.from, link.to);
  });
  return Decoration.set(ranges, true);
}

function linkAt(view: EditorView, pos: number): LinkRange | undefined {
  return linksAt(view.state).find((l) => l.from <= pos && pos <= l.to);
}

export function wikilinks(options: WikilinkOptions): Extension {
  const display = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = decorations(view, options);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.startState.field(syntaxField) !==
            update.state.field(syntaxField) ||
          update.transactions.some((tr) =>
            tr.effects.some((e) => e.is(refreshWikilinks)),
          )
        ) {
          this.decorations = decorations(update.view, options);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

  const clicks = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
      const pos = view.posAtCoords(event);
      const link = pos === null ? undefined : linkAt(view, pos);
      if (!link) return false;
      event.preventDefault();
      options.open(link.target);
      return true;
    },
  });

  return [display, clicks];
}
