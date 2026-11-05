import { ask, open } from "@tauri-apps/plugin-dialog";
import { openPalette, pick } from "../components/Palette";
import { prompt } from "../components/Prompt";
import { openSettings } from "../components/SettingsDialog";
import { menuFolder, menuTarget } from "../components/Sidebar";
import { togglePreview } from "../components/Workspace";
import { settings, updateSettings } from "../state/settings";
import {
  active,
  activeNote,
  allFolders,
  allNotes,
  closeTab,
  createFolder,
  createNote,
  cycleTab,
  deleteFolder,
  deleteNote,
  inZettelkasten,
  moveToAddress,
  moveToFolder,
  newTab,
  noteById,
  noteLabel,
  openVault,
  refreshLinks,
  renameFolder,
  renameNote,
  setZettelkasten,
  tabs,
  vaultRoot,
  zettelkasten,
} from "../state/workspace";
import { type NoteId, type Placement, vault } from "../vault/api";
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

/** Asks where in the Zettelkasten note `id` (or a new note, for null) should go. */
async function chooseAddress(id: NoteId | null): Promise<Placement | null> {
  const subtreeOf = id && noteById(id)?.address;
  const filed = id !== null && inZettelkasten(id);
  const targets = allNotes().filter(
    (n) =>
      n.address &&
      inZettelkasten(n.id) &&
      // A note can't be filed after or beside itself or the notes after it.
      !(filed && subtreeOf && isUnder(n.address, subtreeOf)),
  );
  const target = await pick<NoteId | null>("File after or beside...", [
    { label: "New top-level address", value: null },
    ...targets.map((n) => ({ label: noteLabel(n), value: n.id })),
  ]);
  if (!target) return null;
  if (target.value === null) return { kind: "top" };
  const of = target.value;
  const label = noteLabel(noteById(of));
  const how = await pick<"next" | "aside">("Next note or aside?", [
    { label: `Next note after ${label}`, value: "next" },
    { label: `Aside to ${label}`, value: "aside" },
  ]);
  return how && { kind: how.value, of };
}

/** Prefix check on address text; `1.10` is not under `1.1`. */
function isUnder(address: string, root: string): boolean {
  if (address === root) return true;
  if (!address.startsWith(root)) return false;
  const next = address[root.length];
  const last = root[root.length - 1];
  // The next segment switches kind (digit <-> letter), or opens with "." after the top number.
  return next === "." || /\d/.test(last) !== /\d/.test(next);
}

async function fileNote(id: NoteId) {
  const placement = await chooseAddress(id);
  if (!placement) return;
  const plan = await vault.planMove(id, placement);
  const [first, ...rest] = plan.moves;
  const links = plan.linkEdits.reduce((sum, e) => sum + e.count, 0);
  if (rest.length > 0 || links > 0) {
    const parts = [`Move "${noteLabel(noteById(id))}" to ${first.to}`];
    if (rest.length > 0) {
      parts.push(`with the ${rest.length} note(s) under it`);
    }
    let message = `${parts.join(" ")}?`;
    if (links > 0) {
      message += ` ${links} link(s) in ${plan.linkEdits.length} note(s) will be updated.`;
    }
    const ok = await ask(message, {
      title: "Move note",
      kind: "info",
      okLabel: "Move",
    });
    if (!ok) return;
  }
  await moveToAddress(id, placement);
}

const folderLabel = (path: string) => (path === "" ? "Vault root" : path);

async function moveNoteToFolder(id: NoteId) {
  const note = noteById(id);
  const zk = zettelkasten()?.path;
  const choices = ["", ...allFolders().map((f) => f.path)]
    .filter((path) => path !== zk && path !== note?.folder)
    .map((path) => ({ label: folderLabel(path), value: path }));
  const choice = await pick("Move to folder...", choices);
  if (!choice) return;
  if (note?.address && inZettelkasten(id)) {
    const ok = await ask(
      `Moving "${noteLabel(note)}" out of the Zettelkasten removes its address ${note.address}. Links to it will point at its id instead.`,
      { title: "Move note", kind: "info", okLabel: "Move" },
    );
    if (!ok) return;
  }
  await moveToFolder(id, choice.value);
}

/** Mod+N: a note where the vault's settings say new notes go. */
async function newNoteDefault() {
  const current = activeNote();
  const wanted =
    settings.newNoteLocation === "folder"
      ? settings.newNoteFolder
      : settings.newNoteLocation === "current" && current
        ? (noteById(current)?.folder ?? "")
        : "";
  // A folder that's gone (deleted or renamed outside the app) falls back to the root.
  const folder =
    wanted === "" || allFolders().some((f) => f.path === wanted) ? wanted : "";
  await newNoteIn(folder);
}

async function newFolder(parent: string) {
  const name = await prompt({
    title: parent ? `New folder in ${parent}` : "New folder",
    label: "Name",
    confirm: "Create",
  });
  if (name === null || !name.trim()) return;
  await createFolder(parent, name.trim());
}

async function newNoteIn(folder: string) {
  if (folder === zettelkasten()?.path) {
    const placement = await chooseAddress(null);
    if (placement) await newNote(placement, "New note");
    return;
  }
  return newNote(
    { kind: "unaddressed", folder },
    folder ? `New note in ${folder}` : "New note",
  );
}

async function renameFolderPrompt(path: string) {
  const name = await prompt({
    title: "Rename folder",
    label: "Name",
    initial: path.split("/").pop() ?? "",
    confirm: "Rename",
  });
  if (name === null || !name.trim()) return;
  await renameFolder(path, name.trim());
}

async function removeFolder(path: string) {
  const verb =
    settings.deleteMode === "trash" ? "Move to trash" : "Delete permanently";
  const count = allNotes().filter(
    (n) => n.folder === path || n.folder.startsWith(`${path}/`),
  ).length;
  const ok = await ask(
    `${verb}: the folder "${path}" with ${count} note(s) and everything else in it?`,
    { title: "Delete folder", kind: "warning", okLabel: verb },
  );
  if (ok) await deleteFolder(path);
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
      id: `${idPrefix}.next`,
      title: "New next note after current note",
      enabled: enabled(true),
      run: withTarget((of) => newNote({ kind: "next", of }, "New next note")),
    },
    {
      id: `${idPrefix}.aside`,
      title: "New aside to current note",
      enabled: enabled(true),
      run: withTarget((of) => newNote({ kind: "aside", of }, "New aside")),
    },
    {
      id: `${idPrefix}.moveToAddress`,
      title: "File or move current note to a Zettelkasten address",
      enabled: () => enabled()() && zettelkasten() !== null,
      run: withTarget(fileNote),
    },
    {
      id: `${idPrefix}.moveToFolder`,
      title: "Move current note to a folder",
      enabled: enabled(),
      run: withTarget(moveNoteToFolder),
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

/** Commands for the sidebar's right-clicked folder; only enabled while its menu is open. */
function onFolder(): Command[] {
  const withFolder = (f: (path: string) => unknown) => () => {
    const path = menuFolder();
    if (path !== null) return f(path);
  };
  const enabled = () => hasVault() && menuFolder() !== null;
  return [
    {
      id: "folder.menu.newNote",
      title: "New note in folder",
      enabled,
      run: withFolder(newNoteIn),
    },
    {
      id: "folder.menu.newFolder",
      title: "New folder in folder",
      enabled,
      run: withFolder(newFolder),
    },
    {
      id: "folder.menu.rename",
      title: "Rename folder",
      enabled,
      run: withFolder(renameFolderPrompt),
    },
    {
      id: "folder.menu.delete",
      title: "Delete folder",
      enabled,
      run: withFolder(removeFolder),
    },
    {
      id: "folder.menu.setZettelkasten",
      title: "Use folder as the Zettelkasten",
      enabled: () => enabled() && zettelkasten() === null,
      run: withFolder(setZettelkasten),
    },
  ];
}

/** Registers every app command; returns the unregister function. */
export function registerAppCommands(): () => void {
  return registerCommands([
    {
      id: "palette.commands",
      title: "Show all commands",
      keybinding: "Mod+P",
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
      title: "New note",
      keybinding: "Mod+N",
      enabled: hasVault,
      run: newNoteDefault,
    },
    {
      id: "note.newUnaddressed",
      title: "New note without an address",
      enabled: hasVault,
      run: () => newNote({ kind: "unaddressed" }, "New note"),
    },
    ...onNote("note", activeNote, true),
    ...onNote("menu", menuTarget, false),
    ...onFolder(),
    {
      id: "folder.new",
      title: "New folder",
      enabled: hasVault,
      run: () => newFolder(""),
    },
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
      id: "view.togglePreview",
      title: "Toggle preview pane",
      keybinding: "Mod+Shift+P",
      enabled: hasVault,
      run: togglePreview,
    },
    {
      id: "settings.open",
      title: "Open settings",
      keybinding: "Mod+,",
      enabled: hasVault,
      run: openSettings,
    },
    {
      id: "editor.toggleVim",
      title: "Toggle Vim key bindings",
      enabled: hasVault,
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
