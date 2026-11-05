import type { EditorView } from '@codemirror/view';
import { CodeMirror, Vim } from '@replit/codemirror-vim';

interface VimActions {
  save?(): void;
  /** Closes what the editor is in; edits are saved first, so `:q` acts like `:wq`. */
  quit?(): void;
}

/**
 * Vim's ex commands are global to the page, so each editor registers what
 * `:w` and `:q` do for it; an editor without an action ignores the command.
 */
const actions = new WeakMap<EditorView, VimActions>();

export function setVimActions(view: EditorView, value: VimActions) {
  actions.set(view, value);
}

const run = (cm: CodeMirror, action: keyof VimActions) => {
  const handler = actions.get(cm.cm6)?.[action];
  // After the ex command finishes: quitting destroys the editor running it.
  if (handler) setTimeout(handler, 0);
};

CodeMirror.commands.save = (cm: CodeMirror) => run(cm, 'save');
Vim.defineEx('quit', 'q', (cm) => run(cm as unknown as CodeMirror, 'quit'));
Vim.defineEx('wq', 'wq', (cm) => run(cm as unknown as CodeMirror, 'quit'));
Vim.defineEx('xit', 'x', (cm) => run(cm as unknown as CodeMirror, 'quit'));
