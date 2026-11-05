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

export const vault = {
  create: (path: string) => invoke<FolderNode>('create_vault', { path }),
  open: (path: string) => invoke<FolderNode>('open_vault', { path }),
  last: () => invoke<string | null>('last_vault'),
  tree: () => invoke<FolderNode>('list_tree'),
  createNote: (placement: Placement, title?: string, kind?: string) =>
    invoke<NoteSummary>('create_note', { placement, title, kind }),
  readNote: (id: NoteId) => invoke<string>('read_note', { id }),
  writeNote: (id: NoteId, text: string) =>
    invoke<NoteSummary>('write_note', { id, text }),
  renameNote: (id: NoteId, title: string) =>
    invoke<NoteSummary>('rename_note', { id, title }),
  deleteNote: (id: NoteId, mode?: DeleteMode) =>
    invoke<void>('delete_note', { id, mode }),
  createFolder: (parent: string, name: string) =>
    invoke<string>('create_folder', { parent, name }),
  renameFolder: (path: string, name: string) =>
    invoke<string>('rename_folder', { path, name }),
  /** Resolves to the ids of the notes deleted with the folder. */
  deleteFolder: (path: string, mode?: DeleteMode) =>
    invoke<NoteId[]>('delete_folder', { path, mode }),
  setZettelkasten: (path: string) => invoke<void>('set_zettelkasten', { path }),
  /** Resolves to the ids of every note whose file changed. */
  moveToFolder: (id: NoteId, folder: string) =>
    invoke<NoteId[]>('move_to_folder', { id, folder }),
  planMove: (id: NoteId, placement: Placement) =>
    invoke<MovePlan>('plan_move', { id, placement }),
  /** Resolves to the ids of every note whose file changed. */
  applyMove: (id: NoteId, placement: Placement) =>
    invoke<NoteId[]>('apply_move', { id, placement }),
  backlinks: (id: NoteId) => invoke<NoteSummary[]>('backlinks', { id }),
  /** `/.sliver/links.typ`: the link table and `wikilinks` show rule. */
  linkLibrary: (showAddresses: boolean) =>
    invoke<SourceFile>('link_library', { showAddresses }),
  analyze: (text: string) => invoke<Analysis>('analyze', { text }),
  /** `/.sliver/theme.typ` with the light or dark theme's colours. */
  themeLibrary: (dark: boolean) =>
    invoke<SourceFile>('theme_library', { dark }),
  /** The wrapper main that includes note `id` with wikilinks applied. */
  previewMain: (id: NoteId) => invoke<PreviewMain>('preview_main', { id }),
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
  openInZotero: (key: string) => invoke<void>('open_in_zotero', { key }),
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
    /** Drops unsaved edits, e.g. after the note was deleted. */
    cancel() {
      clearTimeout(timer);
      pending = undefined;
    },
    hasPending: () => pending !== undefined,
  };
}
