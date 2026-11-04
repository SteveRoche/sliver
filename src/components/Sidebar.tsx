import { createTreeCollection, Menu, TreeView } from "@ark-ui/solid";
import ArrowDown from "lucide-solid/icons/arrow-down";
import FilePlus from "lucide-solid/icons/file-plus";
import FoldVertical from "lucide-solid/icons/fold-vertical";
import GitBranch from "lucide-solid/icons/git-branch";
import Pencil from "lucide-solid/icons/pencil";
import Plus from "lucide-solid/icons/plus";
import Trash2 from "lucide-solid/icons/trash";
import TriangleAlert from "lucide-solid/icons/triangle-exclamation-point";
import UnfoldVertical from "lucide-solid/icons/unfold-vertical";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { runCommand } from "../commands/registry";
import {
  activeNote,
  noteById,
  noteLabel,
  openNote,
  tree,
} from "../state/workspace";
import type { NoteId, TreeNode } from "../vault/api";

type Node = Omit<TreeNode, "children"> & { children?: Node[] };

/** Ark treats a node as a branch whenever it has a children array. */
function toNodes(nodes: TreeNode[]): Node[] {
  return nodes.map(({ children, ...note }) =>
    children.length > 0 ? { ...note, children: toNodes(children) } : note,
  );
}

function branchIds(nodes: Node[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.children) {
      out.push(node.id);
      branchIds(node.children, out);
    }
  }
  return out;
}

/** The note the context menu acts on; menu commands read it. */
const [menuTarget, setMenuTarget] = createSignal<NoteId | null>(null);

export { menuTarget };

export function Sidebar() {
  const nodes = createMemo(() => toNodes(tree()));
  const collection = createMemo(() =>
    createTreeCollection<Node>({
      nodeToValue: (node) => node.id,
      nodeToString: (node) => noteLabel(node as TreeNode),
      rootNode: {
        id: "root",
        title: null,
        address: null,
        tags: [],
        headerError: null,
        children: nodes(),
      },
    }),
  );

  // Branches start expanded; ones created later are expanded as they appear.
  const [expanded, setExpanded] = createSignal<string[]>([]);
  const seen = new Set<string>();
  createEffect(() => {
    const fresh = branchIds(nodes()).filter((id) => !seen.has(id));
    for (const id of fresh) seen.add(id);
    if (fresh.length) setExpanded((current) => [...current, ...fresh]);
  });

  const onContextMenu = (event: MouseEvent) => {
    const row = (event.target as Element).closest<HTMLElement>(
      "[data-note-id]",
    );
    setMenuTarget(row?.dataset.noteId ?? null);
  };

  return (
    <aside class="sidebar">
      <div class="sidebar-header">
        <span>Notes</span>
        <button
          type="button"
          class="icon-button"
          title="New note"
          aria-label="New note"
          onClick={() => runCommand("note.new")}
        >
          <Plus size={16} />
        </button>
      </div>
      <Menu.Root
        onSelect={(details) => runCommand(details.value)}
        onOpenChange={(details) => {
          if (!details.open) queueMicrotask(() => setMenuTarget(null));
        }}
      >
        {/* A div, not Ark's default button: a button centres its content. */}
        <Menu.ContextTrigger
          class="sidebar-tree"
          onContextMenu={onContextMenu}
          asChild={(triggerProps) => <div {...triggerProps()} />}
        >
          <TreeView.Root
            collection={collection()}
            selectionMode="single"
            selectedValue={activeNote() ? [activeNote() as string] : []}
            onSelectionChange={(details) => {
              const id = details.selectedValue[0];
              if (id) openNote(id);
            }}
            expandOnClick={false}
            expandedValue={expanded()}
            onExpandedChange={(details) => setExpanded(details.expandedValue)}
          >
            <TreeView.Tree aria-label="Notes">
              <For each={collection().rootNode.children ?? []}>
                {(node, index) => (
                  <NodeView node={node} indexPath={[index()]} />
                )}
              </For>
            </TreeView.Tree>
          </TreeView.Root>
          <Show when={tree().length === 0}>
            <p class="pane-message">No notes yet. Press + to create one.</p>
          </Show>
        </Menu.ContextTrigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content class="menu">
              <Show
                when={menuTarget()}
                fallback={
                  <Menu.Item value="note.new">
                    <FilePlus size={14} /> New note
                  </Menu.Item>
                }
              >
                <Menu.Item
                  value="menu.continue"
                  disabled={!noteById(menuTarget() ?? "")?.address}
                >
                  <ArrowDown size={14} /> New continuation
                </Menu.Item>
                <Menu.Item
                  value="menu.branch"
                  disabled={!noteById(menuTarget() ?? "")?.address}
                >
                  <GitBranch size={14} /> New branch
                </Menu.Item>
                <Menu.Separator class="menu-separator" />
                <Menu.Item value="menu.rename">
                  <Pencil size={14} /> Rename...
                </Menu.Item>
                <Menu.Item value="menu.delete" class="danger">
                  <Trash2 size={14} /> Delete...
                </Menu.Item>
              </Show>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </aside>
  );
}

function NodeView(props: { node: Node; indexPath: number[] }) {
  const label = () => (
    <span class="note-label" data-note-id={props.node.id}>
      <Show when={props.node.address}>
        <span class="note-address">{props.node.address}</span>
      </Show>
      <span class="note-title">{props.node.title ?? "Untitled"}</span>
      <Show when={props.node.headerError}>
        {(error) => (
          <span class="note-warning" title={error()}>
            <TriangleAlert size={12} aria-label="Header error" />
          </span>
        )}
      </Show>
    </span>
  );

  return (
    <TreeView.NodeProvider node={props.node} indexPath={props.indexPath}>
      <Show
        when={props.node.children}
        fallback={
          <TreeView.Item class="tree-item">
            <TreeView.ItemText class="tree-text">{label()}</TreeView.ItemText>
          </TreeView.Item>
        }
      >
        {(children) => (
          <TreeView.Branch>
            <TreeView.BranchControl class="tree-item">
              {/* Only this toggles; clicking the rest of the row opens the note. */}
              <TreeView.BranchTrigger class="tree-toggle">
                <TreeView.NodeContext>
                  {(node) =>
                    node().expanded ? (
                      <FoldVertical size={12} aria-label="Collapse" />
                    ) : (
                      <UnfoldVertical size={12} aria-label="Expand" />
                    )
                  }
                </TreeView.NodeContext>
              </TreeView.BranchTrigger>
              <TreeView.BranchText class="tree-text">
                {label()}
              </TreeView.BranchText>
            </TreeView.BranchControl>
            <TreeView.BranchContent class="tree-children">
              <For each={children()}>
                {(child, index) => (
                  <NodeView
                    node={child}
                    indexPath={[...props.indexPath, index()]}
                  />
                )}
              </For>
            </TreeView.BranchContent>
          </TreeView.Branch>
        )}
      </Show>
    </TreeView.NodeProvider>
  );
}
