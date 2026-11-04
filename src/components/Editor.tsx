import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import { createEffect, onCleanup, onMount } from "solid-js";

interface EditorProps {
  initialDoc: string;
  onChange: (text: string) => void;
  extensions?: Extension[];
  vim?: boolean;
  onView?: (view: EditorView | undefined) => void;
}

const theme = EditorView.theme({
  "&": { height: "100%", color: "inherit", backgroundColor: "transparent" },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: "1.5",
  },
  ".cm-content": { caretColor: "currentColor" },
  ".cm-cursor": { borderLeftColor: "currentColor" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted)",
    border: "none",
    userSelect: "none",
    WebkitUserSelect: "none",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "var(--active-line)",
  },
  // Bottom panels: the Vim command line (`:` and `/`) and its status.
  ".cm-panels": {
    backgroundColor: "var(--pane-bg)",
    color: "var(--fg)",
  },
  ".cm-panels.cm-panels-bottom": {
    borderTop: "1px solid var(--border)",
  },
  ".cm-vim-panel": {
    alignItems: "center",
    minHeight: "24px",
    padding: "0 8px",
    fontFamily: "var(--mono)",
    fontSize: "13px",
  },
  ".cm-vim-panel input": {
    flex: "1",
    padding: "0",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
  },
  ".cm-fat-cursor": {
    background: "var(--muted)",
    color: "var(--bg)",
  },
  "&.cm-focused": { outline: "none" },
});

export function Editor(props: EditorProps) {
  let parent!: HTMLDivElement;
  // Vim must come before the other keymaps to see keys first.
  const vimMode = new Compartment();

  onMount(() => {
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: props.initialDoc,
        extensions: [
          vimMode.of(props.vim ? vim() : []),
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) props.onChange(update.state.doc.toString());
          }),
          theme,
          props.extensions ?? [],
        ],
      }),
    });
    props.onView?.(view);

    createEffect(() => {
      view.dispatch({ effects: vimMode.reconfigure(props.vim ? vim() : []) });
    });

    onCleanup(() => {
      props.onView?.(undefined);
      view.destroy();
    });
  });

  return <div ref={parent} class="editor" />;
}
