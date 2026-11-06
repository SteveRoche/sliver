import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  snippet,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import ALargeSmall from 'lucide-solid/icons/a-large-small';
import Code from 'lucide-solid/icons/code';
import File from 'lucide-solid/icons/file';
import Link from 'lucide-solid/icons/link';
import Omega from 'lucide-solid/icons/omega';
import Package from 'lucide-solid/icons/package';
import Pi from 'lucide-solid/icons/pi';
import Quote from 'lucide-solid/icons/quote';
import SquareFunction from 'lucide-solid/icons/square-function';
import Tag from 'lucide-solid/icons/tag';
import TypeIcon from 'lucide-solid/icons/type';
import Variable from 'lucide-solid/icons/variable';
import { type Component, createRoot } from 'solid-js';
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

function wikilinkSource(options: CompletionOptions) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const open = ctx.matchBefore(OPEN_LINK);
    if (!open || inRaw(ctx.state, open.from)) return null;
    const closed = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2) === ']]';
    return {
      from: open.from + 2,
      options: options.notes().map(note => ({
        label: note.label,
        type: 'wikilink',
        apply: closed ? note.target : `${note.target}]]`,
      })),
      validFor: /^[^[\]|\n]*$/,
    };
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

type Kind = CompletionItem['kind'] | 'wikilink' | 'citation';

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

/**
 * Autocomplete for wikilink targets after `[[`, for Typst itself, and for
 * citation keys from the Zotero library after `@`.
 */
export function completion(options: CompletionOptions): Extension {
  return autocompletion({
    override: [
      wikilinkSource(options),
      typstSource(options),
      zoteroSource(options),
    ],
    icons: false,
    addToOptions: [iconColumn],
  });
}
