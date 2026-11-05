import { createStore } from 'solid-js/store';
import { type DeleteMode, vault } from '../vault/api';

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
  defaultViewMode: 'edit' | 'read' | 'source';
  /** Where "New note of kind" puts each kind's notes, by kind name. */
  kindFolders: Record<string, string>;
}

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
};

const [settings, setStore] = createStore<Settings>({ ...DEFAULTS });
/** True while a vault is open, so there's somewhere to save to. */
let loaded = false;

export { settings };

/** Loads the open vault's settings over the defaults. */
export async function loadSettings() {
  const json = await vault.loadSettings().catch(() => null);
  let saved: Partial<Settings> = {};
  try {
    if (json) saved = JSON.parse(json);
  } catch (error) {
    console.warn('ignoring unreadable settings.json:', error);
  }
  // A value of the wrong type (hand-edited, or from an older schema) is dropped.
  const valid = Object.fromEntries(
    Object.entries(saved).filter(
      ([key, value]) =>
        key in DEFAULTS &&
        typeof value === typeof DEFAULTS[key as keyof Settings],
    ),
  );
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

export function updateSettings(patch: Partial<Settings>) {
  setStore(patch);
  if (!loaded) return;
  vault
    .saveSettings(JSON.stringify({ ...settings }, null, 2))
    .catch((error) => console.warn('could not save settings:', error));
}
