import { For, Index, onCleanup, onMount, Show } from "solid-js";
import type { Diagnostic } from "../typst/protocol";
import { LINK_SCHEME } from "./wikilinks";

interface PreviewProps {
  /** Pages of the last successful compile, kept while the source has errors. */
  pages: string[];
  diagnostics: Diagnostic[];
  loadingPackages?: string[];
  /** Called with the note id when a `sliver://` link is clicked. */
  onOpenNote?: (id: string) => void;
}

export function Preview(props: PreviewProps) {
  let container!: HTMLDivElement;

  // Delegated from the SVG anchors (keyboard activation also fires `click`).
  // Every anchor is intercepted: following one would navigate the webview
  // away from the app.
  const onClick = (event: MouseEvent) => {
    const anchor = (event.target as Element).closest("a");
    if (!anchor) return;
    event.preventDefault();
    const href =
      anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href") ?? "";
    if (href.startsWith(LINK_SCHEME)) {
      props.onOpenNote?.(href.slice(LINK_SCHEME.length));
    }
  };

  onMount(() => {
    container.addEventListener("click", onClick);
    onCleanup(() => container.removeEventListener("click", onClick));
  });

  return (
    <div class="preview" ref={container}>
      <Index each={props.pages}>
        {/* SVG comes from our own compiler, so innerHTML is safe here. */}
        {(svg) => <div class="page" innerHTML={svg()} />}
      </Index>
      <Show when={(props.loadingPackages ?? []).length > 0}>
        <div class="loading">
          Downloading {(props.loadingPackages ?? []).join(", ")}...
        </div>
      </Show>
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
