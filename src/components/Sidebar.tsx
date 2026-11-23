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
import Group from 'lucide-solid/icons/group';
import Library from 'lucide-solid/icons/library';
import Milestone from 'lucide-solid/icons/milestone';
import PanelTop from 'lucide-solid/icons/panel-top';
import Pencil from 'lucide-solid/icons/pencil';
import Plus from 'lucide-solid/icons/plus';
import Shapes from 'lucide-solid/icons/shapes';
import Trash2 from 'lucide-solid/icons/trash';
import TriangleAlert from 'lucide-solid/icons/triangle-exclamation-point';
import X from 'lucide-solid/icons/x';
import {
  createComputed,
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
import { createStore, reconcile } from 'solid-js/store';
import { Portal } from 'solid-js/web';
import {
  type DropTarget,
  dropAsset,
  dropFolder,
  dropNotes,
} from '../commands/app';
import { runCommand } from '../commands/registry';
import { settings } from '../state/settings';
import {
  activeAsset,
  activeNote,
  collapsedFolders,
  inZettelkasten,
  isNoteAddress,
  isViewable,
  noteById,
  noteLabel,
  openAsset,
  openNote,
  openNoteHere,
  sectionLabel,
  sections,
  sequenceOf,
  setFolderCollapsed,
  tree,
  zettelkasten,
} from '../state/workspace';
import type {
  AssetNode,
  FolderNode,
  NoteId,
  SectionNode,
  TreeNode,
} from '../vault/api';
import { SyncIndicator } from './SyncSettings';
import { overlayScrollbar } from './scrollbars';

/** What a folder row shows (not its contents, which are its row's children). */
type FolderRow = Pick<FolderNode, 'name' | 'path' | 'kind' | 'warning'>;
/** What a note row shows (its next notes are its row's children). */
type NoteRow = Omit<TreeNode, 'children'>;
type SectionRow = Pick<SectionNode, 'first' | 'last' | 'name'>;

/**
 * Row data for Ark's tree: folders and notes share one collection. Rows
 * carry only what they show, so reconciling a new tree against them (by
 * `id`, which is unique across kinds) touches each row once.
 */
type Node =
  | {
      id: string;
      kind: 'folder';
      folder: FolderRow;
      depth: number;
      children: Node[];
    }
  | {
      id: string;
      kind: 'note';
      note: NoteRow;
      depth: number;
      children?: Node[];
    }
  | {
      id: string;
      kind: 'section';
      section: SectionRow;
      depth: number;
      children: Node[];
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
const SECTION_PREFIX = 'section:';
const assetId = (path: string) => ASSET_PREFIX + path;

function noteNodes(notes: TreeNode[], depth: number): Node[] {
  return notes.map(({ children, ...note }) => ({
    id: note.id,
    kind: 'note',
    note,
    depth,
    // Ark treats a node as a branch whenever it has a children array.
    children: children.length > 0 ? noteNodes(children, depth) : undefined,
  }));
}

/** Where a Zettelkasten row sorts: by its (first) sequence; notes without an address last. */
function sequenceKey(node: Node): number {
  if (node.kind === 'section') return node.section.first;
  if (node.kind === 'note') return sequenceOf(node.note.address) ?? Infinity;
  return Infinity;
}

/** Subfolders indent like a file tree; trains of thought don't. */
function folderContents(folder: FolderNode, depth: number): Node[] {
  // The Zettelkasten's section headings, between the sequences outside
  // them. A section's notes indent one level (a section is a grouping, like
  // a folder), so the sequences after it don't look like part of it; the
  // trains of thought within still don't indent.
  const sectioned = [
    ...folder.sections.map(
      (section): Node => ({
        id: SECTION_PREFIX + section.first,
        kind: 'section',
        section: {
          first: section.first,
          last: section.last,
          name: section.name,
        },
        depth,
        children: noteNodes(section.notes, depth + 1),
      }),
    ),
    ...noteNodes(folder.notes, depth),
  ].sort((a, b) => sequenceKey(a) - sequenceKey(b));
  return [
    ...folder.folders.map(
      (sub): Node => ({
        id: folderId(sub.path),
        kind: 'folder',
        folder: {
          name: sub.name,
          path: sub.path,
          kind: sub.kind,
          warning: sub.warning,
        },
        depth,
        children: folderContents(sub, depth + 1),
      }),
    ),
    ...sectioned,
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
    if ((node.kind === 'note' && node.children) || node.kind === 'section') {
      out.push(node.id);
    }
    noteBranchIds(node.children ?? [], out);
  }
  return out;
}

/** What the context menu acts on; menu commands read these. */
const [menuTarget, setMenuTarget] = createSignal<NoteId | null>(null);
const [menuFolder, setMenuFolder] = createSignal<string | null>(null);
const [menuAsset, setMenuAsset] = createSignal<string | null>(null);
const [menuSection, setMenuSection] = createSignal<number | null>(null);

export { menuAsset, menuFolder, menuSection, menuTarget };

/**
 * Notes marked with Shift-click or Shift+arrow, which the context menu,
 * dragging and (in the Zettelkasten) "Make section" act on together. A
 * plain click, arrow move or Escape clears them.
 */
const [marked, setMarked] = createSignal<ReadonlySet<NoteId>>(new Set());
let markAnchor: NoteId | null = null;

/** The notes the context menu acts on: the marked ones if it opened on one of them. */
export function menuNotes(): NoteId[] {
  const target = menuTarget();
  if (!target) return [];
  return marked().has(target) ? markedNotes() : [target];
}

/** The notes "Make section" acts on: the menu's notes, if all are addressed Zettelkasten notes. */
export function sectionCandidates(): NoteId[] {
  const notes = menuNotes();
  return notes.length > 0 && notes.every(inSequence) ? notes : [];
}

export const clearMarks = () => setMarked(new Set<NoteId>());

/** The marked notes that still exist. */
export const markedNotes = (): NoteId[] =>
  [...marked()].filter(id => noteById(id));

const inSequence = (id: NoteId) =>
  inZettelkasten(id) && isNoteAddress(noteById(id)?.address ?? null);

/** Marks the visible notes from the anchor (the last row clicked or moved to) to `id`. */
function markRun(tree: HTMLElement, id: NoteId) {
  const rows = [...tree.querySelectorAll<HTMLElement>('[data-note-id]')].map(
    row => row.dataset.noteId,
  );
  const from = markAnchor ? rows.indexOf(markAnchor) : -1;
  const to = rows.indexOf(id);
  if (from < 0 || to < 0) {
    markAnchor = id;
    setMarked(new Set([id]));
    return;
  }
  setMarked(
    new Set(
      rows
        .slice(Math.min(from, to), Math.max(from, to) + 1)
        .filter((row): row is NoteId => !!row),
    ),
  );
}

/** Every row the tree shows, in order: folded branches render none. */
const ROW = '[data-part="item"], [data-part="branch-control"]';

/** How long arrowing stays on a note before it opens, so holding a key doesn't open each one. */
const OPEN_DELAY_MS = 100;

/**
 * Clicks on rows that the tree's selection doesn't cover, in the capture
 * phase so they never reach it (which would open the note in place):
 * Cmd/Ctrl-click and middle-click open a note in a new tab, and Shift-click
 * marks the run of notes from the last one clicked (or marked) to this one.
 * Keys: Up and Down (and j and k with Vim on) move to the previous or next
 * row and open a note there in place, with Shift they mark instead.
 */
function rowClicks(tree: HTMLElement) {
  const onClick = (event: MouseEvent) => {
    const target = event.target as Element;
    const id = target.closest<HTMLElement>('[data-note-id]')?.dataset.noteId;
    if (target.closest('.fold-toggle')) return;
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey) {
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      openNote(id);
      return;
    }
    if (!event.shiftKey) {
      if (marked().size > 0) clearMarks();
      markAnchor = id ?? null;
      return;
    }
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    markRun(tree, id);
  };
  const onAuxClick = (event: MouseEvent) => {
    if (event.button !== 1) return;
    const id = (event.target as Element).closest<HTMLElement>('[data-note-id]')
      ?.dataset.noteId;
    if (!id) return;
    event.preventDefault();
    openNote(id);
  };
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && marked().size > 0) clearMarks();
    if (event.defaultPrevented || event.metaKey || event.ctrlKey) return;
    if (event.altKey) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const vim = settings.vim;
    const step =
      key === 'ArrowDown' || (vim && key === 'j')
        ? 1
        : key === 'ArrowUp' || (vim && key === 'k')
          ? -1
          : 0;
    if (step === 0) return;
    const current = (event.target as Element).closest<HTMLElement>(ROW);
    if (!current || !tree.contains(current)) return;
    // Ark's tree skips events already handled (its arrows only move focus, and j and k would typeahead).
    event.preventDefault();
    const rows = [...tree.querySelectorAll<HTMLElement>(ROW)];
    const next = rows[rows.indexOf(current) + step];
    if (!next) return;
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
    const id = next.dataset.noteId;
    clearTimeout(openTimer);
    if (event.shiftKey) {
      if (marked().size === 0) markAnchor = current.dataset.noteId ?? null;
      if (id) markRun(tree, id);
      return;
    }
    if (marked().size > 0) clearMarks();
    markAnchor = id ?? null;
    if (id) openTimer = setTimeout(() => void openNoteHere(id), OPEN_DELAY_MS);
  };
  tree.addEventListener('click', onClick, { capture: true });
  tree.addEventListener('auxclick', onAuxClick);
  tree.addEventListener('keydown', onKey, { capture: true });
  return () => {
    clearTimeout(openTimer);
    tree.removeEventListener('click', onClick, { capture: true });
    tree.removeEventListener('auxclick', onAuxClick);
    tree.removeEventListener('keydown', onKey, { capture: true });
  };
}

/** How far the pointer moves before a press on a row becomes a drag. */
const DRAG_PX = 5;

/** What a drag in the sidebar carries. */
type Dragged = { notes: NoteId[] } | { asset: string } | { folder: string };

/** Whether `path` is `folder` or inside it. */
const within = (path: string, folder: string) =>
  path === folder || path.startsWith(`${folder}/`);

/**
 * Where `dragged` would go if dropped on `over` (a row, or null for the
 * tree's empty space, the vault root), or null where it can't go. Only a
 * single note can become a Zettelkasten note's next note or aside; nothing
 * goes into its own folder or below itself, no folder into the
 * Zettelkasten, and the Zettelkasten only to the root.
 */
function dropTargetFor(
  dragged: Dragged,
  over: HTMLElement | null,
): DropTarget | null {
  const zk = zettelkasten()?.path;
  const onNote = over?.dataset.noteId;
  if (onNote && 'notes' in dragged && dragged.notes.length === 1) {
    return dragged.notes[0] === onNote ? null : { note: onNote };
  }
  const folder = onNote
    ? noteById(onNote)?.folder
    : over?.dataset.section !== undefined
      ? zk
      : over?.dataset.folderPath !== undefined
        ? over.dataset.folderPath
        : over?.dataset.assetPath !== undefined
          ? parentPath(over.dataset.assetPath)
          : '';
  if (folder === undefined) return null;
  if ('notes' in dragged) {
    if (dragged.notes.length > 1 && folder === zk) return null;
    return { folder };
  }
  if ('folder' in dragged) {
    const path = dragged.folder;
    const invalid =
      folder === zk ||
      within(folder, path) ||
      folder === parentPath(path) ||
      (path === zk && folder !== '');
    return invalid ? null : { folder };
  }
  return { folder };
}

/**
 * Dragging notes, files and folders onto folders or rows to move them
 * (pointer events: HTML5 drag and drop is unreliable in the webview). A
 * marked note drags every marked note. The row under the pointer is marked
 * when the drop would do something; the click that ends a drag is
 * swallowed, so it doesn't open (or fold) the row.
 */
function treeDragging(tree: HTMLElement) {
  const rowAt = (x: number, y: number) =>
    document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>(
        '[data-folder-path], [data-note-id], [data-asset-path], [data-section]',
      );
  let highlighted: HTMLElement | null = null;
  const highlight = (el: HTMLElement | null) => {
    if (el === highlighted) return;
    highlighted?.classList.remove('drop-target');
    el?.classList.add('drop-target');
    highlighted = el;
  };

  const onDown = (down: PointerEvent) => {
    if (down.button !== 0 || down.shiftKey) return;
    const row = (down.target as Element).closest<HTMLElement>(
      '[data-note-id], [data-asset-path], [data-folder-path]',
    );
    if (!row || (down.target as Element).closest('.fold-toggle')) return;
    const note = row.dataset.noteId;
    const dragged: Dragged = note
      ? { notes: marked().has(note) ? [...marked()] : [note] }
      : row.dataset.assetPath !== undefined
        ? { asset: row.dataset.assetPath }
        : { folder: row.dataset.folderPath ?? '' };
    const sources = (): HTMLElement[] =>
      'notes' in dragged && dragged.notes.length > 1
        ? [...tree.querySelectorAll<HTMLElement>('.tree-item.marked')]
        : [row];
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
          'notes' in dragged
            ? dragged.notes.length > 1
              ? `${dragged.notes.length} notes`
              : noteLabel(noteById(dragged.notes[0]))
            : fileName('asset' in dragged ? dragged.asset : dragged.folder);
        document.body.appendChild(ghost);
        for (const el of sources()) el.classList.add('drag-source');
      }
      dragging = true;
      tree.classList.add('dragging');
      if (ghost) {
        ghost.style.left = `${move.clientX + 12}px`;
        ghost.style.top = `${move.clientY + 8}px`;
      }
      const over = rowAt(move.clientX, move.clientY) ?? null;
      const inTree = over
        ? tree.contains(over)
        : tree.contains(document.elementFromPoint(move.clientX, move.clientY));
      target = over !== row && inTree ? dropTargetFor(dragged, over) : null;
      highlight(target ? over : null);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      tree.classList.remove('dragging');
      for (const el of sources()) el.classList.remove('drag-source');
      ghost?.remove();
      highlight(null);
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
        'notes' in dragged
          ? dropNotes(dragged.notes, target)
          : 'asset' in dragged
            ? dropAsset(dragged.asset, target)
            : dropFolder(dragged.folder, target);
      void done.catch(error => console.error('could not move:', error));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  tree.addEventListener('pointerdown', onDown);
  return () => tree.removeEventListener('pointerdown', onDown);
}

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

const parentPath = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

const sameStrings = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

export function Sidebar() {
  // A store reconciled by id, so a refreshed tree keeps each row's object
  // (and `<For>` its mounted row) and updates only the fields that changed;
  // new objects would remount every row.
  const [nodes, setNodes] = createStore<Node[]>([]);
  createComputed(() =>
    setNodes(reconcile(folderContents(tree(), 0), { key: 'id' })),
  );
  const collection = createMemo(() =>
    createTreeCollection<Node>({
      nodeToValue: node => node.id,
      nodeToString: node =>
        node.kind === 'folder'
          ? node.folder.name
          : node.kind === 'asset'
            ? node.asset.name
            : node.kind === 'section'
              ? sectionLabel(node.section)
              : noteLabel(node.note),
      rootNode: {
        id: 'root',
        kind: 'folder',
        folder: tree(),
        depth: 0,
        children: nodes,
      },
    }),
  );

  // Sections and trains of thought start unfolded; ones created later unfold as they appear.
  const [foldedNotes, setFoldedNotes] = createSignal<string[]>([]);
  // The same array while its contents are, so Ark doesn't recompute every
  // row's state after a refresh that changed no branch.
  const expanded = createMemo(
    () => {
      const folded = new Set(foldedNotes());
      const collapsed = new Set(collapsedFolders());
      return [
        ...noteBranchIds(nodes).filter(id => !folded.has(id)),
        ...[tree(), ...allSubfolders(tree())]
          .filter(f => !collapsed.has(f.path))
          .map(f => folderId(f.path)),
      ];
    },
    undefined,
    { equals: sameStrings },
  );

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
      '[data-note-id], [data-folder-path], [data-asset-path], [data-section]',
    );
    const note = row?.dataset.noteId;
    // Like a file manager: a menu on an unmarked note is for that note alone.
    if (note && !marked().has(note) && marked().size > 0) clearMarks();
    setMenuTarget(note ?? null);
    setMenuFolder(row?.dataset.folderPath ?? null);
    setMenuAsset(row?.dataset.assetPath ?? null);
    const section = row?.dataset.section;
    setMenuSection(section === undefined ? null : Number(section));
  };

  const targetNote = () => noteById(menuTarget() ?? '');
  const targetSection = () => sections().find(s => s.first === menuSection());
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
            onCleanup(rowClicks(tree));
          }
        })
      }
    >
      <div class="sidebar-header">
        <span>Notes</span>
        <div class="sidebar-actions">
          <SyncIndicator />
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
              setMenuSection(null);
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
              if (
                !id ||
                id.startsWith(FOLDER_PREFIX) ||
                id.startsWith(SECTION_PREFIX)
              ) {
                return;
              }
              if (id.startsWith(ASSET_PREFIX)) {
                void openAsset(id.slice(ASSET_PREFIX.length));
              } else {
                void openNoteHere(id);
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
                      <FilePlus size={14} /> New note…
                    </Menu.Item>
                    <Menu.Item value="folder.new">
                      <FolderPlus size={14} /> New folder…
                    </Menu.Item>
                  </>
                }
              >
                <Match when={targetNote()}>
                  {note => (
                    <NoteMenu
                      addressed={!!note().address && inZettelkasten(note().id)}
                      filed={inZettelkasten(note().id)}
                      count={menuNotes().length}
                      sequences={sectionCandidates()}
                    />
                  )}
                </Match>
                <Match when={targetFolder()}>
                  {folder => <FolderMenu folder={folder()} />}
                </Match>
                <Match when={menuAsset()}>
                  <AssetMenu />
                </Match>
                <Match when={targetSection()}>
                  <SectionMenu />
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

function NoteMenu(props: {
  addressed: boolean;
  filed: boolean;
  /** How many notes the menu acts on: more than one when opened on marked notes. */
  count: number;
  /** The notes whose sequences "Make section" would name. */
  sequences: NoteId[];
}) {
  const range = () => {
    const numbers = props.sequences
      .map(id => sequenceOf(noteById(id)?.address ?? null))
      .filter((n): n is number => n !== undefined);
    const first = Math.min(...numbers);
    const last = Math.max(...numbers);
    return first === last ? `sequence ${first}` : `sequences ${first}–${last}`;
  };
  const single = () => props.count === 1;
  return (
    <>
      <Show when={single()}>
        <Menu.Item value="menu.openInNewTab">
          <PanelTop size={14} /> Open in new tab
        </Menu.Item>
        <Menu.Separator class="menu-separator" />
      </Show>
      <Show when={props.sequences.length > 0}>
        <Menu.Item value="menu.markSection">
          <Group size={14} /> Make {range()} a section…
        </Menu.Item>
        <Menu.Separator class="menu-separator" />
      </Show>
      <Show when={single() && props.addressed}>
        <Menu.Item value="menu.next">
          <CornerDownRight size={14} /> New next note…
        </Menu.Item>
        <Menu.Item value="menu.aside">
          <ArrowDown size={14} /> New aside…
        </Menu.Item>
        <Menu.Separator class="menu-separator" />
      </Show>
      <Show when={single()}>
        <Menu.Item value="menu.moveToAddress" disabled={!zettelkasten()}>
          <Milestone size={14} />{' '}
          {props.filed ? 'Move to address…' : 'File into Zettelkasten…'}
        </Menu.Item>
      </Show>
      <Menu.Item value="menu.moveToFolder">
        <FolderInput size={14} />{' '}
        {single() ? 'Move to folder…' : `Move ${props.count} notes to folder…`}
      </Menu.Item>
      <Show when={single()}>
        <Menu.Item value="menu.changeKind">
          <Shapes size={14} /> Change kind…
        </Menu.Item>
        <Menu.Separator class="menu-separator" />
        <Menu.Item value="menu.rename">
          <Pencil size={14} /> Rename…
        </Menu.Item>
      </Show>
      <Show when={!single()}>
        <Menu.Separator class="menu-separator" />
      </Show>
      <Menu.Item value="menu.delete" class="danger">
        <Trash2 size={14} />{' '}
        {single() ? 'Delete' : `Delete ${props.count} notes`}
      </Menu.Item>
    </>
  );
}

function FolderMenu(props: { folder: FolderNode }) {
  const isZettelkasten = () => props.folder.kind === 'zettelkasten';
  return (
    <>
      <Menu.Item value="folder.menu.newNote">
        <FilePlus size={14} /> New note…
      </Menu.Item>
      <Show when={!isZettelkasten()}>
        <Menu.Item value="folder.menu.newFolder">
          <FolderPlus size={14} /> New folder…
        </Menu.Item>
      </Show>
      <Show when={!zettelkasten()}>
        <Menu.Item value="folder.menu.setZettelkasten">
          <Library size={14} /> Use as Zettelkasten
        </Menu.Item>
      </Show>
      <Menu.Separator class="menu-separator" />
      <Menu.Item value="folder.menu.rename">
        <FolderPen size={14} /> Rename folder…
      </Menu.Item>
      <Show when={!isZettelkasten()}>
        <Menu.Item value="folder.menu.delete" class="danger">
          <FolderX size={14} /> Delete folder
        </Menu.Item>
      </Show>
    </>
  );
}

function SectionMenu() {
  return (
    <>
      <Menu.Item value="section.menu.rename">
        <Pencil size={14} /> Rename section…
      </Menu.Item>
      <Menu.Item value="section.menu.unmark">
        <X size={14} /> Remove section heading
      </Menu.Item>
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
        <FolderInput size={14} /> Move to folder…
      </Menu.Item>
      <Menu.Item value="asset.menu.rename">
        <Pencil size={14} /> Rename…
      </Menu.Item>
      <Menu.Item value="asset.menu.delete" class="danger">
        <Trash2 size={14} /> Delete
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
        <Match when={props.node.kind === 'section' && props.node}>
          {node => (
            <SectionView
              node={node() as Extract<Node, { kind: 'section' }>}
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

/** A branch's rows, rendered only while it's unfolded: folded ones cost nothing.
    A folder's (`guideDepth`, its own depth) get an indent guide below its icon. */
function Children(props: {
  nodes: Node[];
  indexPath: number[];
  guideDepth?: number;
}) {
  return (
    <TreeView.BranchContent
      class={
        props.guideDepth === undefined
          ? 'tree-children'
          : 'tree-children indent-guide'
      }
      style={
        props.guideDepth === undefined
          ? undefined
          : { '--depth': String(props.guideDepth) }
      }
    >
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
      <Children
        nodes={props.node.children}
        indexPath={props.indexPath}
        guideDepth={settings.indentGuides ? props.node.depth : undefined}
      />
    </TreeView.Branch>
  );
}

/** A Zettelkasten section: a heading over a run of sequences, whose row folds their notes. */
function SectionView(props: {
  node: Extract<Node, { kind: 'section' }>;
  indexPath: number[];
  style: JSX.CSSProperties;
}) {
  const section = () => props.node.section;
  return (
    <TreeView.Branch>
      <TreeView.BranchControl
        class="tree-item section-row"
        style={props.style}
        data-section={section().first}
      >
        <TreeView.BranchTrigger class="folder-toggle">
          <span class="section-number">
            {section().first === section().last
              ? section().first
              : `${section().first}–${section().last}`}
          </span>
          <span class="note-title section-name">{section().name}</span>
        </TreeView.BranchTrigger>
      </TreeView.BranchControl>
      <Children
        nodes={props.node.children}
        indexPath={props.indexPath}
        guideDepth={settings.indentGuides ? props.node.depth : undefined}
      />
    </TreeView.Branch>
  );
}

function NoteView(props: {
  node: Extract<Node, { kind: 'note' }>;
  indexPath: number[];
  style: JSX.CSSProperties;
}) {
  const note = () => props.node.note;
  const rowClass = () =>
    marked().has(note().id) ? 'tree-item marked' : 'tree-item';
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
          class={rowClass()}
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
            class={rowClass()}
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
