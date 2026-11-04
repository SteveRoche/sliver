import { For, Index, Show } from "solid-js";
import type { Diagnostic } from "../typst/protocol";

interface PreviewProps {
  /** Pages of the last successful compile, kept while the source has errors. */
  pages: string[];
  diagnostics: Diagnostic[];
}

export function Preview(props: PreviewProps) {
  return (
    <div class="preview">
      <Index each={props.pages}>
        {/* SVG comes from our own compiler, so innerHTML is safe here. */}
        {(svg) => <div class="page" innerHTML={svg()} />}
      </Index>
      <Show when={props.diagnostics.length > 0}>
        <ul class="diagnostics">
          <For each={props.diagnostics}>
            {(d) => (
              <li class={d.severity}>
                <Show when={d.range}>
                  {(range) => (
                    <span class="location">
                      {range().start.line + 1}:{range().start.column + 1}
                    </span>
                  )}
                </Show>
                {d.message}
                <For each={d.hints}>
                  {(hint) => <div class="hint">hint: {hint}</div>}
                </For>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
