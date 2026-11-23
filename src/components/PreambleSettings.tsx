import type { EditorView } from '@codemirror/view';
import { ask } from '@tauri-apps/plugin-dialog';
import Pencil from 'lucide-solid/icons/pencil';
import Plus from 'lucide-solid/icons/plus';
import RotateCcw from 'lucide-solid/icons/rotate-ccw';
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
  preambleTooltip,
  renameKind,
  savePreamble,
} from '../state/workspace';
import type { Diagnostic, Position } from '../typst/protocol';
import { type PreambleWarning, type Template, vault } from '../vault/api';
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
 * Edits one preamble or template. It saves once typing pauses (whatever the
 * notes' autosave setting: there is no Mod+S here) and when it closes; a
 * preamble's save recompiles the visible note's preview with it.
 */
function PreambleEditor(props: {
  path: string;
  initial: string;
  warnings: PreambleWarning[];
  /** Writes the text; resolves to its warnings. */
  save: (text: string) => Promise<PreambleWarning[]>;
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
      setWarnings(await props.save(text));
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
            pending = text();
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
            tooltip: (text, position, before) =>
              preambleTooltip(props.path, text, position, before),
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

/**
 * The settings section for preambles (shared Typst code for notes) and
 * templates (what new notes start with), common and per kind.
 */
export function PreambleSettings() {
  /** The kind whose files are shown; null is the common ones. */
  const [selected, setSelected] = createSignal<string | null>(null);
  const [file, setFile] = createSignal<'preamble' | 'template'>('preamble');
  const [templates, setTemplates] = createSignal<Template[]>([]);
  createEffect(on(kinds, () => void vault.listTemplates().then(setTemplates)));
  const currentTemplate = () => templates().find(t => t.kind === selected());
  const saveTemplate = async (kind: string | null, text: string) => {
    await vault.saveTemplate(kind, text);
    setTemplates(list => list.map(t => (t.kind === kind ? { ...t, text } : t)));
    return [];
  };
  const [form, setForm] = createSignal<NameForm | null>(null);
  const [formError, setFormError] = createSignal<string | null>(null);
  let nameInput: HTMLInputElement | undefined;

  createEffect(() => {
    const kind = selected();
    if (kind !== null && !kinds().includes(kind)) setSelected(null);
  });

  const current = () => preambles().find(p => p.kind === selected());
  /** Bumped by "Restore default", to remount the editor with the new text. */
  const [restored, setRestored] = createSignal(0);
  // Keyed by path, so saving (which replaces the preamble or template
  // object) doesn't remount the editor.
  const editorKey = createMemo(
    () => {
      const path =
        file() === 'preamble' ? current()?.path : currentTemplate()?.path;
      return path ? { path, restored: restored() } : undefined;
    },
    undefined,
    { equals: (a, b) => a?.path === b?.path && a?.restored === b?.restored },
  );

  const restoreDefault = async () => {
    const kind = selected();
    const template = file() === 'template';
    const what = `${kind === null ? 'the common' : `kind "${kind}"'s`} ${template ? 'template' : 'preamble'}`;
    const ok = await ask(
      `Replace ${what} with the default? Its current text is lost.`,
      { title: 'Restore default', kind: 'warning', okLabel: 'Restore' },
    );
    if (!ok) return;
    await flushEditor?.();
    const text = await vault.defaultText(kind, template);
    if (template) await saveTemplate(kind, text);
    else await savePreamble(kind, text);
    setRestored(n => n + 1);
  };

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
      `${verb}: the preamble and template of kind "${kind}"? ${count} note(s) of this kind keep it in their header and only get the common preamble.`,
      { title: 'Delete kind', kind: 'warning', okLabel: verb },
    );
    if (!ok) return;
    await flushEditor?.();
    await deleteKind(kind);
  };

  return (
    <section class="settings-section preamble-settings">
      <h3 class="settings-section-title">Templates</h3>
      <Show
        when={file() === 'template'}
        fallback={
          <p class="setting-description preamble-intro">
            A preamble is Typst code shared by notes. Its definitions (imports,{' '}
            <code>#let</code>) are available in notes without importing them,
            and its <code>template</code> styles the whole note. The common
            preamble applies to every note; a kind's applies to the notes with
            that <code>kind</code> in their header.
          </p>
        }
      >
        <p class="setting-description preamble-intro">
          A template is what a new note starts with below its header: the common
          one, or its kind's if that isn't empty. <code>{'{{title}}'}</code>{' '}
          becomes the note's title, <code>{'{{date}}'}</code> and{' '}
          <code>{'{{time}}'}</code> the date and time it was created, and{' '}
          <code>{'{{date:dddd, D MMMM YYYY}}'}</code> formats them:{' '}
          <code>YYYY</code> <code>MM</code> <code>MMMM</code> <code>DD</code>{' '}
          <code>dddd</code> <code>HH</code> <code>hh</code> <code>mm</code>{' '}
          <code>ss</code> <code>A</code> and shorter forms; text in{' '}
          <code>[brackets]</code> stays as it is. <code>{'{{cursor}}'}</code>{' '}
          marks where the cursor starts.
        </p>
      </Show>
      <div class="preamble-toolbar">
        <fieldset class="segmented" aria-label="File">
          <For each={['preamble', 'template'] as const}>
            {f => (
              <button
                type="button"
                class="segment"
                classList={{ active: file() === f }}
                aria-pressed={file() === f}
                onClick={() => setFile(f)}
              >
                {f === 'preamble' ? 'Preamble' : 'Template'}
              </button>
            )}
          </For>
        </fieldset>
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
        <button
          type="button"
          title={
            file() === 'template'
              ? "Replace this template with the default (a kind's is empty, so the common one applies)"
              : 'Replace this preamble with the default'
          }
          onClick={() => void restoreDefault()}
        >
          <RotateCcw size={14} /> Restore default
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
      <Show when={editorKey()} keyed>
        {({ path }) => {
          const kind = untrack(selected);
          if (untrack(file) === 'template') {
            return (
              <PreambleEditor
                path={path}
                initial={untrack(currentTemplate)?.text ?? ''}
                warnings={[]}
                save={text => saveTemplate(kind, text)}
              />
            );
          }
          const preamble = untrack(current);
          return (
            <PreambleEditor
              path={path}
              initial={preamble?.text ?? ''}
              warnings={preamble?.warnings ?? []}
              save={text => savePreamble(kind, text)}
            />
          );
        }}
      </Show>
    </section>
  );
}
