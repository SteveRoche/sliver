import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  completionStatus,
  currentCompletions,
  pickedCompletion,
  selectedCompletionIndex,
  snippet,
} from '@codemirror/autocomplete';
import {
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
} from '@codemirror/state';
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import ALargeSmall from 'lucide-solid/icons/a-large-small';
import Code from 'lucide-solid/icons/code';
import File from 'lucide-solid/icons/file';
import Link from 'lucide-solid/icons/link';
import Omega from 'lucide-solid/icons/omega';
import Package from 'lucide-solid/icons/package';
import Pi from 'lucide-solid/icons/pi';
import Plus from 'lucide-solid/icons/plus';
import Quote from 'lucide-solid/icons/quote';
import SquareFunction from 'lucide-solid/icons/square-function';
import Tag from 'lucide-solid/icons/tag';
import TypeIcon from 'lucide-solid/icons/type';
import Variable from 'lucide-solid/icons/variable';
import { type Component, createRoot } from 'solid-js';
import { overlayScrollbar } from '../components/scrollbars';
import type { CompletionItem, Completions, Position } from '../typst/protocol';
import { inRaw } from './analysis';

export interface LinkCandidate {
  label: string;
  /** What goes between the brackets: an address, or a uuid. */
  target: string;
}

export interface CitationCandidate {
  key: string;
  title: string;
  byline: string;
}

export interface CompletionOptions {
  /** Notes `[[` can link to. */
  notes(): LinkCandidate[];
  /**
   * Creates a note for a link being typed (`query` is the text after `[[`),
   * resolving to its link target, or null when cancelled.
   */
  newNote?(query: string): Promise<string | null>;
  /**
   * Zotero items matching what follows an `@`, for citing what
   * `references.bib` doesn't have yet; none while Zotero isn't running.
   */
  zotero?(query: string): Promise<CitationCandidate[]>;
  /** Typst completions from the compiler (`typst-ide`). */
  typst(
    text: string,
    position: Position,
    explicit: boolean,
  ): Promise<Completions | null>;
}

/** An unfinished `[[target` before the cursor. */
const OPEN_LINK = /\[\[[^[\]|\n]*/;

interface Pending {
  id: number;
  from: number;
  to: number;
}

const addPending = StateEffect.define<Pending>();
const removePending = StateEffect.define<number>();
let pendingIds = 0;

/** Unfinished links whose note is being created, kept in step with edits. */
const pendingLinks = StateField.define<Pending[]>({
  create: () => [],
  update(value, tr) {
    let next = tr.docChanged
      ? value.map(p => ({
          id: p.id,
          from: tr.changes.mapPos(p.from, 1),
          to: tr.changes.mapPos(p.to, -1),
        }))
      : value;
    for (const effect of tr.effects) {
      if (effect.is(addPending)) next = [...next, effect.value];
      if (effect.is(removePending)) {
        next = next.filter(p => p.id !== effect.value);
      }
    }
    return next;
  },
});

/**
 * Replaces the unfinished link `[[query` (and a `]]` after it) at
 * `from`..`to` with a link to a new note, once `create` has made it.
 */
async function linkToNewNote(
  view: EditorView,
  create: (query: string) => Promise<string | null>,
  completion: Completion,
  from: number,
  to: number,
) {
  const query = view.state.sliceDoc(from, to);
  const end = view.state.sliceDoc(to, to + 2) === ']]' ? to + 2 : to;
  const id = ++pendingIds;
  view.dispatch({
    effects: addPending.of({ id, from: from - 2, to: end }),
    annotations: pickedCompletion.of(completion),
  });
  const target = await create(query).catch(() => null);
  const pending = view.state.field(pendingLinks).find(p => p.id === id);
  view.dispatch({ effects: removePending.of(id) });
  // Unless the link's text was deleted meanwhile.
  if (target === null || !pending || pending.to - pending.from < 2) return;
  const insert = `[[${target}]]`;
  view.dispatch({
    changes: { from: pending.from, to: pending.to, insert },
    selection: { anchor: pending.from + insert.length },
  });
}

const NEW_NOTE_LABEL = 'New note';

function wikilinkSource(options: CompletionOptions) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const open = ctx.matchBefore(OPEN_LINK);
    if (!open || inRaw(ctx.state, open.from)) return null;
    const closed = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2) === ']]';
    const notes: Completion[] = options.notes().map(note => ({
      label: note.label,
      type: 'wikilink',
      apply: closed ? note.target : `${note.target}]]`,
    }));
    const create = options.newNote;
    if (create) {
      notes.push({
        // Labelled with the query itself so the filter always keeps it.
        label: open.text.slice(2),
        displayLabel: 'New note',
        type: 'newNote',
        // Below every match.
        boost: -1e6,
        apply: (view, completion, from, to) =>
          void linkToNewNote(view, create, completion, from, to),
      });
    }
    // No `validFor`: the create option's label must follow the query.
    return { from: open.from + 2, options: notes };
  };
}

/** An unfinished `@key` before the cursor (not after a word: `a@b` is text). */
const OPEN_CITATION = /(?:^|[^\p{L}\p{N}_])@[\p{L}\p{N}_\-.:]*/u;

/** Shorter queries would match most of a library. */
const MIN_QUERY = 2;

function zoteroSource(options: CompletionOptions) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const match = ctx.matchBefore(OPEN_CITATION);
    if (!match || !options.zotero) return null;
    const at = match.from + match.text.indexOf('@');
    const query = ctx.state.sliceDoc(at + 1, ctx.pos);
    if (inRaw(ctx.state, at) || (query.length < MIN_QUERY && !ctx.explicit)) {
      return null;
    }
    const found = await options.zotero(query);
    if (ctx.aborted || found.length === 0) return null;
    return {
      from: at + 1,
      options: found.map(item => ({
        label: item.key,
        detail: item.byline,
        info: item.title,
        type: 'citation',
      })),
      // Zotero matched titles and authors too, which the key doesn't show.
      filter: false,
    };
  };
}

type Kind = CompletionItem['kind'] | 'wikilink' | 'newNote' | 'citation';

const ICONS: Record<Kind, Component<{ size?: number }>> = {
  syntax: Code,
  func: SquareFunction,
  type: TypeIcon,
  param: Variable,
  constant: Pi,
  path: File,
  package: Package,
  label: Tag,
  font: ALargeSmall,
  symbol: Omega,
  wikilink: Link,
  newNote: Plus,
  citation: Quote,
};

/** One rendered SVG per kind, cloned for each row of the menu. */
const iconTemplates = new Map<string, Element>();

/**
 * Lucide icons in the menu instead of CodeMirror's default glyphs (which are
 * text characters and emoji). Each option's `type` is its kind.
 */
const iconColumn = {
  render(completion: Completion): Node | null {
    const kind = completion.type as Kind | undefined;
    if (!kind || !(kind in ICONS)) return null;
    let template = iconTemplates.get(kind);
    if (!template) {
      template = createRoot(dispose => {
        const node = ICONS[kind]({ size: 14 }) as Element;
        dispose();
        return node;
      });
      iconTemplates.set(kind, template);
    }
    const icon = document.createElement('span');
    icon.className = 'cm-completion-kind';
    icon.appendChild(template.cloneNode(true));
    return icon;
  },
  position: 20,
};

/**
 * Typst snippets mark fields as `${name}`, which CodeMirror shares, but a
 * literal `#{` (a code block) means a field to CodeMirror unless escaped.
 */
const toSnippet = (apply: string) =>
  apply.includes('${') ? snippet(apply.replace(/#\{/g, '#\\{')) : apply;

function typstSource(options: CompletionOptions) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (ctx.matchBefore(OPEN_LINK)) return null;
    const line = ctx.state.doc.lineAt(ctx.pos);
    const found = await options.typst(
      ctx.state.doc.toString(),
      { line: line.number - 1, column: ctx.pos - line.from },
      ctx.explicit,
    );
    if (!found || ctx.aborted || found.items.length === 0) return null;
    const doc = ctx.state.doc;
    if (found.from.line >= doc.lines) return null;
    const from = doc.line(found.from.line + 1).from + found.from.column;
    return {
      from,
      options: found.items.map(
        (item): Completion => ({
          label: item.label,
          detail: item.detail,
          type: item.kind,
          apply: toSnippet(item.apply),
        }),
      ),
      // Narrow the list locally while an identifier is typed, instead of asking again.
      validFor: /^[\w-]*$/,
    };
  };
}

const isNewNote = (completion: Completion | undefined) =>
  completion?.type === 'newNote';

/** The `[[` menu: its last option is the one to create a note. */
const linkMenu = (state: EditorState) => {
  const options = currentCompletions(state);
  return isNewNote(options[options.length - 1]);
};

function newNoteFooter(): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'cm-new-note-footer';
  li.setAttribute('role', 'option');
  const icon = iconColumn.render({ label: '', type: 'newNote' });
  if (icon) li.appendChild(icon);
  const label = li.appendChild(document.createElement('span'));
  label.className = 'cm-completionLabel';
  label.textContent = NEW_NOTE_LABEL;
  return li;
}

/**
 * Gives the open menu's list an overlay scrollbar, and pins the `[[` menu's
 * create option below it, outside the scrolling list: CodeMirror renders
 * only a window of the options, so its own row for that option (hidden) is
 * often not in the DOM. The footer takes that option's id, which is how
 * CodeMirror's own mousedown handler finds what was clicked.
 */
const menuChrome = ViewPlugin.fromClass(
  class {
    list: HTMLElement | null = null;
    detachScrollbar = () => {};
    footer: HTMLLIElement | null = null;

    constructor(readonly view: EditorView) {}

    update(update: ViewUpdate) {
      if (
        completionStatus(update.state) === null &&
        completionStatus(update.startState) === null
      ) {
        return;
      }
      // After the tooltip has replaced its list for this update.
      this.view.requestMeasure({
        key: this,
        read: () => null,
        write: () => this.sync(),
      });
    }

    sync() {
      const id = this.view.contentDOM.getAttribute('aria-controls');
      const list = id ? document.getElementById(id) : null;
      if (list !== this.list) {
        this.detachScrollbar();
        this.detachScrollbar = list ? overlayScrollbar(list) : () => {};
        this.list = list;
      }
      const state = this.view.state;
      const index = currentCompletions(state).length - 1;
      if (!list || !linkMenu(state)) {
        this.footer?.remove();
        return;
      }
      // Without an id CodeMirror skips the hidden row, so never scrolls to it.
      list.querySelector('.cm-new-note-option')?.removeAttribute('id');
      this.footer ??= newNoteFooter();
      this.footer.id = `${id}-${index}`;
      this.footer.toggleAttribute(
        'aria-selected',
        selectedCompletionIndex(state) === index,
      );
      if (list.nextElementSibling !== this.footer) list.after(this.footer);
    }

    destroy() {
      this.detachScrollbar();
      this.footer?.remove();
    }
  },
);

/**
 * Autocomplete for wikilink targets after `[[`, for Typst itself, and for
 * citation keys from the Zotero library after `@`.
 */
export function completion(options: CompletionOptions): Extension {
  return [
    pendingLinks,
    menuChrome,
    autocompletion({
      override: [
        wikilinkSource(options),
        typstSource(options),
        zoteroSource(options),
      ],
      icons: false,
      addToOptions: [iconColumn],
      tooltipClass: state => (linkMenu(state) ? 'cm-link-menu' : ''),
      optionClass: completion =>
        isNewNote(completion) ? 'cm-new-note-option' : '',
    }),
  ];
}
