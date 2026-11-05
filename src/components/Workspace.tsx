import { Splitter, useSplitter } from '@ark-ui/solid';
import { createEffect, For, type JSX, Show } from 'solid-js';
import { type LayoutNode, paneNote, type Split } from '../state/layout';
import {
  focusedPane,
  focusPane,
  globalPreviewNote,
  globalShown,
  globalSizes,
  layout,
  noteById,
  noteLabel,
  openNote,
  type Pane,
  paneSizes,
  previewFocus,
  previewLayout,
  sessionFor,
  setGlobalSizes,
  setPaneSplitSizes,
  setSizes,
  setSplitSizes,
} from '../state/workspace';
import type { NoteId } from '../vault/api';
import { DebugPanel } from './DebugPanel';
import { editorElement } from './editorHosts';
import { Keys } from './Keys';
import { Preview } from './Preview';
import { Sidebar } from './Sidebar';
import { dropTarget, TabBar } from './TabBar';

/** Narrowest a pane, editor or preview gets while dragging a divider. */
const MIN_PX = 120;

/**
 * A draggable line between two flex children. It resizes its neighbours
 * (the elements before and after it), keeping their combined weight.
 */
function Divider(props: {
  direction: 'row' | 'column';
  class?: string;
  weights: () => [number, number];
  onResize: (before: number, after: number) => void;
}) {
  let el!: HTMLHRElement;
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const prev = el.previousElementSibling?.getBoundingClientRect();
    const next = el.nextElementSibling?.getBoundingClientRect();
    if (!prev || !next) return;
    const row = props.direction === 'row';
    const prevPx = row ? prev.width : prev.height;
    const totalPx = prevPx + (row ? next.width : next.height);
    const [a, b] = props.weights();
    const total = a + b;
    const start = row ? event.clientX : event.clientY;
    el.setPointerCapture(event.pointerId);
    el.classList.add('dragging');
    const onMove = (move: PointerEvent) => {
      const delta = (row ? move.clientX : move.clientY) - start;
      const min = Math.min(MIN_PX, totalPx / 2);
      const before = Math.min(Math.max(prevPx + delta, min), totalPx - min);
      const weight = (total * before) / totalPx;
      props.onResize(weight, total - weight);
    };
    const onUp = () => {
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  };
  return (
    <hr
      ref={el}
      class={`divider divider-${props.direction} ${props.class ?? ''}`}
      aria-orientation={props.direction === 'row' ? 'vertical' : 'horizontal'}
      onPointerDown={onDown}
    />
  );
}

/** Children laid out by flex weight with dividers between them. */
function Weighted<T>(props: {
  direction: 'row' | 'column';
  class?: string;
  dividerClass?: string;
  items: T[];
  sizes: number[];
  onResize: (sizes: number[]) => void;
  children: (item: T) => JSX.Element;
}) {
  return (
    <div class={`weighted weighted-${props.direction} ${props.class ?? ''}`}>
      <For each={props.items}>
        {(item, i) => (
          <>
            <Show when={i() > 0}>
              <Divider
                direction={props.direction}
                class={props.dividerClass}
                weights={() => [props.sizes[i() - 1], props.sizes[i()]]}
                onResize={(before, after) => {
                  const sizes = [...props.sizes];
                  sizes[i() - 1] = before;
                  sizes[i()] = after;
                  props.onResize(sizes);
                }}
              />
            </Show>
            <div
              class="weighted-child"
              style={{ flex: `${props.sizes[i()] ?? 1} 1 0px` }}
            >
              {props.children(item)}
            </div>
          </>
        )}
      </For>
    </div>
  );
}

function LayoutView(props: { node: LayoutNode }) {
  return (
    <Show when={props.node} keyed>
      {node =>
        node.kind === 'split' ? (
          <SplitView node={node} />
        ) : (
          <PaneView pane={node} />
        )
      }
    </Show>
  );
}

function SplitView(props: { node: Split }) {
  return (
    <Weighted
      direction={props.node.direction}
      class="split"
      items={props.node.children}
      sizes={props.node.sizes}
      onResize={sizes => setSplitSizes(props.node.id, sizes)}
    >
      {child => <LayoutView node={child} />}
    </Weighted>
  );
}

/** A note's preview, wired to its session. */
/** `jumps`: whether a click moves the note's editor there (not in reading view). */
function NotePreview(props: { note: NoteId; jumps?: () => boolean }) {
  const session = () => sessionFor(props.note);
  return (
    <Preview
      note={props.note}
      pages={session()?.pages() ?? []}
      diagnostics={session()?.result()?.diagnostics ?? []}
      loadingPackages={session()?.result()?.loadingPackages ?? []}
      onOpenNote={openNote}
      onJump={(page, x, y) => {
        if (props.jumps?.() === false) return;
        void session()?.jumpFromClick(page, x, y);
      }}
      focus={(() => {
        const focus = previewFocus();
        return focus && focus.note === props.note ? focus : undefined;
      })()}
    />
  );
}

/** One pane: its tab bar over its active note's editor and/or preview. */
function PaneView(props: { pane: Pane }) {
  let slot!: HTMLDivElement;
  const note = () => paneNote(props.pane);
  const focused = () => focusedPane().id === props.pane.id;
  const showEditor = () => props.pane.mode !== 'read';
  const showPreview = () =>
    props.pane.mode === 'read' ||
    (props.pane.mode === 'edit' && previewLayout() === 'pane');

  // Adopt the editors of this pane's notes (see `editorHosts`).
  createEffect(() => {
    for (const tab of props.pane.tabs) {
      if (!tab.note) continue;
      const el = editorElement(tab.note);
      if (el.parentElement !== slot) slot.appendChild(el);
    }
  });

  const drop = () => {
    const target = dropTarget();
    return target?.pane === props.pane.id ? target.zone : null;
  };

  return (
    <div
      class="pane-view"
      classList={{ focused: focused() }}
      data-pane-id={props.pane.id}
      onPointerDown={() => focusPane(props.pane.id)}
      onFocusIn={() => focusPane(props.pane.id)}
    >
      <TabBar pane={props.pane} focused={focused()} />
      <div
        class="pane-body"
        classList={{ 'with-preview': showEditor() && showPreview() }}
      >
        <div
          class="pane-editor"
          hidden={!showEditor()}
          style={{
            flex:
              showEditor() && showPreview()
                ? `${props.pane.sizes[0]} 1 0px`
                : '1 1 0px',
          }}
        >
          <div ref={slot} class="note-tabs" />
          <Show when={!note()}>
            <EmptyTab />
          </Show>
        </div>
        <Show when={showEditor() && showPreview()}>
          <Divider
            direction="row"
            class="preview-divider"
            weights={() => [props.pane.sizes[0], props.pane.sizes[1]]}
            onResize={(a, b) => setPaneSplitSizes(props.pane.id, [a, b])}
          />
        </Show>
        <Show when={showPreview()}>
          <div
            class="pane-preview"
            style={{
              flex: showEditor() ? `${props.pane.sizes[1]} 1 0px` : '1 1 0px',
            }}
          >
            <Show when={note()} keyed>
              {id => (
                <NotePreview
                  note={id}
                  jumps={() => props.pane.mode !== 'read'}
                />
              )}
            </Show>
          </div>
        </Show>
        <Show when={drop()}>
          {zone => <div class={`drop-overlay drop-${zone()}`} />}
        </Show>
      </div>
    </div>
  );
}

/** The shared preview column (global preview layout). */
function GlobalPreview() {
  const note = () => globalPreviewNote();
  return (
    <div class="global-preview">
      <div class="preview-header">
        <Show when={note()}>
          {id => <span class="preview-title">{noteLabel(noteById(id()))}</span>}
        </Show>
      </div>
      <Show when={note()} keyed>
        {id => <NotePreview note={id} />}
      </Show>
    </div>
  );
}

export function Workspace() {
  const splitter = useSplitter({
    panels: [
      { id: 'sidebar', minSize: 12, maxSize: 40 },
      { id: 'main', minSize: 30 },
    ],
    defaultSize: paneSizes(),
    onResizeEnd: details => setSizes(details.size),
  });

  return (
    <Splitter.RootProvider class="workspace" value={splitter}>
      <Splitter.Panel id="sidebar" class="pane">
        <Sidebar />
      </Splitter.Panel>
      <Splitter.ResizeTrigger
        id="sidebar:main"
        class="divider divider-row"
        aria-label="Resize sidebar"
      />
      <Splitter.Panel id="main" class="pane main-area">
        <Show
          when={
            previewLayout() === 'global' &&
            globalShown() &&
            // Nothing to show (every pane is in reading view, or empty): no column.
            globalPreviewNote() !== null
          }
          fallback={<LayoutView node={layout.root} />}
        >
          <Weighted
            direction="row"
            class="global-layout"
            dividerClass="preview-divider"
            items={['panes', 'preview']}
            sizes={globalSizes()}
            onResize={setGlobalSizes}
          >
            {item =>
              item === 'panes' ? (
                <LayoutView node={layout.root} />
              ) : (
                <GlobalPreview />
              )
            }
          </Weighted>
        </Show>
        <DebugPanel />
      </Splitter.Panel>
    </Splitter.RootProvider>
  );
}

/** What an empty tab (or an empty pane) shows. */
function EmptyTab() {
  return (
    <div class="pane-message empty">
      <p>No note open.</p>
      <p>
        <Keys keybinding="Mod+O" /> go to note &middot;{' '}
        <Keys keybinding="Mod+P" /> commands &middot;{' '}
        <Keys keybinding="Mod+N" /> new note
      </p>
    </div>
  );
}
