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
import type { NoteId } from '../vault/api';
import { withOverlayScrollbar } from './scrollbars';
import { CITE_SCHEME, LINK_SCHEME } from './wikilinks';

interface PreviewProps {
  /** The note shown; its page is compiled as wide as this preview. */
  note: NoteId;
  /** Pages of the last successful compile, kept while the source has errors. */
  pages: string[];
  diagnostics: Diagnostic[];
  loadingPackages?: string[];
  /** Called with the note id when a `sliver://` link is clicked. */
  onOpenNote?: (id: string) => void;
  /** The keys cited in a run of link areas on a line (in points). */
  citationsAt?: (
    page: number,
    box: { x: number; end: number; y: number; height: number },
  ) => Promise<string[]>;
  /** Called with the cited keys when a citation is clicked. */
  onCitation?: (keys: string[]) => void;
  /** What hovering a citation shows. */
  citationCard?: (keys: string[]) => HTMLElement;
  /** A problem that affects the whole preview, e.g. unreadable references. */
  notice?: string | null;
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

/** Where an SVG link area is on its page, in points. */
function linkBox(anchor: Element) {
  const match = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(
    anchor.getAttribute('transform') ?? '',
  );
  const rect = anchor.querySelector('rect');
  const width = Number(rect?.getAttribute('width'));
  const height = Number(rect?.getAttribute('height'));
  if (!match || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  const x = Number(match[1]);
  return { x, end: x + width, y: Number(match[2]), height };
}

const hrefOf = (anchor: Element) =>
  anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href');

/** The nearest link area before (`-1`) or after (`1`) `anchor` among its siblings. */
function siblingAnchor(anchor: Element, direction: -1 | 1) {
  let el =
    direction < 0 ? anchor.previousElementSibling : anchor.nextElementSibling;
  while (el && el.tagName.toLowerCase() !== 'a') {
    el = direction < 0 ? el.previousElementSibling : el.nextElementSibling;
  }
  return el;
}

/**
 * A link area that may be (part of) a citation, and the run of link areas
 * touching it on its line. Typst links a citation's text to its
 * bibliography entry, which SVG can't express (an anchor without an href),
 * so only the punctuation carries our `sliver-cite:` link; together they
 * cover the citation (or a group Typst merged, like "(Doe 2020; Roe 2021)").
 */
function citationArea(target: EventTarget | null) {
  const anchor = (target as Element | null)?.closest?.('a');
  const href = anchor && hrefOf(anchor);
  if (!anchor || (href && !href.startsWith(CITE_SCHEME))) return null;
  const page = anchor.closest('.page');
  const box = linkBox(anchor);
  if (!page || !box) return null;
  let { x, end } = box;
  for (const direction of [-1, 1] as const) {
    let current: Element = anchor;
    for (;;) {
      const next = siblingAnchor(current, direction);
      const b = next && linkBox(next);
      const nextHref = next && hrefOf(next);
      if (!next || !b || (nextHref && !nextHref.startsWith(CITE_SCHEME))) {
        break;
      }
      const touches =
        direction < 0 ? Math.abs(b.end - x) < 0.5 : Math.abs(b.x - end) < 0.5;
      if (Math.abs(b.y - box.y) > 0.5 || !touches) break;
      if (direction < 0) x = b.x;
      else end = b.end;
      current = next;
    }
  }
  const index = [...(page.parentElement?.children ?? [])]
    .filter(el => el.classList.contains('page'))
    .indexOf(page);
  return { anchor, page: index, box: { x, end, y: box.y, height: box.height } };
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
    } else {
      const area = citationArea(anchor);
      if (!area) return;
      hideCard();
      void props.citationsAt?.(area.page, area.box).then(keys => {
        if (keys.length > 0) props.onCitation?.(keys);
      });
    }
  };

  // A hovered citation shows its card under it, until the pointer has left
  // both the citation and the card for a moment.
  let card: HTMLElement | undefined;
  let cardAnchor: Element | undefined;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const hideCard = () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    card?.remove();
    card = undefined;
    cardAnchor = undefined;
  };

  const onOver = (event: MouseEvent) => {
    const area = citationArea(event.target);
    if (!area || !props.citationCard) return;
    clearTimeout(hideTimer);
    if (area.anchor === cardAnchor) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(async () => {
      const keys = (await props.citationsAt?.(area.page, area.box)) ?? [];
      if (keys.length === 0 || !area.anchor.isConnected) return;
      hideCard();
      const rect = area.anchor.getBoundingClientRect();
      card = props.citationCard?.(keys);
      if (!card) return;
      cardAnchor = area.anchor;
      card.classList.add('floating');
      card.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 340))}px`;
      card.style.top = `${rect.bottom + 6}px`;
      card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
      card.addEventListener('mouseleave', scheduleHide);
      document.body.appendChild(card);
    }, 300);
  };

  const scheduleHide = () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideCard, 200);
  };

  const onOut = (event: MouseEvent) => {
    if (citationArea(event.target)) scheduleHide();
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
    container.addEventListener('mouseover', onOver);
    container.addEventListener('mouseout', onOut);
    container.addEventListener('scroll', hideCard);
    onCleanup(() => {
      container.removeEventListener('click', onClick);
      container.removeEventListener('mouseover', onOver);
      container.removeEventListener('mouseout', onOut);
      container.removeEventListener('scroll', hideCard);
      hideCard();
    });

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
      ref={el => {
        container = el;
        withOverlayScrollbar(el);
      }}
      data-preview-theme={isPreviewDark() ? 'dark' : 'light'}
      style={{ '--max-page-width': `${settings.maxPreviewWidth}px` }}
    >
      <Index each={props.pages}>
        {/* SVG comes from our own compiler, so innerHTML is safe here. */}
        {svg => <div class="page" innerHTML={svg()} />}
      </Index>
      <Show when={props.notice}>
        {notice => <div class="loading">{notice()}</div>}
      </Show>
      <Show when={(props.loadingPackages ?? []).length > 0}>
        <div class="loading">
          Downloading {(props.loadingPackages ?? []).join(', ')}...
        </div>
      </Show>
      <Show when={props.diagnostics.length > 0}>
        <ul class="diagnostics">
          <For each={props.diagnostics}>
            {d => (
              <li class={d.severity}>
                <Show when={preambleName(d.path)}>
                  {name => <span class="location">In {name()}</span>}
                </Show>
                <Show when={d.range}>
                  {range => (
                    <span class="location">
                      {range().start.line + 1}:{range().start.column + 1}
                    </span>
                  )}
                </Show>
                {d.message}
                <For each={d.hints}>
                  {hint => <div class="hint">hint: {hint}</div>}
                </For>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
