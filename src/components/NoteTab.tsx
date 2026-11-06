import type { EditorView } from '@codemirror/view';
import { createEffect, createResource, Match, on, Switch } from 'solid-js';
import { pasteImages } from '../editor/attachments';
import { citations, refreshCitations } from '../editor/citations';
import { setDiagnostics } from '../editor/diagnostics';
import { followCursor } from '../editor/sync';
import { typstEditing } from '../editor/typst';
import { setVimActions } from '../editor/vimCommands';
import { refreshWikilinks, wikilinks } from '../editor/wikilinks';
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
  noteById,
  noteLabel,
  openNote,
  resolveTarget,
  saveAttachment,
  saveNote,
  sessionFor,
  setPreviewFocus,
  tabOf,
  takeStartCursor,
  tree,
} from '../state/workspace';
import type { NoteId } from '../vault/api';
import { citationCard } from './citationCard';
import { Editor } from './Editor';

const links = wikilinks({
  title: target => {
    const id = resolveTarget(target);
    return id ? (noteById(id)?.title ?? 'Untitled') : null;
  },
  open: target => {
    const id = resolveTarget(target);
    if (id) openNote(id);
  },
});

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
  const [text] = createResource(() => session?.text);
  let view: EditorView | undefined;

  const follow = followCursor(
    () => settings.previewFollowsCursor && !props.hidden,
    position =>
      void session
        ?.locate(position)
        .then(points => setPreviewFocus({ note: props.id, points })),
  );

  const editing = typstEditing({
    notes: linkCandidates,
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

  const showDiagnostics = () => {
    const compiled = session?.compiled();
    if (view && compiled)
      view.dispatch({ effects: setDiagnostics.of(compiled) });
  };
  createEffect(on(() => session?.compiled(), showDiagnostics));
  createEffect(
    on(tree, () => view?.dispatch({ effects: refreshWikilinks.of(null) }), {
      defer: true,
    }),
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
        {s => (
          <Editor
            initialDoc={text() ?? ''}
            onChange={next => s().edit(next)}
            onView={attach}
            extensions={[editing, links, cites, follow, paste]}
            vim={settings.vim}
            lineNumbers={settings.lineNumbers}
          />
        )}
      </Match>
    </Switch>
  );
}
