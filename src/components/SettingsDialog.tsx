import { Combobox, createListCollection, Dialog, Switch } from '@ark-ui/solid';
import { ask } from '@tauri-apps/plugin-dialog';
import Eye from 'lucide-solid/icons/eye';
import FileCode from 'lucide-solid/icons/file-code';
import FileText from 'lucide-solid/icons/file-text';
import RotateCcw from 'lucide-solid/icons/rotate-ccw';
import SquarePen from 'lucide-solid/icons/square-pen';
import SunMoon from 'lucide-solid/icons/sun-moon';
import X from 'lucide-solid/icons/x';
import {
  type Component,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  Switch as Pick,
  Show,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import {
  restoreDefaults,
  type Settings,
  settings,
  updateSettings,
} from '../state/settings';
import { allFolders, refreshLinks } from '../state/workspace';
import { handleEditorEscape } from './Editor';
import { fuzzyScore } from './Palette';
import { PreambleSettings } from './PreambleSettings';
import { MIN_PREVIEW_PX } from './Preview';
import { withOverlayScrollbar } from './scrollbars';

type SectionId = 'appearance' | 'editor' | 'preview' | 'notes' | 'preambles';

const SECTIONS: {
  id: SectionId;
  label: string;
  icon: Component<{ size?: number }>;
}[] = [
  { id: 'appearance', label: 'Appearance', icon: SunMoon },
  { id: 'editor', label: 'Editor', icon: SquarePen },
  { id: 'preview', label: 'Preview', icon: Eye },
  { id: 'notes', label: 'Notes', icon: FileText },
  { id: 'preambles', label: 'Preambles', icon: FileCode },
];

const [open, setOpen] = createSignal(false);
const [section, setSection] = createSignal<SectionId>('appearance');
// Window capture runs before Ark's Escape handling on the document, so an
// editor in the dialog gets Escape first (see `handleEditorEscape`).
createRoot(() =>
  createEffect(() => {
    if (!open()) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      if (handleEditorEscape(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    onCleanup(() =>
      window.removeEventListener('keydown', onKey, { capture: true }),
    );
  }),
);

export const openSettings = (at?: SectionId) => {
  if (at) setSection(at);
  setOpen(true);
};

function SettingText(props: { name: string; description?: string }) {
  return (
    <>
      <span class="setting-name">{props.name}</span>
      {props.description && (
        <span class="setting-description">{props.description}</span>
      )}
    </>
  );
}

function ToggleSetting(props: {
  name: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Switch.Root
      class="setting"
      checked={props.checked}
      onCheckedChange={(details) => props.onChange(details.checked)}
    >
      <Switch.Label class="setting-text">
        <SettingText name={props.name} description={props.description} />
      </Switch.Label>
      <Switch.Control class="switch">
        <Switch.Thumb class="switch-thumb" />
      </Switch.Control>
      <Switch.HiddenInput />
    </Switch.Root>
  );
}

function SelectSetting<T extends string>(props: {
  id: string;
  name: string;
  description?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div class="setting">
      <label class="setting-text" for={props.id}>
        <SettingText name={props.name} description={props.description} />
      </label>
      <select
        id={props.id}
        class="setting-select"
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value as T)}
      >
        <For each={props.options}>
          {(option) => <option value={option.value}>{option.label}</option>}
        </For>
      </select>
    </div>
  );
}

function NumberSetting(props: {
  id: string;
  name: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  return (
    <div class="setting">
      <label class="setting-text" for={props.id}>
        <SettingText name={props.name} description={props.description} />
      </label>
      <span class="setting-number">
        <input
          id={props.id}
          type="number"
          class="setting-select"
          value={props.value}
          min={props.min}
          max={props.max}
          step={props.step}
          onChange={(e) => {
            const value = e.currentTarget.valueAsNumber;
            if (Number.isNaN(value)) {
              e.currentTarget.value = String(props.value);
              return;
            }
            const clamped = Math.min(props.max, Math.max(props.min, value));
            e.currentTarget.value = String(clamped);
            props.onChange(clamped);
          }}
        />
        {props.unit}
      </span>
    </div>
  );
}

/** Picks a folder by fuzzy search over every folder in the vault. */
function FolderSetting(props: {
  id: string;
  name: string;
  description?: string;
  value: string;
  onChange: (path: string) => void;
}) {
  const [query, setQuery] = createSignal('');
  const collection = createMemo(() => {
    const folders = allFolders().map((f) => ({
      label: f.path,
      value: f.path,
      zettelkasten: f.kind === 'zettelkasten',
    }));
    const q = query().trim();
    const items = q
      ? folders
          .map((f) => ({ f, score: fuzzyScore(q, f.label) }))
          .filter((e) => e.score !== null)
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
          .map((e) => e.f)
      : folders;
    return createListCollection({ items });
  });

  return (
    <div class="setting">
      <label class="setting-text" for={props.id}>
        <SettingText name={props.name} description={props.description} />
      </label>
      <Combobox.Root
        class="folder-combobox"
        collection={collection()}
        ids={{ input: props.id }}
        defaultValue={props.value ? [props.value] : []}
        defaultInputValue={props.value}
        placeholder="Search folders..."
        openOnClick
        inputBehavior="autohighlight"
        onOpenChange={(details) => {
          if (details.open) setQuery('');
        }}
        onInputValueChange={(details) => {
          if (details.reason === 'input-change') setQuery(details.inputValue);
        }}
        onValueChange={(details) => {
          const path = details.value[0];
          if (path !== undefined) props.onChange(path);
        }}
      >
        <Combobox.Control>
          <Combobox.Input class="setting-select combobox-input" />
        </Combobox.Control>
        <Portal>
          <Combobox.Positioner>
            <Combobox.Content
              class="combobox-content"
              ref={withOverlayScrollbar}
            >
              <For each={collection().items}>
                {(item) => (
                  <Combobox.Item item={item} class="combobox-item">
                    <Combobox.ItemText>{item.label}</Combobox.ItemText>
                    <Show when={item.zettelkasten}>
                      <span class="combobox-tag">Zettelkasten</span>
                    </Show>
                  </Combobox.Item>
                )}
              </For>
              <Show when={collection().items.length === 0}>
                <div class="combobox-empty">No folders match</div>
              </Show>
            </Combobox.Content>
          </Combobox.Positioner>
        </Portal>
      </Combobox.Root>
    </div>
  );
}

function SectionBody(props: { title: string; children: JSX.Element }) {
  return (
    <section class="settings-section">
      <h3 class="settings-section-title">{props.title}</h3>
      {props.children}
    </section>
  );
}

export function SettingsDialog() {
  return (
    <Dialog.Root
      open={open()}
      onOpenChange={(details) => setOpen(details.open)}
      closeOnEscape={false}
      lazyMount
      unmountOnExit
    >
      <Portal>
        <Dialog.Backdrop class="dialog-backdrop" />
        <Dialog.Positioner class="dialog-positioner">
          <Dialog.Content class="dialog settings">
            <nav class="settings-nav" aria-label="Settings sections">
              <Dialog.Title class="settings-heading">Settings</Dialog.Title>
              <For each={SECTIONS}>
                {(item) => (
                  <button
                    type="button"
                    class="settings-nav-item"
                    classList={{ active: section() === item.id }}
                    aria-current={section() === item.id ? 'page' : undefined}
                    onClick={() => setSection(item.id)}
                  >
                    <item.icon size={14} />
                    {item.label}
                  </button>
                )}
              </For>
              <button
                type="button"
                class="settings-nav-item settings-restore"
                onClick={async () => {
                  const ok = await ask(
                    'Restore every setting of this vault to its default?',
                    {
                      title: 'Restore defaults',
                      kind: 'warning',
                      okLabel: 'Restore',
                    },
                  );
                  if (!ok) return;
                  restoreDefaults();
                  void refreshLinks();
                }}
              >
                <RotateCcw size={14} />
                Restore defaults
              </button>
            </nav>

            <div
              class="settings-body"
              classList={{ fill: section() === 'preambles' }}
              ref={withOverlayScrollbar}
            >
              <Dialog.CloseTrigger
                class="icon-button settings-close"
                aria-label="Close settings"
              >
                <X size={16} />
              </Dialog.CloseTrigger>
              <Pick>
                <Match when={section() === 'appearance'}>
                  <SectionBody title="Appearance">
                    <SelectSetting<Settings['theme']>
                      id="setting-theme"
                      name="Theme"
                      description="Light or dark colours for the app and note previews."
                      value={settings.theme}
                      options={[
                        { value: 'system', label: 'Follow system' },
                        { value: 'light', label: 'Light' },
                        { value: 'dark', label: 'Dark' },
                      ]}
                      onChange={(theme) => updateSettings({ theme })}
                    />
                    <SelectSetting<Settings['previewTheme']>
                      id="setting-preview-theme"
                      name="Preview theme"
                      description="Note previews can follow the app or stay light or dark."
                      value={settings.previewTheme}
                      options={[
                        { value: 'app', label: 'Same as app' },
                        { value: 'light', label: 'Light' },
                        { value: 'dark', label: 'Dark' },
                      ]}
                      onChange={(previewTheme) =>
                        updateSettings({ previewTheme })
                      }
                    />
                  </SectionBody>
                </Match>
                <Match when={section() === 'editor'}>
                  <SectionBody title="Editor">
                    <ToggleSetting
                      name="Vim key bindings"
                      description="Edit notes with Vim motions and commands."
                      checked={settings.vim}
                      onChange={(vim) => updateSettings({ vim })}
                    />
                    <ToggleSetting
                      name="Autosave"
                      description="Save notes while you type. When off, notes save on Mod+S and when their tab or the window closes."
                      checked={settings.autosave}
                      onChange={(autosave) => updateSettings({ autosave })}
                    />
                    <Show when={settings.autosave}>
                      <NumberSetting
                        id="setting-autosave-delay"
                        name="Autosave delay"
                        description="How long typing must pause before a save."
                        value={settings.autosaveDelay}
                        min={100}
                        max={10000}
                        step={100}
                        unit="ms"
                        onChange={(autosaveDelay) =>
                          updateSettings({ autosaveDelay })
                        }
                      />
                    </Show>
                    <ToggleSetting
                      name="Line numbers"
                      description="Show line numbers beside the text."
                      checked={settings.lineNumbers}
                      onChange={(lineNumbers) =>
                        updateSettings({ lineNumbers })
                      }
                    />
                  </SectionBody>
                </Match>
                <Match when={section() === 'preview'}>
                  <SectionBody title="Preview">
                    <SelectSetting<Settings['linkDisplay']>
                      id="setting-link-display"
                      name="Wikilink text"
                      description="What links without custom text show."
                      value={settings.linkDisplay}
                      options={[
                        { value: 'title', label: 'Note title' },
                        { value: 'address', label: 'Zettelkasten address' },
                      ]}
                      onChange={(linkDisplay) => {
                        updateSettings({ linkDisplay });
                        void refreshLinks();
                      }}
                    />
                    <SelectSetting<Settings['defaultViewMode']>
                      id="setting-default-view-mode"
                      name="View for new panes"
                      description="What a pane shows when it's created, e.g. by splitting. Each pane can switch later."
                      value={settings.defaultViewMode}
                      options={[
                        { value: 'edit', label: 'Editor and preview' },
                        { value: 'source', label: 'Editor only' },
                        { value: 'read', label: 'Reading view' },
                      ]}
                      onChange={(defaultViewMode) =>
                        updateSettings({ defaultViewMode })
                      }
                    />
                    <ToggleSetting
                      name="Follow the cursor"
                      description="Scroll the preview to where the editor's cursor rests. Clicking the preview always jumps to the source."
                      checked={settings.previewFollowsCursor}
                      onChange={(previewFollowsCursor) =>
                        updateSettings({ previewFollowsCursor })
                      }
                    />
                    <NumberSetting
                      id="setting-max-preview-width"
                      name="Maximum page width"
                      description="Wider panes centre the page instead of stretching it."
                      value={settings.maxPreviewWidth}
                      min={MIN_PREVIEW_PX}
                      max={2000}
                      step={20}
                      unit="px"
                      onChange={(maxPreviewWidth) =>
                        updateSettings({ maxPreviewWidth })
                      }
                    />
                  </SectionBody>
                </Match>
                <Match when={section() === 'notes'}>
                  <SectionBody title="Notes">
                    <SelectSetting<Settings['newNoteLocation']>
                      id="setting-new-note-location"
                      name="Default location for new notes"
                      description="Where Mod+N creates a note. A note in the Zettelkasten asks for its address first."
                      value={settings.newNoteLocation}
                      options={[
                        { value: 'root', label: 'Vault root folder' },
                        {
                          value: 'current',
                          label: 'Same folder as current note',
                        },
                        {
                          value: 'folder',
                          label: 'In the folder specified below',
                        },
                      ]}
                      onChange={(newNoteLocation) =>
                        updateSettings({ newNoteLocation })
                      }
                    />
                    <Show when={settings.newNoteLocation === 'folder'}>
                      <FolderSetting
                        id="setting-new-note-folder"
                        name="Folder to create new notes in"
                        value={settings.newNoteFolder}
                        onChange={(newNoteFolder) =>
                          updateSettings({ newNoteFolder })
                        }
                      />
                    </Show>
                    <SelectSetting<Settings['deleteMode']>
                      id="setting-delete-mode"
                      name="Deleting a note"
                      description="Where deleted note files go."
                      value={settings.deleteMode}
                      options={[
                        { value: 'trash', label: 'Move to system trash' },
                        { value: 'permanent', label: 'Delete permanently' },
                      ]}
                      onChange={(deleteMode) => updateSettings({ deleteMode })}
                    />
                  </SectionBody>
                </Match>
                <Match when={section() === 'preambles'}>
                  <PreambleSettings />
                </Match>
              </Pick>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
