import { Dialog } from '@ark-ui/solid';
import Search from 'lucide-solid/icons/search';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { availableCommands, keybindingOf } from '../commands/registry';
import { allNotes, noteLabel, openNote } from '../state/workspace';
import { Keys } from './Keys';
import { withOverlayScrollbar } from './scrollbars';

export type PaletteMode = 'commands' | 'notes';

interface Item {
  key: string;
  label: string;
  detail?: string;
  keybinding?: string;
  run: () => unknown;
}

interface Request {
  placeholder: string;
  items: () => Item[];
  /** Called when the palette closes without a choice. */
  cancel?: () => void;
}

const [request, setRequest] = createSignal<Request | null>(null);

export function openPalette(mode: PaletteMode) {
  request()?.cancel?.();
  setRequest({
    placeholder: mode === 'notes' ? 'Go to note...' : 'Run a command...',
    items: () => itemsFor(mode),
  });
}

export interface Choice<T> {
  label: string;
  detail?: string;
  value: T;
}

/** Lets the user pick one of `choices`; resolves to null when cancelled. */
export function pick<T>(
  placeholder: string,
  choices: Choice<T>[],
): Promise<{ value: T } | null> {
  request()?.cancel?.();
  return new Promise(resolve =>
    setRequest({
      placeholder,
      items: () =>
        choices.map((choice, i) => ({
          key: String(i),
          label: choice.label,
          detail: choice.detail,
          run: () => resolve({ value: choice.value }),
        })),
      cancel: () => resolve(null),
    }),
  );
}

/**
 * Subsequence match with bonuses for consecutive characters and word starts;
 * null when `query` doesn't match. Higher is better.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of q) {
    if (char === ' ') continue;
    const at = t.indexOf(char, from);
    if (at < 0) return null;
    score += 1;
    if (at === previous + 1) score += 3;
    if (at === 0 || /[\s.\-_/]/.test(t[at - 1])) score += 2;
    previous = at;
    from = at + 1;
  }
  return score - t.length * 0.01;
}

function itemsFor(m: PaletteMode): Item[] {
  if (m === 'notes') {
    return allNotes().map(note => ({
      key: note.id,
      label: noteLabel(note),
      run: () => openNote(note.id),
    }));
  }
  return availableCommands()
    .filter(c => !c.id.startsWith('palette.'))
    .map(command => ({
      key: command.id,
      label: command.title,
      keybinding: keybindingOf(command),
      run: command.run,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function Palette() {
  const [query, setQuery] = createSignal('');
  const [highlighted, setHighlighted] = createSignal(0);
  let input: HTMLInputElement | undefined;
  let list: HTMLDivElement | undefined;
  /**
   * Where the pointer last was. Scrolling the list under a still pointer
   * fires `pointermove` too (WebKit), which would steal the highlight from
   * the keyboard; only a real move should highlight the row under it.
   */
  let pointer = { x: -1, y: -1 };
  const hover = (event: PointerEvent, index: number) => {
    if (event.clientX === pointer.x && event.clientY === pointer.y) return;
    pointer = { x: event.clientX, y: event.clientY };
    setHighlighted(index);
  };

  const items = createMemo(() => {
    const req = request();
    if (!req) return [];
    const all = req.items();
    const q = query().trim();
    if (!q) return all;
    return all
      .map(item => ({ item, score: fuzzyScore(q, item.label) }))
      .filter(
        (entry): entry is { item: Item; score: number } => entry.score !== null,
      )
      .sort((a, b) => b.score - a.score)
      .map(entry => entry.item);
  });

  const close = () => {
    request()?.cancel?.();
    setRequest(null);
    setQuery('');
    setHighlighted(0);
  };

  const choose = (item: Item | undefined) => {
    if (!item) return;
    setRequest(null);
    close();
    // Let the dialog restore focus before the command moves it elsewhere.
    queueMicrotask(() => void item.run());
  };

  const move = (delta: number) => {
    const count = items().length;
    if (count === 0) return;
    const next = (highlighted() + delta + count) % count;
    setHighlighted(next);
    list?.children[next]?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) {
      event.preventDefault();
      move(1);
    } else if (
      event.key === 'ArrowUp' ||
      (event.ctrlKey && event.key === 'p')
    ) {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(items()[highlighted()]);
    }
  };

  return (
    <Dialog.Root
      open={request() !== null}
      onOpenChange={details => !details.open && close()}
      initialFocusEl={() => input ?? null}
      lazyMount
      unmountOnExit
    >
      <Portal>
        <Dialog.Backdrop class="dialog-backdrop" />
        <Dialog.Positioner class="dialog-positioner top">
          <Dialog.Content class="dialog palette" aria-label="Command palette">
            <div class="palette-search">
              <Search size={16} aria-hidden="true" />
              <input
                ref={input}
                class="palette-input"
                role="combobox"
                aria-expanded="true"
                aria-controls="palette-list"
                aria-activedescendant={`palette-item-${highlighted()}`}
                placeholder={request()?.placeholder}
                value={query()}
                onInput={e => {
                  setQuery(e.currentTarget.value);
                  setHighlighted(0);
                }}
                onKeyDown={onKeyDown}
              />
            </div>
            <div
              ref={el => {
                list = el;
                withOverlayScrollbar(el);
              }}
              id="palette-list"
              class="palette-list"
              role="listbox"
            >
              <For each={items()}>
                {(item, i) => (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled on the combobox input (aria-activedescendant).
                  <div
                    id={`palette-item-${i()}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={i() === highlighted()}
                    class="palette-item"
                    onPointerMove={e => hover(e, i())}
                    onClick={() => choose(item)}
                  >
                    <span>{item.label}</span>
                    <Show when={item.keybinding}>
                      {keybinding => <Keys keybinding={keybinding()} />}
                    </Show>
                    <Show when={item.detail}>
                      <span class="palette-detail">{item.detail}</span>
                    </Show>
                  </div>
                )}
              </For>
              <Show when={items().length === 0}>
                <div class="palette-empty">No matches</div>
              </Show>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
