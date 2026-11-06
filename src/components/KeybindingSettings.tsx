import RotateCcw from 'lucide-solid/icons/rotate-ccw';
import X from 'lucide-solid/icons/x';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from 'solid-js';
import {
  bindableCommands,
  type Command,
  eventKeybinding,
  keybindingOf,
  normalizeKeybinding,
  vimUses,
} from '../commands/registry';
import { setKeybinding, settings } from '../state/settings';
import { Keys } from './Keys';
import { SectionBody } from './settingControls';

/**
 * Every command with its keybinding: click one and press keys to change it.
 * Notes what else uses the same keys, including Vim in the editor.
 */
export function KeybindingSettings() {
  const [filter, setFilter] = createSignal('');
  /** The command whose new keys are being pressed. */
  const [recording, setRecording] = createSignal<Command | null>(null);

  const commands = createMemo(() =>
    bindableCommands().sort((a, b) => a.title.localeCompare(b.title)),
  );
  const shown = () => {
    const words = filter().toLowerCase().split(/\s+/).filter(Boolean);
    return commands().filter(c =>
      words.every(w => c.title.toLowerCase().includes(w)),
    );
  };
  /** Commands by the keys they're bound to. */
  const byKeys = createMemo(() => {
    const map = new Map<string, Command[]>();
    for (const command of commands()) {
      const keybinding = keybindingOf(command);
      if (!keybinding) continue;
      const keys = normalizeKeybinding(keybinding);
      map.set(keys, [...(map.get(keys) ?? []), command]);
    }
    return map;
  });

  const notes = (command: Command, keybinding: string) => {
    const others = (byKeys().get(normalizeKeybinding(keybinding)) ?? [])
      .filter(c => c !== command)
      .map(c => c.title);
    return [
      others.length > 0 && `Also bound to ${others.join(', ')}.`,
      settings.vim &&
        vimUses(keybinding) &&
        (settings.keybindings[command.id] === undefined
          ? 'Vim uses these keys in the editor, so there they go to Vim.'
          : 'Vim uses these keys too; in the editor this takes them.'),
    ].filter(Boolean);
  };

  createEffect(() => {
    const command = recording();
    if (!command) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') return setRecording(null);
      const keybinding = eventKeybinding(event);
      if (!keybinding) return;
      setKeybinding(
        command.id,
        keybinding === command.keybinding ? null : keybinding,
      );
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => window.removeEventListener('keydown', onKey, true));
  });

  return (
    <SectionBody title="Keybindings">
      <input
        class="setting-select setting-filter"
        type="search"
        placeholder="Filter commands"
        value={filter()}
        onInput={e => setFilter(e.currentTarget.value)}
      />
      <For each={shown()}>
        {command => {
          const keybinding = () => keybindingOf(command);
          const changed = () => settings.keybindings[command.id] !== undefined;
          return (
            <div class="setting">
              <div class="setting-text">
                <span class="setting-name">{command.title}</span>
                <Show when={keybinding()}>
                  {keys => (
                    <For each={notes(command, keys())}>
                      {note => <span class="setting-description">{note}</span>}
                    </For>
                  )}
                </Show>
              </div>
              <div class="keybinding-controls">
                <Show when={changed()}>
                  <button
                    type="button"
                    class="icon-button"
                    title="Use the default"
                    aria-label="Use the default keybinding"
                    onClick={() => setKeybinding(command.id, null)}
                  >
                    <RotateCcw size={14} />
                  </button>
                </Show>
                <Show when={keybinding()}>
                  <button
                    type="button"
                    class="icon-button"
                    title="Remove"
                    aria-label="Remove the keybinding"
                    onClick={() =>
                      setKeybinding(command.id, command.keybinding ? '' : null)
                    }
                  >
                    <X size={14} />
                  </button>
                </Show>
                <button
                  type="button"
                  class="keybinding-button"
                  classList={{ recording: recording() === command }}
                  onClick={() => setRecording(command)}
                >
                  <Show when={recording() !== command} fallback="Press keys...">
                    <Show when={keybinding()} fallback="None">
                      {keys => <Keys keybinding={keys()} />}
                    </Show>
                  </Show>
                </button>
              </div>
            </div>
          );
        }}
      </For>
    </SectionBody>
  );
}
