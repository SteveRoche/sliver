import type { NoteId } from '../vault/api';

/**
 * The editor area's layout: a tree of splits whose leaves are panes. A pane
 * has its own tabs and shows its active note as an editor, a preview or
 * both. The helpers that change the tree mutate it in place, for use inside
 * a store's `produce`.
 */

/** An editor tab; like in Obsidian it can be empty (Mod+T) until a note is opened in it. */
export interface Tab {
  key: string;
  note: NoteId | null;
}

/** What a pane shows of its note: editor and preview, preview only, or editor only. */
export type ViewMode = 'edit' | 'read' | 'source';

export interface Pane {
  kind: 'pane';
  id: string;
  tabs: Tab[];
  /** Key of the active tab. */
  active: string | null;
  mode: ViewMode;
  /** Editor and preview sizes (flex weights) when both show. */
  sizes: number[];
}

export interface Split {
  kind: 'split';
  id: string;
  /** `row` puts children side by side, `column` one above the other. */
  direction: 'row' | 'column';
  children: LayoutNode[];
  /** Flex weights, one per child. */
  sizes: number[];
}

export type LayoutNode = Pane | Split;

/** Where a tab dropped on a pane goes: beside it, or into it (`center`). */
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

let nextId = 0;
export const newId = (prefix: string) => `${prefix}-${nextId++}`;

export const newPane = (tabs: Tab[] = [], active: string | null = null) =>
  ({
    kind: 'pane',
    id: newId('pane'),
    tabs,
    active,
    mode: 'edit',
    sizes: [50, 50],
  }) satisfies Pane;

/** Every pane, depth first (left to right, top to bottom). */
export function panes(node: LayoutNode): Pane[] {
  return node.kind === 'pane' ? [node] : node.children.flatMap(panes);
}

export const findPane = (root: LayoutNode, id: string) =>
  panes(root).find((p) => p.id === id);

export const paneOfTab = (root: LayoutNode, key: string) =>
  panes(root).find((p) => p.tabs.some((t) => t.key === key));

export const paneNote = (pane: Pane): NoteId | null =>
  pane.tabs.find((t) => t.key === pane.active)?.note ?? null;

/** The split holding `id` and its index there; none for the root. */
function parentOf(
  node: LayoutNode,
  id: string,
): { parent: Split; index: number } | undefined {
  if (node.kind === 'pane') return undefined;
  const index = node.children.findIndex((c) => c.id === id);
  if (index >= 0) return { parent: node, index };
  for (const child of node.children) {
    const found = parentOf(child, id);
    if (found) return found;
  }
  return undefined;
}

/** Puts `pane` beside the pane `targetId` on its `edge` side. */
export function insertBeside(
  state: { root: LayoutNode },
  targetId: string,
  edge: Exclude<DropZone, 'center'>,
  pane: Pane,
) {
  const direction = edge === 'left' || edge === 'right' ? 'row' : 'column';
  const after = edge === 'right' || edge === 'bottom';
  const found = parentOf(state.root, targetId);
  if (found && found.parent.direction === direction) {
    // Same direction as the split it's in: become a sibling, halving the target.
    const { parent, index } = found;
    const half = parent.sizes[index] / 2;
    parent.sizes[index] = half;
    const at = after ? index + 1 : index;
    parent.children.splice(at, 0, pane);
    parent.sizes.splice(at, 0, half);
    return;
  }
  const target = found ? found.parent.children[found.index] : state.root;
  const split: Split = {
    kind: 'split',
    id: newId('split'),
    direction,
    children: after ? [target, pane] : [pane, target],
    sizes: [50, 50],
  };
  if (found) found.parent.children[found.index] = split;
  else state.root = split;
}

/**
 * Removes pane `id`, folding a split left with one child into its parent.
 * The last pane is never removed.
 */
export function removePane(state: { root: LayoutNode }, id: string) {
  const found = parentOf(state.root, id);
  if (!found) return;
  const { parent, index } = found;
  parent.children.splice(index, 1);
  parent.sizes.splice(index, 1);
  if (parent.children.length > 1) return;
  const only = parent.children[0];
  const grand = parentOf(state.root, parent.id);
  if (!grand) {
    state.root = only;
  } else if (
    only.kind === 'split' &&
    only.direction === grand.parent.direction
  ) {
    // The survivor splits the same way as its new parent: merge it in.
    const weight = grand.parent.sizes[grand.index];
    const total = only.sizes.reduce((a, b) => a + b, 0) || 1;
    grand.parent.children.splice(grand.index, 1, ...only.children);
    grand.parent.sizes.splice(
      grand.index,
      1,
      ...only.sizes.map((s) => (s / total) * weight),
    );
  } else {
    grand.parent.children[grand.index] = only;
  }
}

/** The layout as saved in `workspace.json`: tabs by note, no ids. */
export type SavedNode =
  | {
      kind: 'pane';
      tabs: (NoteId | null)[];
      active: number;
      mode: ViewMode;
      sizes: number[];
    }
  | {
      kind: 'split';
      direction: 'row' | 'column';
      sizes: number[];
      children: SavedNode[];
    };

export function save(node: LayoutNode): SavedNode {
  if (node.kind === 'pane') {
    return {
      kind: 'pane',
      tabs: node.tabs.map((t) => t.note),
      active: node.tabs.findIndex((t) => t.key === node.active),
      mode: node.mode,
      sizes: [...node.sizes],
    };
  }
  return {
    kind: 'split',
    direction: node.direction,
    sizes: [...node.sizes],
    children: node.children.map(save),
  };
}

/**
 * Rebuilds a saved layout. `keep` filters out notes that no longer exist;
 * panes left without tabs are dropped (unless it's the only one).
 */
export function restore(
  saved: SavedNode,
  keep: (id: NoteId) => boolean,
  newTabKey: () => string,
): LayoutNode {
  const build = (node: SavedNode): LayoutNode | null => {
    if (node.kind === 'pane') {
      const tabs = node.tabs
        .filter((id) => id === null || keep(id))
        .map((note) => ({ key: newTabKey(), note }));
      if (tabs.length === 0) return null;
      const wanted = node.tabs[node.active];
      const active =
        tabs.find((t) => t.note === wanted && wanted !== undefined) ?? tabs[0];
      return {
        ...newPane(tabs, active.key),
        mode: ['edit', 'read', 'source'].includes(node.mode)
          ? node.mode
          : 'edit',
        sizes: node.sizes?.length === 2 ? node.sizes : [50, 50],
      };
    }
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, i) => {
      const built = build(child);
      if (built) {
        children.push(built);
        sizes.push(node.sizes?.[i] ?? 50);
      }
    });
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return {
      kind: 'split',
      id: newId('split'),
      direction: node.direction === 'column' ? 'column' : 'row',
      children,
      sizes,
    };
  };
  return build(saved) ?? newPane();
}
