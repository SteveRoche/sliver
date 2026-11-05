import {
  createEffect,
  createSignal,
  For,
  Index,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import { settings } from '../state/settings';
import { isPreviewDark } from '../state/theme';
import { setPreviewWidth } from '../state/workspace';
import type { Diagnostic, PagePoint } from '../typst/protocol';
import { withOverlayScrollbar } from './scrollbars';
import { LINK_SCHEME } from './wikilinks';

interface PreviewProps {
  /** The note shown; its page is compiled as wide as this preview. */
  note: string;
  /** Pages of the last successful compile, kept while the source has errors. */
  pages: string[];
  diagnostics: Diagnostic[];
  loadingPackages?: string[];
  /** Called with the note id when a `sliver://` link is clicked. */
  onOpenNote?: (id: string) => void;
  /** Called for a click anywhere else on a page, in points from its top left. */
  onJump?: (page: number, x: number, y: number) => void;
  /** A spot to bring into view and mark, e.g. where the editor's cursor is. */
  focus?: { points: PagePoint[]; seq: number };
}

/** A click on a page in points from its top left, read off the SVG's viewBox. */
function pagePoint(page: HTMLElement, event: MouseEvent) {
  const svg = page.querySelector('svg');
  if (!svg) return null;
  const box = svg.getBoundingClientRect();
  const scale = svg.viewBox.baseVal.width / box.width;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return {
    x: (event.clientX - box.left) * scale,
    y: (event.clientY - box.top) * scale,
  };
}

const PREAMBLES = '/.sliver/preambles/';

/** "the common preamble" or "preamble <kind>" for a preamble's path. */
function preambleName(path: string | undefined): string | null {
  if (!path?.startsWith(PREAMBLES)) return null;
  const rest = path.slice(PREAMBLES.length);
  if (rest === 'common.typ') return 'the common preamble';
  const kind = /^kinds\/(.+)\.typ$/.exec(rest)?.[1];
  return kind ? `preamble ${kind}` : null;
}

/** The smallest maximum page width the settings allow. */
export const MIN_PREVIEW_PX = 340;

export function Preview(props: PreviewProps) {
  let container!: HTMLDivElement;

  // Delegated from the SVG anchors (keyboard activation also fires `click`).
  // Every anchor is intercepted: following one would navigate the webview
  // away from the app.
  const onClick = (event: MouseEvent) => {
    const anchor = (event.target as Element).closest('a');
    if (!anchor) {
      const page = (event.target as Element).closest<HTMLElement>('.page');
      const point = page && pagePoint(page, event);
      if (page && point) {
        const index = [...container.querySelectorAll('.page')].indexOf(page);
        props.onJump?.(index, point.x, point.y);
      }
      return;
    }
    event.preventDefault();
    const href =
      anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href') ?? '';
    if (href.startsWith(LINK_SCHEME)) {
      props.onOpenNote?.(href.slice(LINK_SCHEME.length));
    }
  };

  /** Scrolls `point` into view if it isn't, and marks it briefly. */
  const showPoint = (point: PagePoint | undefined) => {
    const page =
      point && container.querySelectorAll<HTMLElement>('.page')[point.page];
    const svg = page?.querySelector('svg');
    if (!point || !page || !svg) return;
    const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    const x = point.x * scale;
    const y = point.y * scale;
    const top = page.offsetTop + y;
    const visible =
      top > container.scrollTop + 24 &&
      top < container.scrollTop + container.clientHeight - 24;
    if (!visible) {
      container.scrollTo({
        top: top - container.clientHeight / 3,
        behavior: 'smooth',
      });
    }
    page.querySelector('.preview-marker')?.remove();
    const marker = document.createElement('div');
    marker.className = 'preview-marker';
    marker.style.left = `${x}px`;
    marker.style.top = `${y}px`;
    marker.addEventListener('animationend', () => marker.remove());
    page.appendChild(marker);
  };

  onMount(() => {
    container.addEventListener('click', onClick);
    onCleanup(() => container.removeEventListener('click', onClick));

    // Pages are compiled as wide as the pane allows. Until a compile for a
    // new width lands, CSS stretches the old SVG to fit (`.page svg`).
    const [available, setAvailable] = createSignal(container.clientWidth);
    const observer = new ResizeObserver(() =>
      setAvailable(container.clientWidth),
    );
    observer.observe(container);
    onCleanup(() => observer.disconnect());

    createEffect(() => {
      const focus = props.focus;
      if (focus) showPoint(focus.points[0]);
    });
    createEffect(() => {
      // A hidden preview keeps its last compile.
      if (available() < 1) return;
      setPreviewWidth(
        props.note,
        Math.min(available(), settings.maxPreviewWidth),
      );
    });
  });

  return (
    <div
      class="preview"
      ref={(el) => {
        container = el;
        withOverlayScrollbar(el);
      }}
      data-preview-theme={isPreviewDark() ? 'dark' : 'light'}
      style={{ '--max-page-width': `${settings.maxPreviewWidth}px` }}
    >
      <Index each={props.pages}>
        {/* SVG comes from our own compiler, so innerHTML is safe here. */}
        {(svg) => <div class="page" innerHTML={svg()} />}
      </Index>
      <Show when={(props.loadingPackages ?? []).length > 0}>
        <div class="loading">
          Downloading {(props.loadingPackages ?? []).join(', ')}...
        </div>
      </Show>
      <Show when={props.diagnostics.length > 0}>
        <ul class="diagnostics">
          <For each={props.diagnostics}>
            {(d) => (
              <li class={d.severity}>
                <Show when={preambleName(d.path)}>
                  {(name) => <span class="location">In {name()}</span>}
                </Show>
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
