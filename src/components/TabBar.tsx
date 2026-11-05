import BookOpen from 'lucide-solid/icons/book-open';
import Code from 'lucide-solid/icons/code';
import Columns2 from 'lucide-solid/icons/columns-2';
import X from 'lucide-solid/icons/x';
import {
  batch,
  type Component,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import type { DropZone } from '../state/layout';
import {
  activateTab,
  closeTab,
  dropTab,
  moveTab,
  noteById,
  noteLabel,
  type Pane,
  previewLayout,
  sessionFor,
  setPaneMode,
  type Tab,
  type ViewMode,
} from '../state/workspace';
import { overlayScrollbar } from './scrollbars';

const tabLabel = (tab: Tab) =>
  tab.note ? noteLabel(noteById(tab.note)) : 'New tab';

/** Pixels the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 5;
/** How far outside its tab bar a dragged tab goes before it drops on panes instead. */
const DETACH_PX = 16;

interface Drag {
  from: number;
  /** Insert position in the list without the dragged tab (`moveTab` semantics). */
  to: number;
  /** How far the dragged tab has moved from its slot. */
  dx: number;
  /** Width of the dragged tab: how far the others shift to make room. */
  width: number;
  /** Off the tab bar: the tab follows the pointer as a ghost and drops on a pane. */
  detached: boolean;
  x: number;
  y: number;
  label: string;
}

/** Where a tab dragged off its bar would land; panes draw it as an overlay. */
const [dropTarget, setDropTarget] = createSignal<{
  pane: string;
  zone: DropZone;
  index?: number;
} | null>(null);

export { dropTarget };

/** The pane (and where in it) under a point, for a tab dragged off its bar. */
function targetAt(x: number, y: number) {
  const el = document.elementFromPoint(x, y);
  const paneEl = el?.closest<HTMLElement>('[data-pane-id]');
  const pane = paneEl?.dataset.paneId;
  if (!paneEl || !pane) return null;
  const bar = el?.closest('.tab-bar');
  if (bar) {
    const centers = [...bar.querySelectorAll('.tab')].map((t) => {
      const r = t.getBoundingClientRect();
      return r.left + r.width / 2;
    });
    return {
      pane,
      zone: 'center' as const,
      index: centers.filter((c) => x > c).length,
    };
  }
  const body = paneEl.querySelector('.pane-body')?.getBoundingClientRect();
  if (!body) return null;
  const fx = (x - body.left) / body.width;
  const fy = (y - body.top) / body.height;
  const nx = Math.min(fx, 1 - fx);
  const ny = Math.min(fy, 1 - fy);
  let zone: DropZone = 'center';
  if (Math.min(nx, ny) < 0.25) {
    if (nx < ny) zone = fx < 0.5 ? 'left' : 'right';
    else zone = fy < 0.5 ? 'top' : 'bottom';
  }
  return { pane, zone };
}

const MODES: {
  mode: ViewMode;
  label: string;
  icon: Component<{ size?: number }>;
}[] = [
  { mode: 'edit', label: 'Editor and preview', icon: Columns2 },
  { mode: 'source', label: 'Editor only', icon: Code },
  { mode: 'read', label: 'Reading view', icon: BookOpen },
];

/**
 * A pane's tabs: click to switch, middle-click or x to close, drag to
 * reorder, or drag off the bar onto a pane to move the tab there or split
 * it off beside that pane. Dragging uses pointer events rather than HTML5
 * drag and drop, which Tauri's own file-drop handling intercepts in the
 * webview. Within the bar the dragged tab follows the pointer and the others
 * slide aside to show where it lands.
 */
export function TabBar(props: { pane: Pane; focused: boolean }) {
  let bar!: HTMLDivElement;
  let list!: HTMLDivElement;
  const [drag, setDrag] = createSignal<Drag | null>(null);
  onMount(() => onCleanup(overlayScrollbar(list)));
  // Set for one frame when a drop is committed, so the tabs don't animate
  // from their shifted positions back to their (already moved) DOM slots.
  const [settling, setSettling] = createSignal(false);

  const startDrag = (event: PointerEvent, from: number, tab: Tab) => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest('.tab-close')) return;
    // Stops the press from starting a text selection.
    event.preventDefault();

    const elements = [...list.querySelectorAll<HTMLElement>('.tab')];
    const rects = elements.map((el) => el.getBoundingClientRect());
    const own = rects[from];
    const ownCenter = own.left + own.width / 2;
    // Midpoints of the other tabs at rest, measured once: shifted tabs
    // would otherwise feed back into the calculation.
    const otherCenters = rects
      .filter((_, i) => i !== from)
      .map((r) => r.left + r.width / 2);
    const barRect = bar.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragging = true;
      const detached =
        move.clientY < barRect.top - DETACH_PX ||
        move.clientY > barRect.bottom + DETACH_PX ||
        move.clientX < barRect.left ||
        move.clientX > barRect.right;
      const center = ownCenter + dx;
      const to = otherCenters.filter((c) => center > c).length;
      setDrag({
        from,
        to,
        dx,
        width: own.width,
        detached,
        x: move.clientX,
        y: move.clientY,
        label: tabLabel(tab),
      });
      setDropTarget(detached ? targetAt(move.clientX, move.clientY) : null);
    };
    const onEnd = (end: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      const done = drag();
      const target = dropTarget();
      setDropTarget(null);
      if (!done) return;
      setSettling(true);
      batch(() => {
        setDrag(null);
        if (end.type !== 'pointerup') return;
        if (!done.detached) moveTab(props.pane.id, done.from, done.to);
        else if (target) {
          dropTab(tab.key, target.pane, target.zone, target.index);
        }
      });
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setSettling(false)),
      );
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  };

  /** Horizontal offset for tab `i` while a drag is in progress. */
  const offset = (i: number): number => {
    const d = drag();
    if (!d || d.detached) return 0;
    if (i === d.from) return d.dx;
    if (i < d.from) return i >= d.to ? d.width : 0;
    return i - 1 < d.to ? -d.width : 0;
  };

  return (
    <div
      ref={bar}
      class="tab-bar"
      classList={{
        focused: props.focused,
        reordering: drag() !== null,
        settling: settling(),
      }}
    >
      <div ref={list} class="tab-list" role="tablist" aria-label="Open notes">
        <For each={props.pane.tabs}>
          {(tab, index) => {
            const isActive = () => props.pane.active === tab.key;
            const dirty = () =>
              tab.note ? (sessionFor(tab.note)?.dirty() ?? false) : false;
            return (
              <div
                role="tab"
                tabIndex={isActive() ? 0 : -1}
                aria-selected={isActive()}
                class="tab"
                classList={{
                  active: isActive(),
                  dirty: dirty(),
                  dragged: drag()?.from === index(),
                }}
                style={{
                  transform: drag()
                    ? `translateX(${offset(index())}px)`
                    : undefined,
                }}
                title={tabLabel(tab)}
                onPointerDown={(e) => startDrag(e, index(), tab)}
                onClick={() => activateTab(tab.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') activateTab(tab.key);
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    void closeTab(tab.key);
                  }
                }}
              >
                <span class="tab-label">{tabLabel(tab)}</span>
                <button
                  type="button"
                  class="tab-close"
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeTab(tab.key);
                  }}
                >
                  <span class="tab-dot" aria-hidden="true" />
                  <X class="tab-x" size={14} aria-hidden="true" />
                </button>
              </div>
            );
          }}
        </For>
      </div>
      <div class="pane-modes">
        <For
          each={MODES.filter(
            // With one shared preview, a pane has no preview of its own to hide.
            (m) => previewLayout() === 'pane' || m.mode !== 'source',
          )}
        >
          {(item) => (
            <button
              type="button"
              class="icon-button pane-mode"
              classList={{
                active:
                  props.pane.mode === item.mode ||
                  (item.mode === 'edit' &&
                    previewLayout() === 'global' &&
                    props.pane.mode === 'source'),
              }}
              aria-label={item.label}
              title={item.label}
              onClick={() => setPaneMode(props.pane.id, item.mode)}
            >
              <item.icon size={14} />
            </button>
          )}
        </For>
      </div>
      <Show when={drag()?.detached ? drag() : null}>
        {(d) => (
          <div
            class="tab-ghost"
            style={{ left: `${d().x + 12}px`, top: `${d().y + 8}px` }}
          >
            {d().label}
          </div>
        )}
      </Show>
    </div>
  );
}
