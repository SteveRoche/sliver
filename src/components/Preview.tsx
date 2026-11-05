import {
  createEffect,
  createSignal,
  For,
  Index,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { settings } from "../state/settings";
import { isPreviewDark } from "../state/theme";
import { setPreviewWidth } from "../state/workspace";
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

/** The narrowest the preview pane gets before it collapses instead. */
export const MIN_PREVIEW_PX = 340;

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

    // Pages are compiled as wide as the pane allows. Until a compile for a
    // new width lands, CSS stretches the old SVG to fit (`.page svg`).
    const [available, setAvailable] = createSignal(container.clientWidth);
    const observer = new ResizeObserver(() =>
      setAvailable(container.clientWidth),
    );
    observer.observe(container);
    onCleanup(() => observer.disconnect());
    createEffect(() => {
      // A collapsed (or collapsing) pane keeps its last compile.
      if (available() < MIN_PREVIEW_PX) return;
      setPreviewWidth(Math.min(available(), settings.maxPreviewWidth));
    });
  });

  return (
    <div
      class="preview"
      ref={container}
      data-preview-theme={isPreviewDark() ? "dark" : "light"}
      style={{ "--max-page-width": `${settings.maxPreviewWidth}px` }}
    >
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
