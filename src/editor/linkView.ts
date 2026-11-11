import { invertedEffects, isolateHistory } from '@codemirror/commands';
import {
  Annotation,
  type ChangeDesc,
  type ChangeSpec,
  EditorState,
  type Extension,
  StateEffect,
  StateField,
  type TransactionSpec,
} from '@codemirror/state';
import type { LinkRange } from '../vault/api';
import { linksAt, syntaxField } from './analysis';

/**
 * Uuid links as a view. A link to a note without an address is `[[uuid]]`
 * in the file; the editor's text has the note's title there instead, and
 * this table remembers which uuid each title stands for. Conversion
 * happens only where text crosses between file and editor (`fromFile`,
 * `toFile`, and the filter for text coming in), never on cursor moves, so
 * undo and redo only ever see real edits.
 */
export interface UuidLink {
  /** The title's range in the editor's text (inside `[[...]]`). */
  from: number;
  to: number;
  uuid: string;
  /** The text that stands for the uuid; the entry counts while it's there. */
  shown: string;
}

export interface LinkViewOptions {
  /** The note's current title, or null when there's no such note. */
  title(uuid: string): string | null;
  /** For a uuid whose note is gone: the title it had, if known. */
  formerTitle(uuid: string): string | null;
  /** The target (address or uuid) of the one note titled `title`, else null. */
  resolveTitle(title: string): string | null;
}

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Looks like a Zettelkasten address (or a sequence number). */
export const ADDRESS = /^\d+(?:\.\d+(?:[a-z]+\d+)*[a-z]*)?$/i;

/** Same pattern as the `wikilinks` show rule (`link_library`). */
const WIKILINK = /\[\[([^[\]\n]+)\]\]/g;

/** What a uuid target is shown as: the title as plain link text. */
export function label(title: string): string {
  return (
    title
      .replace(/[[\]|\n]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Untitled'
  );
}

const mapLink = (link: UuidLink, changes: ChangeDesc): UuidLink | null => {
  const from = changes.mapPos(link.from, 1);
  const to = changes.mapPos(link.to, -1);
  return from < to ? { ...link, from, to } : null;
};

const mapLinks = (links: UuidLink[], changes: ChangeDesc) =>
  links.flatMap(link => mapLink(link, changes) ?? []);

/** Adds (or replaces, by position) entries; positions in the new document. */
const addLinks = StateEffect.define<UuidLink[]>({ map: mapLinks });
/** Drops the entries at these positions. */
const removeLinks = StateEffect.define<UuidLink[]>({ map: mapLinks });
/** Replaces the whole table (a reload from disk). */
const resetLinks = StateEffect.define<UuidLink[]>({ map: mapLinks });

/** Marks text that's already in editor form: the incoming filter leaves it. */
const converted = Annotation.define<boolean>();

const byPosition = (a: UuidLink, b: UuidLink) => a.from - b.from;

export const uuidLinks = StateField.define<UuidLink[]>({
  create: () => [],
  update(value, tr) {
    let links = tr.docChanged ? mapLinks(value, tr.changes) : value;
    for (const effect of tr.effects) {
      if (effect.is(resetLinks)) {
        links = effect.value;
      } else if (effect.is(addLinks)) {
        const at = new Set(effect.value.map(l => l.from));
        links = [...links.filter(l => !at.has(l.from)), ...effect.value];
      } else if (effect.is(removeLinks)) {
        const gone = new Set(effect.value.map(l => `${l.from}:${l.uuid}`));
        links = links.filter(l => !gone.has(`${l.from}:${l.uuid}`));
      }
    }
    return links === value ? value : [...links].sort(byPosition);
  },
});

/**
 * Undo and redo restore the table with the text: an entry whose title a
 * change deleted comes back when the deletion is undone, and one a change
 * added goes when it's undone.
 */
const linkHistory = invertedEffects.of(tr => {
  const out: StateEffect<UuidLink[]>[] = [];
  for (const effect of tr.effects) {
    if (effect.is(addLinks)) out.push(removeLinks.of(effect.value));
    else if (effect.is(removeLinks)) out.push(addLinks.of(effect.value));
    else if (effect.is(resetLinks)) {
      out.push(resetLinks.of(tr.startState.field(uuidLinks)));
    }
  }
  if (tr.docChanged) {
    const lost = tr.startState
      .field(uuidLinks)
      .filter(link => mapLink(link, tr.changes) === null);
    if (lost.length > 0) out.push(addLinks.of(lost));
  }
  return out;
});

/** The entries whose title is still there, in order. */
export function intactLinks(state: EditorState): UuidLink[] {
  return (
    state
      .field(uuidLinks, false)
      ?.filter(l => state.sliceDoc(l.from, l.to) === l.shown) ?? []
  );
}

/** The uuid the title at `from`..`to` stands for, if it does. */
export function uuidAt(
  state: EditorState,
  from: number,
  to: number,
): string | undefined {
  return state
    .field(uuidLinks, false)
    ?.find(
      l =>
        l.from === from && l.to === to && state.sliceDoc(from, to) === l.shown,
    )?.uuid;
}

/** The note's wikilinks with the targets the file has: a title standing for a uuid reads as that uuid. */
export function linksIn(state: EditorState): LinkRange[] {
  return linksAt(state).map(link => {
    const uuid = uuidAt(state, link.targetFrom, link.targetTo);
    return uuid ? { ...link, target: uuid } : link;
  });
}

/**
 * How a uuid shows: its note's title, else the title it had (a deleted
 * note), else "Missing note". A uuid never shows; the file keeps it.
 */
function shownFor(options: LinkViewOptions, uuid: string): string {
  return label(
    options.title(uuid) ?? options.formerTitle(uuid) ?? 'Missing note',
  );
}

/**
 * File text in editor form: each uuid target replaced by its note's title,
 * with the table of what they stand for.
 */
export function fromFile(
  text: string,
  options: LinkViewOptions,
  /**
   * The link target ranges `analyze` found in `text`; when given, only
   * those convert, so `[[uuid]]` in raw text or a comment stays as it is.
   */
  targets?: { from: number; to: number }[],
): { text: string; links: UuidLink[] } {
  const isLink = targets
    ? new Set(targets.map(t => `${t.from}:${t.to}`))
    : null;
  let out = '';
  let last = 0;
  const links: UuidLink[] = [];
  for (const match of text.matchAll(WIKILINK)) {
    const inner = match[1];
    const bar = inner.indexOf('|');
    const raw = bar < 0 ? inner : inner.slice(0, bar);
    const target = raw.trim();
    if (!UUID.test(target)) continue;
    const start = match.index + 2 + raw.indexOf(target);
    if (isLink && !isLink.has(`${start}:${start + target.length}`)) continue;
    const shown = shownFor(options, target);
    out += text.slice(last, start);
    const from = out.length;
    out += shown;
    links.push({ from, to: out.length, uuid: target, shown });
    last = start + target.length;
  }
  return { text: out + text.slice(last), links };
}

const fileTexts = new WeakMap<EditorState, string>();

/**
 * The editor's text as the file has it: titles that stand for uuids back to
 * their uuids. Cached per state (states are immutable), since a keystroke and
 * the compile result after it both ask for the same one.
 */
export function toFile(state: EditorState): string {
  let file = fileTexts.get(state);
  if (file === undefined) {
    file = computeFile(state);
    fileTexts.set(state, file);
  }
  return file;
}

function computeFile(state: EditorState): string {
  const text = state.doc.toString();
  const links = intactLinks(state);
  if (links.length === 0) return text;
  let out = '';
  let last = 0;
  for (const link of links) {
    out += text.slice(last, link.from) + link.uuid;
    last = link.to;
  }
  return out + text.slice(last);
}

/** An editor offset as a file offset; inside a title, the start of its uuid. */
export function docToFileOffset(state: EditorState, pos: number): number {
  let delta = 0;
  for (const link of intactLinks(state)) {
    if (link.from >= pos) break;
    if (pos < link.to) return link.from + delta;
    delta += link.uuid.length - (link.to - link.from);
  }
  return pos + delta;
}

/** A file offset as an editor offset; inside a uuid, the start of its title. */
export function fileToDocOffset(state: EditorState, pos: number): number {
  let delta = 0;
  for (const link of intactLinks(state)) {
    const start = link.from + delta;
    if (start >= pos) break;
    if (pos < start + link.uuid.length) return link.from;
    delta += link.uuid.length - (link.to - link.from);
  }
  return pos - delta;
}

interface LinePosition {
  line: number;
  column: number;
}

/**
 * A 0-based line and UTF-16 column in the file as one in the editor, and
 * back. Titles and uuids never span lines, so only columns move.
 */
export function fileToDocPosition(
  state: EditorState,
  position: LinePosition,
): LinePosition {
  if (position.line >= state.doc.lines) return position;
  const line = state.doc.line(position.line + 1);
  const start = docToFileOffset(state, line.from);
  const at = fileToDocOffset(state, start + position.column);
  return { line: position.line, column: Math.max(0, at - line.from) };
}

export function docToFilePosition(
  state: EditorState,
  position: LinePosition,
): LinePosition {
  if (position.line >= state.doc.lines) return position;
  const line = state.doc.line(position.line + 1);
  const start = docToFileOffset(state, line.from);
  const at = docToFileOffset(state, line.from + position.column);
  return { line: position.line, column: at - start };
}

/**
 * Text coming into the editor in file form or as complete links (a
 * completion or retarget putting in a uuid, a paste, a Vim put, a reload)
 * is put in editor form in the same transaction, so history sees one step:
 * a uuid target becomes its title with an entry, and a complete link
 * inserted in one piece whose title names a note links to it (an entry,
 * or its address). Undo and redo are left alone: the table comes back
 * with them (`linkHistory`).
 */
function incoming(options: () => LinkViewOptions | null) {
  return EditorState.transactionFilter.of(tr => {
    const opts = options();
    if (
      !opts ||
      !tr.docChanged ||
      tr.annotation(converted) ||
      tr.isUserEvent('undo') ||
      tr.isUserEvent('redo')
    ) {
      return tr;
    }
    const doc = tr.newDoc;
    // Raw text as it was, where `[[...]]` isn't a link.
    const raw = (tr.startState.field(syntaxField, false)?.raw ?? []).map(r => ({
      from: tr.changes.mapPos(r.from, 1),
      to: tr.changes.mapPos(r.to, -1),
    }));
    const inRaw = (pos: number) => raw.some(r => r.from < pos && pos < r.to);
    const inserted: { from: number; to: number }[] = [];
    tr.changes.iterChangedRanges((_fa, _ta, from, to) => {
      inserted.push({ from, to });
    });
    const changes: ChangeSpec[] = [];
    const links: UuidLink[] = [];
    let delta = 0;
    const seen = new Set<number>();
    for (const range of inserted) {
      const first = doc.lineAt(range.from).number;
      const last = doc.lineAt(range.to).number;
      for (let n = first; n <= last; n++) {
        const line = doc.line(n);
        if (seen.has(n)) continue;
        seen.add(n);
        for (const match of line.text.matchAll(WIKILINK)) {
          const linkFrom = line.from + match.index;
          const linkTo = linkFrom + match[0].length;
          if (linkTo < range.from || linkFrom > range.to) continue;
          if (inRaw(linkFrom)) continue;
          const inner = match[1];
          const bar = inner.indexOf('|');
          const raw = bar < 0 ? inner : inner.slice(0, bar);
          const target = raw.trim();
          if (!target) continue;
          const from = linkFrom + 2 + raw.indexOf(target);
          const to = from + target.length;
          let replacement: string;
          let uuid: string | null = null;
          if (UUID.test(target)) {
            replacement = shownFor(opts, target);
            uuid = target;
          } else if (
            !ADDRESS.test(target) &&
            range.from <= linkFrom &&
            linkTo <= range.to &&
            uuidAt(tr.state, from, to) === undefined
          ) {
            // A whole link put in at once, by its title.
            const resolved = opts.resolveTitle(target);
            if (resolved === null) continue;
            if (UUID.test(resolved)) {
              links.push({
                from: from + delta,
                to: to + delta,
                uuid: resolved,
                shown: target,
              });
              continue;
            }
            replacement = resolved;
          } else {
            continue;
          }
          changes.push({ from, to, insert: replacement });
          if (uuid) {
            links.push({
              from: from + delta,
              to: from + delta + replacement.length,
              uuid,
              shown: replacement,
            });
          }
          delta += replacement.length - target.length;
        }
      }
    }
    if (changes.length === 0 && links.length === 0) return tr;
    const spec: TransactionSpec = {
      changes,
      effects: links.length > 0 ? addLinks.of(links) : [],
      sequential: true,
    };
    return [tr, spec];
  });
}

/** Seeds the table for a note's first text (already in editor form). */
export const initialLinks = (links: UuidLink[]) => uuidLinks.init(() => links);

/**
 * Replaces the editor's text with `file` (a reload from disk) in editor
 * form: the smallest change, plus the table for the new text. Returns null
 * when nothing changes.
 */
export function replaceFromFile(
  state: EditorState,
  file: string,
  options: LinkViewOptions,
  targets: { from: number; to: number }[] | undefined,
  effects: StateEffect<unknown>[] = [],
): TransactionSpec | null {
  if (toFile(state) === file) return null;
  const next = fromFile(file, options, targets);
  const current = state.doc.toString();
  let start = 0;
  while (start < current.length && current[start] === next.text[start]) start++;
  let end = 0;
  while (
    end < current.length - start &&
    end < next.text.length - start &&
    current[current.length - 1 - end] === next.text[next.text.length - 1 - end]
  ) {
    end++;
  }
  return {
    changes: {
      from: start,
      to: current.length - end,
      insert: next.text.slice(start, next.text.length - end),
    },
    effects: [resetLinks.of(next.links), ...effects],
    annotations: converted.of(true),
  };
}

/**
 * Brings the titles standing for uuids up to date after notes were
 * renamed, or null when they are. A real edit, an undo step of its own
 * (undoing it shows the old title again; the link still names the note),
 * so history never maps other steps through a change it didn't record.
 */
export function renamedTitles(
  state: EditorState,
  options: LinkViewOptions,
): TransactionSpec | null {
  const changes: ChangeSpec[] = [];
  const links: UuidLink[] = [];
  let delta = 0;
  for (const link of intactLinks(state)) {
    const title = options.title(link.uuid);
    if (title === null) continue;
    const shown = label(title);
    if (shown === link.shown) continue;
    changes.push({ from: link.from, to: link.to, insert: shown });
    links.push({
      from: link.from + delta,
      to: link.from + delta + shown.length,
      uuid: link.uuid,
      shown,
    });
    delta += shown.length - (link.to - link.from);
  }
  if (changes.length === 0) return null;
  return {
    changes,
    effects: addLinks.of(links),
    annotations: [converted.of(true), isolateHistory.of('full')],
  };
}

/** Points a link at a note by its uuid without changing its text (resolving a typed title). */
export const linkTitle = (link: UuidLink) => addLinks.of([link]);

export function linkView(options: () => LinkViewOptions | null): Extension {
  return [uuidLinks, linkHistory, incoming(options)];
}
