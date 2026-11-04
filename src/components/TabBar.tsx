import X from "lucide-solid/icons/x";
import { batch, createSignal, For } from "solid-js";
import {
  activateTab,
  active,
  closeTab,
  moveTab,
  noteById,
  noteLabel,
  sessionFor,
  type Tab,
  tabs,
} from "../state/workspace";

const tabLabel = (tab: Tab) =>
  tab.note ? noteLabel(noteById(tab.note)) : "New tab";

/** Pixels the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 5;

interface Drag {
  from: number;
  /** Insert position in the list without the dragged tab (`moveTab` semantics). */
  to: number;
  /** How far the dragged tab has moved from its slot. */
  dx: number;
  /** Width of the dragged tab: how far the others shift to make room. */
  width: number;
}

/**
 * Editor-style tabs: click to switch, middle-click or x to close, drag to
 * reorder. Reordering uses pointer events rather than HTML5 drag and drop,
 * which Tauri's own file-drop handling intercepts in the webview. The dragged
 * tab follows the pointer and the others slide aside to show where it lands.
 */
export function TabBar() {
  let bar!: HTMLDivElement;
  const [drag, setDrag] = createSignal<Drag | null>(null);
  // Set for one frame when a drop is committed, so the tabs don't animate
  // from their shifted positions back to their (already moved) DOM slots.
  const [settling, setSettling] = createSignal(false);

  const startDrag = (event: PointerEvent, from: number) => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest(".tab-close")) return;
    // Stops the press from starting a text selection.
    event.preventDefault();

    const elements = [...bar.querySelectorAll<HTMLElement>(".tab")];
    const rects = elements.map((el) => el.getBoundingClientRect());
    const own = rects[from];
    const ownCenter = own.left + own.width / 2;
    // Midpoints of the other tabs at rest, measured once: shifted tabs
    // would otherwise feed back into the calculation.
    const otherCenters = rects
      .filter((_, i) => i !== from)
      .map((r) => r.left + r.width / 2);
    const startX = event.clientX;
    let dragging = false;

    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - startX;
      if (!dragging && Math.abs(dx) < DRAG_THRESHOLD) return;
      dragging = true;
      const center = ownCenter + dx;
      const to = otherCenters.filter((c) => center > c).length;
      setDrag({ from, to, dx, width: own.width });
    };
    const onEnd = (end: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      const done = drag();
      if (!done) return;
      setSettling(true);
      batch(() => {
        setDrag(null);
        if (end.type === "pointerup") moveTab(done.from, done.to);
      });
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setSettling(false)),
      );
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  /** Horizontal offset for tab `i` while a drag is in progress. */
  const offset = (i: number): number => {
    const d = drag();
    if (!d) return 0;
    if (i === d.from) return d.dx;
    if (i < d.from) return i >= d.to ? d.width : 0;
    return i - 1 < d.to ? -d.width : 0;
  };

  return (
    <div
      ref={bar}
      class="tab-bar"
      classList={{ reordering: drag() !== null, settling: settling() }}
      role="tablist"
      aria-label="Open notes"
    >
      <For each={tabs}>
        {(tab, index) => {
          const isActive = () => active() === tab.key;
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
              onPointerDown={(e) => startDrag(e, index())}
              onClick={() => activateTab(tab.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") activateTab(tab.key);
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
  );
}
