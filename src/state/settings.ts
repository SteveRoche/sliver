import { createStore } from "solid-js/store";
import { type DeleteMode, vault } from "../vault/api";

/** App-level settings, persisted by the backend in `state.json`. */
export interface Settings {
  vim: boolean;
  deleteMode: DeleteMode;
  /** What resolved wikilinks show when they have no custom text. */
  linkDisplay: "title" | "address";
}

const DEFAULTS: Settings = {
  vim: false,
  deleteMode: "trash",
  linkDisplay: "title",
};

const [settings, setStore] = createStore<Settings>({ ...DEFAULTS });

export { settings };

export async function loadSettings() {
  const saved = await vault.getSettings().catch(() => null);
  if (saved && typeof saved === "object") {
    setStore({ ...DEFAULTS, ...(saved as Partial<Settings>) });
  }
}

export function updateSettings(patch: Partial<Settings>) {
  setStore(patch);
  vault
    .setSettings({ ...settings })
    .catch((error) => console.warn("could not save settings:", error));
}
