import { Splitter, useSplitter } from "@ark-ui/solid";
import { For, onCleanup, Show } from "solid-js";
import {
  active,
  activeNote,
  openNote,
  paneSizes,
  sessionFor,
  setSizes,
  tabs,
} from "../state/workspace";
import { Keys } from "./Keys";
import { NoteTab } from "./NoteTab";
import { MIN_PREVIEW_PX, Preview } from "./Preview";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";

let togglePreviewPane: (() => void) | undefined;

/** Shows or hides (collapses) the preview pane; a no-op without a workspace. */
export const togglePreview = () => togglePreviewPane?.();

export function Workspace() {
  const session = () => {
    const id = activeNote();
    return id ? sessionFor(id) : undefined;
  };

  const splitter = useSplitter({
    panels: [
      { id: "sidebar", minSize: 12, maxSize: 40 },
      { id: "editor", minSize: 20 },
      // Dragged below its minimum the preview collapses rather than squishing.
      {
        id: "preview",
        minSize: `${MIN_PREVIEW_PX}px`,
        collapsible: true,
        collapsedSize: 0,
      },
    ],
    defaultSize: paneSizes(),
    onResizeEnd: (details) => setSizes(details.size),
    onCollapse: () => setSizes(splitter().getSizes()),
    onExpand: () => setSizes(splitter().getSizes()),
  });

  togglePreviewPane = () => {
    const api = splitter();
    if (api.isPanelCollapsed("preview")) api.expandPanel("preview");
    else api.collapsePanel("preview");
  };
  onCleanup(() => {
    togglePreviewPane = undefined;
  });

  return (
    <Splitter.RootProvider class="workspace" value={splitter}>
      <Splitter.Panel id="sidebar" class="pane">
        <Sidebar />
      </Splitter.Panel>
      <Splitter.ResizeTrigger
        id="sidebar:editor"
        class="resize-trigger"
        aria-label="Resize sidebar"
      />
      <Splitter.Panel id="editor" class="pane editor-pane">
        <TabBar />
        <div class="note-tabs">
          <For each={tabs}>
            {(tab) => (
              <Show
                when={tab.note}
                keyed
                fallback={<EmptyTab hidden={active() !== tab.key} />}
              >
                {(id) => <NoteTab id={id} hidden={active() !== tab.key} />}
              </Show>
            )}
          </For>
          <Show when={tabs.length === 0}>
            <EmptyTab hidden={false} />
          </Show>
        </div>
      </Splitter.Panel>
      <Splitter.ResizeTrigger
        id="editor:preview"
        class="resize-trigger preview-divider"
        aria-label="Resize preview"
      />
      <Splitter.Panel id="preview" class="pane">
        <div class="preview-header" />
        <Preview
          pages={session()?.pages() ?? []}
          diagnostics={session()?.result()?.diagnostics ?? []}
          loadingPackages={session()?.result()?.loadingPackages ?? []}
          onOpenNote={openNote}
        />
      </Splitter.Panel>
    </Splitter.RootProvider>
  );
}

/** What an empty tab (or an empty editor area) shows. */
function EmptyTab(props: { hidden: boolean }) {
  return (
    <div class="pane-message empty" hidden={props.hidden}>
      <p>No note open.</p>
      <p>
        <Keys keybinding="Mod+O" /> go to note &middot;{" "}
        <Keys keybinding="Mod+P" /> commands &middot;{" "}
        <Keys keybinding="Mod+N" /> new note
      </p>
    </div>
  );
}
