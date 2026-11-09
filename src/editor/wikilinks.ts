import { isolateHistory } from '@codemirror/commands';
import {
  type EditorState,
  type Extension,
  Facet,
  StateEffect,
  StateField,
  type TransactionSpec,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { isMac } from '../commands/registry';
import type { LinkRange } from '../vault/api';
import { linksAt, syntaxField } from './analysis';
import {
  ADDRESS,
  linksIn,
  linkTitle,
  linkView,
  replaceFromFile,
  toFile,
  UUID,
  uuidAt,
} from './linkView';

export interface WikilinkOptions {
  /** The linked note's title, or null when the target doesn't resolve. */
  title(target: string): string | null;
  /**
   * What a resolving link without custom text shows (the title or, per the
   * `linkDisplay` setting, the address), and the other form for its hover
   * (null when there's none); null when the target doesn't resolve.
   */
  label(target: string): { shown: string; hover: string | null } | null;
  /** For a uuid whose note is gone: the title it had, if known. */
  formerTitle(target: string): string | null;
  open(target: string): void;
  /**
   * The target (address, or uuid) of the note titled `title` that a link
   * typed as `[[title]]` should point at, or null when there's none (or
   * no single one).
   */
  resolveTitle(title: string): string | null;
}

/** Re-renders link labels, e.g. after a note was renamed. */
export const refreshWikilinks = StateEffect.define<null>();

const optionsFacet = Facet.define<WikilinkOptions, WikilinkOptions | null>({
  combine: values => values[0] ?? null,
});

/**
 * The link the main cursor is in (brackets included, or just after them),
 * with its text on entering, so leaving can tell whether it was edited.
 * Nothing about the text changes on entering or leaving: a uuid link's
 * title is already the editor's text (see `linkView.ts`).
 */
interface ActiveLink {
  from: number;
  to: number;
  original: string;
}

const setActive = StateEffect.define<ActiveLink | null>({
  map(value, mapping) {
    if (!value) return value;
    const from = mapping.mapPos(value.from, 1);
    const to = mapping.mapPos(value.to, -1);
    return from < to ? { ...value, from, to } : null;
  },
});

const activeField = StateField.define<ActiveLink | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setActive)) return effect.value;
    }
    if (!value || !tr.docChanged) return value;
    const from = tr.changes.mapPos(value.from, 1);
    const to = tr.changes.mapPos(value.to, -1);
    return from < to ? { ...value, from, to } : null;
  },
});

/** The target of the link text at `from`..`to`, where it is, or null when it's no longer a link. */
function parseLink(state: EditorState, from: number, to: number) {
  const match = /^\[\[([^[\]\n]*)\]\]$/.exec(state.sliceDoc(from, to));
  if (!match) return null;
  const inner = match[1];
  const bar = inner.indexOf('|');
  const raw = bar < 0 ? inner : inner.slice(0, bar);
  const target = raw.trim();
  const start = from + 2 + raw.length - raw.trimStart().length;
  return { target, from: start, to: start + target.length };
}

/**
 * The change that makes the editor show `file` (a reload from disk), in
 * editor form, or null when it already does.
 */
export function reloadSpec(
  state: EditorState,
  file: string,
  targets?: { from: number; to: number }[],
): TransactionSpec | null {
  const options = state.facet(optionsFacet) ?? {
    title: () => null,
    formerTitle: () => null,
    resolveTitle: () => null,
  };
  // The file wins: a link being edited no longer stands for what it did.
  return replaceFromFile(state, file, options, targets, [setActive.of(null)]);
}

/** The document as the file should have it: titles standing for uuids back as uuids. */
export function savedText(state: EditorState): string {
  return toFile(state);
}

/** The target of the link at `pos` as the file has it (a title standing for a uuid reads as the uuid). */
function targetAt(state: EditorState, pos: number): string | undefined {
  return linksIn(state).find(l => l.from <= pos && pos <= l.to)?.target;
}

/** Whether the main cursor is in (or at the edge of) a wikilink. */
export function linkAtCursor(view: EditorView): boolean {
  return targetAt(view.state, view.state.selection.main.head) !== undefined;
}

/** Follows (or, when broken, creates) the link at the cursor. */
export function followLinkAtCursor(view: EditorView): boolean {
  const options = view.state.facet(optionsFacet);
  const target = targetAt(view.state, view.state.selection.main.head);
  if (!options || target === undefined) return false;
  options.open(target);
  return true;
}

/**
 * Points `links` at `target` in one undoable step. A uuid goes in as it
 * is; the incoming filter (`linkView.ts`) shows it as the note's title in
 * the same transaction.
 */
export function retargetLinks(
  state: EditorState,
  links: { targetFrom: number; targetTo: number }[],
  target: string,
): TransactionSpec {
  return {
    changes: state.changes(
      links.map(l => ({ from: l.targetFrom, to: l.targetTo, insert: target })),
    ),
  };
}

/**
 * The cursor left the active link. Untouched, nothing happens. Edited
 * text is resolved: the title of a note links to it (its address, or, for
 * a note without one, the title stands for its uuid), an address or uuid
 * stays, and anything else stays as an uninitialized link (Mod-click
 * creates the note). After undo or redo nothing is resolved, so the redo
 * history survives.
 */
function leave(
  state: EditorState,
  options: WikilinkOptions,
  active: ActiveLink,
  undoing: boolean,
): TransactionSpec {
  const done = setActive.of(null);
  const link = parseLink(state, active.from, active.to);
  if (
    !link?.target ||
    state.sliceDoc(active.from, active.to) === active.original
  ) {
    return { effects: done };
  }
  if (undoing || UUID.test(link.target) || ADDRESS.test(link.target)) {
    return { effects: done };
  }
  if (uuidAt(state, link.from, link.to) !== undefined) return { effects: done };
  const resolved = options.resolveTitle(link.target);
  if (resolved === null || resolved === link.target) return { effects: done };
  if (UUID.test(resolved)) {
    return {
      effects: [
        done,
        linkTitle({
          from: link.from,
          to: link.to,
          uuid: resolved,
          shown: link.target,
        }),
      ],
      annotations: isolateHistory.of('full'),
    };
  }
  return {
    changes: { from: link.from, to: link.to, insert: resolved },
    effects: done,
    annotations: isolateHistory.of('full'),
  };
}

/** What, if anything, has to change for the cursor's position. */
function reconcile(
  state: EditorState,
  options: WikilinkOptions,
  undoing: boolean,
): TransactionSpec | null {
  const head = state.selection.main.head;
  const active = state.field(activeField);
  if (active) {
    if (head < active.from || head > active.to) {
      return leave(state, options, active, undoing);
    }
    return null;
  }
  const link = linksAt(state).find(l => l.from <= head && head <= l.to);
  // The analysis lags edits: only trust a link whose text is still there.
  if (!link || state.sliceDoc(link.targetFrom, link.targetTo) !== link.target) {
    return null;
  }
  return {
    effects: setActive.of({
      from: link.from,
      to: link.to,
      original: state.sliceDoc(link.from, link.to),
    }),
  };
}

class LinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly target: string,
    readonly broken: boolean,
    /** The tooltip of a working link: the form `label` doesn't show. */
    readonly hover: string = target,
  ) {
    super();
  }

  eq(other: LinkWidget) {
    return (
      other.label === this.label &&
      other.target === this.target &&
      other.broken === this.broken &&
      other.hover === this.hover
    );
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = this.broken ? 'cm-wikilink broken' : 'cm-wikilink';
    span.textContent = this.label;
    span.title = this.broken
      ? `No note "${this.target}". ${isMac ? 'Cmd' : 'Ctrl'}-click to create it.`
      : this.hover;
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

const sourceMark = Decoration.mark({ class: 'cm-wikilink-source' });

/**
 * Shows each wikilink as its target's title (or its custom text) until the
 * cursor enters it, when the source comes back for editing; a uuid link's
 * source is its title already.
 */
function decorations(
  view: EditorView,
  options: WikilinkOptions,
): DecorationSet {
  const { state } = view;
  const active = state.field(activeField);
  const ranges = linksIn(state).flatMap((link: LinkRange) => {
    if (link.from >= link.to) return [];
    if (active && link.from < active.to && link.to > active.from) return [];
    const uuid = UUID.test(link.target);
    const editing = state.selection.ranges.some(
      r => r.from <= link.to && r.to >= link.from,
    );
    if (editing) return [sourceMark.range(link.from, link.to)];
    const label = options.label(link.target);
    // A uuid never shows, even when its note is gone.
    const shown =
      label?.shown ??
      (uuid ? (options.formerTitle(link.target) ?? 'Missing note') : null);
    const widget = new LinkWidget(
      link.text ?? shown ?? link.target,
      shown ?? link.target,
      label === null,
      label?.hover ?? (uuid ? (shown ?? link.target) : link.target),
    );
    return [Decoration.replace({ widget }).range(link.from, link.to)];
  });
  if (active && active.from < active.to) {
    ranges.push(sourceMark.range(active.from, active.to));
  }
  return Decoration.set(ranges, true);
}

export function wikilinks(options: WikilinkOptions): Extension {
  const display = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      scheduled = false;
      undoing = false;

      destroyed = false;

      constructor(readonly view: EditorView) {
        this.decorations = decorations(view, options);
        this.schedule();
      }

      destroy() {
        this.destroyed = true;
      }

      update(update: ViewUpdate) {
        const syntaxChanged =
          update.startState.field(syntaxField) !==
          update.state.field(syntaxField);
        if (
          update.docChanged ||
          update.selectionSet ||
          syntaxChanged ||
          update.startState.field(activeField) !==
            update.state.field(activeField) ||
          update.transactions.some(tr =>
            tr.effects.some(e => e.is(refreshWikilinks)),
          )
        ) {
          this.decorations = decorations(update.view, options);
        }
        if (update.docChanged || update.selectionSet || syntaxChanged) {
          this.undoing ||= update.transactions.some(
            tr => tr.isUserEvent('undo') || tr.isUserEvent('redo'),
          );
          this.schedule();
        }
      }

      /** Updates can't dispatch, so the follow-up runs right after. */
      schedule() {
        if (this.scheduled) return;
        this.scheduled = true;
        queueMicrotask(() => {
          this.scheduled = false;
          if (this.destroyed || this.view.composing) return;
          const spec = reconcile(this.view.state, options, this.undoing);
          this.undoing = false;
          if (spec) this.view.dispatch(spec);
        });
      }
    },
    { decorations: plugin => plugin.decorations },
  );

  const clicks = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
      const pos = view.posAtCoords(event);
      const target = pos === null ? undefined : targetAt(view.state, pos);
      if (target === undefined) return false;
      event.preventDefault();
      options.open(target);
      return true;
    },
  });

  return [
    optionsFacet.of(options),
    activeField,
    linkView(() => options),
    display,
    clicks,
  ];
}
