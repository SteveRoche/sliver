import { closeCompletion, completionStatus } from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  tooltips,
} from '@codemirror/view';
import { getCM, Vim, vim } from '@replit/codemirror-vim';
import { createEffect, onCleanup, onMount } from 'solid-js';
import { overlayScrollbar } from './scrollbars';

interface EditorProps {
  initialDoc: string;
  onChange: (text: string) => void;
  extensions?: Extension;
  vim?: boolean;
  lineNumbers?: boolean;
  onView?: (view: EditorView | undefined) => void;
}

let tooltipLayer: HTMLElement | undefined;

/**
 * Where editor tooltips go: outside the panes, so they aren't clipped. Each
 * editor puts a container carrying its theme classes in here, and the theme
 * makes those `height: 100%`; directly in the body they would stack below
 * the app and let the window scroll, so the layer has no height.
 */
function tooltipHost() {
  if (!tooltipLayer) {
    tooltipLayer = document.createElement('div');
    tooltipLayer.className = 'tooltip-layer';
    document.body.appendChild(tooltipLayer);
  }
  return tooltipLayer;
}

const theme = EditorView.theme({
  '&': { height: '100%', color: 'inherit', backgroundColor: 'transparent' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.5',
  },
  '.cm-content': { caretColor: 'currentColor' },
  '.cm-cursor': { borderLeftColor: 'currentColor' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--muted)',
    border: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  // CodeMirror's default focused selection is lilac; this one follows the theme.
  '.cm-selectionBackground, .cm-content ::selection': {
    background: 'var(--selection-inactive) !important',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, &.cm-focused .cm-content ::selection':
    {
      background: 'var(--selection) !important',
    },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'var(--active-line)',
  },
  // Bottom panels: the Vim command line (`:` and `/`) and its status.
  '.cm-panels': {
    backgroundColor: 'var(--pane-bg)',
    color: 'var(--fg)',
  },
  '.cm-panels.cm-panels-bottom': {
    borderTop: '1px solid var(--border)',
  },
  '.cm-vim-panel': {
    alignItems: 'center',
    minHeight: '24px',
    padding: '0 8px',
    fontFamily: 'var(--mono)',
    fontSize: '13px',
  },
  '.cm-vim-panel input': {
    flex: '1',
    padding: '0',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
  },
  '.cm-fat-cursor': {
    background: 'var(--muted)',
    color: 'var(--bg)',
  },
  // Set here, not in App.css: CodeMirror's own theme is injected later and would win.
  '.cm-tooltip': {
    border: '1px solid var(--border)',
    backgroundColor: 'var(--surface)',
    color: 'var(--fg)',
    boxShadow: '0 4px 16px rgb(0 0 0 / 0.25)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--mono)',
    fontSize: '13px',
    maxHeight: '16em',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li, .cm-new-note-footer': {
    padding: '2px 8px',
    lineHeight: '18px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected], .cm-new-note-footer[aria-selected]':
    {
      backgroundColor: 'var(--selected)',
      color: 'var(--fg)',
    },
  // Five rows of 22px.
  '.cm-tooltip.cm-link-menu > ul': { maxHeight: '110px' },
  // Shown by the footer instead. Positioned against the tooltip, at the
  // list's top, so selecting it never scrolls the list.
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li.cm-new-note-option': {
    position: 'absolute',
    top: '0',
    height: '0',
    padding: '0',
    visibility: 'hidden',
  },
  '.cm-new-note-footer': {
    listStyle: 'none',
    borderTop: '1px solid var(--border)',
    fontFamily: 'var(--mono)',
    fontSize: '13px',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal' },
  '.cm-completionMatchedText': {
    textDecoration: 'none',
    color: 'var(--accent)',
  },
  '.cm-typst-hover': {
    maxWidth: 'min(640px, 90vw)',
    padding: '6px 10px',
    fontSize: '13px',
    lineHeight: '1.4',
    whiteSpace: 'pre-wrap',
  },
  '.cm-signature': {
    maxWidth: 'min(640px, 90vw)',
    padding: '6px 10px',
    fontSize: '13px',
    lineHeight: '1.4',
  },
  '.cm-signature-head': { fontFamily: 'var(--mono)', color: 'var(--muted)' },
  '.cm-signature-param.active': { color: 'var(--fg)', fontWeight: '700' },
  '.cm-signature-default': {
    fontFamily: 'var(--mono)',
    color: 'var(--muted)',
    marginTop: '4px',
  },
  '.cm-signature-docs': { marginTop: '4px' },
  '.cm-signature-docs code': { fontFamily: 'var(--mono)', fontSize: '12px' },
  '.cm-completion-kind': {
    display: 'inline-flex',
    verticalAlign: '-2px',
    marginRight: '6px',
    color: 'var(--muted)',
  },
  '&.cm-focused': { outline: 'none' },
});

/**
 * Gives an Escape pressed in an editor to that editor, if it has a use for
 * it: closing Vim's command line or the completion menu, else Vim's own
 * Escape (leaving insert or visual mode, dropping a pending command).
 * Returns whether it did.
 *
 * Dialogs holding an editor call this before Ark sees the key: Ark's dialog
 * handles Escape on the document in the capture phase and prevents its
 * default even with `closeOnEscape` off, which keeps it from reaching
 * CodeMirror.
 */
export function handleEditorEscape(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const dom = target.closest<HTMLElement>('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) return false;
  if (target.closest('.cm-panels')) {
    // Vim's command line closes when it loses focus.
    view.focus();
    return true;
  }
  if (completionStatus(view.state) !== null) return closeCompletion(view);
  const cm = getCM(view);
  if (!cm?.state.vim) return false;
  Vim.handleKey(cm, '<Esc>', 'user');
  return true;
}

export function Editor(props: EditorProps) {
  let parent!: HTMLDivElement;
  // Vim must come before the other keymaps to see keys first.
  const vimMode = new Compartment();
  const gutter = new Compartment();
  const gutterFor = (on: boolean | undefined) =>
    on ? [lineNumbers(), highlightActiveLineGutter()] : [];

  onMount(() => {
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: props.initialDoc,
        extensions: [
          tooltips({ parent: tooltipHost() }),
          vimMode.of(props.vim ? vim() : []),
          gutter.of(gutterFor(props.lineNumbers)),
          highlightActiveLine(),
          drawSelection(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.lineWrapping,
          EditorView.updateListener.of(update => {
            if (update.docChanged) props.onChange(update.state.doc.toString());
          }),
          theme,
          props.extensions ?? [],
        ],
      }),
    });
    props.onView?.(view);
    const detachScrollbar = overlayScrollbar(view.scrollDOM);

    createEffect(() => {
      view.dispatch({ effects: vimMode.reconfigure(props.vim ? vim() : []) });
    });
    createEffect(() => {
      view.dispatch({
        effects: gutter.reconfigure(gutterFor(props.lineNumbers)),
      });
    });

    onCleanup(() => {
      detachScrollbar();
      props.onView?.(undefined);
      view.destroy();
    });
  });

  return <div ref={parent} class="editor" />;
}
