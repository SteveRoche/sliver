import { Combobox, createListCollection, Switch } from '@ark-ui/solid';
import { createMemo, createSignal, For, type JSX, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { allFolders } from '../state/workspace';
import { fuzzyScore } from './Palette';
import { withOverlayScrollbar } from './scrollbars';

/** The rows of the settings view: a label and description beside a control. */

export function SettingText(props: { name: string; description?: string }) {
  return (
    <>
      <span class="setting-name">{props.name}</span>
      {props.description && (
        <span class="setting-description">{props.description}</span>
      )}
    </>
  );
}

export function ToggleSetting(props: {
  name: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Switch.Root
      class="setting"
      checked={props.checked}
      onCheckedChange={details => props.onChange(details.checked)}
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

export function SelectSetting<T extends string>(props: {
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
        onChange={e => props.onChange(e.currentTarget.value as T)}
      >
        <For each={props.options}>
          {option => <option value={option.value}>{option.label}</option>}
        </For>
      </select>
    </div>
  );
}

export function NumberSetting(props: {
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
          onChange={e => {
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
export function FolderSetting(props: {
  id: string;
  name: string;
  description?: string;
  value: string;
  onChange: (path: string) => void;
}) {
  const [query, setQuery] = createSignal('');
  const collection = createMemo(() => {
    const folders = allFolders().map(f => ({
      label: f.path,
      value: f.path,
      zettelkasten: f.kind === 'zettelkasten',
    }));
    const q = query().trim();
    const items = q
      ? folders
          .map(f => ({ f, score: fuzzyScore(q, f.label) }))
          .filter(e => e.score !== null)
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
          .map(e => e.f)
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
        placeholder="Search folders…"
        openOnClick
        inputBehavior="autohighlight"
        onOpenChange={details => {
          if (details.open) setQuery('');
        }}
        onInputValueChange={details => {
          if (details.reason === 'input-change') setQuery(details.inputValue);
        }}
        onValueChange={details => {
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
                {item => (
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

export function SectionBody(props: { title: string; children: JSX.Element }) {
  return (
    <section class="settings-section">
      <h3 class="settings-section-title">{props.title}</h3>
      {props.children}
    </section>
  );
}
