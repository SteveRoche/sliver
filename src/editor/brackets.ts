import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { EditorState, type Extension, Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';

/**
 * Auto-closing pairs for Typst: brackets, strings, math (`$`) and raw
 * (`` ` ``). Not `'`, which is an apostrophe in prose.
 */
export const typstBrackets = (): Extension => [
  EditorState.languageData.of(() => [
    {
      closeBrackets: {
        brackets: ['(', '[', '{', '"', '$', '`'],
        // A pair is only closed before whitespace or one of these. The
        // default (`)]}:;>`) lacks the closers of `$...$` and raw, so `(`
        // typed inside a fresh `$$` stayed unclosed.
        before: ')]}:;>$`"',
      },
    },
  ]),
  closeBrackets(),
  // Above the default keymap so Backspace deletes an empty pair together.
  Prec.high(keymap.of(closeBracketsKeymap)),
];
