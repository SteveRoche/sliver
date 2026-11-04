import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { onCleanup, onMount } from "solid-js";

interface EditorProps {
  initialDoc: string;
  onChange: (text: string) => void;
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
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "var(--active-line)",
  },
  "&.cm-focused": { outline: "none" },
});

export function Editor(props: EditorProps) {
  let parent!: HTMLDivElement;

  onMount(() => {
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: props.initialDoc,
        extensions: [
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
        ],
      }),
    });
    view.focus();
    onCleanup(() => view.destroy());
  });

  return <div ref={parent} class="editor" />;
}
