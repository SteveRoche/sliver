import { createStore } from "solid-js/store";
import { type DeleteMode, vault } from "../vault/api";

/** Per-vault settings, persisted by the backend in `.sliver/settings.json`. */
export interface Settings {
  vim: boolean;
  lineNumbers: boolean;
  deleteMode: DeleteMode;
  /** What resolved wikilinks show when they have no custom text. */
  linkDisplay: "title" | "address";
  /**
   * Where Mod+N creates notes. A note that lands in the Zettelkasten asks
   * for its address first.
   */
  newNoteLocation: "root" | "current" | "folder";
  /** The folder for `newNoteLocation: "folder"`; `""` is the vault root. */
  newNoteFolder: string;
  theme: "system" | "light" | "dark";
  /** The preview's theme: the app's, or fixed. */
  previewTheme: "app" | "light" | "dark";
  /** Widest preview page, in CSS px. */
  maxPreviewWidth: number;
}

const DEFAULTS: Settings = {
  vim: false,
  lineNumbers: true,
  deleteMode: "trash",
  linkDisplay: "title",
  newNoteLocation: "root",
  newNoteFolder: "",
  theme: "system",
  previewTheme: "app",
  maxPreviewWidth: 560,
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
    console.warn("ignoring unreadable settings.json:", error);
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

export function updateSettings(patch: Partial<Settings>) {
  setStore(patch);
  if (!loaded) return;
  vault
    .saveSettings(JSON.stringify({ ...settings }, null, 2))
    .catch((error) => console.warn("could not save settings:", error));
}
