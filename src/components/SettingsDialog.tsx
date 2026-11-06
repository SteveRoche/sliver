import { Dialog } from '@ark-ui/solid';
import { ask } from '@tauri-apps/plugin-dialog';
import Eye from 'lucide-solid/icons/eye';
import FileCode from 'lucide-solid/icons/file-code';
import FileText from 'lucide-solid/icons/file-text';
import Keyboard from 'lucide-solid/icons/keyboard';
import Quote from 'lucide-solid/icons/quote';
import RotateCcw from 'lucide-solid/icons/rotate-ccw';
import SquarePen from 'lucide-solid/icons/square-pen';
import SunMoon from 'lucide-solid/icons/sun-moon';
import X from 'lucide-solid/icons/x';
import {
  type Component,
  createEffect,
  createRoot,
  createSignal,
  For,
  Match,
  onCleanup,
  Switch as Pick,
  Show,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import { citationStyleChoices, refreshReferences } from '../state/citations';
import {
  restoreDefaults,
  type Settings,
  settings,
  updateSettings,
} from '../state/settings';
import { refreshLinks } from '../state/workspace';
import { handleEditorEscape } from './Editor';
import { KeybindingSettings } from './KeybindingSettings';
import { PreambleSettings } from './PreambleSettings';
import { MIN_PREVIEW_PX } from './Preview';
import { withOverlayScrollbar } from './scrollbars';
import {
  FolderSetting,
  NumberSetting,
  SectionBody,
  SelectSetting,
  SettingText,
  ToggleSetting,
} from './settingControls';

type SectionId =
  | 'appearance'
  | 'editor'
  | 'preview'
  | 'notes'
  | 'citations'
  | 'keybindings'
  | 'preambles';

const SECTIONS: {
  id: SectionId;
  label: string;
  icon: Component<{ size?: number }>;
}[] = [
  { id: 'appearance', label: 'Appearance', icon: SunMoon },
  { id: 'editor', label: 'Editor', icon: SquarePen },
  { id: 'preview', label: 'Preview', icon: Eye },
  { id: 'notes', label: 'Notes', icon: FileText },
  { id: 'citations', label: 'Citations', icon: Quote },
  { id: 'keybindings', label: 'Keybindings', icon: Keyboard },
  { id: 'preambles', label: 'Templates', icon: FileCode },
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

export function SettingsDialog() {
  return (
    <Dialog.Root
      open={open()}
      onOpenChange={details => setOpen(details.open)}
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
                {item => (
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
                    'Restore every setting of this vault to its default? Templates and preambles are kept as they are; each has its own "Restore default" in the Templates section.',
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
                      onChange={theme => updateSettings({ theme })}
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
                      onChange={previewTheme =>
                        updateSettings({ previewTheme })
                      }
                    />
                    <ToggleSetting
                      name="Indent guides"
                      description="Draw a line in the sidebar along the contents of each open folder."
                      checked={settings.indentGuides}
                      onChange={indentGuides =>
                        updateSettings({ indentGuides })
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
                      onChange={vim => updateSettings({ vim })}
                    />
                    <ToggleSetting
                      name="Autosave"
                      description="Save notes while you type. When off, notes save on Mod+S and when their tab or the window closes."
                      checked={settings.autosave}
                      onChange={autosave => updateSettings({ autosave })}
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
                        onChange={autosaveDelay =>
                          updateSettings({ autosaveDelay })
                        }
                      />
                    </Show>
                    <ToggleSetting
                      name="Line numbers"
                      description="Show line numbers beside the text."
                      checked={settings.lineNumbers}
                      onChange={lineNumbers => updateSettings({ lineNumbers })}
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
                      onChange={linkDisplay => {
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
                      onChange={defaultViewMode =>
                        updateSettings({ defaultViewMode })
                      }
                    />
                    <ToggleSetting
                      name="Follow the cursor"
                      description="Scroll the preview to where the editor's cursor rests. Clicking the preview always jumps to the source."
                      checked={settings.previewFollowsCursor}
                      onChange={previewFollowsCursor =>
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
                      onChange={maxPreviewWidth =>
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
                      onChange={newNoteLocation =>
                        updateSettings({ newNoteLocation })
                      }
                    />
                    <Show when={settings.newNoteLocation === 'folder'}>
                      <FolderSetting
                        id="setting-new-note-folder"
                        name="Folder to create new notes in"
                        value={settings.newNoteFolder}
                        onChange={newNoteFolder =>
                          updateSettings({ newNoteFolder })
                        }
                      />
                    </Show>
                    <SelectSetting<Settings['attachmentLocation']>
                      id="setting-attachment-location"
                      name="Default location for new attachments"
                      description="Where files pasted or dropped into a note are saved."
                      value={settings.attachmentLocation}
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
                      onChange={attachmentLocation =>
                        updateSettings({ attachmentLocation })
                      }
                    />
                    <Show when={settings.attachmentLocation === 'folder'}>
                      <FolderSetting
                        id="setting-attachment-folder"
                        name="Folder for new attachments"
                        value={settings.attachmentFolder}
                        onChange={attachmentFolder =>
                          updateSettings({ attachmentFolder })
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
                      onChange={deleteMode => updateSettings({ deleteMode })}
                    />
                  </SectionBody>
                </Match>
                <Match when={section() === 'citations'}>
                  <SectionBody title="Citations">
                    <p class="setting-note">
                      Cite with <code>@citationKey</code>, keys from Zotero with
                      the Better BibTeX add-on. "Insert citation from Zotero"
                      (Mod+Shift+C) opens Zotero's picker. Entries are kept in{' '}
                      <code>.sliver/references.bib</code>, so previews work
                      while Zotero is closed.
                    </p>
                    <SelectSetting<string>
                      id="setting-citation-style"
                      name="Citation style"
                      description="How citations and reference lists are formatted. A kind's template can set its own, and a note its own with citation-style in its header. Custom CSL files go in .sliver/styles."
                      value={settings.citationStyle}
                      options={citationStyleChoices()}
                      onChange={citationStyle =>
                        updateSettings({ citationStyle })
                      }
                    />
                    <ToggleSetting
                      name="Reference list"
                      description="End each preview with the references the note cites."
                      checked={settings.showReferences}
                      onChange={showReferences =>
                        updateSettings({ showReferences })
                      }
                    />
                    <div class="setting">
                      <div class="setting-text">
                        <SettingText
                          name="Refresh references"
                          description="Fetch every cited entry from Zotero again, e.g. after editing items there. Also happens when the vault opens."
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => void refreshReferences()}
                      >
                        Refresh
                      </button>
                    </div>
                  </SectionBody>
                </Match>
                <Match when={section() === 'keybindings'}>
                  <KeybindingSettings />
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
