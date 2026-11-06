import { ask, open } from '@tauri-apps/plugin-dialog';
import { openPalette, pick } from '../components/Palette';
import { prompt } from '../components/Prompt';
import { openSettings } from '../components/SettingsDialog';
import { menuFolder, menuTarget } from '../components/Sidebar';
import { toggleWrap } from '../editor/format';
import { triggerSignature } from '../editor/signature';
import { insertCitation, refreshReferences } from '../state/citations';
import { toggleDebug } from '../state/debug';
import {
  canGo,
  canMove,
  type FolgezettelMove,
  go,
  moveAlong,
} from '../state/navigation';
import { settings, updateSettings } from '../state/settings';
import {
  active,
  activeNote,
  allFolders,
  allNotes,
  closePane,
  closeTab,
  createFolder,
  createNote,
  cyclePane,
  cycleTab,
  deleteFolder,
  deleteNote,
  focusedPane,
  focusedTabs,
  inZettelkasten,
  kinds,
  layout,
  moveToAddress,
  moveToFolder,
  newTab,
  noteById,
  noteLabel,
  openVault,
  previewLayout,
  refreshLinks,
  renameFolder,
  renameNote,
  saveNote,
  sessionFor,
  setNoteKind,
  setPreviewLayout,
  setZettelkasten,
  splitFocused,
  togglePreview,
  toggleReading,
  vaultRoot,
  zettelkasten,
} from '../state/workspace';
import { type NoteId, type Placement, vault } from '../vault/api';
import { type Command, registerCommands } from './registry';

export async function chooseAndOpenVault(create: boolean) {
  const path = await open({
    directory: true,
    title: create ? 'Choose an empty folder for the new vault' : 'Open a vault',
  });
  if (typeof path !== 'string') return;
  await openVault(path, create);
}

async function newNote(placement: Placement, heading: string, kind?: string) {
  const title = await prompt({
    title: kind ? `${heading} (${kind})` : heading,
    label: 'Title',
    confirm: 'Create',
  });
  if (title === null) return;
  await createNote(placement, title.trim(), kind);
}

async function rename(id: NoteId) {
  const note = noteById(id);
  const title = await prompt({
    title: 'Rename note',
    label: 'Title',
    initial: note?.title ?? '',
    confirm: 'Rename',
  });
  if (title === null || !title.trim()) return;
  await renameNote(id, title.trim());
}

async function remove(id: NoteId) {
  const verb =
    settings.deleteMode === 'trash' ? 'Move to trash' : 'Delete permanently';
  const ok = await ask(`${verb}: "${noteLabel(noteById(id))}"?`, {
    title: 'Delete note',
    kind: 'warning',
    okLabel: verb,
  });
  if (ok) await deleteNote(id);
}

/** Asks where in the Zettelkasten note `id` (or a new note, for null) should go. */
async function chooseAddress(id: NoteId | null): Promise<Placement | null> {
  const subtreeOf = id && noteById(id)?.address;
  const filed = id !== null && inZettelkasten(id);
  const targets = allNotes().filter(
    n =>
      n.address &&
      inZettelkasten(n.id) &&
      // A note can't be filed after or beside itself or the notes after it.
      !(filed && subtreeOf && isUnder(n.address, subtreeOf)),
  );
  const target = await pick<NoteId | null>('File after or beside...', [
    { label: 'New top-level address', value: null },
    ...targets.map(n => ({ label: noteLabel(n), value: n.id })),
  ]);
  if (!target) return null;
  if (target.value === null) return { kind: 'top' };
  const of = target.value;
  const label = noteLabel(noteById(of));
  const how = await pick<'next' | 'aside'>('Next note or aside?', [
    { label: `Next note after ${label}`, value: 'next' },
    { label: `Aside to ${label}`, value: 'aside' },
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
  return next === '.' || /\d/.test(last) !== /\d/.test(next);
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
    let message = `${parts.join(' ')}?`;
    if (links > 0) {
      message += ` ${links} link(s) in ${plan.linkEdits.length} note(s) will be updated.`;
    }
    const ok = await ask(message, {
      title: 'Move note',
      kind: 'info',
      okLabel: 'Move',
    });
    if (!ok) return;
  }
  await moveToAddress(id, placement);
}

const folderLabel = (path: string) => (path === '' ? 'Vault root' : path);

async function moveNoteToFolder(id: NoteId) {
  const note = noteById(id);
  const zk = zettelkasten()?.path;
  const choices = ['', ...allFolders().map(f => f.path)]
    .filter(path => path !== zk && path !== note?.folder)
    .map(path => ({ label: folderLabel(path), value: path }));
  const choice = await pick('Move to folder...', choices);
  if (!choice) return;
  if (note?.address && inZettelkasten(id)) {
    const ok = await ask(
      `Moving "${noteLabel(note)}" out of the Zettelkasten removes its address ${note.address}. Links to it will point at its id instead.`,
      { title: 'Move note', kind: 'info', okLabel: 'Move' },
    );
    if (!ok) return;
  }
  await moveToFolder(id, choice.value);
}

/** A folder that's gone (deleted or renamed outside the app) falls back to the root. */
const existingFolder = (path: string) =>
  path === '' || allFolders().some(f => f.path === path) ? path : '';

/** Mod+N: a note where the vault's settings say new notes go. */
async function newNoteDefault(kind?: string) {
  const current = activeNote();
  const wanted =
    settings.newNoteLocation === 'folder'
      ? settings.newNoteFolder
      : settings.newNoteLocation === 'current' && current
        ? (noteById(current)?.folder ?? '')
        : '';
  await newNoteIn(existingFolder(wanted), kind);
}

/** Asks for a kind, then creates a note in that kind's folder (else where Mod+N would). */
async function newNoteOfKind() {
  const choice = await pick(
    'New note of kind...',
    kinds().map(kind => ({ label: kind, value: kind })),
  );
  if (!choice) return;
  const kind = choice.value;
  const folder = settings.kindFolders[kind];
  if (folder !== undefined) await newNoteIn(existingFolder(folder), kind);
  else await newNoteDefault(kind);
}

async function changeKind(id: NoteId) {
  const current = noteById(id)?.kind ?? null;
  const choice = await pick<string | null>('Change note kind...', [
    { label: 'No kind', value: null },
    ...kinds().map(kind => ({ label: kind, value: kind })),
  ]);
  if (!choice || choice.value === current) return;
  await setNoteKind(id, choice.value);
}

async function newFolder(parent: string) {
  const name = await prompt({
    title: parent ? `New folder in ${parent}` : 'New folder',
    label: 'Name',
    confirm: 'Create',
  });
  if (name === null || !name.trim()) return;
  await createFolder(parent, name.trim());
}

async function newNoteIn(folder: string, kind?: string) {
  if (folder === zettelkasten()?.path) {
    const placement = await chooseAddress(null);
    if (placement) await newNote(placement, 'New note', kind);
    return;
  }
  return newNote(
    { kind: 'unaddressed', folder },
    folder ? `New note in ${folder}` : 'New note',
    kind,
  );
}

async function renameFolderPrompt(path: string) {
  const name = await prompt({
    title: 'Rename folder',
    label: 'Name',
    initial: path.split('/').pop() ?? '',
    confirm: 'Rename',
  });
  if (name === null || !name.trim()) return;
  await renameFolder(path, name.trim());
}

async function removeFolder(path: string) {
  const verb =
    settings.deleteMode === 'trash' ? 'Move to trash' : 'Delete permanently';
  const count = allNotes().filter(
    n => n.folder === path || n.folder.startsWith(`${path}/`),
  ).length;
  const ok = await ask(
    `${verb}: the folder "${path}" with ${count} note(s) and everything else in it?`,
    { title: 'Delete folder', kind: 'warning', okLabel: verb },
  );
  if (ok) await deleteFolder(path);
}

const hasVault = () => vaultRoot() !== null;
const hasAddress = (id: NoteId | null) => !!id && !!noteById(id)?.address;

/**
 * Note commands for one target: the active note (`note.*`) or the
 * sidebar's right-clicked note (`menu.*`, only enabled while its context
 * menu is open).
 */
function onNote(idPrefix: string, target: () => NoteId | null): Command[] {
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
      title: 'New next note after current note',
      enabled: enabled(true),
      run: withTarget(of => newNote({ kind: 'next', of }, 'New next note')),
    },
    {
      id: `${idPrefix}.aside`,
      title: 'New aside to current note',
      enabled: enabled(true),
      run: withTarget(of => newNote({ kind: 'aside', of }, 'New aside')),
    },
    {
      id: `${idPrefix}.moveToAddress`,
      title: 'File or move current note to a Zettelkasten address',
      enabled: () => enabled()() && zettelkasten() !== null,
      run: withTarget(fileNote),
    },
    {
      id: `${idPrefix}.moveToFolder`,
      title: 'Move current note to a folder',
      enabled: enabled(),
      run: withTarget(moveNoteToFolder),
    },
    {
      id: `${idPrefix}.changeKind`,
      title: 'Change kind of current note',
      enabled: enabled(),
      run: withTarget(changeKind),
    },
    {
      id: `${idPrefix}.rename`,
      title: 'Rename current note',
      keybinding: 'F2',
      enabled: enabled(),
      run: withTarget(rename),
    },
    {
      id: `${idPrefix}.delete`,
      title: 'Delete current note',
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
      id: 'folder.menu.newNote',
      title: 'New note in folder',
      enabled,
      run: withFolder(newNoteIn),
    },
    {
      id: 'folder.menu.newFolder',
      title: 'New folder in folder',
      enabled,
      run: withFolder(newFolder),
    },
    {
      id: 'folder.menu.rename',
      title: 'Rename folder',
      enabled,
      run: withFolder(renameFolderPrompt),
    },
    {
      id: 'folder.menu.delete',
      title: 'Delete folder',
      enabled,
      run: withFolder(removeFolder),
    },
    {
      id: 'folder.menu.setZettelkasten',
      title: 'Use folder as the Zettelkasten',
      enabled: () => enabled() && zettelkasten() === null,
      run: withFolder(setZettelkasten),
    },
  ];
}

/** The active note's editor, if it's on screen. */
const shownEditor = () => {
  const id = activeNote();
  return id ? sessionFor(id)?.shownView() : undefined;
};

/** Registers every app command; returns the unregister function. */
export function registerAppCommands(): () => void {
  return registerCommands([
    {
      id: 'palette.commands',
      title: 'Show all commands',
      keybinding: 'Mod+P',
      run: () => openPalette('commands'),
    },
    {
      id: 'palette.notes',
      title: 'Go to note',
      keybinding: 'Mod+O',
      enabled: hasVault,
      run: () => openPalette('notes'),
    },
    {
      id: 'note.new',
      title: 'New note',
      keybinding: 'Mod+N',
      enabled: hasVault,
      run: () => newNoteDefault(),
    },
    {
      id: 'note.newOfKind',
      title: 'New note of kind',
      keybinding: 'Mod+Shift+N',
      enabled: () => hasVault() && kinds().length > 0,
      run: newNoteOfKind,
    },
    {
      id: 'note.newUnaddressed',
      title: 'New note without an address',
      enabled: hasVault,
      run: () => newNote({ kind: 'unaddressed' }, 'New note'),
    },
    ...onNote('note', activeNote),
    ...[...onNote('menu', menuTarget), ...onFolder()].map(command => ({
      ...command,
      contextMenu: true,
    })),
    {
      id: 'folder.new',
      title: 'New folder',
      enabled: hasVault,
      run: () => newFolder(''),
    },
    {
      id: 'tab.new',
      title: 'New tab',
      keybinding: 'Mod+T',
      enabled: hasVault,
      run: newTab,
    },
    {
      id: 'note.save',
      title: 'Save current note',
      keybinding: 'Mod+S',
      enabled: () => activeNote() !== null,
      run: () => {
        const id = activeNote();
        if (id) return saveNote(id);
      },
    },
    {
      id: 'tab.close',
      title: 'Close tab',
      keybinding: 'Mod+W',
      enabled: () => active() !== null,
      run: () => {
        const key = active();
        if (key) return closeTab(key);
      },
    },
    {
      id: 'tab.next',
      title: 'Next tab',
      keybinding: 'Ctrl+Tab',
      enabled: () => focusedTabs().length > 1,
      run: () => cycleTab(1),
    },
    {
      id: 'tab.previous',
      title: 'Previous tab',
      keybinding: 'Ctrl+Shift+Tab',
      enabled: () => focusedTabs().length > 1,
      run: () => cycleTab(-1),
    },
    {
      id: 'view.togglePreview',
      title: 'Toggle preview',
      keybinding: 'Mod+Shift+P',
      enabled: hasVault,
      run: togglePreview,
    },
    {
      id: 'view.toggleReading',
      title: 'Toggle reading view',
      keybinding: 'Mod+E',
      enabled: hasVault,
      run: toggleReading,
    },
    {
      id: 'view.togglePreviewLayout',
      title: 'Toggle global preview mode',
      enabled: hasVault,
      run: () =>
        setPreviewLayout(previewLayout() === 'pane' ? 'global' : 'pane'),
    },
    {
      id: 'pane.splitRight',
      title: 'Split right (move tab to a new pane)',
      keybinding: 'Mod+\\',
      enabled: () => hasVault() && focusedTabs().length > 1,
      run: () => splitFocused('right'),
    },
    {
      id: 'pane.splitDown',
      title: 'Split down (move tab to a new pane)',
      keybinding: 'Mod+Shift+\\',
      enabled: () => hasVault() && focusedTabs().length > 1,
      run: () => splitFocused('bottom'),
    },
    {
      id: 'pane.next',
      title: 'Focus next pane',
      keybinding: 'Mod+Alt+ArrowRight',
      enabled: () => hasVault() && layout.root.kind === 'split',
      run: () => cyclePane(1),
    },
    {
      id: 'pane.previous',
      title: 'Focus previous pane',
      keybinding: 'Mod+Alt+ArrowLeft',
      enabled: () => hasVault() && layout.root.kind === 'split',
      run: () => cyclePane(-1),
    },
    {
      id: 'pane.close',
      title: 'Close pane',
      enabled: () => hasVault() && layout.root.kind === 'split',
      run: closePane,
    },
    ...[
      { id: 'format.bold', title: 'Bold', keybinding: 'Mod+B', marker: '*' },
      {
        id: 'format.italic',
        title: 'Italic',
        keybinding: 'Mod+I',
        marker: '_',
      },
    ].map(({ marker, ...command }) => ({
      ...command,
      enabled: () => shownEditor() !== undefined,
      run: () => {
        const view = shownEditor();
        if (view) toggleWrap(view, marker);
      },
    })),
    ...(
      [
        ['nav.back', 'Go back', 'Mod+[', -1],
        ['nav.forward', 'Go forward', 'Mod+]', 1],
      ] as const
    ).map(([id, title, keybinding, direction]) => ({
      id,
      title,
      keybinding,
      enabled: () => canGo(focusedPane().id, direction),
      run: () => go(focusedPane().id, direction),
    })),
    // Unbound by default: the obvious keys are taken (Alt+arrows move lines).
    ...(
      [
        ['nav.parent', 'Go to parent note', 'parent'],
        ['nav.next', 'Go to first next note', 'next'],
        ['nav.previousAside', 'Go to previous aside', 'previousAside'],
        ['nav.nextAside', 'Go to next aside', 'nextAside'],
      ] as [string, string, FolgezettelMove][]
    ).map(([id, title, move]) => ({
      id,
      title,
      enabled: () => canMove(focusedPane().id, move),
      run: () => moveAlong(focusedPane().id, move),
    })),
    {
      id: 'editor.signatureHelp',
      title: 'Show parameter hints',
      keybinding: 'Mod+Shift+Space',
      enabled: () => shownEditor() !== undefined,
      run: () => {
        const view = shownEditor();
        view?.dispatch({ effects: triggerSignature.of(null) });
        view?.focus();
      },
    },
    {
      id: 'citation.insert',
      title: 'Insert citation from Zotero',
      keybinding: 'Mod+Shift+C',
      enabled: () => activeNote() !== null,
      run: insertCitation,
    },
    {
      id: 'citation.refresh',
      title: 'Refresh references from Zotero',
      enabled: hasVault,
      run: refreshReferences,
    },
    {
      id: 'debug.toggle',
      title: 'Toggle debug view (compile timings)',
      run: toggleDebug,
    },
    {
      id: 'settings.open',
      title: 'Open settings',
      keybinding: 'Mod+,',
      enabled: hasVault,
      run: () => openSettings(),
    },
    {
      id: 'settings.preambles',
      title: 'Edit templates and preambles',
      enabled: hasVault,
      run: () => openSettings('preambles'),
    },
    {
      id: 'editor.toggleVim',
      title: 'Toggle Vim key bindings',
      enabled: hasVault,
      run: () => updateSettings({ vim: !settings.vim }),
    },
    {
      id: 'editor.toggleLineNumbers',
      title: 'Toggle line numbers',
      enabled: hasVault,
      run: () => updateSettings({ lineNumbers: !settings.lineNumbers }),
    },
    {
      id: 'links.toggleDisplay',
      title: 'Toggle wikilinks between titles and addresses',
      enabled: hasVault,
      run: () => {
        updateSettings({
          linkDisplay: settings.linkDisplay === 'title' ? 'address' : 'title',
        });
        return refreshLinks();
      },
    },
    {
      id: 'vault.open',
      title: 'Open another vault...',
      run: () => chooseAndOpenVault(false),
    },
    {
      id: 'vault.create',
      title: 'Create a new vault...',
      run: () => chooseAndOpenVault(true),
    },
  ]);
}
