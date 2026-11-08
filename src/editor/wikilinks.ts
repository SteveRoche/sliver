import { invertedEffects, isolateHistory } from '@codemirror/commands';
import {
  EditorSelection,
  type EditorState,
  type Extension,
  Facet,
  StateEffect,
  StateField,
  Transaction,
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

export interface WikilinkOptions {
  /** The linked note's title, or null when the target doesn't resolve. */
  title(target: string): string | null;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Looks like a Zettelkasten address (or a sequence number). */
const ADDRESS = /^\d+(?:\.\d+(?:[a-z]+\d+)*[a-z]*)?$/i;

/**
 * The link the main cursor is in (brackets included, or just after them).
 * Its uuid target, if it has one, is replaced in the document by the note's
 * title (`shown`) for as long as the cursor stays, so the title can be
 * edited as text and the uuid never shows. Leaving puts the uuid back when
 * the title wasn't touched, and otherwise points the link at the note the
 * new text names (see `leave`). Saving goes through `savedText`, so the
 * file keeps the uuid meanwhile.
 */
interface ActiveLink {
  from: number;
  to: number;
  /** The target as it was on entering (a uuid when `expanded`). */
  original: string;
  /** What stands in the document for `original` while the link is active. */
  shown: string;
  expanded: boolean;
  /**
   * The uuid's note is gone, and `shown` is its former title: the link
   * keeps that title (an uninitialized link) instead of the dead uuid.
   */
  orphan: boolean;
}

const setActive = StateEffect.define<ActiveLink | null>({
  map(value, mapping) {
    if (!value) return value;
    const from = mapping.mapPos(value.from, 1);
    const to = mapping.mapPos(value.to, -1);
    return from < to ? { ...value, from, to } : null;
  },
});

/**
 * Undo and redo restore the link state along with the text of a step that
 * put a link in (a completion, a retarget), so undoing one forgets which
 * note its title stood for. Only steps that change the text: the rest
 * (entering, leaving) aren't undo steps.
 */
const linkHistory = invertedEffects.of(tr =>
  tr.docChanged && tr.effects.some(e => e.is(setActive))
    ? [setActive.of(tr.startState.field(activeField))]
    : [],
);

/** Drops the active link's state, e.g. when the file replaced the text. */
export const forgetActiveLink = setActive.of(null);

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

/** What a uuid target is shown as: the title as plain link text. */
function label(title: string): string {
  return (
    title
      .replace(/[[\]|\n]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Untitled'
  );
}

/** The active link's target as the file should have it. */
function activeTarget(state: EditorState, active: ActiveLink) {
  const link = parseLink(state, active.from, active.to);
  if (!link) return null;
  const target =
    active.expanded && !active.orphan && link.target === active.shown
      ? active.original
      : link.target;
  return { ...link, target };
}

/** The document as the file should have it: with the active link's uuid back if its title is untouched. */
export function savedText(state: EditorState): string {
  const text = state.doc.toString();
  const active = state.field(activeField, false);
  if (!active?.expanded) return text;
  const link = activeTarget(state, active);
  if (!link || link.target !== active.original) return text;
  return text.slice(0, link.from) + link.target + text.slice(link.to);
}

/** The target of the link at `pos`, as it should be followed. */
function targetAt(state: EditorState, pos: number): string | undefined {
  const active = state.field(activeField);
  if (active && active.from <= pos && pos <= active.to) {
    return activeTarget(state, active)?.target || undefined;
  }
  return linksAt(state).find(l => l.from <= pos && pos <= l.to)?.target;
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

/** Replaces the uuid `target` by its note's title and makes `link` active. */
/** What stands in the document for uuid `target` while its link is active. */
function shownFor(options: WikilinkOptions, target: string) {
  const title = options.title(target);
  const former = title === null ? options.formerTitle(target) : null;
  return {
    shown: label(title ?? former ?? 'Missing note'),
    orphan: former !== null,
  };
}

/**
 * Text and link state for putting `target` (an address or uuid) into a link
 * the cursor will be in: a uuid goes in as its note's title, standing for
 * the uuid (see `ActiveLink`). Dispatch the text and `active(from, to)`, the
 * link's bounds afterwards, in one undoable step, which `linkHistory`
 * makes undo forget the link along with the text.
 */
export function linkTarget(state: EditorState, target: string) {
  const options = state.facet(optionsFacet);
  const uuid = UUID.test(target) && options !== null;
  const { shown, orphan } = uuid
    ? shownFor(options, target)
    : { shown: target, orphan: false };
  return {
    text: shown,
    active: (from: number, to: number) =>
      setActive.of({
        from,
        to,
        original: target,
        shown,
        expanded: uuid,
        orphan,
      }),
  };
}

/**
 * Points `links` at `target` in one undoable step; the one the cursor is
 * in gets its editing form (`linkTarget`).
 */
export function retargetLinks(
  state: EditorState,
  links: { from: number; to: number; targetFrom: number; targetTo: number }[],
  target: string,
): TransactionSpec {
  const head = state.selection.main.head;
  const here = links.find(l => l.from <= head && head <= l.to);
  const form = linkTarget(state, target);
  const changes = state.changes(
    links.map(l => ({
      from: l.targetFrom,
      to: l.targetTo,
      insert: l === here ? form.text : target,
    })),
  );
  return {
    changes,
    effects: here
      ? form.active(changes.mapPos(here.from, -1), changes.mapPos(here.to, 1))
      : [],
  };
}

function expand(
  state: EditorState,
  options: WikilinkOptions,
  link: { from: number; to: number },
  target: { target: string; from: number; to: number },
): TransactionSpec {
  const { shown, orphan } = shownFor(options, target.target);
  const delta = shown.length - (target.to - target.from);
  // A position inside the uuid keeps its distance to the nearer end.
  const map = (pos: number) => {
    if (pos <= target.from) return pos;
    if (pos >= target.to) return pos + delta;
    return pos - target.from <= target.to - pos
      ? target.from + Math.min(pos - target.from, shown.length)
      : target.from + shown.length - Math.min(target.to - pos, shown.length);
  };
  return {
    changes: { from: target.from, to: target.to, insert: shown },
    selection: EditorSelection.create(
      state.selection.ranges.map(r =>
        EditorSelection.range(map(r.anchor), map(r.head)),
      ),
      state.selection.mainIndex,
    ),
    effects: setActive.of({
      from: link.from,
      to: link.to + delta,
      original: target.target,
      shown,
      expanded: true,
      orphan,
    }),
    annotations: Transaction.addToHistory.of(false),
  };
}

/**
 * The cursor left the active link. An untouched title becomes its uuid
 * again (unless the uuid's note is gone: then the title stays, an
 * uninitialized link), and other untouched links stay as they are, even a
 * title that some note has now (a deleted note's link stays uninitialized
 * until followed). Edited text is resolved: the title of a note links to
 * it (its address, or uuid), an address or uuid stays, and anything else
 * stays as an uninitialized link (Mod-click creates the note). After undo
 * or redo nothing is resolved, so the redo history survives.
 */
function leave(
  state: EditorState,
  options: WikilinkOptions,
  active: ActiveLink,
  undoing: boolean,
): TransactionSpec {
  const done = setActive.of(null);
  const link = parseLink(state, active.from, active.to);
  if (!link?.target) return { effects: done };
  // Untouched: an orphan keeps its former title, anything else is as it was.
  if (link.target === active.shown && (active.orphan || !active.expanded)) {
    return { effects: done };
  }
  if (active.expanded && link.target === active.shown) {
    return {
      changes: { from: link.from, to: link.to, insert: active.original },
      effects: done,
      // The exact inverse of the expansion, which wasn't recorded either.
      annotations: Transaction.addToHistory.of(false),
    };
  }
  if (undoing || UUID.test(link.target) || ADDRESS.test(link.target)) {
    return { effects: done };
  }
  const resolved = options.resolveTitle(link.target);
  if (resolved === null || resolved === link.target) return { effects: done };
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
    // A uuid that arrived meanwhile (a completion, a retarget, a paste).
    const link = parseLink(state, active.from, active.to);
    if (link && UUID.test(link.target)) {
      return expand(state, options, active, link);
    }
    return null;
  }
  const link = linksAt(state).find(l => l.from <= head && head <= l.to);
  // The analysis lags edits: only trust a link whose text is still there.
  if (!link || state.sliceDoc(link.targetFrom, link.targetTo) !== link.target) {
    return null;
  }
  if (UUID.test(link.target)) {
    return expand(state, options, link, {
      target: link.target,
      from: link.targetFrom,
      to: link.targetTo,
    });
  }
  return {
    effects: setActive.of({
      from: link.from,
      to: link.to,
      original: link.target,
      shown: link.target,
      expanded: false,
      orphan: false,
    }),
  };
}

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
    span.title = this.broken
      ? `No note "${this.target}". ${isMac ? 'Cmd' : 'Ctrl'}-click to create it.`
      : this.target;
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

const sourceMark = Decoration.mark({ class: 'cm-wikilink-source' });

/**
 * Shows each wikilink as its target's title (or its custom text) until the
 * cursor enters it, when the source comes back for editing. A uuid link
 * shows its source only once it's active (and the uuid replaced).
 */
function decorations(
  view: EditorView,
  options: WikilinkOptions,
): DecorationSet {
  const { state } = view;
  const active = state.field(activeField);
  const ranges = linksAt(state).flatMap((link: LinkRange) => {
    if (link.from >= link.to) return [];
    if (active && link.from < active.to && link.to > active.from) return [];
    const uuid = UUID.test(link.target);
    const editing =
      !uuid &&
      state.selection.ranges.some(r => r.from <= link.to && r.to >= link.from);
    if (editing) return [sourceMark.range(link.from, link.to)];
    const title = options.title(link.target);
    // A uuid never shows, even when its note is gone.
    const shown =
      title ??
      (uuid ? (options.formerTitle(link.target) ?? 'Missing note') : null);
    const widget = new LinkWidget(
      link.text ?? shown ?? link.target,
      shown ?? link.target,
      title === null,
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

  return [optionsFacet.of(options), activeField, linkHistory, display, clicks];
}
