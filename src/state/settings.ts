import { createStore } from 'solid-js/store';
import { type DeleteMode, vault } from '../vault/api';
import type { ViewMode } from './layout';

/** Per-vault settings, persisted by the backend in `.sliver/settings.json`. */
export interface Settings {
  vim: boolean;
  lineNumbers: boolean;
  /** Save while typing; when off, notes save on Mod+S and when their tab or the window closes. */
  autosave: boolean;
  /** How long typing must pause before an autosave, in ms. */
  autosaveDelay: number;
  deleteMode: DeleteMode;
  /** What resolved wikilinks show when they have no custom text. */
  linkDisplay: 'title' | 'address';
  /**
   * Where Mod+N creates notes. A note that lands in the Zettelkasten asks
   * for its address first.
   */
  newNoteLocation: 'root' | 'current' | 'folder';
  /** The folder for `newNoteLocation: "folder"`; `""` is the vault root. */
  newNoteFolder: string;
  theme: 'system' | 'light' | 'dark';
  /** The preview's theme: the app's, or fixed. */
  previewTheme: 'app' | 'light' | 'dark';
  /** Widest preview page, in CSS px. */
  maxPreviewWidth: number;
  /** Scroll the preview to where the editor's cursor rests. */
  previewFollowsCursor: boolean;
  /** The view a pane starts in when it's created (by splitting, or for an empty workspace). */
  defaultViewMode: ViewMode;
  /** Where "New note of kind" puts each kind's notes, by kind name. */
  kindFolders: Record<string, string>;
  /**
   * How citations and reference lists are formatted: a Typst style name or
   * a custom style's path. Kinds (through their template) and notes (the
   * `citation-style` header field) can override it.
   */
  citationStyle: string;
  /** End each preview with the reference list of what the note cites. */
  showReferences: boolean;
  /** Keybindings changed from their defaults, by command id; `""` is none. */
  keybindings: Record<string, string>;
}

/** APA, the default citation style (Typst's full name; `apa` is its alias). */
export const DEFAULT_CITATION_STYLE = 'american-psychological-association';

const DEFAULTS: Settings = {
  vim: false,
  lineNumbers: true,
  autosave: true,
  autosaveDelay: 500,
  deleteMode: 'trash',
  linkDisplay: 'title',
  newNoteLocation: 'root',
  newNoteFolder: '',
  theme: 'system',
  previewTheme: 'app',
  maxPreviewWidth: 560,
  previewFollowsCursor: true,
  defaultViewMode: 'edit',
  kindFolders: {},
  citationStyle: DEFAULT_CITATION_STYLE,
  showReferences: true,
  keybindings: {},
};

/** The allowed values of the settings that are a choice. */
const CHOICES: { [K in keyof Settings]?: readonly Settings[K][] } = {
  deleteMode: ['trash', 'permanent'],
  linkDisplay: ['title', 'address'],
  newNoteLocation: ['root', 'current', 'folder'],
  theme: ['system', 'light', 'dark'],
  previewTheme: ['app', 'light', 'dark'],
  defaultViewMode: ['edit', 'read', 'source'],
};

/** Whether `value` (from a hand-editable file) can be setting `key`. */
function isValid(key: string, value: unknown): boolean {
  if (!(key in DEFAULTS)) return false;
  const k = key as keyof Settings;
  if (typeof value !== typeof DEFAULTS[k]) return false;
  const choices: readonly unknown[] | undefined = CHOICES[k];
  if (choices) return choices.includes(value);
  if (k === 'kindFolders' || k === 'keybindings') {
    return (
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value as object).every(v => typeof v === 'string')
    );
  }
  return typeof value !== 'number' || Number.isFinite(value);
}

const [settings, setStore] = createStore<Settings>({ ...DEFAULTS });
/** True while a vault is open, so there's somewhere to save to. */
let loaded = false;

export { settings };

/** Loads the open vault's settings over the defaults. */
export async function loadSettings() {
  const json = await vault.loadSettings().catch(() => null);
  let saved: unknown = {};
  try {
    if (json) saved = JSON.parse(json);
  } catch (error) {
    console.warn('ignoring unreadable settings.json:', error);
  }
  // A value that isn't valid (hand-edited, or from an older schema) is dropped.
  const valid: Partial<Settings> =
    saved && typeof saved === 'object'
      ? Object.fromEntries(
          Object.entries(saved).filter(([key, value]) => isValid(key, value)),
        )
      : {};
  setStore({ ...DEFAULTS, ...valid });
  loaded = true;
}

export function resetSettings() {
  loaded = false;
  setStore({ ...DEFAULTS });
}

/** Puts every setting of the open vault back to its default. */
export function restoreDefaults() {
  updateSettings({ ...DEFAULTS });
}

/** Sets (or with null clears) kind `kind`'s default folder. */
export function setKindFolder(kind: string, folder: string | null) {
  const { [kind]: _, ...rest } = settings.kindFolders;
  updateSettings({
    kindFolders: folder === null ? rest : { ...rest, [kind]: folder },
  });
}

/** Sets command `id`'s keybinding (`""` for none), or with null its default again. */
export function setKeybinding(id: string, keybinding: string | null) {
  const { [id]: _, ...rest } = settings.keybindings;
  updateSettings({
    keybindings: keybinding === null ? rest : { ...rest, [id]: keybinding },
  });
}

export function updateSettings(patch: Partial<Settings>) {
  setStore(patch);
  if (!loaded) return;
  vault
    .saveSettings(JSON.stringify({ ...settings }, null, 2))
    .catch(error => console.warn('could not save settings:', error));
}
