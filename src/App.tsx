import { createSignal } from "solid-js";
import "./App.css";
import { Editor } from "./components/Editor";
import { Preview } from "./components/Preview";
import { livePreview, TypstClient } from "./typst/client";
import type { Diagnostic } from "./typst/protocol";

const MAIN = "/main.typ";

const SAMPLE = `= Sliver

Type on the left; the preview updates as you go.

$ sum_(i=1)^n i = (n(n+1)) / 2 $

- Typst *markup*
- _Live_ preview
`;

function App() {
  const [pages, setPages] = createSignal<string[]>([]);
  const [diagnostics, setDiagnostics] = createSignal<Diagnostic[]>([]);

  const update = livePreview(
    new TypstClient(),
    MAIN,
    (result) => {
      if (result.pages.length > 0) setPages(result.pages);
      setDiagnostics(result.diagnostics);
    },
    (error) =>
      setDiagnostics([
        { severity: "error", message: error.message, hints: [] },
      ]),
  );
  update(SAMPLE);

  return (
    <main class="split">
      <Editor initialDoc={SAMPLE} onChange={update} />
      <Preview pages={pages()} diagnostics={diagnostics()} />
    </main>
  );
}

export default App;
