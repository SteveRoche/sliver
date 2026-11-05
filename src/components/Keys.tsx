import { For, Show } from 'solid-js';
import { isMac, keybindingKeys } from '../commands/registry';

/** A keybinding hint, one spaced-out key at a time. */
export function Keys(props: { keybinding: string }) {
  return (
    <kbd class="keys">
      <For each={keybindingKeys(props.keybinding)}>
        {(key, i) => (
          <>
            <Show when={!isMac && i() > 0}>
              <span class="key-separator">+</span>
            </Show>
            <span class="key">{key}</span>
          </>
        )}
      </For>
    </kbd>
  );
}
