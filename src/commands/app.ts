import { ask, message, open } from '@tauri-apps/plugin-dialog';
import { openPalette, pick } from '../components/Palette';
import { prompt, promptWithChoice } from '../components/Prompt';
import { openSettings } from '../components/SettingsDialog';
import {
  clearMarks,
  menuAsset,
  menuFolder,
  menuSection,
  menuTarget,
  sectionCandidates,
} from '../components/Sidebar';
import { toggleWrap } from '../editor/format';
import { triggerSignature } from '../editor/signature';
import { followLinkAtCursor, linkAtCursor } from '../editor/wikilinks';
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
  deleteAsset,
  deleteFolder,
  deleteNote,
  focusedPane,
  focusedTabs,
  formerTitle,
  inZettelkasten,
  kinds,
  layout,
  markSection,
  moveAsset,
  moveToAddress,
  moveToFolder,
  newTab,
  noteById,
  noteLabel,
  openAsset,
  openNote,
  openVault,
  previewLayout,
  refreshLinks,
  renameAsset,
  renameFolder,
  renameNote,
  renameSection,
  resolveTarget,
  saveNote,
  sectionLabel,
  sections,
  sequenceOf,
  sessionFor,
  setNoteKind,
  setPreviewLayout,
  setZettelkasten,
  splitFocused,
  titleClash,
  titleKey,
  togglePreview,
  toggleReading,
  unmarkSection,
  vaultRoot,
  zettelkasten,
} from '../state/workspace';
import {
  type AddressPlace,
  type NoteId,
  type NoteSummary,
  type Placement,
  vault,
} from '../vault/api';
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
    validate: text => titleClash(text),
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
    validate: text => titleClash(text, id),
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
      resolveTarget(n.address) === n.id &&
      // A note can't be filed after or beside itself or the notes after it.
      !(filed && subtreeOf && isUnder(n.address, subtreeOf)),
  );
  const target = await pick<NoteId | null>('File after or beside…', [
    { label: 'New sequence', value: null },
    ...targets.map(n => ({ label: noteLabel(n), value: n.id })),
  ]);
  if (!target) return null;
  if (target.value === null) return { kind: 'newSequence' };
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
  if (placement) await fileAt(id, placement);
}

/** Moves note `id` to `placement`, after confirming what else changes. */
async function fileAt(id: NoteId, placement: Placement) {
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
  const choice = await pick('Move to folder…', choices);
  if (choice) await moveNoteInto(id, choice.value);
}

/** Moves note `id` into folder `folder`, warning first if it loses its address. */
async function moveNoteInto(id: NoteId, folder: string) {
  const note = noteById(id);
  if (note?.address && inZettelkasten(id)) {
    const ok = await ask(
      `Moving "${noteLabel(note)}" out of the Zettelkasten removes its address ${note.address}. Links to it will point at its id instead.`,
      { title: 'Move note', kind: 'info', okLabel: 'Move' },
    );
    if (!ok) return;
  }
  await moveToFolder(id, folder);
}

/** Where a note or file was dropped in the sidebar: a folder, or a note's row. */
export type DropTarget = { folder: string } | { note: NoteId };

/**
 * Drops note `id` in the sidebar: onto the Zettelkasten, a new sequence;
 * onto a Zettelkasten note, a next note or aside of it (asked); onto
 * another folder (or a note in one), into that folder.
 */
export async function dropNote(id: NoteId, target: DropTarget) {
  const zk = zettelkasten()?.path;
  if ('note' in target) {
    if (target.note === id) return;
    const onto = noteById(target.note);
    if (!onto) return;
    if (onto.address && inZettelkasten(onto.id)) {
      const label = noteLabel(onto);
      const how = await pick<'next' | 'aside'>('Next note or aside?', [
        { label: `Next note after ${label}`, value: 'next' },
        { label: `Aside to ${label}`, value: 'aside' },
      ]);
      if (how) await fileAt(id, { kind: how.value, of: onto.id });
      return;
    }
    return dropNote(id, { folder: onto.folder });
  }
  if (target.folder === zk) {
    if (!inZettelkasten(id)) await fileAt(id, { kind: 'newSequence' });
    return;
  }
  if (noteById(id)?.folder !== target.folder) {
    await moveNoteInto(id, target.folder);
  }
}

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const parentOf = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const joinPath = (folder: string, name: string) =>
  folder ? `${folder}/${name}` : name;

/**
 * Whether to go ahead with moving `from` to `to` (a file or a folder): asks
 * when paths in notes, preambles or templates would be rewritten.
 */
async function confirmPathMove(from: string, to: string, title: string) {
  const plan = await vault.planPathMove(from, to);
  const paths = plan.notes.reduce((sum, e) => sum + e.count, 0);
  if (paths === 0 && plan.files.length === 0) return true;
  const where = [
    plan.notes.length > 0
      ? `${paths} path(s) in ${plan.notes.length} note(s)`
      : '',
    plan.files.length > 0
      ? `${plan.files.length} preamble or template file(s)`
      : '',
  ].filter(Boolean);
  return ask(`${where.join(' and ')} will be updated to /${to}.`, {
    title,
    kind: 'info',
    okLabel: 'Move',
  });
}

/** Drops file `path` in the sidebar: into the folder (or the note's folder) under it. */
export async function dropAsset(path: string, target: DropTarget) {
  const folder =
    'note' in target ? noteById(target.note)?.folder : target.folder;
  if (folder === undefined || folder === parentOf(path)) return;
  if (
    await confirmPathMove(path, joinPath(folder, fileName(path)), 'Move file')
  ) {
    await moveAsset(path, folder);
  }
}

async function renameAssetPrompt(path: string) {
  const name = await prompt({
    title: 'Rename file',
    label: 'Name',
    initial: fileName(path),
    confirm: 'Rename',
  });
  if (name === null || !name.trim() || name.trim() === fileName(path)) return;
  const to = joinPath(parentOf(path), name.trim());
  if (await confirmPathMove(path, to, 'Rename file')) {
    await renameAsset(path, name.trim());
  }
}

async function moveAssetPrompt(path: string) {
  const choices = ['', ...allFolders().map(f => f.path)]
    .filter(folder => folder !== parentOf(path))
    .map(folder => ({ label: folderLabel(folder), value: folder }));
  const choice = await pick('Move file to folder…', choices);
  if (choice) await dropAsset(path, { folder: choice.value });
}

async function removeAsset(path: string) {
  const verb =
    settings.deleteMode === 'trash' ? 'Move to trash' : 'Delete permanently';
  const ok = await ask(`${verb}: "${path}"?`, {
    title: 'Delete file',
    kind: 'warning',
    okLabel: verb,
  });
  if (ok) await deleteAsset(path);
}

/** A folder that's gone (deleted or renamed outside the app) falls back to the root. */
const existingFolder = (path: string) =>
  path === '' || allFolders().some(f => f.path === path) ? path : '';

/** The folder the vault's settings say new notes go in, `current` being the note they're made from. */
function newNoteFolder(current: NoteId | null): string {
  const wanted =
    settings.newNoteLocation === 'folder'
      ? settings.newNoteFolder
      : settings.newNoteLocation === 'current' && current
        ? (noteById(current)?.folder ?? '')
        : '';
  return existingFolder(wanted);
}

/** Mod+N: a note where the vault's settings say new notes go. */
async function newNoteDefault(kind?: string) {
  const result = await promptWithChoice({
    title: kind ? `New note (${kind})` : 'New note',
    label: 'Title',
    confirm: 'Create',
    choice: folderChoice(newNoteFolder(activeNote())),
    validate: text => titleClash(text),
  });
  if (result) await noteInFolder(result.choice, result.text.trim(), true, kind);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mod-click (or Mod+Enter) on a broken wikilink in note `source`. A title
 * that notes have asks which one to link to, with their folders, or to
 * create another (the new-note dialog); one no note has creates the note
 * in the vault root. An address creates the note there when that leaves no
 * gap in the Zettelkasten, else offers the address that doesn't (or a note
 * titled as the target). A uuid whose note is gone counts as the title it
 * had, if known (else it does nothing). Either way the note's links to the
 * target then point at the note (its address, or uuid without one); other
 * notes' stay as they are.
 */
export async function followBrokenLink(source: NoteId, raw: string) {
  const target = sessionFor(source)?.sourceTarget(raw) ?? raw.trim();
  // What the link names: the target, or a dead uuid's former title.
  const name = UUID.test(target) ? formerTitle(target) : target;
  if (!target || !name) return;
  const relink = (note: NoteSummary) => {
    const next = note.address ?? note.id;
    if (next !== target) sessionFor(source)?.retarget(target, next);
  };

  const key = titleKey(name);
  const titled = allNotes().filter(n => n.title && titleKey(n.title) === key);
  if (titled.length > 0) {
    const choice = await pick<NoteId | null>(`Link to "${name}"`, [
      ...titled.map(n => ({
        label: `${noteLabel(n)} (${folderLabel(n.folder)})`,
        value: n.id,
      })),
      { label: `Create a new note titled "${name}"…`, value: null },
    ]);
    if (!choice) return;
    if (choice.value !== null) {
      const note = noteById(choice.value);
      if (note) relink(note);
      openNote(choice.value);
      return;
    }
    const note = await newLinkedNote(source, name, true);
    if (note) relink(note);
    return;
  } else {
    // Fails without a Zettelkasten: then it's only a title.
    const place = await vault.placeForAddress(name).catch(() => null);
    if (place) {
      if (place.address !== name) {
        const where = placeLabel(place.placement);
        const choice = await pick<'address' | 'title'>(`No note ${name}`, [
          {
            label: `Create ${place.address}, ${where}, and link to it (${name} would leave a gap)`,
            value: 'address',
          },
          { label: `Create a note titled "${name}"`, value: 'title' },
        ]);
        if (!choice) return;
        if (choice.value === 'address') {
          await linkedNoteAt(place, relink);
          return;
        }
      } else {
        await linkedNoteAt(place, relink);
        return;
      }
    }
  }

  // An uninitialized link's note goes in the vault root.
  const note = await noteInFolder('', name);
  if (note) relink(note);
}

/** Creates a note titled `title` in `folder`, asking for an address in the Zettelkasten. */
async function noteInFolder(
  folder: string,
  title: string,
  open = true,
  kind?: string,
) {
  let placement: Placement | null = { kind: 'unaddressed', folder };
  if (folder === zettelkasten()?.path) placement = await chooseAddress(null);
  return placement && createNote(placement, title, kind, open);
}

/** The "In:" folder dropdown of the new-note prompts, starting at `initial`. */
const folderChoice = (initial: string) => ({
  label: 'In:',
  options: ['', ...allFolders().map(f => f.path)].map(path => ({
    label: folderLabel(path),
    value: path,
  })),
  initial,
});

/**
 * Create a new note in `[[` completion in note `source`: asks for a
 * title (starting from what was typed) and a folder, and creates the note without opening it.
 * Resolves to the note, or null when cancelled.
 */
export async function newLinkedNote(
  source: NoteId,
  query: string,
  open = false,
) {
  const result = await promptWithChoice({
    title: 'New linked note',
    label: 'Title',
    initial: query.trim(),
    confirm: 'Create',
    choice: folderChoice(newNoteFolder(source)),
    validate: text => titleClash(text),
  });
  if (result === null) return null;
  // Stays on the linking note unless `open`.
  return noteInFolder(result.choice, result.text.trim(), open);
}

/** "the next note after 1.2 Title", "an aside to ...", "a new sequence". */
function placeLabel(placement: Placement): string {
  switch (placement.kind) {
    case 'next':
      return `the next note after ${noteLabel(noteById(placement.of))}`;
    case 'aside':
      return `an aside to ${noteLabel(noteById(placement.of))}`;
    default:
      return 'a new sequence';
  }
}

/** Asks for a title and creates a note at `place`. */
async function linkedNoteAt(
  place: AddressPlace,
  relink: (note: NoteSummary) => void,
) {
  const title = await prompt({
    title: `New note ${place.address}`,
    label: 'Title',
    confirm: 'Create',
    validate: text => titleClash(text),
  });
  if (title === null) return;
  relink(await createNote(place.placement, title.trim()));
}

/** Asks for a kind, then creates a note in that kind's folder (else where Mod+N would). */
async function newNoteOfKind() {
  const choice = await pick(
    'New note of kind…',
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
  const choice = await pick<string | null>('Change note kind…', [
    { label: 'No kind', value: null },
    ...kinds().map(kind => ({ label: kind, value: kind })),
  ]);
  if (!choice || choice.value === current) return;
  await setNoteKind(id, choice.value);
}

const sectionAt = (first: number) => sections().find(s => s.first === first);

async function renameSectionPrompt(first: number) {
  const section = sectionAt(first);
  const name = await prompt({
    title: `Rename section ${section ? sectionLabel(section) : first}`,
    label: 'Name',
    initial: section?.name ?? '',
    confirm: 'Rename',
  });
  if (name?.trim()) await renameSection(first, name.trim());
}

/**
 * Names the sequences of the notes marked in the sidebar (or of the
 * right-clicked note) as a section: the run from the lowest to the highest.
 */
async function markSectionPrompt() {
  const numbers = sectionCandidates()
    .map(id => sequenceOf(noteById(id)?.address ?? null))
    .filter((n): n is number => n !== undefined);
  if (numbers.length === 0) return;
  const first = Math.min(...numbers);
  const last = Math.max(...numbers);
  const range =
    first === last ? `sequence ${first}` : `sequences ${first}–${last}`;
  const name = await prompt({
    title: `Make ${range} a section`,
    label: 'Name',
    confirm: 'Make section',
  });
  if (!name?.trim()) return;
  try {
    await markSection(first, last, name.trim());
    clearMarks();
  } catch (error) {
    await message(`Can't make ${range} a section: ${error}`, {
      title: 'Make section',
      kind: 'warning',
    });
  }
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
  const to = joinPath(parentOf(path), name.trim());
  if (to !== path && (await confirmPathMove(path, to, 'Rename folder'))) {
    await renameFolder(path, name.trim());
  }
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

/** Commands for the sidebar's right-clicked section; only enabled while its menu is open. */
function onSection(): Command[] {
  const withSection = (f: (first: number) => unknown) => () => {
    const first = menuSection();
    if (first !== null) return f(first);
  };
  const enabled = () => hasVault() && menuSection() !== null;
  return [
    {
      id: 'section.menu.rename',
      title: 'Rename section',
      enabled,
      run: withSection(renameSectionPrompt),
    },
    {
      id: 'section.menu.unmark',
      title: 'Remove section heading',
      enabled,
      run: withSection(unmarkSection),
    },
  ];
}

/** Commands for the sidebar's right-clicked file; only enabled while its menu is open. */
function onAsset(): Command[] {
  const withAsset = (f: (path: string) => unknown) => () => {
    const path = menuAsset();
    if (path !== null) return f(path);
  };
  const enabled = () => hasVault() && menuAsset() !== null;
  return [
    {
      id: 'asset.menu.open',
      title: 'Open file',
      enabled,
      run: withAsset(openAsset),
    },
    {
      id: 'asset.menu.openExternal',
      title: 'Open file in its default app',
      enabled,
      run: withAsset(path => vault.openAsset(path)),
    },
    {
      id: 'asset.menu.copyPath',
      title: 'Copy path of file',
      enabled,
      run: withAsset(path => navigator.clipboard.writeText(`/${path}`)),
    },
    {
      id: 'asset.menu.rename',
      title: 'Rename file',
      enabled,
      run: withAsset(renameAssetPrompt),
    },
    {
      id: 'asset.menu.move',
      title: 'Move file to a folder',
      enabled,
      run: withAsset(moveAssetPrompt),
    },
    {
      id: 'asset.menu.delete',
      title: 'Delete file',
      enabled,
      run: withAsset(removeAsset),
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
    {
      id: 'menu.markSection',
      title: 'Make section from marked sequences',
      enabled: () => hasVault() && sectionCandidates().length > 0,
      run: markSectionPrompt,
    },
    ...[
      ...onNote('menu', menuTarget),
      ...onFolder(),
      ...onSection(),
      ...onAsset(),
    ].map(command => ({
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
      run: () => {
        const wasReading = focusedPane().mode === 'read';
        toggleReading();
        // Back to editing, the editor takes the keys (Vim keeps its mode).
        if (wasReading) requestAnimationFrame(() => shownEditor()?.focus());
      },
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
      id: 'editor.followLink',
      title: 'Follow link at cursor',
      keybinding: 'Mod+Enter',
      // Otherwise Mod+Enter stays CodeMirror's (a blank line below).
      enabled: () => {
        const view = shownEditor();
        return !!view?.hasFocus && !!linkAtCursor(view);
      },
      run: () => {
        const view = shownEditor();
        if (view) followLinkAtCursor(view);
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
      title: 'Open another vault…',
      run: () => chooseAndOpenVault(false),
    },
    {
      id: 'vault.create',
      title: 'Create a new vault…',
      run: () => chooseAndOpenVault(true),
    },
  ]);
}
