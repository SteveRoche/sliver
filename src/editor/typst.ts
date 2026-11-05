import type { Extension } from '@codemirror/state';
import type { Completions, Position, Signature } from '../typst/protocol';
import { syntax } from './analysis';
import { typstBrackets } from './brackets';
import { completion, type LinkCandidate } from './completion';
import { diagnostics } from './diagnostics';
import { signatureHelp } from './signature';

export interface TypstEditingOptions {
  /** Typst completions for the editor's current text. */
  complete(
    text: string,
    position: Position,
    explicit: boolean,
  ): Promise<Completions | null>;
  signature(text: string, position: Position): Promise<Signature | null>;
  /** Notes `[[` can link to; none by default. */
  notes?: () => LinkCandidate[];
}

/**
 * What every Typst editor has: highlighting, squiggles, completion,
 * signature help and auto-closing pairs.
 */
export const typstEditing = (options: TypstEditingOptions): Extension => [
  syntax(),
  diagnostics(),
  completion({ notes: options.notes ?? (() => []), typst: options.complete }),
  signatureHelp(options.signature),
  typstBrackets(),
];
