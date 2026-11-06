import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import { settings } from '../state/settings';
import { isPreviewDark } from '../state/theme';
import { resizing, setPreviewWidth } from '../state/workspace';
import type { Diagnostic, Page, PagePoint } from '../typst/protocol';
import type { NoteId } from '../vault/api';
import { SeverityIcon } from './SeverityIcon';
import { withOverlayScrollbar } from './scrollbars';
import { CITE_SCHEME, LINK_SCHEME } from './wikilinks';

interface PreviewProps {
  /** The note shown; its page is compiled as wide as this preview. */
  note: NoteId;
  /** Pages of the last successful compile, kept while the source has errors. */
  pages: Page[];
  /** How the latest `pages` moved the anchor `onAnchor` reported. */
  shift?: { from: PagePoint; to: PagePoint } | null;
  /**
   * Hands over where the anchor is (the point at the top of the visible
   * area, in the shown layout) for compiles to follow; `undefined` on unmount.
   */
  onAnchor?: (get: (() => PagePoint | null) | undefined) => void;
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

/** Points per CSS pixel on `page` as it's shown (CSS may stretch it). */
function pointsPerPixel(page: HTMLElement) {
  const scale = Number(page.dataset.width) / page.getBoundingClientRect().width;
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

/** A click on a page in points from its top left. */
function pagePoint(page: HTMLElement, event: MouseEvent) {
  const scale = pointsPerPixel(page);
  if (!scale) return null;
  const box = page.getBoundingClientRect();
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
  const band = anchor.closest<HTMLElement>('.band');
  const rect = anchor.querySelector('rect');
  const width = Number(rect?.getAttribute('width'));
  const height = Number(rect?.getAttribute('height'));
  if (!match || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  const x = Number(match[1]);
  const y = Number(match[2]) + Number(band?.dataset.top ?? 0);
  return { x, end: x + width, y, height };
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
  const index = [...(page.parentElement?.children ?? [])].indexOf(page);
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

/** How far past the visible area bands are kept in the DOM, in viewports. */
const BAND_MARGIN = 0.5;

/** The SVG of each band element, inserted while the band is near the screen. */
const bandSvgs = new WeakMap<HTMLElement, string>();

const percent = (part: number, whole: number) =>
  `${whole > 0 ? (part / whole) * 100 : 0}%`;

/**
 * Makes `host`'s children show `pages`: one `.page` each, sized by its
 * aspect ratio (so CSS can stretch it while a new width compiles), with
 * its fill and its bands as placeholders positioned in percent. A band
 * whose key is already shown keeps its element and content.
 */
function reconcilePages(host: HTMLElement, pages: Page[]) {
  while (host.children.length > pages.length) host.lastElementChild?.remove();
  pages.forEach((page, i) => {
    let el = host.children[i] as HTMLElement | undefined;
    if (!el) {
      el = document.createElement('div');
      el.className = 'page';
      const fill = document.createElement('div');
      fill.className = 'page-fill';
      el.appendChild(fill);
      host.appendChild(el);
    }
    el.dataset.width = String(page.width);
    el.style.aspectRatio = `${page.width} / ${page.height}`;
    const fill = el.firstElementChild as HTMLElement;
    // Our own compiler's SVG, so innerHTML is safe (as for the bands).
    if (bandSvgs.get(fill) !== page.background) {
      fill.innerHTML = page.background;
      bandSvgs.set(fill, page.background);
    }

    const old = [...el.children].slice(1) as HTMLElement[];
    let after: Element = fill;
    for (const band of page.bands) {
      const reused = old.findIndex(b => b.dataset.key === band.key);
      let bandEl = reused < 0 ? undefined : old.splice(reused, 1)[0];
      if (!bandEl) {
        bandEl = document.createElement('div');
        bandEl.className = 'band';
        bandEl.dataset.key = band.key;
        bandSvgs.set(bandEl, band.svg);
      }
      bandEl.dataset.top = String(band.top);
      bandEl.style.top = percent(band.top, page.height);
      bandEl.style.height = percent(band.height, page.height);
      if (after.nextElementSibling !== bandEl) after.after(bandEl);
      after = bandEl;
    }
    for (const unused of old) unused.remove();
  });
}

/** Puts the SVG of bands near `container`'s visible area in, and takes it out of the others. */
function showNearBands(container: HTMLElement) {
  const view = container.getBoundingClientRect();
  const margin = view.height * BAND_MARGIN;
  for (const band of container.querySelectorAll<HTMLElement>('.band')) {
    const box = band.getBoundingClientRect();
    const near =
      box.bottom >= view.top - margin && box.top <= view.bottom + margin;
    if (near && !band.firstChild) {
      band.innerHTML = bandSvgs.get(band) ?? '';
    } else if (!near && band.firstChild) {
      band.textContent = '';
    }
  }
}

export function Preview(props: PreviewProps) {
  let container!: HTMLDivElement;
  let pagesHost!: HTMLDivElement;

  // Delegated from the SVG anchors (keyboard activation also fires `click`).
  // Every anchor is intercepted: following one would navigate the webview
  // away from the app.
  const onClick = (event: MouseEvent) => {
    const anchor = (event.target as Element).closest('a');
    if (!anchor) {
      const page = (event.target as Element).closest<HTMLElement>('.page');
      const point = page && pagePoint(page, event);
      if (page && point) {
        const index = [...pagesHost.children].indexOf(page);
        props.onJump?.(index, point.x, point.y);
      }
      return;
    }
    event.preventDefault();
    const href = hrefOf(anchor) ?? '';
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
    const page = point && (pagesHost.children[point.page] as HTMLElement);
    const perPixel = page && pointsPerPixel(page);
    if (!point || !page || !perPixel) return;
    const x = point.x / perPixel;
    const y = point.y / perPixel;
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

  // Scroll anchoring: the point at the top of the visible area stays where
  // it is on screen when the pages change size, whether CSS stretches them
  // during a resize or a compile reflows them (`props.shift` says where its
  // text went). Without it, the content under the view moves by however
  // much the height above it changed, a lot near the end of a long note.
  let anchor: { page: number; pt: number; offset: number } | null = null;
  /** The pages' size when `anchor` was taken, to tell their resizes from scrolling. */
  let anchoredSize = '';

  const pagesSize = () => {
    const box = pagesHost.getBoundingClientRect();
    return `${box.width}x${box.height}`;
  };

  /** Takes the anchor from what the view shows now. */
  const measureAnchor = () => {
    anchoredSize = pagesSize();
    anchor = null;
    const top = container.getBoundingClientRect().top;
    const pages = [...pagesHost.children] as HTMLElement[];
    const page = pages.findIndex(el => el.getBoundingClientRect().bottom > top);
    const el = pages[page];
    const perPixel = el && pointsPerPixel(el);
    if (!el || !perPixel) return;
    const box = el.getBoundingClientRect();
    const pt = Math.max(0, top - box.top) * perPixel;
    anchor = { page, pt, offset: box.top + pt / perPixel - top };
  };

  /** Scrolls so the anchor is back where it was in the view, if there is one. */
  const restoreAnchor = () => {
    const el = anchor && (pagesHost.children[anchor.page] as HTMLElement);
    const perPixel = el && pointsPerPixel(el);
    if (anchor && el && perPixel) {
      const top = container.getBoundingClientRect().top;
      const now = el.getBoundingClientRect().top + anchor.pt / perPixel;
      container.scrollTop += now - (top + anchor.offset);
    }
    measureAnchor();
  };

  let frame = 0;
  const onScroll = () => {
    hideCard();
    // A scroll from the pages changing size (the browser clamping it) isn't
    // the user's: put the anchor back instead of moving it.
    if (pagesSize() === anchoredSize) measureAnchor();
    else restoreAnchor();
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      showNearBands(container);
    });
  };

  onMount(() => {
    onCleanup(() => cancelAnimationFrame(frame));
    props.onAnchor?.(() =>
      anchor ? { page: anchor.page, x: 0, y: anchor.pt } : null,
    );
    onCleanup(() => props.onAnchor?.(undefined));
    let shownNote = props.note;
    createEffect(() => {
      const pages = props.pages;
      const shift = props.shift;
      // Another note's anchor means nothing here.
      if (props.note !== shownNote) {
        shownNote = props.note;
        anchor = null;
      }
      if (anchor && shift && shift.from.page === anchor.page) {
        anchor = {
          ...anchor,
          page: shift.to.page,
          pt: anchor.pt + shift.to.y - shift.from.y,
        };
      }
      reconcilePages(pagesHost, pages);
      restoreAnchor();
      showNearBands(container);
    });
    container.addEventListener('click', onClick);
    container.addEventListener('mouseover', onOver);
    container.addEventListener('mouseout', onOut);
    container.addEventListener('scroll', onScroll, { passive: true });
    onCleanup(() => {
      container.removeEventListener('click', onClick);
      container.removeEventListener('mouseover', onOver);
      container.removeEventListener('mouseout', onOut);
      container.removeEventListener('scroll', onScroll);
      hideCard();
    });

    // Pages are compiled as wide as the pane allows. Until a compile for a
    // new width lands, CSS stretches the old page to fit (`.page`, `.band`).
    const [available, setAvailable] = createSignal(container.clientWidth);
    const observer = new ResizeObserver(() => {
      setAvailable(container.clientWidth);
      onScroll();
    });
    observer.observe(container);
    observer.observe(pagesHost);
    onCleanup(() => observer.disconnect());

    createEffect(() => {
      const focus = props.focus;
      if (focus) showPoint(focus.points[0]);
    });
    createEffect(() => {
      // A hidden preview keeps its last compile; during a resize CSS
      // stretches the page, and the last width compiles once it ends.
      if (available() < 1 || resizing()) return;
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
      <div class="pages" ref={pagesHost} />
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
                <SeverityIcon severity={d.severity} />
                <div>
                  <span class="diagnostic-message">
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
                  </span>
                  <For each={d.hints}>
                    {hint => <div class="hint">hint: {hint}</div>}
                  </For>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
