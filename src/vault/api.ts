import { invoke } from '@tauri-apps/api/core';

export type NoteId = string;

export interface NoteSummary {
  id: NoteId;
  title: string | null;
  /** As written in the header; may not be a valid address. */
  address: string | null;
  tags: string[];
  headerError: string | null;
  /** Directory relative to the vault root, `/`-separated; `""` is the root. */
  folder: string;
  /** The note's kind, which picks its kind preamble. */
  kind: string | null;
}

export interface TreeNode extends NoteSummary {
  /** Something about the note's place in the vault looks wrong. */
  warning: string | null;
  children: TreeNode[];
}

/**
 * A folder: subfolders, then notes. In the Zettelkasten the notes form the
 * address tree (unaddressed ones last); elsewhere they're a flat list.
 */
export interface FolderNode {
  name: string;
  path: string;
  kind: 'plain' | 'zettelkasten';
  warning: string | null;
  folders: FolderNode[];
  notes: TreeNode[];
  /** Files that aren't notes, by name. */
  assets: AssetNode[];
}

/** A file in the vault that isn't a note: an image, a PDF, data, ... */
export interface AssetNode {
  name: string;
  /** Relative to the vault root, `/`-separated (no leading slash). */
  path: string;
}

/** Where an asset or folder went, and the notes whose paths were rewritten. */
export interface Moved {
  path: string;
  changed: NoteId[];
}

/** What moving an asset or folder would rewrite, for a confirmation prompt. */
export interface PathPlan {
  notes: { id: NoteId; count: number }[];
  /** Preambles and templates, as vault paths. */
  files: string[];
}

/** What changed in the vault outside the app (the `vault-changed` event). */
export interface DiskChanges {
  changed: NoteId[];
  removed: NoteId[];
  /** Assets added, changed or removed, as vault paths. */
  assets: string[];
  tree: boolean;
  preambles: boolean;
}

/** What `applyMove` would change, for a confirmation prompt. */
export interface MovePlan {
  moves: { id: NoteId; from: string | null; to: string }[];
  linkEdits: { id: NoteId; count: number }[];
}

export type Placement =
  | { kind: 'unaddressed'; folder?: string }
  | { kind: 'top' }
  /** The next free sibling of `of`: `1.1a` -> `1.1b`. */
  | { kind: 'aside'; of: NoteId }
  /** One level deeper than `of`: `1.1a` -> `1.1a1`. */
  | { kind: 'next'; of: NoteId };

export type DeleteMode = 'trash' | 'permanent';

/** A wikilink in the editor's text; offsets are UTF-16, like CodeMirror's. */
/** A new note's place for a link to an address: the next note of `of` (top level without it), at `address`. */
export interface AddressPlace {
  of: NoteId | null;
  address: string;
}

export interface LinkRange {
  from: number;
  to: number;
  target: string;
  targetFrom: number;
  targetTo: number;
  text: string | null;
}

/** A citation key in the editor's text: `@key`, or `<key>` in `cite(<key>)`. */
export interface CitationRange {
  from: number;
  to: number;
  key: string;
}

/** Highlighting, wikilinks and citations of a note's text (`sliver_vault::analyze`). */
export interface Analysis {
  /** Flat `from, to, tag` triples; `tag` indexes `tagClasses`. */
  highlights: number[];
  tagClasses: string[];
  links: LinkRange[];
  citations: CitationRange[];
  /** Paths that don't start at the vault root. */
  relativePaths: { from: number; to: number }[];
}

/** A generated Typst file the preview compiles alongside the notes. */
export interface SourceFile {
  path: string;
  text: string;
}

/** The wrapper main for a note, and the hidden lines before its text. */
export interface PreviewMain extends SourceFile {
  prefix: string;
}

/** Something in a preamble that would act differently in an export; UTF-16 offsets. */
export interface PreambleWarning {
  from: number;
  to: number;
  message: string;
}

/** What new notes start with below their header: the default (`kind` null) or a kind's. */
export interface Template {
  kind: string | null;
  /** As Typst sees it, with the vault as root. */
  path: string;
  /** Empty if the file doesn't exist yet. */
  text: string;
}

/** Shared Typst code: the common preamble (`kind` null) or a kind's. */
export interface Preamble {
  kind: string | null;
  /** As Typst sees it, with the vault as root. */
  path: string;
  text: string;
  exists: boolean;
  warnings: PreambleWarning[];
}

/** `.sliver/references.bib`: the entries for the keys the vault cites. */
export interface References extends SourceFile {
  entries: { key: string; title: string | null }[];
}

/** A custom CSL style from `.sliver/styles/`. */
export interface CitationStyle extends SourceFile {
  name: string;
}

/** A citation chosen in Zotero's picker. */
export interface ZoteroPick {
  citationKey: string;
  locator: string;
  /** What the locator counts, e.g. `page`. */
  label: string;
  suppressAuthor: boolean;
}

/** A Zotero item found by `zoteroSearch`. */
export interface ZoteroItem {
  citationKey: string;
  title: string;
  /** E.g. `Bellotti et al. 2004`. */
  byline: string;
}

export const vault = {
  create: (path: string) => invoke<FolderNode>('create_vault', { path }),
  open: (path: string) => invoke<FolderNode>('open_vault', { path }),
  last: () => invoke<string | null>('last_vault'),
  tree: () => invoke<FolderNode>('list_tree'),
  /** `body` goes below the header, e.g. an expanded template. */
  createNote: (
    placement: Placement,
    title?: string,
    kind?: string,
    body?: string,
  ) => invoke<NoteSummary>('create_note', { placement, title, kind, body }),
  readNote: (id: NoteId) => invoke<string>('read_note', { id }),
  writeNote: (id: NoteId, text: string) =>
    invoke<NoteSummary>('write_note', { id, text }),
  renameNote: (id: NoteId, title: string) =>
    invoke<NoteSummary>('rename_note', { id, title }),
  deleteNote: (id: NoteId, mode?: DeleteMode) =>
    invoke<void>('delete_note', { id, mode }),
  createFolder: (parent: string, name: string) =>
    invoke<string>('create_folder', { parent, name }),
  /** Paths into the folder are rewritten in notes, preambles and templates. */
  renameFolder: (path: string, name: string) =>
    invoke<Moved>('rename_folder', { path, name }),
  /** Resolves to the ids of the notes deleted with the folder. */
  deleteFolder: (path: string, mode?: DeleteMode) =>
    invoke<NoteId[]>('delete_folder', { path, mode }),
  setZettelkasten: (path: string) => invoke<void>('set_zettelkasten', { path }),
  /** Resolves to the ids of every note whose file changed. */
  moveToFolder: (id: NoteId, folder: string) =>
    invoke<NoteId[]>('move_to_folder', { id, folder }),
  /** Where a note created for a broken link to `target` goes, if it's an address (`place_for_address`). */
  placeForAddress: (target: string) =>
    invoke<AddressPlace | null>('place_for_address', { target }),
  planMove: (id: NoteId, placement: Placement) =>
    invoke<MovePlan>('plan_move', { id, placement }),
  /** Resolves to the ids of every note whose file changed. */
  applyMove: (id: NoteId, placement: Placement) =>
    invoke<NoteId[]>('apply_move', { id, placement }),
  backlinks: (id: NoteId) => invoke<NoteSummary[]>('backlinks', { id }),
  /** `/.sliver/links.typ`: the link table and `wikilinks` show rule. */
  linkLibrary: (showAddresses: boolean) =>
    invoke<SourceFile>('link_library', { showAddresses }),
  /** Note `id`'s link table: the notes its link `targets` name. */
  linkTable: (id: NoteId, targets: string[]) =>
    invoke<SourceFile>('link_table', { id, targets }),
  analyze: (text: string) => invoke<Analysis>('analyze', { text }),
  /** `/.sliver/theme.typ` with the light or dark theme's colours. */
  themeLibrary: (dark: boolean) =>
    invoke<SourceFile>('theme_library', { dark }),
  /** The wrapper main that includes note `id` with wikilinks applied. */
  previewMain: (id: NoteId) => invoke<PreviewMain>('preview_main', { id }),
  /** What "Restore default" puts back in a preamble or (`template`) a note template. */
  defaultText: (kind: string | null, template: boolean) =>
    invoke<string>('default_text', { kind, template }),
  listTemplates: () => invoke<Template[]>('list_templates'),
  saveTemplate: (kind: string | null, text: string) =>
    invoke<void>('save_template', { kind, text }),
  /** What a new note of `kind` starts with: its kind's template, else the default. */
  noteTemplate: (kind?: string) => invoke<string>('note_template', { kind }),
  listPreambles: () => invoke<Preamble[]>('list_preambles'),
  savePreamble: (kind: string | null, text: string) =>
    invoke<PreambleWarning[]>('save_preamble', { kind, text }),
  createKind: (name: string) => invoke<void>('create_kind', { name }),
  /** Resolves to the ids of the notes whose kind was rewritten. */
  renameKind: (from: string, to: string) =>
    invoke<NoteId[]>('rename_kind', { from, to }),
  deleteKind: (name: string, mode?: DeleteMode) =>
    invoke<void>('delete_kind', { name, mode }),
  setKind: (id: NoteId, kind: string | null) =>
    invoke<NoteSummary>('set_kind', { id, kind }),
  loadWorkspace: () => invoke<string | null>('load_workspace'),
  saveWorkspace: (json: string) => invoke<void>('save_workspace', { json }),
  /** The open vault's `.sliver/settings.json`, if it has one. */
  loadSettings: () => invoke<string | null>('load_settings'),
  saveSettings: (json: string) => invoke<void>('save_settings', { json }),
  references: () => invoke<References>('references'),
  /** `/.sliver/citations.typ`, what the preview wrapper knows about citations. */
  citationLibrary: (options: {
    style: string;
    styles: string[];
    showReferences: boolean;
    enabled: boolean;
  }) => invoke<SourceFile>('citation_library', options),
  citationStyles: () => invoke<CitationStyle[]>('citation_styles'),
  /**
   * Fetches entries from Zotero: with `all` every cited key (and drops
   * uncited entries), else only the missing ones.
   */
  refreshReferences: (all: boolean) =>
    invoke<{ changed: boolean; reachable: boolean }>('refresh_references', {
      all,
    }),
  zoteroReady: () => invoke<boolean>('zotero_ready'),
  /** Opens Zotero's citation picker; the picks' entries are saved first. */
  zoteroPick: () => invoke<ZoteroPick[]>('zotero_pick'),
  /** Items in the Zotero library matching `query`; none while Zotero isn't running. */
  zoteroSearch: (query: string) =>
    invoke<ZoteroItem[]>('zotero_search', { query }),
  openInZotero: (key: string) => invoke<void>('open_in_zotero', { key }),
  /** Any vault file by vault path (`/a/b.png`); rejects if there's none. */
  readFile: (path: string) => invoke<ArrayBuffer>('read_file', { path }),
  /** Saves a new asset; resolves to its vault path (a number added if taken). */
  addAsset: (folder: string, name: string, data: ArrayBuffer | Uint8Array) =>
    invoke<string>('add_asset', new Uint8Array(data), {
      headers: {
        'x-folder': encodeURIComponent(folder),
        'x-name': encodeURIComponent(name),
      },
    }),
  /** Copies a file from outside the vault into `folder`. */
  importAsset: (folder: string, source: string) =>
    invoke<string>('import_asset', { folder, source }),
  /** What moving asset or folder `from` to `to` would rewrite. */
  planPathMove: (from: string, to: string) =>
    invoke<PathPlan>('plan_path_move', { from, to }),
  renameAsset: (path: string, name: string) =>
    invoke<Moved>('rename_asset', { path, name }),
  moveAsset: (path: string, folder: string) =>
    invoke<Moved>('move_asset', { path, folder }),
  deleteAsset: (path: string, mode?: DeleteMode) =>
    invoke<void>('delete_asset', { path, mode }),
  /** Opens an asset in the system's default app for it. */
  openAsset: (path: string) => invoke<void>('open_asset', { path }),
  /** Opens a web or mail link in the default browser or mail app. */
  openUrl: (url: string) => invoke<void>('open_url', { url }),
  /** Writes a note deleted outside the app back to disk. */
  restoreNote: (id: NoteId, folder: string, text: string) =>
    invoke<NoteSummary>('restore_note', { id, folder, text }),
};

/**
 * Saves `id` once typing pauses for `delayMs()`, while `enabled()`. Writes
 * never overlap, and `flush()` saves anything pending immediately (call it
 * on tab close/blur, and for a manual save).
 */
export function autosave(
  id: NoteId,
  onSaved: (summary: NoteSummary) => void,
  onError: (error: unknown) => void,
  options: { enabled: () => boolean; delayMs: () => number },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | undefined;
  let saving: Promise<void> = Promise.resolve();

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const text = pending;
    if (text === undefined) return saving;
    pending = undefined;
    saving = saving
      .then(() => vault.writeNote(id, text))
      .then(onSaved, onError);
    return saving;
  };

  return {
    update(text: string) {
      pending = text;
      clearTimeout(timer);
      if (options.enabled()) timer = setTimeout(flush, options.delayMs());
    },
    flush,
    /** Stops a scheduled save; what's pending waits for `flush()`. */
    hold() {
      clearTimeout(timer);
    },
    /** Drops unsaved edits, e.g. after the note was deleted. */
    cancel() {
      clearTimeout(timer);
      pending = undefined;
    },
    hasPending: () => pending !== undefined,
  };
}
