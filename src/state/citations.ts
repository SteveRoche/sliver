import { message } from '@tauri-apps/plugin-dialog';
import { createEffect, createRoot, createSignal, on } from 'solid-js';
import { pick } from '../components/Palette';
import { typst } from '../typst/instance';
import {
  type CitationStyle,
  type NoteId,
  vault,
  type ZoteroPick,
} from '../vault/api';
import { DEFAULT_CITATION_STYLE, settings } from './settings';
import { escapeMarkup as markup } from './templates';
import { isPreviewDark } from './theme';
import { activeNote, invalidatePreviews, sessionFor } from './workspace';

/** Must match `sliver_vault::REFERENCES_PATH`. */
const REFERENCES_PATH = '/.sliver/references.bib';
/** Throwaway mains: one checks that `references.bib` parses, one renders an entry. */
const CHECK_PATH = '/.sliver/check/references.typ';
const ENTRY_PATH = '/.sliver/check/entry.typ';
/** Must match the label in `sliver_vault::preview_main`. */
const STYLE_LABEL = 'sliver-citation-style';

const [entries, setEntries] = createSignal(new Map<string, string | null>());
const [builtinStyles, setBuiltinStyles] = createSignal<
  { name: string; label: string }[]
>([]);
const [customStyles, setCustomStyles] = createSignal<CitationStyle[]>([]);
const [referencesError, setReferencesError] = createSignal<string | null>(null);

/** Why `references.bib` can't be used, if it can't. */
export { referencesError };

let active = false;
/** Whether the wrapper cites from `references.bib` (it parses). */
let enabled = false;
/** Rendered entries by style and key; null when there is nothing to show. */
const rendered = new Map<string, string | null>();

/** The keys of `references.bib` with their titles. */
export const referenceEntries = () => entries();

/** Whether `references.bib` has an entry for `key`. */
export const hasReference = (key: string) => entries().has(key);

/** The entry's title, if `references.bib` has one for `key`. */
export const referenceTitle = (key: string) => entries().get(key) ?? null;

/** The styles the settings offer: the vault's custom ones, then Typst's. */
export const citationStyleChoices = () => [
  ...customStyles().map(s => ({ value: s.path, label: `${s.name} (custom)` })),
  ...builtinStyles()
    .filter(s => !s.label.startsWith('A short alias of'))
    .map(s => ({ value: s.name, label: s.label }))
    .sort((a, b) => a.label.localeCompare(b.label)),
];

const typstString = (text: string) => `"${text.replace(/[\\"]/g, '\\$&')}"`;

const knownStyles = () => [
  ...builtinStyles().map(s => s.name),
  ...customStyles().map(s => s.path),
];

/** The vault's style, or the default when it names a style that's gone. */
const vaultStyle = () =>
  knownStyles().includes(settings.citationStyle)
    ? settings.citationStyle
    : DEFAULT_CITATION_STYLE;

async function sendLibrary() {
  const library = await vault.citationLibrary({
    style: vaultStyle(),
    styles: knownStyles(),
    showReferences: settings.showReferences,
    enabled,
  });
  await typst.setSource(library.path, library.text);
  invalidatePreviews();
}

/** Hands the custom CSL styles to the compiler. */
async function loadStyles() {
  if (builtinStyles().length === 0) {
    setBuiltinStyles(await typst.citationStyles());
  }
  const styles = await vault.citationStyles();
  for (const old of customStyles()) {
    if (!styles.some(s => s.path === old.path)) {
      await typst.removeSource(old.path);
    }
  }
  for (const style of styles) await typst.setSource(style.path, style.text);
  setCustomStyles(styles);
}

/**
 * Hands `references.bib` and the citation library to the compiler. A file
 * Typst can't read would fail every preview, so it's checked first and left
 * out (every citation then shows as unknown) if it doesn't parse.
 */
async function loadReferences() {
  const references = await vault.references();
  await typst.setSource(references.path, references.text);
  const check = await typst.standalone(
    CHECK_PATH,
    `#bibliography(${typstString(references.path)})\n`,
    false,
  );
  enabled = check.errors.length === 0;
  setReferencesError(
    enabled ? null : `references.bib can't be read: ${check.errors[0]}`,
  );
  setEntries(new Map(references.entries.map(e => [e.key, e.title])));
  rendered.clear();
  await sendLibrary();
}

/** Loads the open vault's references and styles; call after the theme is sent. */
export async function loadCitations() {
  active = true;
  await loadStyles();
  await loadReferences();
}

export function unloadCitations() {
  active = false;
  enabled = false;
  for (const style of customStyles()) void typst.removeSource(style.path);
  void typst.removeSource(REFERENCES_PATH);
  setCustomStyles([]);
  setEntries(new Map());
  setReferencesError(null);
  rendered.clear();
}

/**
 * Fetches entries from Zotero: with `all`, every cited key (and drops
 * entries nothing cites any more); otherwise only keys without an entry.
 * Resolves to false when Zotero couldn't be reached.
 */
export async function syncReferences(all: boolean): Promise<boolean> {
  if (!active) return true;
  const result = await vault.refreshReferences(all);
  if (result.changed && active) await loadReferences();
  return result.reachable;
}

createRoot(() => {
  createEffect(
    on(
      () => [settings.citationStyle, settings.showReferences],
      () => {
        if (!active) return;
        rendered.clear();
        void sendLibrary();
      },
      { defer: true },
    ),
  );
  createEffect(on(isPreviewDark, () => rendered.clear(), { defer: true }));
});

/**
 * Renders `key`'s entry as `note`'s preview formats it (the style it ended
 * up with, from its wrapper's `<sliver-citation-style>` metadata), as SVG.
 */
export async function renderReference(
  note: NoteId,
  key: string,
): Promise<string | null> {
  if (!enabled || !hasReference(key)) return null;
  const main = sessionFor(note)?.mainPath();
  const used = main ? await typst.metadataText(main, STYLE_LABEL) : null;
  const style = used ?? vaultStyle();
  const id = `${style}\n${key}`;
  const cached = rendered.get(id);
  if (cached !== undefined) return cached;
  const text = [
    '#import "/.sliver/theme.typ" as theme',
    // As wide as the card (300 CSS px), so text keeps its size.
    '#set page(width: 225pt, height: auto, margin: 4pt, fill: theme.paper)',
    '#set text(fill: theme.ink, size: 10pt)',
    '#show link: set text(fill: theme.accent)',
    `#set bibliography(style: ${typstString(style)})`,
    `#cite(label(${typstString(key)}), form: none)`,
    `#bibliography(${typstString(REFERENCES_PATH)}, title: none, full: false)`,
  ].join('\n');
  const out = await typst.standalone(ENTRY_PATH, text, true);
  const svg = out.pages[0] ?? null;
  rendered.set(id, svg);
  return svg;
}

/** Short forms of Zotero's locator labels. */
const LOCATOR_LABELS: Record<string, string> = {
  page: 'p.',
  chapter: 'chap.',
  section: 'sec.',
  paragraph: 'para.',
  line: 'l.',
  figure: 'fig.',
  volume: 'vol.',
  note: 'n.',
  verse: 'v.',
  book: 'bk.',
  column: 'col.',
  folio: 'fol.',
  number: 'no.',
  opus: 'op.',
  part: 'pt.',
  'sub verbo': 's.v.',
};

/** Keys `@key` can name: label characters, not ending in `.` or `:`. */
const REF_KEY = /^[\p{L}\p{N}_\-.:]*[\p{L}\p{N}_-]$/u;

/**
 * Typst source citing `picks`: `@key`, `@key[p. 7]` with a locator, or a
 * `#cite` call where `@` can't express it (suppressed author, unusual keys).
 * Citations side by side render as one, e.g. "(Doe 2020; Roe 2021)".
 */
export function citationText(picks: ZoteroPick[]): string {
  return picks
    .map(p => {
      const label = LOCATOR_LABELS[p.label] ?? p.label;
      const supplement = p.locator
        ? `${label ? `${label} ` : ''}${p.locator}`
        : '';
      if (REF_KEY.test(p.citationKey) && !p.suppressAuthor) {
        return `@${p.citationKey}${supplement ? `[${markup(supplement)}]` : ''}`;
      }
      const args = [`label(${typstString(p.citationKey)})`];
      if (supplement) args.push(`supplement: [${markup(supplement)}]`);
      if (p.suppressAuthor) args.push('form: "year"');
      return `#cite(${args.join(', ')})`;
    })
    .join(' ');
}

/**
 * The keys cited in a run of link areas of `note`'s preview: page `page`,
 * from `x` to `end` on the line whose top is `y`, in points. Typst places a
 * citation at its start, and the others merged into a group at its end, so
 * every mark within the run counts; a cross-reference's mark (no key) means
 * the run isn't a citation.
 */
export async function citationsAt(
  note: NoteId,
  page: number,
  box: { x: number; end: number; y: number; height: number },
): Promise<string[]> {
  const main = sessionFor(note)?.mainPath();
  if (!main) return [];
  const marks = (await typst.citationMarks(main)).filter(
    m =>
      m.page === page &&
      m.y >= box.y - 1 &&
      m.y <= box.y + box.height + 1 &&
      m.x >= box.x - 0.5 &&
      m.x <= box.end + 0.5,
  );
  if (marks.some(m => m.key === null)) return [];
  return [...new Set(marks.map(m => m.key as string))];
}

async function warn(text: string) {
  await message(text, { title: 'Zotero', kind: 'warning' });
}

/**
 * Zotero items matching `query` that `references.bib` has no entry for yet
 * (Typst's own completion offers those), for `@` completion. Citing one
 * fetches its entry on the next save.
 */
export async function searchZotero(query: string) {
  const items = await vault.zoteroSearch(query);
  return items
    .filter(item => !hasReference(item.citationKey))
    .map(item => ({
      key: item.citationKey,
      title: item.title,
      byline: item.byline,
    }));
}

/** Selects `key`'s item in Zotero. */
export async function openInZotero(key: string) {
  try {
    await vault.openInZotero(key);
  } catch (error) {
    await warn(`Could not open Zotero: ${error}`);
  }
}

/** Opens a citation clicked in a preview in Zotero, asking which first when it cites several. */
export async function openCitations(keys: string[]) {
  const known = keys.filter(hasReference);
  if (known.length <= 1) return openInZotero(known[0] ?? keys[0]);
  const choice = await pick(
    'Open which citation in Zotero?',
    known.map(k => ({ label: referenceTitle(k) ?? k, detail: k, value: k })),
  );
  if (choice) await openInZotero(choice.value);
}

/** Opens Zotero's citation picker and inserts the picks at the cursor. */
export async function insertCitation() {
  const id = activeNote();
  const session = id ? sessionFor(id) : undefined;
  if (!session) return;
  let picks: ZoteroPick[];
  try {
    picks = await vault.zoteroPick();
  } catch (error) {
    await warn(String(error));
    return;
  }
  if (picks.length === 0) return;
  await loadReferences();
  session.insert(citationText(picks));
}

/** Refetches every cited entry from Zotero, e.g. after editing items there. */
export async function refreshReferences() {
  if (!(await syncReferences(true))) {
    await warn(
      "Zotero isn't running, or the Better BibTeX add-on isn't installed. The references already in the vault are used meanwhile.",
    );
  }
}
