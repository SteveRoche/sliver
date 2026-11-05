import { onCleanup, onMount } from 'solid-js';

/**
 * Overlay scrollbars: the native ones are hidden app-wide (App.css), so a
 * scroll container's width never depends on whether it overflows. These
 * thumbs float over the content, appear while scrolling or hovered, and
 * fade out shortly after. Native overlay scrollbars would follow the OS
 * setting (and take space when it says "always"), so they're drawn here.
 */

const THICKNESS = 8;
const MIN_LENGTH = 24;
const HIDE_AFTER_MS = 900;

type Axis = 'x' | 'y';

/** Adds overlay scrollbars to `el`; returns a cleanup function. */
export function overlayScrollbar(el: HTMLElement): () => void {
  const host = el.parentElement;
  if (!host) return () => {};
  if (getComputedStyle(host).position === 'static') {
    host.style.position = 'relative';
  }

  const thumbs: Record<Axis, HTMLDivElement> = {
    x: document.createElement('div'),
    y: document.createElement('div'),
  };
  for (const axis of ['x', 'y'] as const) {
    thumbs[axis].className = `overlay-thumb overlay-thumb-${axis}`;
    host.appendChild(thumbs[axis]);
  }

  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let dragging = false;
  let hovering = false;

  const setVisible = (visible: boolean) => {
    for (const thumb of Object.values(thumbs)) {
      thumb.classList.toggle('visible', visible);
    }
  };
  const flash = () => {
    setVisible(true);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!dragging && !hovering) setVisible(false);
    }, HIDE_AFTER_MS);
  };

  /** Track length, thumb length and the scrollable distance along `axis`. */
  const measure = (axis: Axis) => {
    const view = axis === 'y' ? el.clientHeight : el.clientWidth;
    const content = axis === 'y' ? el.scrollHeight : el.scrollWidth;
    const length = Math.max(MIN_LENGTH, (view * view) / Math.max(content, 1));
    return { view, length, range: content - view };
  };

  const layout = () => {
    const box = el.getBoundingClientRect();
    const hostBox = host.getBoundingClientRect();
    const left = box.left - hostBox.left - host.clientLeft;
    const top = box.top - hostBox.top - host.clientTop;
    for (const axis of ['x', 'y'] as const) {
      const thumb = thumbs[axis];
      const { view, length, range } = measure(axis);
      thumb.hidden = range <= 1;
      if (thumb.hidden) continue;
      const scrolled = axis === 'y' ? el.scrollTop : el.scrollLeft;
      const offset = ((view - length) * scrolled) / range;
      if (axis === 'y') {
        thumb.style.height = `${length}px`;
        thumb.style.transform = `translate(${left + el.clientWidth - THICKNESS}px, ${top + offset}px)`;
      } else {
        thumb.style.width = `${length}px`;
        thumb.style.transform = `translate(${left + offset}px, ${top + el.clientHeight - THICKNESS}px)`;
      }
    }
  };

  const onScroll = () => {
    layout();
    flash();
  };
  el.addEventListener('scroll', onScroll, { passive: true });

  const cleanups: (() => void)[] = [];
  for (const axis of ['x', 'y'] as const) {
    const thumb = thumbs[axis];
    const enter = () => {
      hovering = true;
      setVisible(true);
    };
    const leave = () => {
      hovering = false;
      flash();
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      thumb.setPointerCapture(event.pointerId);
      dragging = true;
      const start = axis === 'y' ? event.clientY : event.clientX;
      const startScroll = axis === 'y' ? el.scrollTop : el.scrollLeft;
      const { view, length, range } = measure(axis);
      const perPixel = range / Math.max(view - length, 1);
      const move = (e: PointerEvent) => {
        const delta = (axis === 'y' ? e.clientY : e.clientX) - start;
        if (axis === 'y') el.scrollTop = startScroll + delta * perPixel;
        else el.scrollLeft = startScroll + delta * perPixel;
      };
      const up = () => {
        dragging = false;
        thumb.removeEventListener('pointermove', move);
        thumb.removeEventListener('pointerup', up);
        thumb.removeEventListener('pointercancel', up);
        flash();
      };
      thumb.addEventListener('pointermove', move);
      thumb.addEventListener('pointerup', up);
      thumb.addEventListener('pointercancel', up);
    };
    thumb.addEventListener('pointerenter', enter);
    thumb.addEventListener('pointerleave', leave);
    thumb.addEventListener('pointerdown', down);
    cleanups.push(() => {
      thumb.removeEventListener('pointerenter', enter);
      thumb.removeEventListener('pointerleave', leave);
      thumb.removeEventListener('pointerdown', down);
    });
  }

  // Content can grow without the container resizing, so watch the children too.
  const resizes = new ResizeObserver(layout);
  const watch = (node: Element) => resizes.observe(node);
  watch(el);
  for (const child of el.children) watch(child);
  const mutations = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) watch(node);
      }
    }
    layout();
  });
  mutations.observe(el, { childList: true });
  layout();

  return () => {
    clearTimeout(hideTimer);
    el.removeEventListener('scroll', onScroll);
    resizes.disconnect();
    mutations.disconnect();
    for (const cleanup of cleanups) cleanup();
    for (const thumb of Object.values(thumbs)) thumb.remove();
  };
}

/** For `ref={withOverlayScrollbar}`: attaches once mounted, detaches on cleanup. */
export function withOverlayScrollbar(el: HTMLElement) {
  onMount(() => onCleanup(overlayScrollbar(el)));
}
