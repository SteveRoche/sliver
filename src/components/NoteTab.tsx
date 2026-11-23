import type { EditorView } from '@codemirror/view';
import { createEffect, createResource, Match, on, Switch } from 'solid-js';
import { followBrokenLink, newLinkedNote } from '../commands/app';
import { pasteImages } from '../editor/attachments';
import { citations, refreshCitations } from '../editor/citations';
import { setDiagnostics } from '../editor/diagnostics';
import {
  docToFilePosition,
  fileToDocPosition,
  fromFile,
  initialLinks,
  renamedTitles,
} from '../editor/linkView';
import { followCursor } from '../editor/sync';
import { typstEditing } from '../editor/typst';
import { setVimActions } from '../editor/vimCommands';
import {
  refreshWikilinks,
  savedText,
  type WikilinkOptions,
  wikilinks,
} from '../editor/wikilinks';
import {
  hasReference,
  openInZotero,
  referenceEntries,
  searchZotero,
} from '../state/citations';
import { settings } from '../state/settings';
import {
  allNotes,
  closeTab,
  followFrom,
  formerTitle,
  noteById,
  noteLabel,
  resolveTarget,
  saveAttachment,
  saveNote,
  sessionFor,
  setPreviewFocus,
  tabOf,
  takeStartCursor,
  titleKey,
} from '../state/workspace';
import type { Position } from '../typst/protocol';
import { type NoteId, vault } from '../vault/api';
import { citationCard } from './citationCard';
import { Editor } from './Editor';

const linkCandidates = () =>
  allNotes().map(note => ({
    label: noteLabel(note),
    // Addresses read better in the source; unaddressed notes only have their uuid.
    target: note.address ?? note.id,
  }));

/**
 * The editor for one open note, rendered into its `.note-tab` element by
 * `editorHosts`. Hidden editors stay mounted, so each keeps its own cursor,
 * selection and undo history.
 */
export function NoteTab(props: { id: NoteId; hidden: boolean }) {
  const session = sessionFor(props.id);
  const linkOptions: WikilinkOptions = {
    title: target => {
      const id = resolveTarget(target);
      return id ? (noteById(id)?.title ?? 'Untitled') : null;
    },
    label: target => {
      const id = resolveTarget(target);
      const note = id && noteById(id);
      if (!note) return null;
      const title = note.title ?? 'Untitled';
      // Like the preview's rule: the address only where the note has one.
      return settings.linkDisplay === 'address' && note.address
        ? { shown: note.address, hover: title }
        : { shown: title, hover: note.address };
    },
    open: (target, newTab) => {
      const id = resolveTarget(target);
      if (id) void followFrom(props.id, id, newTab);
      else void followBrokenLink(props.id, target);
    },
    formerTitle: target => formerTitle(target) ?? null,
    resolveTitle: text => {
      const key = titleKey(text);
      const titled = allNotes().filter(
        n => n.title && titleKey(n.title) === key,
      );
      // Titles are unique in the vault; several only after outside edits.
      const note = titled.length === 1 ? titled[0] : undefined;
      return note ? (note.address ?? note.id) : null;
    },
  };
  const links = wikilinks(linkOptions);
  /** The note's text, with which `[[...]]` are links (not raw or comments). */
  const [text] = createResource(async () => {
    if (!session) return undefined;
    const source = await session.text;
    const analysis = await vault.analyze(source).catch(() => null);
    return {
      source,
      targets: analysis?.links.map(l => ({
        from: l.targetFrom,
        to: l.targetTo,
      })),
    };
  });
  let view: EditorView | undefined;

  const follow = followCursor(
    () => settings.previewFollowsCursor && !props.hidden,
    position =>
      void session
        // The compiler sees the file, where uuids stand for titles.
        ?.locate(view ? docToFilePosition(view.state, position) : position)
        .then(points => setPreviewFocus({ note: props.id, points })),
  );

  const editing = typstEditing({
    notes: linkCandidates,
    newNote: async query => {
      const note = await newLinkedNote(props.id, query);
      return note && (note.address ?? note.id);
    },
    complete: async (text, position, explicit) =>
      (await session?.complete(text, position, explicit)) ?? null,
    signature: async (text, position) =>
      (await session?.signature(text, position)) ?? null,
    zotero: searchZotero,
    tooltip: async (text, position, before) =>
      (await session?.tooltip(text, position, before)) ?? null,
    lintPaths: true,
  });

  const paste = pasteImages((name, data) =>
    saveAttachment(props.id, name, data),
  );

  const cites = citations({
    known: hasReference,
    card: key => citationCard(props.id, [key]),
    open: key => void openInZotero(key),
  });

  const attach = (v: EditorView | undefined) => {
    view = v;
    session?.attachView(v);
    if (v) {
      const start = takeStartCursor(props.id, v.state.doc.toString());
      if (start !== undefined) {
        v.dispatch({ selection: { anchor: start }, scrollIntoView: true });
        // After the pane adopts the editor's element.
        requestAnimationFrame(() => {
          if (!props.hidden) v.focus();
        });
      }
      setVimActions(v, {
        save: () => void saveNote(props.id),
        quit: () => {
          const tab = tabOf(props.id);
          if (tab) void closeTab(tab.key);
        },
      });
      showDiagnostics();
    }
  };

  /** The compile's diagnostics, located in the editor's text (titles where the file has uuids). */
  const showDiagnostics = () => {
    const compiled = session?.compiled();
    if (!view || !compiled) return;
    const state = view.state;
    // Older ones keep following the edits until a compile of this text.
    const file = savedText(state);
    if (compiled.text !== file) return;
    const at = (p: Position) => fileToDocPosition(state, p);
    view.dispatch({
      effects: setDiagnostics.of({
        text: state.doc.toString(),
        diagnostics: compiled.diagnostics.map(d =>
          d.range
            ? {
                ...d,
                range: { start: at(d.range.start), end: at(d.range.end) },
              }
            : d,
        ),
      }),
    });
  };
  createEffect(on(() => session?.compiled(), showDiagnostics));
  createEffect(
    on(
      [() => session?.linksChanged(), () => settings.linkDisplay],
      () => {
        if (!view) return;
        // A renamed note's title, where a link here shows it as text.
        const renamed = renamedTitles(view.state, linkOptions);
        view.dispatch(renamed ?? {}, { effects: refreshWikilinks.of(null) });
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      referenceEntries,
      () => view?.dispatch({ effects: refreshCitations.of(null) }),
      { defer: true },
    ),
  );

  return (
    <Switch>
      <Match when={text.error}>
        <p class="pane-message">Could not open note: {String(text.error)}</p>
      </Match>
      <Match when={text() !== undefined && session}>
        {s => {
          // Titles where the file has uuids (see `linkView.ts`).
          const loaded = text();
          const initial = fromFile(
            loaded?.source ?? '',
            linkOptions,
            loaded?.targets,
          );
          return (
            <Editor
              initialDoc={initial.text}
              onChange={next => s().edit(view ? savedText(view.state) : next())}
              onView={attach}
              extensions={[
                initialLinks(initial.links),
                editing,
                links,
                cites,
                follow,
                paste,
              ]}
              vim={settings.vim}
              lineNumbers={settings.lineNumbers}
            />
          );
        }}
      </Match>
    </Switch>
  );
}
