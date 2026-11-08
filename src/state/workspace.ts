import type { EditorView } from '@codemirror/view';
import {
  batch,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  on,
} from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { linksAt } from '../editor/analysis';
import { savedText } from '../editor/wikilinks';
import { type LivePreview, livePreview } from '../typst/client';
import { typst } from '../typst/instance';
import type {
  CompileResult,
  Completions,
  Diagnostic,
  Hover,
  Page,
  PagePoint,
  Position,
  Signature,
} from '../typst/protocol';
import {
  autosave,
  type DiskChanges,
  type FolderNode,
  type Moved,
  type NoteId,
  type NoteSummary,
  type Placement,
  type Preamble,
  type PreambleWarning,
  type SectionNode,
  type TreeNode,
  vault,
} from '../vault/api';
import {
  checkDeferredReferences,
  loadCitations,
  syncReferences,
  unloadCitations,
} from './citations';
import { recordCompile } from './debug';
import {
  type DropZone,
  findPane,
  insertBeside,
  isEmptyTab,
  type LayoutNode,
  newPane,
  type Pane,
  paneNote,
  paneOfTab,
  panes,
  removePane,
  restore,
  type SavedNode,
  save,
  type Tab,
  type ViewMode,
} from './layout';
import {
  loadSettings,
  resetSettings,
  setKindFolder,
  settings,
  updateSettings,
} from './settings';
import { expandTemplate } from './templates';
import { isPreviewDark } from './theme';

/** One open editor tab: its text, live preview and autosave. */
export interface NoteSession {
  id: NoteId;
  text: Promise<string>;
  result: () => CompileResult | undefined;
  /** This note's own diagnostics with the source they were compiled from. */
  compiled: () => { text: string; diagnostics: Diagnostic[] } | undefined;
  /** Moves the editor to the source behind a click on the preview. */
  jumpFromClick(page: number, x: number, y: number): Promise<void>;
  /** Where the text at `position` appears in the preview. */
  locate(position: Position): Promise<PagePoint[]>;
  /** Signature help for the call around `position` in the editor's `text`. */
  signature(text: string, position: Position): Promise<Signature | null>;
  /** What hovering `position` in the editor's `text` shows. */
  tooltip(
    text: string,
    position: Position,
    before: boolean,
  ): Promise<Hover | null>;
  /** Typst completions for the editor's current `text` at `position`. */
  complete(
    text: string,
    position: Position,
    explicit: boolean,
  ): Promise<Completions | null>;
  /** Pages of the last successful compile, kept while the source has errors. */
  pages: () => Page[];
  /**
   * How the latest pages moved the preview's anchor (see
   * `CompileResult.anchor`); set together with `pages`.
   */
  shift: () => CompileResult['anchor'];
  /** Where the preview's anchor is, sent with each compile; `undefined` to stop. */
  setAnchor(get: (() => PagePoint | null) | undefined): void;
  dirty: () => boolean;
  /** Set when the file changed or went away on disk while there were unsaved edits. */
  conflict: () => DiskConflict | null;
  setConflict(conflict: DiskConflict | null): void;
  /** Takes the file's text from disk, dropping unsaved edits. */
  loadFromDisk(text: string): void;
  /** The editor's text now. */
  currentText(): string;
  edit(text: string): void;
  flush(): Promise<void>;
  /** Swaps in text changed outside the editor (e.g. a rename), keeping the cursor. */
  replaceText(text: string): void;
  /** Replaces the editor's selection with `text` (inserts at the cursor) and focuses it. */
  insert(text: string): void;
  /** Points the editor's wikilinks to `from` at `to` instead, keeping their custom text (one undo step). */
  retarget(from: string, to: string): void;
  /** The target as the note's source writes it, for a target from the preview (see `plainQuotes`). */
  sourceTarget(target: string): string | undefined;
  /** The note's editor while it's on screen. */
  shownView(): EditorView | undefined;
  attachView(view: EditorView | undefined): void;
  /** The main file the preview compiles, once known. */
  mainPath(): string | undefined;
  /** Refetches the wrapper main and prefix (after its kind or a preamble changed); doesn't recompile. */
  reloadMain(): Promise<void>;
  /** Resends the note's link table (after titles or addresses changed); doesn't recompile. */
  refreshLinks(): Promise<void>;
  refresh(): void;
  dispose(discard?: boolean): void;
}

export type { Pane, Tab, ViewMode };

/** How a note's file on disk disagrees with its unsaved edits. */
export type DiskConflict = 'changed' | 'deleted';

/** One preview per pane, or one beside all panes for the focused pane's note. */
export type PreviewLayout = 'pane' | 'global';

interface WorkspaceFile {
  layout?: SavedNode;
  /** Index of the focused pane in depth-first order. */
  focused?: number;
  /** Sidebar and editor area. */
  sizes?: number[];
  collapsedFolders?: string[];
  previewLayout?: PreviewLayout;
  /** Pane area and global preview. */
  globalSizes?: number[];
  globalShown?: boolean;
}

const EMPTY_ROOT: FolderNode = {
  name: '',
  path: '',
  kind: 'plain',
  warning: null,
  folders: [],
  notes: [],
  assets: [],
  sections: [],
};

const [vaultRoot, setVaultRoot] = createSignal<string | null>(null);
/** The vault root folder, holding every folder and note. */
const [tree, setTree] = createSignal<FolderNode>(EMPTY_ROOT);
/** Folder paths folded in the sidebar; folders are expanded by default. */
const [collapsedFolders, setCollapsedFolders] = createSignal<string[]>([]);
/** The editor area: a tree of panes (see `layout.ts`). */
const [layout, setLayout] = createStore<{ root: LayoutNode }>({
  root: newPane(),
});
const [focusedId, setFocusedId] = createSignal<string>(layout.root.id);
/** The pane the global preview follows: the last focused one not in reading mode. */
const [lastEditing, setLastEditing] = createSignal<string | null>(null);
const [previewLayout, setPreviewLayoutSignal] =
  createSignal<PreviewLayout>('pane');
const [globalShown, setGlobalShown] = createSignal(true);
const [globalSizes, setGlobalSizesSignal] = createSignal<number[]>([65, 35]);
/** Sidebar and editor area. */
const [paneSizes, setPaneSizes] = createSignal<number[]>([20, 80]);
const sessions = new Map<NoteId, NoteSession>();

export {
  collapsedFolders,
  globalShown,
  globalSizes,
  layout,
  paneSizes,
  previewLayout,
  tree,
  vaultRoot,
};

let nextTabKey = 0;
const newTabKey = () => `tab-${nextTabKey++}`;

const firstPane = () => panes(layout.root)[0];

/** The pane commands act on: the one last clicked or typed in. */
export const focusedPane = (): Pane =>
  findPane(layout.root, focusedId()) ?? firstPane();

/** Key of the focused pane's active tab. */
export const active = () => focusedPane().active;

/** The focused pane's tabs. */
export const focusedTabs = () => focusedPane().tabs;

/** The note in the focused pane's active tab, if any. */
export const activeNote = () => paneNote(focusedPane());

/** Every open tab, in every pane. */
export const allTabs = () => panes(layout.root).flatMap(p => p.tabs);

export const tabOf = (note: NoteId) => allTabs().find(t => t.note === note);

/** The note the global preview shows. */
export const globalPreviewNote = (): NoteId | null => {
  const last = lastEditing();
  const pane =
    (last ? findPane(layout.root, last) : undefined) ?? focusedPane();
  const shown =
    pane.mode !== 'read'
      ? pane
      : panes(layout.root).find(p => p.mode !== 'read');
  return shown ? paneNote(shown) : null;
};

/** Notes whose preview is on screen. */
const visibleNotes = createRoot(() =>
  createMemo(() => {
    const visible = new Set<NoteId>();
    for (const pane of panes(layout.root)) {
      const note = paneNote(pane);
      const previewed =
        pane.mode === 'read' ||
        (pane.mode === 'edit' && previewLayout() === 'pane');
      if (note && previewed) visible.add(note);
    }
    const global = globalPreviewNote();
    if (previewLayout() === 'global' && globalShown() && global) {
      visible.add(global);
    }
    return visible;
  }),
);

/**
 * Resolves once every preview on screen has its first pages (or a compile
 * that failed with nothing left loading), or after `timeoutMs` at the latest.
 */
export function firstPreviews(timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    createRoot(dispose => {
      const done = () => {
        clearTimeout(timer);
        dispose();
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      createEffect(() => {
        const ready = [...visibleNotes()].every(id => {
          const session = sessions.get(id);
          const result = session?.result();
          if (!session || !result) return false;
          return (
            session.pages().length > 0 ||
            (result.loadingPackages.length === 0 &&
              result.loadingFiles.length === 0)
          );
        });
        if (ready) queueMicrotask(done);
      });
    });
  });
}

const index = createRoot(() =>
  createMemo(() => {
    const byId = new Map<NoteId, TreeNode>();
    const byAddress = new Map<string, NoteId>();
    /** Each Zettelkasten note's parent in the address tree. */
    const parents = new Map<NoteId, TreeNode>();
    /** Each sequence's first-level notes (`4.1`, `4.2`; not `4.1a`), by number. */
    const sequences = new Map<number, TreeNode[]>();
    /** Notes in sidebar order, depth first. */
    const notes: TreeNode[] = [];
    const folders: FolderNode[] = [];
    const assets = new Set<string>();
    let zettelkasten: FolderNode | null = null;
    const walkNotes = (nodes: TreeNode[], parent?: TreeNode) => {
      for (const node of nodes) {
        byId.set(node.id, node);
        if (parent) parents.set(node.id, parent);
        notes.push(node);
        if (isNoteAddress(node.address) && !byAddress.has(node.address)) {
          byAddress.set(node.address, node.id);
        }
        walkNotes(node.children, node);
      }
    };
    const walkFolder = (folder: FolderNode) => {
      if (folder.kind === 'zettelkasten') zettelkasten = folder;
      for (const asset of folder.assets) assets.add(asset.path);
      for (const sub of folder.folders) {
        folders.push(sub);
        walkFolder(sub);
      }
      for (const section of folder.sections) walkNotes(section.notes);
      walkNotes(folder.notes);
      if (folder.kind === 'zettelkasten') {
        const roots = [
          ...folder.sections.flatMap(s => s.notes),
          ...folder.notes,
        ];
        for (const root of roots) {
          const sequence = sequenceOf(root.address);
          if (sequence === undefined) continue;
          const list = sequences.get(sequence) ?? [];
          list.push(root);
          sequences.set(sequence, list);
        }
      }
    };
    walkFolder(tree());
    return {
      byId,
      byAddress,
      parents,
      sequences,
      notes,
      folders,
      assets,
      zettelkasten,
    };
  }),
);

export const noteById = (id: NoteId) => index().byId.get(id);

/** A Zettelkasten note's parent in the address tree (its nearest existing ancestor). */
export const parentNote = (id: NoteId) => index().parents.get(id);

const NOTE_ADDRESS = /^[1-9]\d*\.[1-9]\d*(?:[a-z]+[1-9]\d*)*[a-z]*$/;

/** Whether `address` is a note's (`4.1`, `4.1a`), not a bare sequence number or invalid. */
export const isNoteAddress = (address: string | null): address is string =>
  !!address && NOTE_ADDRESS.test(address);

/** The sequence of a note address: `4` for `4.2a`. */
export function sequenceOf(address: string | null): number | undefined {
  return isNoteAddress(address)
    ? Number(address.slice(0, address.indexOf('.')))
    : undefined;
}

/** The first-level notes of sequence `number` (`4.1`, `4.2`), in order. */
export const sequenceNotes = (number: number) =>
  index().sequences.get(number) ?? [];

/** The Zettelkasten's sections in order. */
export const sections = (): SectionNode[] => zettelkasten()?.sections ?? [];

/** `4–5 Writing`, or `4 Writing` for one sequence. */
export function sectionLabel(section: SectionNode): string {
  const range =
    section.first === section.last
      ? `${section.first}`
      : `${section.first}–${section.last}`;
  return `${range} ${section.name}`;
}

/** Notes in sidebar order, for the quick switcher. */
export const allNotes = () => index().notes;

/** Every folder except the root, in sidebar order. */
export const allFolders = () => index().folders;

/** Whether the vault has a file (not a note) at vault path `path`. */
export const assetExists = (path: string) => index().assets.has(path);

/** The Zettelkasten folder, if the vault has one. */
export const zettelkasten = (): FolderNode | null => index().zettelkasten;

export const inZettelkasten = (id: NoteId) =>
  noteById(id)?.folder === zettelkasten()?.path;

export function noteLabel(note: NoteSummary | undefined): string {
  if (!note) return 'Missing note';
  const title = note.title ?? 'Untitled';
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

/** Same pattern as the `wikilinks` show rule (`link_library`). */
const WIKILINK = /\[\[([^[\]\n]+)\]\]/g;

/** The targets `text` links to, as the show rule sees them: sorted, once each. */
function linkTargets(text: string): string[] {
  const targets = new Set<string>();
  for (const match of text.matchAll(WIKILINK)) {
    const target = match[1].split('|')[0].trim();
    if (target) targets.add(target);
  }
  return [...targets].sort();
}

/**
 * Resolves once the vault's shared files (links rule, preambles, theme,
 * citations) have reached the compiler; notes compile only after that.
 */
let vaultSources: Promise<unknown> = Promise.resolve();
/** Must match `sliver_vault::preview_main_path`. */
const previewMainPath = (id: NoteId) => `/.sliver/view/${id}.typ`;

function createSession(id: NoteId): NoteSession {
  const [result, setResult] = createSignal<CompileResult>();
  const [compiled, setCompiled] = createSignal<{
    text: string;
    diagnostics: Diagnostic[];
  }>();
  let mainPath: string | undefined;
  const [pages, setPages] = createSignal<Page[]>([]);
  const [dirty, setDirty] = createSignal(false);
  const [conflict, setConflict] = createSignal<DiskConflict | null>(null);
  let view: EditorView | undefined;
  let preview: LivePreview | undefined;
  const [shift, setShift] = createSignal<CompileResult['anchor']>(null);
  let anchor: (() => PagePoint | null) | undefined;
  let disposed = false;

  const saver = autosave(
    id,
    summary => {
      if (!saver.hasPending()) setDirty(false);
      const kindChanged = noteById(id)?.kind !== summary.kind;
      if (metadataChanged(summary)) void refreshTree();
      // Fetches entries for keys it cites that the vault has none for yet.
      void syncReferences(false).catch(error =>
        console.warn('could not fetch references:', error),
      );
      if (kindChanged) {
        void reloadMain().then(() => preview?.refresh());
      }
    },
    error => console.error(`could not save ${id}:`, error),
    {
      // A conflict holds edits back until the user picks a side.
      enabled: () => settings.autosave && !conflict(),
      delayMs: () => settings.autosaveDelay,
    },
  );
  let latestText: string | undefined;

  // The note's link table covers only the targets its text links to, so it
  // stays small whatever the vault's size; it's resent when they change.
  let tableFor: string | undefined;
  let tableSent: Promise<void> = Promise.resolve();
  const sendLinkTable = (text: string, force = false) => {
    const targets = linkTargets(text);
    const key = targets.join('\n');
    if (!force && key === tableFor) return tableSent;
    tableFor = key;
    tableSent = tableSent
      .then(async () => {
        const table = await vault.linkTable(id, targets);
        if (!disposed) await typst.setSource(table.path, table.text);
      })
      .catch(error => console.warn(`could not update ${id}'s links:`, error));
    return tableSent;
  };

  const text = (async () => {
    const [main, source] = await Promise.all([
      vault.previewMain(id),
      vault.readNote(id),
    ]);
    latestText ??= source;
    const table = sendLinkTable(source);
    // Checked after each step: a closed tab has already removed its files.
    if (disposed) return source;
    await typst.setPrefix(notePath(id), main.prefix);
    if (disposed) return source;
    await typst.setSource(main.path, main.text);
    if (disposed) return source;
    await sendPageWidth(id);
    mainPath = main.path;
    if (disposed) return source;
    preview = livePreview(typst, notePath(id), main.path, {
      visible: () => visibleNotes().has(id),
      anchor: () => anchor?.() ?? null,
      onResult: (r, compiledText, timing) => {
        setResult(r);
        if (r.pages) {
          // Bands sent before come back without SVG: take it from what's shown.
          const shown = new Map(
            pages().flatMap(page => page.bands.map(b => [b.key, b.svg])),
          );
          const next = r.pages.map(page => ({
            ...page,
            bands: page.bands.map(b => ({
              ...b,
              svg: b.svg ?? shown.get(b.key) ?? '',
            })),
          }));
          batch(() => {
            setShift(r.anchor);
            setPages(next);
          });
        } else if (!visibleNotes().has(id)) {
          stalePreviews.add(id);
        }
        setCompiled({
          text: compiledText,
          diagnostics: r.diagnostics.filter(d => d.path === notePath(id)),
        });
        recordCompile({ note: id, ...timing });
      },
      onError: error =>
        setResult({
          pages: null,
          anchor: null,
          diagnostics: [
            { severity: 'error', message: error.message, hints: [] },
          ],
          loadingPackages: [],
          loadingFiles: [],
          compileMs: 0,
          renderMs: 0,
        }),
    });
    await table;
    await vaultSources;
    if (disposed) return source;
    preview.update(source);
    return source;
  })();

  async function reloadMain() {
    const main = await vault.previewMain(id);
    if (disposed) return;
    await typst.setPrefix(notePath(id), main.prefix);
    await typst.setSource(main.path, main.text);
  }

  return {
    id,
    text,
    result,
    compiled,
    pages,
    shift,
    setAnchor: get => {
      anchor = get;
    },
    dirty,
    conflict,
    setConflict(next) {
      if (next) saver.hold();
      setConflict(next);
    },
    currentText: () => (view && savedText(view.state)) ?? latestText ?? '',
    loadFromDisk(next) {
      this.replaceText(next);
      // The edit the replacement made goes nowhere: it's what's on disk.
      saver.cancel();
      setDirty(false);
      setConflict(null);
    },
    async jumpFromClick(page, x, y) {
      if (!mainPath || !view) return;
      const found = await typst.jumpFromClick(mainPath, page, x, y);
      if (!found || found.path !== notePath(id) || !view) return;
      const { line, column } = found.position;
      const doc = view.state.doc;
      if (line >= doc.lines) return;
      const at = Math.min(doc.line(line + 1).from + column, doc.length);
      view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
      view.focus();
    },
    async signature(text, position) {
      if (!mainPath) return null;
      return typst.signature(mainPath, notePath(id), text, position);
    },
    async tooltip(text, position, before) {
      if (!mainPath) return null;
      return typst.tooltip(mainPath, notePath(id), text, position, before);
    },
    async complete(text, position, explicit) {
      if (!mainPath) return null;
      return typst.complete(mainPath, notePath(id), text, position, explicit);
    },
    async locate(position) {
      if (!mainPath) return [];
      return typst.jumpFromCursor(mainPath, notePath(id), position);
    },
    edit(next) {
      // Showing or hiding a link's uuid changes the editor, not the file.
      if (next === latestText) return;
      latestText = next;
      // A new link target needs its table entry before the compile.
      void sendLinkTable(next).then(() => preview?.update(next));
      saver.update(next);
      setDirty(true);
    },
    async flush() {
      await saver.flush();
    },
    replaceText(next) {
      if (!view) return;
      if (savedText(view.state) === next) return;
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
    shownView() {
      // Hidden tabs and reading view hide the editor with `display: none`.
      return view?.dom.offsetParent ? view : undefined;
    },
    retarget(from, to) {
      if (!view) return;
      const changes = linksAt(view.state)
        .filter(link => sameTarget(link.target, from))
        .map(link => ({
          from: link.targetFrom,
          to: link.targetTo,
          insert: to,
        }));
      if (changes.length > 0) view.dispatch({ changes });
    },
    sourceTarget(target) {
      if (!view) return undefined;
      return linksAt(view.state)
        .find(link => sameTarget(link.target, target))
        ?.target.trim();
    },
    insert(text) {
      if (!view) return;
      view.dispatch(view.state.replaceSelection(text));
      view.focus();
    },
    attachView(v) {
      view = v;
    },
    mainPath: () => mainPath,
    reloadMain,
    refreshLinks() {
      return sendLinkTable(this.currentText(), true);
    },
    refresh() {
      preview?.refresh();
    },
    dispose(discard = false) {
      disposed = true;
      if (discard) saver.cancel();
      else void saver.flush();
      preview?.dispose();
      // Everything the worker holds for this note: its text, its wrapper
      // (with the last layout and rendered page hashes) and its page width.
      void typst.removeSource(notePath(id));
      void typst.removeSource(previewMainPath(id));
      void typst.removeSource(pagePath(id));
      void typst.removeSource(`/.sliver/links/${id}.typ`);
      pageWidths.delete(id);
      stalePreviews.delete(id);
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
    known.kind !== summary.kind ||
    known.tags.join('\u0000') !== summary.tags.join('\u0000')
  );
}

// --- vault ---

export async function openVault(path: string, create = false) {
  await closeVault();
  const nodes = create ? await vault.create(path) : await vault.open(path);
  setTree(nodes);
  await loadSettings();
  // Fetched together; open notes load meanwhile and compile once these are in.
  const shared = Promise.all([
    loadLinks(),
    loadPreambles(),
    sendTheme(),
    loadCitations(),
  ]);
  vaultSources = shared.catch(() => undefined);
  await restoreWorkspace();
  // Last, so the workspace mounts with the restored tabs and pane sizes.
  setVaultRoot(path);
  await shared;
  // Off the startup path: checks that only matter if something's wrong.
  void firstPreviews(3000)
    .then(checkDeferredReferences)
    .catch(error => console.warn('could not check references:', error));
  // Picks up edits made in Zotero; previews use the vault's copy meanwhile.
  void syncReferences(true).catch(error =>
    console.warn('could not refresh references:', error),
  );
}

async function closeVault() {
  await flushAll();
  for (const session of sessions.values()) session.dispose(true);
  sessions.clear();
  const pane = newPane();
  setLayout({ root: pane });
  setFocusedId(pane.id);
  setLastEditing(null);
  setTree(EMPTY_ROOT);
  setCollapsedFolders([]);
  for (const preamble of preambles()) void typst.removeSource(preamble.path);
  setPreambles([]);
  unloadCitations();
  resetSettings();
  setVaultRoot(null);
}

async function refreshTree() {
  setTree(await vault.tree());
  await Promise.all([...sessions.values()].map(s => s.refreshLinks()));
  invalidatePreviews();
}

/** Regenerates `links.typ` after the link display setting changed. */
export async function refreshLinks() {
  if (vaultRoot()) await loadLinks();
}

async function loadLinks() {
  const library = await vault.linkLibrary(settings.linkDisplay === 'address');
  await typst.setSource(library.path, library.text);
  invalidatePreviews();
}

// --- preview page ---

/** Where the preview should show, e.g. the editor cursor's spot; `seq` makes repeats distinct. */
const [previewFocus, setFocus] = createSignal<{
  note: NoteId;
  points: PagePoint[];
  seq: number;
}>();
let focusSeq = 0;

export { previewFocus };
export const setPreviewFocus = (focus: { note: NoteId; points: PagePoint[] }) =>
  setFocus({ ...focus, seq: focusSeq++ });

const PX_PER_PT = 4 / 3;
/** Widths snap to this many points, so a resize drag compiles less often. */
const PAGE_STEP_PT = 6;
/** Each note's preview page width; new notes start at the last width set. */
const pageWidths = new Map<NoteId, number>();
let lastWidthPt = 420;
/** Open notes whose preview is out of date (theme, preamble) and not on screen. */
const stalePreviews = new Set<NoteId>();

/** Must match `sliver_vault::page_path`, which the preview wrapper imports. */
const pagePath = (id: NoteId) => `/.sliver/page/${id}.typ`;

function sendPageWidth(id: NoteId) {
  const pt = pageWidths.get(id) ?? lastWidthPt;
  pageWidths.set(id, pt);
  return typst.setSource(pagePath(id), `#let page-width = ${pt}pt\n`);
}

/**
 * Whether the layout is being resized: a divider is dragged, or the window
 * resized within the last moment (it has no end event). Previews keep their
 * page meanwhile, stretched by CSS, and recompile for the new width after.
 */
const [dragResizing, setDragResizing] = createSignal(false);
const [windowResizing, setWindowResizing] = createSignal(false);
export const resizing = () => dragResizing() || windowResizing();
export { setDragResizing };

const WINDOW_RESIZE_SETTLE_MS = 200;
let windowResizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
  setWindowResizing(true);
  clearTimeout(windowResizeTimer);
  windowResizeTimer = setTimeout(
    () => setWindowResizing(false),
    WINDOW_RESIZE_SETTLE_MS,
  );
});

/** Sets note `id`'s preview page width (CSS px) and recompiles it if it changed. */
export function setPreviewWidth(id: NoteId, px: number) {
  const pt = Math.max(
    PAGE_STEP_PT,
    Math.round(px / PX_PER_PT / PAGE_STEP_PT) * PAGE_STEP_PT,
  );
  lastWidthPt = pt;
  if (pageWidths.get(id) === pt) return;
  pageWidths.set(id, pt);
  if (sessions.has(id)) {
    void sendPageWidth(id).then(() => sessions.get(id)?.refresh());
  }
}

async function sendTheme() {
  const theme = await vault.themeLibrary(isPreviewDark());
  await typst.setSource(theme.path, theme.text);
}

/**
 * Recompiles the previews on screen now and the others when they're shown;
 * only `only`'s when given.
 */
export function invalidatePreviews(only?: Iterable<NoteSession>) {
  const visible = visibleNotes();
  for (const session of only ?? sessions.values()) {
    if (visible.has(session.id)) session.refresh();
    else stalePreviews.add(session.id);
  }
}

createRoot(() =>
  createEffect(
    on(isPreviewDark, () => void sendTheme().then(() => invalidatePreviews()), {
      defer: true,
    }),
  ),
);

createRoot(() =>
  createEffect(() => {
    for (const id of visibleNotes()) {
      if (stalePreviews.delete(id)) sessions.get(id)?.refresh();
    }
  }),
);

/** Saves note `id` now, whatever the autosave settings. */
export async function saveNote(id: NoteId) {
  await sessions.get(id)?.flush();
}

export async function flushAll() {
  await Promise.all([...sessions.values()].map(s => s.flush()));
}

// --- panes and tabs ---

const update = (fn: (state: { root: LayoutNode }) => void) => {
  setLayout(produce(fn));
  persistWorkspace();
};

/** Makes pane `id` the one commands act on. */
export function focusPane(id: string) {
  if (focusedId() === id) return;
  setFocusedId(id);
  if (findPane(layout.root, id)?.mode !== 'read') setLastEditing(id);
  persistWorkspace();
}

/**
 * Shows note `id`: activates the tab that already has it (in whichever
 * pane), else fills the focused pane's active tab if it's empty, else opens
 * a new tab there. Each note is in at most one tab.
 */
export function openNote(id: NoteId) {
  if (!noteById(id)) return;
  const existing = tabOf(id);
  if (existing) {
    activateTab(existing.key);
    return;
  }
  sessions.set(id, createSession(id));
  const target = focusedPane();
  update(state => {
    const pane = findPane(state.root, target.id);
    if (!pane) return;
    const current = pane.tabs.find(t => t.key === pane.active);
    if (current && isEmptyTab(current)) {
      current.note = id;
    } else {
      const key = newTabKey();
      pane.tabs.push({ key, note: id });
      pane.active = key;
    }
  });
}

/**
 * Shows note `id` in pane `paneId`'s active tab instead of its current
 * note, like following a link in a browser tab, so stepping through notes
 * doesn't pile up tabs. A note open in a tab already is activated there.
 */
export async function navigate(paneId: string, id: NoteId) {
  if (!noteById(id)) return;
  const existing = tabOf(id);
  if (existing) return activateTab(existing.key);
  focusPane(paneId);
  const pane = findPane(layout.root, paneId);
  const tab = pane?.tabs.find(t => t.key === pane.active);
  if (!tab) return openNote(id);
  const key = tab.key;
  const old = tab.note && sessions.get(tab.note);
  if (old) {
    await old.flush();
    old.dispose();
    sessions.delete(old.id);
  }
  sessions.set(id, createSession(id));
  update(state => {
    const found = paneOfTab(state.root, key)?.tabs.find(t => t.key === key);
    if (found) {
      found.note = id;
      found.asset = undefined;
    }
  });
}

export function newTab() {
  const key = newTabKey();
  const target = focusedPane().id;
  update(state => {
    const pane = findPane(state.root, target);
    if (!pane) return;
    pane.tabs.push({ key, note: null });
    pane.active = key;
  });
}

/** Removes tab `key` from its pane; a pane left empty goes too, unless it's the last. */
function detachTab(state: { root: LayoutNode }, key: string): Tab | undefined {
  const pane = paneOfTab(state.root, key);
  if (!pane) return undefined;
  const position = pane.tabs.findIndex(t => t.key === key);
  const [tab] = pane.tabs.splice(position, 1);
  if (pane.active === key) {
    pane.active =
      pane.tabs[Math.min(position, pane.tabs.length - 1)]?.key ?? null;
  }
  if (pane.tabs.length === 0 && panes(state.root).length > 1) {
    removePane(state, pane.id);
  }
  return tab;
}

/** After the tree changed: a focused pane that's gone hands focus on. */
function settleFocus(prefer?: string) {
  const all = panes(layout.root);
  if (prefer && all.some(p => p.id === prefer)) setFocusedId(prefer);
  else if (!all.some(p => p.id === focusedId())) setFocusedId(all[0].id);
}

export async function closeTab(key: string, discard = false) {
  const pane = paneOfTab(layout.root, key);
  const tab = pane?.tabs.find(t => t.key === key);
  if (!pane || !tab) return;
  const id = tab.note;
  const session = id ? sessions.get(id) : undefined;
  if (session && !discard) await session.flush();
  session?.dispose(discard);
  if (id) sessions.delete(id);
  update(state => void detachTab(state, key));
  settleFocus();
}

export function activateTab(key: string) {
  const pane = paneOfTab(layout.root, key);
  if (!pane) return;
  update(state => {
    const found = findPane(state.root, pane.id);
    if (found) found.active = key;
  });
  focusPane(pane.id);
}

/** Switches to the next (`1`) or previous (`-1`) tab of the focused pane. */
export function cycleTab(delta: number) {
  const tabs = focusedTabs();
  if (tabs.length < 2) return;
  const current = tabs.findIndex(t => t.key === active());
  activateTab(tabs[(current + delta + tabs.length) % tabs.length].key);
}

/** Reorders pane `paneId`'s tabs; `to` is the position without the moved tab. */
export function moveTab(paneId: string, from: number, to: number) {
  if (from === to || from < 0 || to < 0) return;
  update(state => {
    const pane = findPane(state.root, paneId);
    if (!pane) return;
    const [moved] = pane.tabs.splice(from, 1);
    pane.tabs.splice(to, 0, moved);
  });
}

/**
 * Drops tab `key` on pane `targetId`: into it (`center`, at `index` or the
 * end) or into a new pane split off on that side.
 */
export function dropTab(
  key: string,
  targetId: string,
  zone: DropZone,
  index?: number,
) {
  const source = paneOfTab(layout.root, key);
  if (!source) return;
  if (zone === 'center') {
    if (source.id === targetId) return;
  } else if (source.id === targetId && source.tabs.length === 1) {
    // Splitting a pane's only tab off would leave it empty: nothing changes.
    return;
  }
  let focus = targetId;
  update(state => {
    const tab = detachTab(state, key);
    if (!tab) return;
    if (zone === 'center') {
      const target = findPane(state.root, targetId);
      if (!target) return;
      target.tabs.splice(index ?? target.tabs.length, 0, tab);
      target.active = key;
    } else {
      const pane = { ...newPane([tab], key), mode: settings.defaultViewMode };
      focus = pane.id;
      insertBeside(state, targetId, zone, pane);
    }
  });
  settleFocus(focus);
  if (focusedPane().mode !== 'read') setLastEditing(focusedPane().id);
}

/** Moves the focused pane's active tab into a new pane on `edge`. */
export function splitFocused(edge: Exclude<DropZone, 'center'>) {
  const key = active();
  if (key) dropTab(key, focusedPane().id, edge);
}

/** Closes the focused pane with all its tabs. */
export async function closePane() {
  for (const tab of [...focusedTabs()]) await closeTab(tab.key);
}

/** Focuses the pane after (`1`) or before (`-1`) the focused one. */
export function cyclePane(delta: number) {
  const all = panes(layout.root);
  const at = all.findIndex(p => p.id === focusedPane().id);
  focusPane(all[(at + delta + all.length) % all.length].id);
}

export function setPaneMode(paneId: string, mode: ViewMode) {
  update(state => {
    const pane = findPane(state.root, paneId);
    if (pane) pane.mode = mode;
  });
  if (mode !== 'read' && focusedId() === paneId) setLastEditing(paneId);
}

/** Mod+E: the focused pane between reading and editing. */
export function toggleReading() {
  const pane = focusedPane();
  setPaneMode(pane.id, pane.mode === 'read' ? 'edit' : 'read');
}

/**
 * Shows or hides the preview: the focused pane's (editing vs source mode)
 * with a preview per pane, the shared column with a global one.
 */
export function togglePreview() {
  if (previewLayout() === 'global') {
    setGlobalShown(!globalShown());
    persistWorkspace();
    return;
  }
  const pane = focusedPane();
  setPaneMode(pane.id, pane.mode === 'edit' ? 'source' : 'edit');
}

export function setPreviewLayout(value: PreviewLayout) {
  setPreviewLayoutSignal(value);
  persistWorkspace();
}

export function setSplitSizes(splitId: string, sizes: number[]) {
  update(state => {
    const walk = (node: LayoutNode) => {
      if (node.kind !== 'split') return;
      if (node.id === splitId) node.sizes = sizes;
      else node.children.forEach(walk);
    };
    walk(state.root);
  });
}

export function setPaneSplitSizes(paneId: string, sizes: number[]) {
  update(state => {
    const pane = findPane(state.root, paneId);
    if (pane) pane.sizes = sizes;
  });
}

export function setGlobalSizes(sizes: number[]) {
  setGlobalSizesSignal(sizes);
  persistWorkspace();
}

export function setFolderCollapsed(path: string, collapsed: boolean) {
  setCollapsedFolders(list =>
    collapsed ? [...new Set([...list, path])] : list.filter(p => p !== path),
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
      layout: save(layout.root),
      focused: panes(layout.root).findIndex(p => p.id === focusedId()),
      sizes: paneSizes(),
      collapsedFolders: collapsedFolders(),
      previewLayout: previewLayout(),
      globalSizes: globalSizes(),
      globalShown: globalShown(),
    };
    vault
      .saveWorkspace(JSON.stringify(file))
      .catch(error => console.warn('could not save workspace:', error));
  }, 300);
}

async function restoreWorkspace() {
  // The fresh pane `closeVault` left, until a saved layout replaces it;
  // only now are this vault's settings loaded.
  update(state => {
    if (state.root.kind === 'pane') state.root.mode = settings.defaultViewMode;
  });
  const json = await vault.loadWorkspace().catch(() => null);
  if (!json) return;
  try {
    const file = JSON.parse(json) as WorkspaceFile;
    if (file.sizes?.length === 2) setPaneSizes(file.sizes);
    if (Array.isArray(file.collapsedFolders)) {
      setCollapsedFolders(file.collapsedFolders);
    }
    if (file.previewLayout === 'global') setPreviewLayoutSignal('global');
    if (file.globalSizes?.length === 2) setGlobalSizesSignal(file.globalSizes);
    if (file.globalShown === false) setGlobalShown(false);
    if (!file.layout) return;
    const seen = new Set<string>();
    const once = (key: string, exists: boolean) => {
      if (!exists || seen.has(key)) return false;
      seen.add(key);
      return true;
    };
    const root = restore(
      file.layout,
      id => once(id, !!noteById(id)),
      path => once(`asset:${path}`, assetExists(path)),
      newTabKey,
    );
    for (const pane of panes(root)) {
      for (const tab of pane.tabs) {
        if (tab.note) sessions.set(tab.note, createSession(tab.note));
      }
    }
    setLayout({ root });
    const all = panes(layout.root);
    const focused = all[file.focused ?? 0] ?? all[0];
    setFocusedId(focused.id);
    if (focused.mode !== 'read') setLastEditing(focused.id);
  } catch (error) {
    console.warn('ignoring unreadable workspace.json:', error);
  }
}

// --- notes ---

/**
 * `text` with curly quotes made straight. The preview sees a link's text
 * after Typst turned `'` and `"` into smart quotes; the source has them
 * straight, and titles may have either.
 */
export const plainQuotes = (text: string) =>
  text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');

/** A title as links match it: trimmed, case-insensitive, quotes straight. */
export const titleKey = (title: string) =>
  plainQuotes(title.trim()).toLowerCase();

/** The folder a note created at `placement` lands in. */
export const placementFolder = (placement: Placement) =>
  placement.kind === 'unaddressed'
    ? (placement.folder ?? '')
    : (zettelkasten()?.path ?? '');

/**
 * Why a note titled `title` can't be in `folder` (another note there has
 * that title; notes in other folders may), or null. `except` is the note
 * being renamed or moved. The backend refuses the same.
 */
export function titleClash(
  folder: string,
  title: string,
  except?: NoteId,
): string | null {
  const key = titleKey(title);
  if (!key) return null;
  const taken = allNotes().some(
    n =>
      n.id !== except &&
      n.folder === folder &&
      n.title &&
      titleKey(n.title) === key,
  );
  if (!taken) return null;
  const place = folder ? `"${folder}"` : 'the vault root';
  return `A note titled "${title.trim()}" is already in ${place}.`;
}

const sameTarget = (a: string, b: string) =>
  plainQuotes(a.trim()) === plainQuotes(b.trim());

/** Where new notes' editors put the cursor, as an offset from the end of the text. */
const startCursors = new Map<NoteId, number>();

/** Where note `id`'s new editor puts its cursor, once (from its template). */
export function takeStartCursor(id: NoteId, text: string): number | undefined {
  const fromEnd = startCursors.get(id);
  startCursors.delete(id);
  return fromEnd === undefined ? undefined : Math.max(0, text.length - fromEnd);
}

export async function createNote(
  placement: Placement,
  title: string,
  kind?: string,
  open = true,
) {
  const template = await vault.noteTemplate(kind);
  const { body, cursor } = expandTemplate(template, {
    title,
    now: new Date(),
  });
  const note = await vault.createNote(
    placement,
    title || undefined,
    kind,
    body,
  );
  // The body ends the note's text (see `create_note_of_kind`).
  if (cursor !== null) startCursors.set(note.id, body.length - cursor);
  await refreshTree();
  if (open) openNote(note.id);
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
  const tab = tabOf(id);
  if (tab) await closeTab(tab.key, true);
  // Links to the note get rewritten in any note.
  await flushAll();
  await reloadChanged(await vault.deleteNote(id, settings.deleteMode));
}

/** Reloads notes whose files the backend rewrote into their open editors. */
async function reloadChanged(ids: NoteId[]) {
  for (const id of ids) {
    const session = sessions.get(id);
    if (session) session.replaceText(await vault.readNote(id));
  }
  await refreshTree();
}

/**
 * Moves (files or re-addresses) a note to a Zettelkasten address. Unsaved
 * edits are saved first: the move may rewrite links in any note.
 */
export async function moveToAddress(id: NoteId, placement: Placement) {
  await flushAll();
  await reloadChanged(await vault.applyMove(id, placement));
}

/** Names the sequences `first` to `last` as a section. */
export async function markSection(first: number, last: number, name: string) {
  await vault.markSection(first, last, name);
  await refreshTree();
}

export async function renameSection(first: number, name: string) {
  await vault.renameSection(first, name);
  await refreshTree();
}

/** Removes a section's heading; its notes stay. */
export async function unmarkSection(first: number) {
  await vault.unmarkSection(first);
  await refreshTree();
}

export async function moveToFolder(id: NoteId, folder: string) {
  await flushAll();
  await reloadChanged(await vault.moveToFolder(id, folder));
}

export async function createFolder(parent: string, name: string) {
  const path = await vault.createFolder(parent, name);
  setFolderCollapsed(parent, false);
  await refreshTree();
  return path;
}

export async function renameFolder(path: string, name: string) {
  await flushAll();
  const moved = await vault.renameFolder(path, name);
  const renamed = moved.path;
  for (const key of ['newNoteFolder', 'attachmentFolder'] as const) {
    const target = settings[key];
    if (target === path || target.startsWith(`${path}/`)) {
      updateSettings({ [key]: renamed + target.slice(path.length) });
    }
  }
  setCollapsedFolders(list =>
    list.map(p =>
      p === path || p.startsWith(`${path}/`)
        ? renamed + p.slice(path.length)
        : p,
    ),
  );
  await afterPathMove(path, moved);
}

export async function deleteFolder(path: string) {
  const inside = (folder: string) =>
    folder === path || folder.startsWith(`${path}/`);
  for (const tab of allTabs()) {
    const folder = tab.asset
      ? parentFolder(tab.asset)
      : tab.note && noteById(tab.note)?.folder;
    if (folder !== undefined && folder !== null && inside(folder)) {
      await closeTab(tab.key, true);
    }
  }
  await flushAll();
  const changed = await vault.deleteFolder(path, settings.deleteMode);
  setCollapsedFolders(list => list.filter(p => !inside(p)));
  persistWorkspace();
  await reloadChanged(changed);
}

export async function setZettelkasten(path: string) {
  await vault.setZettelkasten(path);
  await refreshTree();
}

// --- preambles ---

const [preambles, setPreambles] = createSignal<Preamble[]>([]);

/** The common preamble, then one per kind, as last loaded or saved. */
export { preambles };

/** Kinds of notes, in name order. */
export const kinds = () =>
  preambles().flatMap(p => (p.kind === null ? [] : [p.kind]));

/** Rereads the preambles and hands the ones that exist to the compiler. */
async function loadPreambles() {
  const list = await vault.listPreambles();
  const gone = preambles().filter(
    old => !list.some(p => p.path === old.path && p.exists),
  );
  for (const preamble of gone) await typst.removeSource(preamble.path);
  for (const preamble of list) {
    if (preamble.exists) await typst.setSource(preamble.path, preamble.text);
  }
  setPreambles(list);
}

/**
 * Wrappers and prefixes depend on which preambles exist and define
 * `template`, so every open note refetches its own; then the visible
 * preview recompiles and the rest when shown.
 */
async function reloadMains(only?: NoteSession[]) {
  const affected = only ?? [...sessions.values()];
  await Promise.all(affected.map(s => s.reloadMain()));
  invalidatePreviews(affected);
}

/** Saves a preamble (`kind` null: the common one) and recompiles with it. */
export async function savePreamble(
  kind: string | null,
  text: string,
): Promise<PreambleWarning[]> {
  const warnings = await vault.savePreamble(kind, text);
  const preamble = preambles().find(p => p.kind === kind);
  if (!preamble) return warnings;
  await typst.setSource(preamble.path, text);
  setPreambles(list =>
    list.map(p =>
      p.kind === kind ? { ...p, text, exists: true, warnings } : p,
    ),
  );
  if (!preamble.exists) {
    // A new file: no note imports it yet, every wrapper may need it now.
    await reloadMains();
  } else {
    // Only the notes whose last compile read it.
    const mains = new Set(await typst.affectedMains(preamble.path));
    await reloadMains(
      [...sessions.values()].filter(s => mains.has(s.mainPath() ?? '')),
    );
  }
  return warnings;
}

export async function createKind(name: string) {
  await vault.createKind(name);
  await loadPreambles();
  await refreshTree();
  await reloadMains();
}

/** Renames a kind; notes of that kind are rewritten to the new name. */
export async function renameKind(from: string, to: string) {
  await flushAll();
  const changed = await vault.renameKind(from, to);
  const folder = settings.kindFolders[from];
  if (folder !== undefined) {
    setKindFolder(from, null);
    setKindFolder(to, folder);
  }
  await loadPreambles();
  await reloadChanged(changed);
  await reloadMains();
}

/** Deletes a kind's preamble; its notes keep the kind and get a warning. */
export async function deleteKind(name: string) {
  await vault.deleteKind(name, settings.deleteMode);
  setKindFolder(name, null);
  await loadPreambles();
  await refreshTree();
  await reloadMains();
}

/** Sets or (with null) clears note `id`'s kind. */
export async function setNoteKind(id: NoteId, kind: string | null) {
  const session = sessions.get(id);
  await session?.flush();
  await vault.setKind(id, kind);
  if (session) session.replaceText(await vault.readNote(id));
  await refreshTree();
  await session?.reloadMain();
  invalidatePreviews();
}

/** The focused pane's note's session, which preamble analysis runs as part of. */
const activeSession = () => {
  const id = activeNote();
  return id ? sessions.get(id) : undefined;
};

/**
 * Typst completions (or signature help) in a preamble's editor, analysed as
 * part of the focused note's preview; none while no note is open.
 */
export async function completePreamble(
  path: string,
  text: string,
  position: Position,
  explicit: boolean,
): Promise<Completions | null> {
  const main = activeSession()?.mainPath();
  return main ? typst.complete(main, path, text, position, explicit) : null;
}

export async function preambleSignature(
  path: string,
  text: string,
  position: Position,
): Promise<Signature | null> {
  const main = activeSession()?.mainPath();
  return main ? typst.signature(main, path, text, position) : null;
}

export async function preambleTooltip(
  path: string,
  text: string,
  position: Position,
  before: boolean,
): Promise<Hover | null> {
  const main = activeSession()?.mainPath();
  return main ? typst.tooltip(main, path, text, position, before) : null;
}

/** The focused note's latest compile diagnostics located in `path`. */
export function diagnosticsIn(path: string): Diagnostic[] {
  const result = activeSession()?.result();
  return result?.diagnostics.filter(d => d.path === path) ?? [];
}

/** Whether note `id`'s editor is on screen: its pane's active tab, not in reading mode. */
export const isEditorShown = (id: NoteId) =>
  panes(layout.root).some(p => paneNote(p) === id && p.mode !== 'read');

// --- assets ---

const parentFolder = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

/** Images the app shows in a tab; other files open in their own app. */
const VIEWABLE = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;
export const isViewable = (path: string) => VIEWABLE.test(path);

const assetTab = (path: string) => allTabs().find(t => t.asset === path);

/** The image in the focused pane's active tab, if any. */
export const activeAsset = () =>
  focusedPane().tabs.find(t => t.key === focusedPane().active)?.asset ?? null;

/** Bumped when an asset changes on disk, so an image tab shows the new one. */
const [assetVersions, setAssetVersions] = createSignal(
  new Map<string, number>(),
);
export const assetVersion = (path: string) => assetVersions().get(path) ?? 0;

/**
 * Opens asset `path`: an image in a tab (like a note: at most one tab per
 * image), anything else in the system's app for it.
 */
export async function openAsset(path: string) {
  if (!isViewable(path)) {
    await vault.openAsset(path);
    return;
  }
  const existing = assetTab(path);
  if (existing) {
    activateTab(existing.key);
    return;
  }
  const target = focusedPane();
  update(state => {
    const pane = findPane(state.root, target.id);
    if (!pane) return;
    const current = pane.tabs.find(t => t.key === pane.active);
    if (current && isEmptyTab(current)) {
      current.asset = path;
    } else {
      const key = newTabKey();
      pane.tabs.push({ key, note: null, asset: path });
      pane.active = key;
    }
  });
}

/**
 * After an asset or folder moved from `from` (and paths to it were
 * rewritten): tabs follow it, rewritten notes reload, preambles reload
 * (they may have been rewritten too), and the compiler forgets both paths.
 */
async function afterPathMove(from: string, moved: Moved) {
  const rebase = (path: string) =>
    path === from || path.startsWith(`${from}/`)
      ? moved.path + path.slice(from.length)
      : path;
  update(state => {
    for (const pane of panes(state.root)) {
      for (const tab of pane.tabs) if (tab.asset) tab.asset = rebase(tab.asset);
    }
  });
  await reloadChanged(moved.changed);
  await loadPreambles();
  await reloadMains();
  await typst.forgetFile(`/${from}`);
  await typst.forgetFile(`/${moved.path}`);
}

export async function renameAsset(path: string, name: string) {
  await flushAll();
  await afterPathMove(path, await vault.renameAsset(path, name));
}

export async function moveAsset(path: string, folder: string) {
  if (parentFolder(path) === folder) return;
  await flushAll();
  await afterPathMove(path, await vault.moveAsset(path, folder));
}

export async function deleteAsset(path: string) {
  const tab = assetTab(path);
  if (tab) await closeTab(tab.key);
  await vault.deleteAsset(path, settings.deleteMode);
  await typst.forgetFile(`/${path}`);
  await refreshTree();
}

/** Copies files from outside the vault (dropped from Finder) into `folder`. */
export async function importAssets(folder: string, sources: string[]) {
  const added: string[] = [];
  for (const source of sources)
    added.push(await vault.importAsset(folder, source));
  setFolderCollapsed(folder, false);
  await refreshTree();
  return added;
}

/** Where files pasted or dropped into note `id` go (`attachmentLocation`). */
function attachmentFolder(id: NoteId | null): string {
  switch (settings.attachmentLocation) {
    case 'root':
      return '';
    case 'current':
      return (id && noteById(id)?.folder) || '';
    case 'folder':
      return settings.attachmentFolder;
  }
}

/** Saves a file pasted into note `id`; resolves to its vault path. */
export async function saveAttachment(
  id: NoteId | null,
  name: string,
  data: ArrayBuffer,
) {
  const path = await vault.addAsset(attachmentFolder(id), name, data);
  await refreshTree();
  return path;
}

/** The open note whose editor is `view`. */
export const noteOfView = (view: EditorView) =>
  [...sessions.values()].find(s => s.shownView() === view)?.id ?? null;

/** Copies files dropped onto note `id`'s editor; resolves to their vault paths. */
export function importAttachments(id: NoteId | null, sources: string[]) {
  return importAssets(attachmentFolder(id), sources);
}

/**
 * Takes in changes made to the vault outside the app (the backend's file
 * watcher): the tree, notes' text (open editors without unsaved edits
 * reload, others get a conflict notice), assets the compiler has loaded,
 * and preambles.
 */
export async function applyDiskChanges(changes: DiskChanges) {
  for (const id of changes.removed) {
    const folder = noteById(id)?.folder;
    if (folder !== undefined) deletedFrom.set(id, folder);
  }
  if (
    changes.tree ||
    changes.changed.length > 0 ||
    changes.removed.length > 0
  ) {
    await refreshTree();
  }
  for (const id of changes.changed) {
    const session = sessions.get(id);
    if (!session) continue;
    if (session.dirty()) session.setConflict('changed');
    else session.loadFromDisk(await vault.readNote(id));
  }
  for (const id of changes.removed) {
    const session = sessions.get(id);
    const tab = tabOf(id);
    if (!session || !tab) continue;
    if (session.dirty()) session.setConflict('deleted');
    else await closeTab(tab.key, true);
  }
  for (const path of changes.assets) {
    const mains = new Set(await typst.forgetFile(`/${path}`));
    invalidatePreviews(
      [...sessions.values()].filter(s => mains.has(s.mainPath() ?? '')),
    );
    const tab = assetTab(path);
    if (tab && !assetExists(path)) await closeTab(tab.key);
  }
  if (changes.assets.length > 0) {
    setAssetVersions(versions => {
      const next = new Map(versions);
      for (const path of changes.assets)
        next.set(path, (next.get(path) ?? 0) + 1);
      return next;
    });
  }
  if (changes.preambles) {
    await loadPreambles();
    await reloadMains();
  }
}

/** Resolves a conflict: keep the editor's text (saved over the file) or take the file's. */
export async function resolveConflict(id: NoteId, keep: 'mine' | 'disk') {
  const session = sessions.get(id);
  if (!session) return;
  const conflict = session.conflict();
  if (keep === 'disk') {
    if (conflict === 'deleted') {
      const tab = tabOf(id);
      if (tab) await closeTab(tab.key, true);
    } else {
      session.loadFromDisk(await vault.readNote(id));
    }
    return;
  }
  session.setConflict(null);
  const text = session.currentText();
  if (conflict === 'deleted') {
    await vault.restoreNote(id, deletedFrom.get(id) ?? '', text);
    deletedFrom.delete(id);
    await refreshTree();
  } else {
    // Written even when nothing is pending: the file has the other text.
    session.edit(text);
  }
  await session.flush();
}

/** The folders of notes deleted on disk, for restoring them. */
const deletedFrom = new Map<NoteId, string>();
