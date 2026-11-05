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

export interface CompletionOptions {
  /** Notes `[[` can link to. */
  notes(): LinkCandidate[];
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

type Kind = CompletionItem['kind'] | 'wikilink';

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

/** Autocomplete for wikilink targets after `[[` and for Typst itself. */
export function completion(options: CompletionOptions): Extension {
  return autocompletion({
    override: [wikilinkSource(options), typstSource(options)],
    icons: false,
    addToOptions: [iconColumn],
  });
}
