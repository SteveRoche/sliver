import { ask, open } from "@tauri-apps/plugin-dialog";
import { openPalette } from "../components/Palette";
import { prompt } from "../components/Prompt";
import { openSettings } from "../components/SettingsDialog";
import { menuTarget } from "../components/Sidebar";
import { settings, updateSettings } from "../state/settings";
import {
  active,
  activeNote,
  closeTab,
  createNote,
  cycleTab,
  deleteNote,
  newTab,
  noteById,
  noteLabel,
  openVault,
  refreshLinks,
  renameNote,
  tabs,
  vaultRoot,
} from "../state/workspace";
import type { NoteId, Placement } from "../vault/api";
import { type Command, registerCommands } from "./registry";

export async function chooseAndOpenVault(create: boolean) {
  const path = await open({
    directory: true,
    title: create ? "Choose an empty folder for the new vault" : "Open a vault",
  });
  if (typeof path !== "string") return;
  await openVault(path, create);
}

async function newNote(placement: Placement, heading: string) {
  const title = await prompt({
    title: heading,
    label: "Title",
    confirm: "Create",
  });
  if (title === null) return;
  await createNote(placement, title.trim());
}

async function rename(id: NoteId) {
  const note = noteById(id);
  const title = await prompt({
    title: "Rename note",
    label: "Title",
    initial: note?.title ?? "",
    confirm: "Rename",
  });
  if (title === null || !title.trim()) return;
  await renameNote(id, title.trim());
}

async function remove(id: NoteId) {
  const verb =
    settings.deleteMode === "trash" ? "Move to trash" : "Delete permanently";
  const ok = await ask(`${verb}: "${noteLabel(noteById(id))}"?`, {
    title: "Delete note",
    kind: "warning",
    okLabel: verb,
  });
  if (ok) await deleteNote(id);
}

const hasVault = () => vaultRoot() !== null;
const hasAddress = (id: NoteId | null) => !!id && !!noteById(id)?.address;

/**
 * Note commands for one target: the active note (`note.*`, with keybindings)
 * or the sidebar's right-clicked note (`menu.*`, only enabled while its
 * context menu is open, so they stay out of the palette).
 */
function onNote(
  idPrefix: string,
  target: () => NoteId | null,
  keybindings: boolean,
): Command[] {
  const withTarget = (f: (id: NoteId) => unknown) => () => {
    const id = target();
    if (id) return f(id);
  };
  const enabled =
    (needsAddress = false) =>
    () =>
      hasVault() && (needsAddress ? hasAddress(target()) : target() !== null);
  return [
    {
      id: `${idPrefix}.continue`,
      title: "New continuation of current note",
      enabled: enabled(true),
      run: withTarget((of) =>
        newNote({ kind: "continuation", of }, "New continuation"),
      ),
    },
    {
      id: `${idPrefix}.branch`,
      title: "New branch from current note",
      enabled: enabled(true),
      run: withTarget((of) => newNote({ kind: "branch", of }, "New branch")),
    },
    {
      id: `${idPrefix}.rename`,
      title: "Rename current note",
      keybinding: keybindings ? "F2" : undefined,
      enabled: enabled(),
      run: withTarget(rename),
    },
    {
      id: `${idPrefix}.delete`,
      title: "Delete current note",
      enabled: enabled(),
      run: withTarget(remove),
    },
  ];
}

/** Registers every app command; returns the unregister function. */
export function registerAppCommands(): () => void {
  return registerCommands([
    {
      id: "palette.commands",
      title: "Show all commands",
      keybinding: "Mod+Shift+P",
      run: () => openPalette("commands"),
    },
    {
      id: "palette.notes",
      title: "Go to note",
      keybinding: "Mod+O",
      enabled: hasVault,
      run: () => openPalette("notes"),
    },
    {
      id: "note.new",
      title: "New note (next top-level address)",
      keybinding: "Mod+N",
      enabled: hasVault,
      run: () => newNote({ kind: "top" }, "New note"),
    },
    {
      id: "note.newUnaddressed",
      title: "New note without an address",
      enabled: hasVault,
      run: () => newNote({ kind: "unaddressed" }, "New note"),
    },
    ...onNote("note", activeNote, true),
    ...onNote("menu", menuTarget, false),
    {
      id: "tab.new",
      title: "New tab",
      keybinding: "Mod+T",
      enabled: hasVault,
      run: newTab,
    },
    {
      id: "tab.close",
      title: "Close tab",
      keybinding: "Mod+W",
      enabled: () => active() !== null,
      run: () => {
        const key = active();
        if (key) return closeTab(key);
      },
    },
    {
      id: "tab.next",
      title: "Next tab",
      keybinding: "Ctrl+Tab",
      enabled: () => tabs.length > 1,
      run: () => cycleTab(1),
    },
    {
      id: "tab.previous",
      title: "Previous tab",
      keybinding: "Ctrl+Shift+Tab",
      enabled: () => tabs.length > 1,
      run: () => cycleTab(-1),
    },
    {
      id: "settings.open",
      title: "Open settings",
      keybinding: "Mod+,",
      run: openSettings,
    },
    {
      id: "editor.toggleVim",
      title: "Toggle Vim key bindings",
      run: () => updateSettings({ vim: !settings.vim }),
    },
    {
      id: "links.toggleDisplay",
      title: "Toggle wikilinks between titles and addresses",
      enabled: hasVault,
      run: () => {
        updateSettings({
          linkDisplay: settings.linkDisplay === "title" ? "address" : "title",
        });
        return refreshLinks();
      },
    },
    {
      id: "vault.open",
      title: "Open another vault...",
      run: () => chooseAndOpenVault(false),
    },
    {
      id: "vault.create",
      title: "Create a new vault...",
      run: () => chooseAndOpenVault(true),
    },
  ]);
}
