import type { Extension } from '@codemirror/state';
import type {
  Completions,
  Hover,
  Position,
  Signature,
} from '../typst/protocol';
import { syntax } from './analysis';
import { typstBrackets } from './brackets';
import {
  type CitationCandidate,
  completion,
  type LinkCandidate,
} from './completion';
import { diagnostics } from './diagnostics';
import { typstHover } from './hover';
import { signatureHelp } from './signature';

export interface TypstEditingOptions {
  /** Typst completions for the editor's current text. */
  complete(
    text: string,
    position: Position,
    explicit: boolean,
  ): Promise<Completions | null>;
  signature(text: string, position: Position): Promise<Signature | null>;
  /** What hovering shows (`before`: the pointer is on the character before `position`). */
  tooltip(
    text: string,
    position: Position,
    before: boolean,
  ): Promise<Hover | null>;
  /** Notes `[[` can link to; none by default. */
  notes?: () => LinkCandidate[];
  /** Zotero items for `@` completion; none by default. */
  zotero?: (query: string) => Promise<CitationCandidate[]>;
  /** Warn about paths that don't start at the vault root (in notes). */
  lintPaths?: boolean;
}

/**
 * What every Typst editor has: highlighting, squiggles, completion,
 * signature help, hover tooltips and auto-closing pairs.
 */
export const typstEditing = (options: TypstEditingOptions): Extension => [
  syntax(options.lintPaths),
  diagnostics(),
  completion({
    notes: options.notes ?? (() => []),
    zotero: options.zotero,
    typst: options.complete,
  }),
  signatureHelp(options.signature),
  typstHover(options.tooltip),
  typstBrackets(),
];
