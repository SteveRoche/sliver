import type { EditorView } from '@codemirror/view';
import { ask } from '@tauri-apps/plugin-dialog';
import Pencil from 'lucide-solid/icons/pencil';
import Plus from 'lucide-solid/icons/plus';
import Trash from 'lucide-solid/icons/trash';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  untrack,
} from 'solid-js';
import { setDiagnostics } from '../editor/diagnostics';
import { typstEditing } from '../editor/typst';
import { setVimActions } from '../editor/vimCommands';
import { setKindFolder, settings } from '../state/settings';
import {
  allFolders,
  allNotes,
  completePreamble,
  createKind,
  deleteKind,
  diagnosticsIn,
  kinds,
  preambleSignature,
  preambles,
  renameKind,
  savePreamble,
} from '../state/workspace';
import type { Diagnostic, Position } from '../typst/protocol';
import type { PreambleWarning } from '../vault/api';
import { Editor } from './Editor';
import { SelectSetting } from './settingControls';

/** Zero-based line and UTF-16 column of `offset` in `text`. */
function positionAt(text: string, offset: number): Position {
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  return { line, column: offset - (before.lastIndexOf('\n') + 1) };
}

const asDiagnostics = (text: string, warnings: PreambleWarning[]) =>
  warnings.map(
    (w): Diagnostic => ({
      severity: 'warning',
      message: w.message,
      hints: [],
      range: { start: positionAt(text, w.from), end: positionAt(text, w.to) },
    }),
  );

/**
 * Edits one preamble. It saves once typing pauses (whatever the notes'
 * autosave setting: there is no Mod+S here) and when it closes; each save
 * recompiles the visible note's preview with it.
 */
function PreambleEditor(props: {
  path: string;
  kind: string | null;
  initial: string;
  warnings: PreambleWarning[];
}) {
  let view: EditorView | undefined;
  let saved = props.initial;
  let pending: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const [warnings, setWarnings] = createSignal(props.warnings);
  const [error, setError] = createSignal<string | null>(null);

  const showDiagnostics = () => {
    view?.dispatch({
      effects: setDiagnostics.of({
        text: saved,
        diagnostics: [
          ...asDiagnostics(saved, warnings()),
          ...diagnosticsIn(props.path),
        ],
      }),
    });
  };
  createEffect(
    on([warnings, () => diagnosticsIn(props.path)], showDiagnostics),
  );

  const save = async () => {
    clearTimeout(timer);
    const text = pending;
    if (text === undefined) return;
    pending = undefined;
    try {
      setWarnings(await savePreamble(props.kind, text));
      saved = text;
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };
  flushEditor = save;
  onCleanup(() => {
    if (flushEditor === save) flushEditor = undefined;
    void save();
  });

  return (
    <>
      <div class="preamble-editor">
        <Editor
          initialDoc={props.initial}
          onChange={text => {
            pending = text;
            clearTimeout(timer);
            timer = setTimeout(save, settings.autosaveDelay);
          }}
          onView={v => {
            view = v;
            if (v) {
              setVimActions(v, { save: () => void save() });
              showDiagnostics();
            }
          }}
          extensions={typstEditing({
            complete: (text, position, explicit) =>
              completePreamble(props.path, text, position, explicit),
            signature: (text, position) =>
              preambleSignature(props.path, text, position),
          })}
          vim={settings.vim}
          lineNumbers={settings.lineNumbers}
        />
      </div>
      <Show when={error()}>
        <p class="preamble-error">Could not save: {error()}</p>
      </Show>
    </>
  );
}

/** Saves the open editor's pending text, e.g. before its kind is renamed. */
let flushEditor: (() => Promise<void>) | undefined;

/** The folder setting's "none": no folder path can be this. */
const NO_FOLDER = '\u0000';

type NameForm = { mode: 'new' } | { mode: 'rename'; kind: string };

/** The settings section for preambles: shared Typst code for notes. */
export function PreambleSettings() {
  /** The kind whose preamble is shown; null is the common one. */
  const [selected, setSelected] = createSignal<string | null>(null);
  const [form, setForm] = createSignal<NameForm | null>(null);
  const [formError, setFormError] = createSignal<string | null>(null);
  let nameInput: HTMLInputElement | undefined;

  createEffect(() => {
    const kind = selected();
    if (kind !== null && !kinds().includes(kind)) setSelected(null);
  });

  const current = () => preambles().find(p => p.kind === selected());
  // Keyed by path, so saving (which replaces the preamble object) doesn't
  // remount the editor.
  const currentPath = createMemo(() => current()?.path);

  const openForm = (next: NameForm) => {
    setFormError(null);
    setForm(next);
    queueMicrotask(() => nameInput?.select());
  };

  const submitName = async (name: string) => {
    const f = form();
    if (!f || !name) return;
    try {
      await flushEditor?.();
      if (f.mode === 'new') await createKind(name);
      else await renameKind(f.kind, name);
      setForm(null);
      setSelected(name);
    } catch (e) {
      setFormError(String(e));
    }
  };

  const remove = async (kind: string) => {
    const count = allNotes().filter(n => n.kind === kind).length;
    const verb =
      settings.deleteMode === 'trash' ? 'Move to trash' : 'Delete permanently';
    const ok = await ask(
      `${verb}: the preamble of kind "${kind}"? ${count} note(s) of this kind keep it in their header and only get the common preamble.`,
      { title: 'Delete kind', kind: 'warning', okLabel: verb },
    );
    if (!ok) return;
    await flushEditor?.();
    await deleteKind(kind);
  };

  return (
    <section class="settings-section preamble-settings">
      <h3 class="settings-section-title">Preambles</h3>
      <p class="setting-description preamble-intro">
        Typst code shared by notes. Its definitions (imports, <code>#let</code>)
        are available in notes without importing them, and its{' '}
        <code>template</code> styles the whole note. The common preamble applies
        to every note; a kind's applies to the notes with that <code>kind</code>{' '}
        in their header.
      </p>
      <div class="preamble-toolbar">
        <select
          class="setting-select"
          aria-label="Preamble"
          value={selected() ?? ''}
          onChange={e => setSelected(e.currentTarget.value || null)}
        >
          <option value="">Common (every note)</option>
          <For each={kinds()}>
            {kind => <option value={kind}>Kind: {kind}</option>}
          </For>
        </select>
        <button type="button" onClick={() => openForm({ mode: 'new' })}>
          <Plus size={14} /> New kind
        </button>
        <Show when={selected()}>
          {kind => (
            <>
              <button
                type="button"
                onClick={() => openForm({ mode: 'rename', kind: kind() })}
              >
                <Pencil size={14} /> Rename
              </button>
              <button
                type="button"
                class="danger"
                onClick={() => remove(kind())}
              >
                <Trash size={14} /> Delete
              </button>
            </>
          )}
        </Show>
      </div>
      <Show when={form()}>
        {f => (
          <form
            class="preamble-toolbar"
            onSubmit={e => {
              e.preventDefault();
              void submitName(nameInput?.value.trim() ?? '');
            }}
          >
            <input
              ref={nameInput}
              class="setting-select"
              aria-label="Kind name"
              placeholder="Kind name"
              value={f().mode === 'rename' ? (selected() ?? '') : ''}
            />
            <button type="submit" class="primary">
              {f().mode === 'new' ? 'Create' : 'Rename'}
            </button>
            <button type="button" onClick={() => setForm(null)}>
              Cancel
            </button>
            <Show when={formError()}>
              <span class="preamble-error">{formError()}</span>
            </Show>
          </form>
        )}
      </Show>
      <Show when={selected()}>
        {kind => (
          <SelectSetting
            id="setting-kind-folder"
            name="Default folder"
            description='Where "New note of kind" puts notes of this kind. Without one, they go where Mod+N puts notes.'
            value={settings.kindFolders[kind()] ?? NO_FOLDER}
            options={[
              { value: NO_FOLDER, label: 'No default folder' },
              { value: '', label: 'Vault root' },
              ...allFolders().map(f => ({ value: f.path, label: f.path })),
            ]}
            onChange={value =>
              setKindFolder(kind(), value === NO_FOLDER ? null : value)
            }
          />
        )}
      </Show>
      <Show when={currentPath()} keyed>
        {path => {
          const preamble = untrack(current);
          return (
            <PreambleEditor
              path={path}
              kind={preamble?.kind ?? null}
              initial={preamble?.text ?? ''}
              warnings={preamble?.warnings ?? []}
            />
          );
        }}
      </Show>
    </section>
  );
}
