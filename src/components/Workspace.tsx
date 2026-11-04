import { Splitter } from "@ark-ui/solid";
import { For, Show } from "solid-js";
import { formatKeybinding } from "../commands/registry";
import {
  active,
  activeNote,
  openNote,
  paneSizes,
  sessionFor,
  setSizes,
  tabs,
} from "../state/workspace";
import { NoteTab } from "./NoteTab";
import { Preview } from "./Preview";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";

export function Workspace() {
  const session = () => {
    const id = activeNote();
    return id ? sessionFor(id) : undefined;
  };

  return (
    <Splitter.Root
      class="workspace"
      panels={[
        { id: "sidebar", minSize: 12, maxSize: 40 },
        { id: "editor", minSize: 20 },
        { id: "preview", minSize: 15 },
      ]}
      defaultSize={paneSizes()}
      onResizeEnd={(details) => setSizes(details.size)}
    >
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
        class="resize-trigger"
        aria-label="Resize preview"
      />
      <Splitter.Panel id="preview" class="pane">
        <Preview
          pages={session()?.pages() ?? []}
          diagnostics={session()?.result()?.diagnostics ?? []}
          loadingPackages={session()?.result()?.loadingPackages ?? []}
          onOpenNote={openNote}
        />
      </Splitter.Panel>
    </Splitter.Root>
  );
}

/** What an empty tab (or an empty editor area) shows. */
function EmptyTab(props: { hidden: boolean }) {
  return (
    <div class="pane-message empty" hidden={props.hidden}>
      <p>No note open.</p>
      <p>
        <kbd>{formatKeybinding("Mod+O")}</kbd> go to note &middot;{" "}
        <kbd>{formatKeybinding("Mod+Shift+P")}</kbd> commands &middot;{" "}
        <kbd>{formatKeybinding("Mod+N")}</kbd> new note
      </p>
    </div>
  );
}
