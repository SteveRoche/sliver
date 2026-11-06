import { createTreeCollection, Menu, TreeView } from '@ark-ui/solid';
import ArrowDown from 'lucide-solid/icons/arrow-down';
import Copy from 'lucide-solid/icons/copy';
import CornerDownRight from 'lucide-solid/icons/corner-down-right';
import ExternalLink from 'lucide-solid/icons/external-link';
import File from 'lucide-solid/icons/file';
import FileImage from 'lucide-solid/icons/file-image';
import FilePlus from 'lucide-solid/icons/file-plus';
import Folder from 'lucide-solid/icons/folder';
import FolderInput from 'lucide-solid/icons/folder-input';
import FolderOpen from 'lucide-solid/icons/folder-open';
import FolderPen from 'lucide-solid/icons/folder-pen';
import FolderPlus from 'lucide-solid/icons/folder-plus';
import FolderX from 'lucide-solid/icons/folder-x';
import Library from 'lucide-solid/icons/library';
import Milestone from 'lucide-solid/icons/milestone';
import Pencil from 'lucide-solid/icons/pencil';
import Plus from 'lucide-solid/icons/plus';
import Shapes from 'lucide-solid/icons/shapes';
import Trash2 from 'lucide-solid/icons/trash';
import TriangleAlert from 'lucide-solid/icons/triangle-exclamation-point';
import {
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import { type DropTarget, dropAsset, dropNote } from '../commands/app';
import { runCommand } from '../commands/registry';
import {
  activeAsset,
  activeNote,
  collapsedFolders,
  inZettelkasten,
  isViewable,
  noteById,
  noteLabel,
  openAsset,
  openNote,
  setFolderCollapsed,
  tree,
  zettelkasten,
} from '../state/workspace';
import type { AssetNode, FolderNode, NoteId, TreeNode } from '../vault/api';
import { overlayScrollbar } from './scrollbars';

/** Row data for Ark's tree: folders and notes share one collection. */
type Node =
  | {
      id: string;
      kind: 'folder';
      folder: FolderNode;
      depth: number;
      children: Node[];
    }
  | {
      id: string;
      kind: 'note';
      note: TreeNode;
      depth: number;
      children?: Node[];
    }
  | {
      id: string;
      kind: 'asset';
      asset: AssetNode;
      depth: number;
      children?: undefined;
    };

const FOLDER_PREFIX = 'folder:';
const folderId = (path: string) => FOLDER_PREFIX + path;
const ASSET_PREFIX = 'asset:';
const assetId = (path: string) => ASSET_PREFIX + path;

function noteNodes(notes: TreeNode[], depth: number): Node[] {
  return notes.map(note => ({
    id: note.id,
    kind: 'note',
    note,
    depth,
    // Ark treats a node as a branch whenever it has a children array.
    children:
      note.children.length > 0 ? noteNodes(note.children, depth) : undefined,
  }));
}

/** Subfolders indent like a file tree; trains of thought don't. */
function folderContents(folder: FolderNode, depth: number): Node[] {
  return [
    ...folder.folders.map(
      (sub): Node => ({
        id: folderId(sub.path),
        kind: 'folder',
        folder: sub,
        depth,
        children: folderContents(sub, depth + 1),
      }),
    ),
    ...noteNodes(folder.notes, depth),
    ...folder.assets.map(
      (asset): Node => ({
        id: assetId(asset.path),
        kind: 'asset',
        asset,
        depth,
      }),
    ),
  ];
}

function noteBranchIds(nodes: Node[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === 'note' && node.children) out.push(node.id);
    noteBranchIds(node.children ?? [], out);
  }
  return out;
}

/** What the context menu acts on; menu commands read these. */
const [menuTarget, setMenuTarget] = createSignal<NoteId | null>(null);
const [menuFolder, setMenuFolder] = createSignal<string | null>(null);
const [menuAsset, setMenuAsset] = createSignal<string | null>(null);

export { menuAsset, menuFolder, menuTarget };

/** How far the pointer moves before a press on a row becomes a drag. */
const DRAG_PX = 5;

/**
 * Dragging notes and files onto folders or note rows to move them (pointer
 * events: HTML5 drag and drop is unreliable in the webview). The row under
 * the pointer is marked; the click that ends a drag is swallowed, so it
 * doesn't open the row.
 */
function treeDragging(tree: HTMLElement) {
  const rowAt = (x: number, y: number) =>
    document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>(
        '[data-folder-path], [data-note-id], [data-asset-path]',
      );
  let marked: HTMLElement | null = null;
  const mark = (el: HTMLElement | null) => {
    if (el === marked) return;
    marked?.classList.remove('drop-target');
    el?.classList.add('drop-target');
    marked = el;
  };

  const onDown = (down: PointerEvent) => {
    if (down.button !== 0) return;
    const row = (down.target as Element).closest<HTMLElement>(
      '[data-note-id], [data-asset-path]',
    );
    if (!row || (down.target as Element).closest('.fold-toggle')) return;
    const dragged: { note: NoteId } | { asset: string } = row.dataset.noteId
      ? { note: row.dataset.noteId }
      : { asset: row.dataset.assetPath ?? '' };
    let dragging = false;
    let target: DropTarget | null = null;
    let ghost: HTMLElement | undefined;

    const onMove = (move: PointerEvent) => {
      if (
        !dragging &&
        Math.hypot(move.clientX - down.clientX, move.clientY - down.clientY) <
          DRAG_PX
      ) {
        return;
      }
      if (!dragging) {
        // Like a tab dragged off its bar: the row's label follows the pointer.
        ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.textContent =
          'note' in dragged
            ? noteLabel(noteById(dragged.note))
            : dragged.asset.slice(dragged.asset.lastIndexOf('/') + 1);
        document.body.appendChild(ghost);
        row.classList.add('drag-source');
      }
      dragging = true;
      tree.classList.add('dragging');
      if (ghost) {
        ghost.style.left = `${move.clientX + 12}px`;
        ghost.style.top = `${move.clientY + 8}px`;
      }
      const over = rowAt(move.clientX, move.clientY);
      const inTree = over
        ? tree.contains(over)
        : tree.contains(document.elementFromPoint(move.clientX, move.clientY));
      if (over === row || !inTree) {
        target = null;
        mark(null);
        return;
      }
      target = over?.dataset.noteId
        ? { note: over.dataset.noteId }
        : over?.dataset.folderPath !== undefined
          ? { folder: over.dataset.folderPath }
          : over?.dataset.assetPath !== undefined
            ? { folder: parentPath(over.dataset.assetPath) }
            : { folder: '' };
      mark(over ?? null);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      tree.classList.remove('dragging');
      row.classList.remove('drag-source');
      ghost?.remove();
      mark(null);
      if (!dragging) return;
      // The click that follows the release would open the row.
      window.addEventListener(
        'click',
        event => {
          event.stopPropagation();
          event.preventDefault();
        },
        { capture: true, once: true },
      );
      if (!target) return;
      const done =
        'note' in dragged
          ? dropNote(dragged.note, target)
          : dropAsset(dragged.asset, target);
      void done.catch(error => console.error('could not move:', error));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  tree.addEventListener('pointerdown', onDown);
  return () => tree.removeEventListener('pointerdown', onDown);
}

const parentPath = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

export function Sidebar() {
  const nodes = createMemo(() => folderContents(tree(), 0));
  const collection = createMemo(() =>
    createTreeCollection<Node>({
      nodeToValue: node => node.id,
      nodeToString: node =>
        node.kind === 'folder'
          ? node.folder.name
          : node.kind === 'asset'
            ? node.asset.name
            : noteLabel(node.note),
      rootNode: {
        id: 'root',
        kind: 'folder',
        folder: tree(),
        depth: 0,
        children: nodes(),
      },
    }),
  );

  // Trains of thought start unfolded; ones created later unfold as they appear.
  const [foldedNotes, setFoldedNotes] = createSignal<string[]>([]);
  const expanded = createMemo(() => {
    const folded = new Set(foldedNotes());
    const collapsed = new Set(collapsedFolders());
    return [
      ...noteBranchIds(nodes()).filter(id => !folded.has(id)),
      ...[tree(), ...allSubfolders(tree())]
        .filter(f => !collapsed.has(f.path))
        .map(f => folderId(f.path)),
    ];
  });

  const onExpandedChange = (open: string[]) => {
    const isOpen = new Set(open);
    const before = new Set(expanded());
    for (const id of new Set([...before, ...isOpen])) {
      if (before.has(id) === isOpen.has(id)) continue;
      if (id.startsWith(FOLDER_PREFIX)) {
        setFolderCollapsed(id.slice(FOLDER_PREFIX.length), !isOpen.has(id));
      } else {
        setFoldedNotes(list =>
          isOpen.has(id) ? list.filter(n => n !== id) : [...list, id],
        );
      }
    }
  };

  const onContextMenu = (event: MouseEvent) => {
    const row = (event.target as Element).closest<HTMLElement>(
      '[data-note-id], [data-folder-path], [data-asset-path]',
    );
    setMenuTarget(row?.dataset.noteId ?? null);
    setMenuFolder(row?.dataset.folderPath ?? null);
    setMenuAsset(row?.dataset.assetPath ?? null);
  };

  const targetNote = () => noteById(menuTarget() ?? '');
  const targetFolder = () =>
    allSubfolders(tree()).find(f => f.path === menuFolder());
  const isEmpty = () =>
    tree().folders.length === 0 &&
    tree().notes.length === 0 &&
    tree().assets.length === 0;
  const selected = () => {
    const note = activeNote();
    const asset = activeAsset();
    return note ? [note] : asset ? [assetId(asset)] : [];
  };

  return (
    <aside
      class="sidebar"
      ref={aside =>
        onMount(() => {
          const tree = aside.querySelector<HTMLElement>('.sidebar-tree');
          if (tree) {
            onCleanup(overlayScrollbar(tree));
            onCleanup(treeDragging(tree));
          }
        })
      }
    >
      <div class="sidebar-header">
        <span>Notes</span>
        <div class="sidebar-actions">
          <button
            type="button"
            class="icon-button"
            title="New folder"
            aria-label="New folder"
            onClick={() => runCommand('folder.new')}
          >
            <FolderPlus size={16} />
          </button>
          <button
            type="button"
            class="icon-button"
            title="New note"
            aria-label="New note"
            onClick={() => runCommand('note.new')}
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
      <Menu.Root
        onSelect={details => runCommand(details.value)}
        onOpenChange={details => {
          if (!details.open) {
            queueMicrotask(() => {
              setMenuTarget(null);
              setMenuFolder(null);
              setMenuAsset(null);
            });
          }
        }}
      >
        {/* A div, not Ark's default button: a button centres its content. */}
        <Menu.ContextTrigger
          class="sidebar-tree"
          onContextMenu={onContextMenu}
          asChild={triggerProps => <div {...triggerProps()} />}
        >
          <TreeView.Root
            collection={collection()}
            selectionMode="single"
            selectedValue={selected()}
            onSelectionChange={details => {
              const id = details.selectedValue[0];
              if (!id || id.startsWith(FOLDER_PREFIX)) return;
              if (id.startsWith(ASSET_PREFIX)) {
                void openAsset(id.slice(ASSET_PREFIX.length));
              } else {
                openNote(id);
              }
            }}
            expandOnClick={false}
            expandedValue={expanded()}
            onExpandedChange={details =>
              onExpandedChange(details.expandedValue)
            }
          >
            <TreeView.Tree aria-label="Notes">
              <For each={collection().rootNode.children ?? []}>
                {(node, index) => (
                  <NodeView node={node} indexPath={[index()]} />
                )}
              </For>
            </TreeView.Tree>
          </TreeView.Root>
          <Show when={isEmpty()}>
            <p class="pane-message">No notes yet. Press + to create one.</p>
          </Show>
        </Menu.ContextTrigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content class="menu">
              <Switch
                fallback={
                  <>
                    <Menu.Item value="note.new">
                      <FilePlus size={14} /> New note
                    </Menu.Item>
                    <Menu.Item value="folder.new">
                      <FolderPlus size={14} /> New folder...
                    </Menu.Item>
                  </>
                }
              >
                <Match when={targetNote()}>
                  {note => (
                    <NoteMenu
                      addressed={!!note().address && inZettelkasten(note().id)}
                      filed={inZettelkasten(note().id)}
                    />
                  )}
                </Match>
                <Match when={targetFolder()}>
                  {folder => <FolderMenu folder={folder()} />}
                </Match>
                <Match when={menuAsset()}>
                  <AssetMenu />
                </Match>
              </Switch>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </aside>
  );
}

function allSubfolders(folder: FolderNode): FolderNode[] {
  return folder.folders.flatMap(f => [f, ...allSubfolders(f)]);
}

function NoteMenu(props: { addressed: boolean; filed: boolean }) {
  return (
    <>
      <Show when={props.addressed}>
        <Menu.Item value="menu.next">
          <CornerDownRight size={14} /> New next note
        </Menu.Item>
        <Menu.Item value="menu.aside">
          <ArrowDown size={14} /> New aside
        </Menu.Item>
        <Menu.Separator class="menu-separator" />
      </Show>
      <Menu.Item value="menu.moveToAddress" disabled={!zettelkasten()}>
        <Milestone size={14} />{' '}
        {props.filed ? 'Move to address...' : 'File into Zettelkasten...'}
      </Menu.Item>
      <Menu.Item value="menu.moveToFolder">
        <FolderInput size={14} /> Move to folder...
      </Menu.Item>
      <Menu.Item value="menu.changeKind">
        <Shapes size={14} /> Change kind...
      </Menu.Item>
      <Menu.Separator class="menu-separator" />
      <Menu.Item value="menu.rename">
        <Pencil size={14} /> Rename...
      </Menu.Item>
      <Menu.Item value="menu.delete" class="danger">
        <Trash2 size={14} /> Delete...
      </Menu.Item>
    </>
  );
}

function FolderMenu(props: { folder: FolderNode }) {
  const isZettelkasten = () => props.folder.kind === 'zettelkasten';
  return (
    <>
      <Menu.Item value="folder.menu.newNote">
        <FilePlus size={14} /> New note
      </Menu.Item>
      <Show when={!isZettelkasten()}>
        <Menu.Item value="folder.menu.newFolder">
          <FolderPlus size={14} /> New folder...
        </Menu.Item>
      </Show>
      <Show when={!zettelkasten()}>
        <Menu.Item value="folder.menu.setZettelkasten">
          <Library size={14} /> Use as Zettelkasten
        </Menu.Item>
      </Show>
      <Menu.Separator class="menu-separator" />
      <Menu.Item value="folder.menu.rename">
        <FolderPen size={14} /> Rename folder...
      </Menu.Item>
      <Show when={!isZettelkasten()}>
        <Menu.Item value="folder.menu.delete" class="danger">
          <FolderX size={14} /> Delete folder...
        </Menu.Item>
      </Show>
    </>
  );
}

function AssetMenu() {
  return (
    <>
      <Menu.Item value="asset.menu.open">
        <FileImage size={14} /> Open
      </Menu.Item>
      <Menu.Item value="asset.menu.openExternal">
        <ExternalLink size={14} /> Open in default app
      </Menu.Item>
      <Menu.Item value="asset.menu.copyPath">
        <Copy size={14} /> Copy path
      </Menu.Item>
      <Menu.Separator class="menu-separator" />
      <Menu.Item value="asset.menu.move">
        <FolderInput size={14} /> Move to folder...
      </Menu.Item>
      <Menu.Item value="asset.menu.rename">
        <Pencil size={14} /> Rename...
      </Menu.Item>
      <Menu.Item value="asset.menu.delete" class="danger">
        <Trash2 size={14} /> Delete...
      </Menu.Item>
    </>
  );
}

function Warning(props: { message: string | null; label: string }) {
  return (
    <Show when={props.message}>
      {message => (
        <span class="note-warning" title={message()}>
          <TriangleAlert size={12} aria-label={props.label} />
        </span>
      )}
    </Show>
  );
}

function NodeView(props: { node: Node; indexPath: number[] }) {
  const depthStyle = (): JSX.CSSProperties => ({
    '--depth': String(props.node.depth),
  });
  return (
    <TreeView.NodeProvider node={props.node} indexPath={props.indexPath}>
      <Switch>
        <Match when={props.node.kind === 'folder' && props.node}>
          {node => (
            <FolderView
              node={node() as Extract<Node, { kind: 'folder' }>}
              indexPath={props.indexPath}
              style={depthStyle()}
            />
          )}
        </Match>
        <Match when={props.node.kind === 'note' && props.node}>
          {node => (
            <NoteView
              node={node() as Extract<Node, { kind: 'note' }>}
              indexPath={props.indexPath}
              style={depthStyle()}
            />
          )}
        </Match>
        <Match when={props.node.kind === 'asset' && props.node}>
          {node => (
            <AssetRow
              asset={(node() as Extract<Node, { kind: 'asset' }>).asset}
              style={depthStyle()}
            />
          )}
        </Match>
      </Switch>
    </TreeView.NodeProvider>
  );
}

/** A branch's rows, rendered only while it's unfolded: folded ones cost nothing. */
function Children(props: { nodes: Node[]; indexPath: number[] }) {
  return (
    <TreeView.BranchContent class="tree-children">
      <TreeView.NodeContext>
        {node => (
          <Show when={node().expanded}>
            <For each={props.nodes}>
              {(child, index) => (
                <NodeView
                  node={child}
                  indexPath={[...props.indexPath, index()]}
                />
              )}
            </For>
          </Show>
        )}
      </TreeView.NodeContext>
    </TreeView.BranchContent>
  );
}

function FolderView(props: {
  node: Extract<Node, { kind: 'folder' }>;
  indexPath: number[];
  style: JSX.CSSProperties;
}) {
  const folder = () => props.node.folder;
  return (
    <TreeView.Branch>
      <TreeView.BranchControl
        class="tree-item folder-row"
        style={props.style}
        data-folder-path={folder().path}
      >
        {/* The whole row folds: a folder has nothing to open. */}
        <TreeView.BranchTrigger class="folder-toggle">
          <TreeView.NodeContext>
            {node => (
              <span class="folder-icon">
                <Switch>
                  <Match when={folder().kind === 'zettelkasten'}>
                    <Library size={14} aria-label="Zettelkasten" />
                  </Match>
                  <Match when={node().expanded}>
                    <FolderOpen size={14} />
                  </Match>
                  <Match when={true}>
                    <Folder size={14} />
                  </Match>
                </Switch>
              </span>
            )}
          </TreeView.NodeContext>
          <span class="note-title">{folder().name}</span>
          <Warning message={folder().warning} label="Folder warning" />
        </TreeView.BranchTrigger>
      </TreeView.BranchControl>
      <Children nodes={props.node.children} indexPath={props.indexPath} />
    </TreeView.Branch>
  );
}

function NoteView(props: {
  node: Extract<Node, { kind: 'note' }>;
  indexPath: number[];
  style: JSX.CSSProperties;
}) {
  const note = () => props.node.note;
  const title = () => (
    <>
      <span class="note-title">{note().title ?? 'Untitled'}</span>
      <Warning message={note().headerError} label="Header error" />
      <Warning message={note().warning} label="Note warning" />
    </>
  );

  return (
    <Show
      when={props.node.children}
      fallback={
        <TreeView.Item
          class="tree-item"
          style={props.style}
          data-note-id={note().id}
        >
          <TreeView.ItemText class="note-label">
            <Show when={note().address}>
              <span class="note-address">{note().address}</span>
            </Show>
            {title()}
          </TreeView.ItemText>
        </TreeView.Item>
      }
    >
      {children => (
        <TreeView.Branch>
          <TreeView.BranchControl
            class="tree-item"
            style={props.style}
            data-note-id={note().id}
          >
            {/* Only the address folds; the rest of the row opens the note.
                Branches always have an address: only addressed notes have next notes. */}
            <TreeView.NodeContext>
              {node => (
                <TreeView.BranchTrigger
                  class="note-address fold-toggle"
                  title={node().expanded ? 'Fold' : 'Unfold'}
                >
                  {note().address}
                </TreeView.BranchTrigger>
              )}
            </TreeView.NodeContext>
            <TreeView.BranchText class="note-label">
              {title()}
            </TreeView.BranchText>
          </TreeView.BranchControl>
          <Children nodes={children()} indexPath={props.indexPath} />
        </TreeView.Branch>
      )}
    </Show>
  );
}

function AssetRow(props: { asset: AssetNode; style: JSX.CSSProperties }) {
  return (
    <TreeView.Item
      class="tree-item asset-row"
      style={props.style}
      data-asset-path={props.asset.path}
    >
      <TreeView.ItemText class="note-label">
        <span class="asset-icon">
          <Show
            when={isViewable(props.asset.path)}
            fallback={<File size={14} />}
          >
            <FileImage size={14} />
          </Show>
        </span>
        <span class="note-title">{props.asset.name}</span>
      </TreeView.ItemText>
    </TreeView.Item>
  );
}
