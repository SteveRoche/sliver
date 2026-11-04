import type { EditorView } from "@codemirror/view";
import { createMemo, createRoot, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { type LivePreview, livePreview } from "../typst/client";
import { typst } from "../typst/instance";
import type { CompileResult } from "../typst/protocol";
import {
  autosave,
  type NoteId,
  type NoteSummary,
  type Placement,
  type TreeNode,
  vault,
} from "../vault/api";
import { settings } from "./settings";

/** One open editor tab: its text, live preview and autosave. */
export interface NoteSession {
  id: NoteId;
  text: Promise<string>;
  result: () => CompileResult | undefined;
  /** Pages of the last successful compile, kept while the source has errors. */
  pages: () => string[];
  dirty: () => boolean;
  edit(text: string): void;
  flush(): Promise<void>;
  /** Swaps in text changed outside the editor (e.g. a rename), keeping the cursor. */
  replaceText(text: string): void;
  attachView(view: EditorView | undefined): void;
  refresh(): void;
  dispose(discard?: boolean): void;
}

/** An editor tab; like in Obsidian it can be empty (Mod+T) until a note is opened in it. */
export interface Tab {
  key: string;
  note: NoteId | null;
}

interface WorkspaceFile {
  tabs: (NoteId | null)[];
  active: number;
  sizes?: number[];
}

const [vaultRoot, setVaultRoot] = createSignal<string | null>(null);
const [tree, setTree] = createSignal<TreeNode[]>([]);
const [tabs, setTabs] = createStore<Tab[]>([]);
/** Key of the active tab. */
const [active, setActive] = createSignal<string | null>(null);
const [paneSizes, setPaneSizes] = createSignal<number[]>([20, 40, 40]);
const sessions = new Map<NoteId, NoteSession>();

export { active, paneSizes, tabs, tree, vaultRoot };

let nextTabKey = 0;
const newTabKey = () => `tab-${nextTabKey++}`;

const activeTab = () => tabs.find((t) => t.key === active());
/** The note in the active tab, if any. */
export const activeNote = () => activeTab()?.note ?? null;

const index = createRoot(() =>
  createMemo(() => {
    const byId = new Map<NoteId, TreeNode>();
    const byAddress = new Map<string, NoteId>();
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        byId.set(node.id, node);
        if (node.address && !byAddress.has(node.address)) {
          byAddress.set(node.address, node.id);
        }
        walk(node.children);
      }
    };
    walk(tree());
    return { byId, byAddress };
  }),
);

export const noteById = (id: NoteId) => index().byId.get(id);

/** Notes in tree order (depth first), for the quick switcher. */
export function allNotes(): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(tree());
  return out;
}

export function noteLabel(note: NoteSummary | undefined): string {
  if (!note) return "Missing note";
  const title = note.title ?? "Untitled";
  return note.address ? `${note.address} ${title}` : title;
}

/** Resolves a wikilink target like the backend does: address first, then uuid. */
export function resolveTarget(target: string): NoteId | undefined {
  return (
    index().byAddress.get(target) ??
    (index().byId.has(target) ? target : undefined)
  );
}

export const sessionFor = (id: NoteId) => sessions.get(id);

const notePath = (id: NoteId) => `/notes/${id}.typ`;

function createSession(id: NoteId): NoteSession {
  const [result, setResult] = createSignal<CompileResult>();
  const [pages, setPages] = createSignal<string[]>([]);
  const [dirty, setDirty] = createSignal(false);
  let view: EditorView | undefined;
  let preview: LivePreview | undefined;
  let disposed = false;

  const saver = autosave(
    id,
    (summary) => {
      if (!saver.hasPending()) setDirty(false);
      if (metadataChanged(summary)) void refreshTree();
    },
    (error) => console.error(`could not save ${id}:`, error),
  );

  const text = (async () => {
    const [main, source] = await Promise.all([
      vault.previewMain(id),
      vault.readNote(id),
    ]);
    await typst.setSource(main.path, main.text);
    if (disposed) return source;
    preview = livePreview(
      typst,
      notePath(id),
      main.path,
      (r) => {
        setResult(r);
        if (r.pages.length > 0) setPages(r.pages);
      },
      (error) =>
        setResult({
          pages: [],
          diagnostics: [
            { severity: "error", message: error.message, hints: [] },
          ],
          loadingPackages: [],
        }),
    );
    preview.update(source);
    return source;
  })();

  return {
    id,
    text,
    result,
    pages,
    dirty,
    edit(next) {
      preview?.update(next);
      saver.update(next);
      setDirty(true);
    },
    async flush() {
      await saver.flush();
    },
    replaceText(next) {
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === next) return;
      let start = 0;
      while (start < current.length && current[start] === next[start]) start++;
      let end = 0;
      while (
        end < current.length - start &&
        end < next.length - start &&
        current[current.length - 1 - end] === next[next.length - 1 - end]
      ) {
        end++;
      }
      view.dispatch({
        changes: {
          from: start,
          to: current.length - end,
          insert: next.slice(start, next.length - end),
        },
      });
    },
    attachView(v) {
      view = v;
    },
    refresh() {
      preview?.refresh();
    },
    dispose(discard = false) {
      disposed = true;
      if (discard) saver.cancel();
      else void saver.flush();
      preview?.dispose();
      void typst.removeSource(notePath(id));
    },
  };
}

function metadataChanged(summary: NoteSummary): boolean {
  const known = noteById(summary.id);
  return (
    !known ||
    known.title !== summary.title ||
    known.address !== summary.address ||
    known.headerError !== summary.headerError ||
    known.tags.join("\u0000") !== summary.tags.join("\u0000")
  );
}

// --- vault ---

export async function openVault(path: string, create = false) {
  await closeVault();
  const nodes = create ? await vault.create(path) : await vault.open(path);
  setTree(nodes);
  await loadLinks();
  await restoreWorkspace();
  // Last, so the workspace mounts with the restored tabs and pane sizes.
  setVaultRoot(path);
}

async function closeVault() {
  await flushAll();
  for (const session of sessions.values()) session.dispose(true);
  sessions.clear();
  setTabs([]);
  setActive(null);
  setTree([]);
  setVaultRoot(null);
}

export async function refreshTree() {
  setTree(await vault.tree());
  await loadLinks();
}

/** Regenerates `links.typ` so open previews show current titles. */
export async function refreshLinks() {
  if (vaultRoot()) await loadLinks();
}

async function loadLinks() {
  const library = await vault.linkLibrary(settings.linkDisplay === "address");
  await typst.setSource(library.path, library.text);
  for (const session of sessions.values()) session.refresh();
}

export async function flushAll() {
  await Promise.all([...sessions.values()].map((s) => s.flush()));
}

// --- tabs ---

/**
 * Shows note `id`: activates the tab that already has it, else fills the
 * active tab if it's empty, else opens a new tab. Each note is in at most one tab.
 */
export function openNote(id: NoteId) {
  if (!noteById(id)) return;
  const existing = tabs.find((t) => t.note === id);
  if (existing) {
    activateTab(existing.key);
    return;
  }
  sessions.set(id, createSession(id));
  const current = activeTab();
  if (current && current.note === null) {
    setTabs((t) => t.key === current.key, "note", id);
  } else {
    const key = newTabKey();
    setTabs(tabs.length, { key, note: id });
    setActive(key);
  }
  persistWorkspace();
}

export function newTab() {
  const key = newTabKey();
  setTabs(tabs.length, { key, note: null });
  activateTab(key);
}

export async function closeTab(key: string, discard = false) {
  const position = tabs.findIndex((t) => t.key === key);
  if (position < 0) return;
  const id = tabs[position].note;
  const session = id ? sessions.get(id) : undefined;
  if (session && !discard) await session.flush();
  session?.dispose(discard);
  if (id) sessions.delete(id);
  setTabs((list) => list.filter((t) => t.key !== key));
  if (active() === key) {
    setActive(tabs[Math.min(position, tabs.length - 1)]?.key ?? null);
  }
  persistWorkspace();
}

export function activateTab(key: string) {
  setActive(key);
  persistWorkspace();
}

export function cycleTab(delta: number) {
  if (tabs.length < 2) return;
  const current = tabs.findIndex((t) => t.key === active());
  const next = (current + delta + tabs.length) % tabs.length;
  activateTab(tabs[next].key);
}

export function moveTab(from: number, to: number) {
  if (from === to || from < 0 || to < 0) return;
  setTabs(
    produce((list) => {
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
    }),
  );
  persistWorkspace();
}

export function setSizes(sizes: number[]) {
  setPaneSizes(sizes);
  persistWorkspace();
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persistWorkspace() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (!vaultRoot()) return;
    const file: WorkspaceFile = {
      tabs: tabs.map((t) => t.note),
      active: tabs.findIndex((t) => t.key === active()),
      sizes: paneSizes(),
    };
    vault
      .saveWorkspace(JSON.stringify(file))
      .catch((error) => console.warn("could not save workspace:", error));
  }, 300);
}

async function restoreWorkspace() {
  const json = await vault.loadWorkspace().catch(() => null);
  if (!json) return;
  try {
    const file = JSON.parse(json) as WorkspaceFile;
    if (file.sizes?.length === 3) setPaneSizes(file.sizes);
    for (const id of file.tabs) {
      if (id === null) newTab();
      else if (noteById(id)) {
        newTab();
        openNote(id);
      }
    }
    const restored = tabs[file.active];
    if (restored) setActive(restored.key);
  } catch (error) {
    console.warn("ignoring unreadable workspace.json:", error);
  }
}

// --- notes ---

export async function createNote(placement: Placement, title: string) {
  const note = await vault.createNote(placement, title || undefined);
  await refreshTree();
  openNote(note.id);
  return note;
}

export async function renameNote(id: NoteId, title: string) {
  const session = sessions.get(id);
  await session?.flush();
  await vault.renameNote(id, title);
  if (session) session.replaceText(await vault.readNote(id));
  await refreshTree();
}

export async function deleteNote(id: NoteId) {
  const tab = tabs.find((t) => t.note === id);
  if (tab) await closeTab(tab.key, true);
  await vault.deleteNote(id, settings.deleteMode);
  await refreshTree();
}
