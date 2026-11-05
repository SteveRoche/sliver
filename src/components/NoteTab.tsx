import type { EditorView } from '@codemirror/view';
import { createEffect, createResource, Match, on, Switch } from 'solid-js';
import { setDiagnostics } from '../editor/diagnostics';
import { followCursor } from '../editor/sync';
import { typstEditing } from '../editor/typst';
import { setVimActions } from '../editor/vimCommands';
import { refreshWikilinks, wikilinks } from '../editor/wikilinks';
import { settings } from '../state/settings';
import {
  allNotes,
  closeTab,
  noteById,
  noteLabel,
  openNote,
  resolveTarget,
  saveNote,
  sessionFor,
  setPreviewFocus,
  tabOf,
  tree,
} from '../state/workspace';
import type { NoteId } from '../vault/api';
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
  });

  const attach = (v: EditorView | undefined) => {
    view = v;
    session?.attachView(v);
    if (v) {
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
            extensions={[editing, links, follow]}
            vim={settings.vim}
            lineNumbers={settings.lineNumbers}
          />
        )}
      </Match>
    </Switch>
  );
}
