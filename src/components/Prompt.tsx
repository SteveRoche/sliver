import { Dialog } from '@ark-ui/solid';
import { createSignal, For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';

/** A dropdown shown after the text field. */
export interface PromptChoice {
  label: string;
  options: { label: string; value: string }[];
  initial: string;
}

interface PromptRequest {
  title: string;
  label: string;
  initial: string;
  confirm: string;
  choice?: PromptChoice;
  resolve: (value: { text: string; choice: string } | null) => void;
}

const [request, setRequest] = createSignal<PromptRequest | null>(null);

/** Asks for one line of text and a choice; resolves to null when cancelled. */
export function promptWithChoice(options: {
  title: string;
  label: string;
  initial?: string;
  confirm?: string;
  choice: PromptChoice;
}): Promise<{ text: string; choice: string } | null> {
  request()?.resolve(null);
  return new Promise(resolve =>
    setRequest({
      initial: '',
      confirm: 'OK',
      ...options,
      resolve,
    }),
  );
}

/** Asks for one line of text; resolves to null when cancelled. */
export async function prompt(options: {
  title: string;
  label: string;
  initial?: string;
  confirm?: string;
}): Promise<string | null> {
  request()?.resolve(null);
  const result = await new Promise<{ text: string } | null>(resolve =>
    setRequest({ initial: '', confirm: 'OK', ...options, resolve }),
  );
  return result?.text ?? null;
}

/** Mount once at the app root. */
export function PromptHost() {
  let input: HTMLInputElement | undefined;
  let select: HTMLSelectElement | undefined;

  const finish = (value: { text: string; choice: string } | null) => {
    request()?.resolve(value);
    setRequest(null);
  };

  return (
    <Dialog.Root
      open={request() !== null}
      onOpenChange={details => !details.open && finish(null)}
      initialFocusEl={() => input ?? null}
      lazyMount
      unmountOnExit
    >
      <Portal>
        <Dialog.Backdrop class="dialog-backdrop" />
        <Dialog.Positioner class="dialog-positioner">
          <Dialog.Content class="dialog">
            <Show when={request()}>
              {req => (
                <form
                  onSubmit={event => {
                    event.preventDefault();
                    finish({
                      text: input?.value ?? '',
                      choice: select?.value ?? '',
                    });
                  }}
                >
                  <Dialog.Title class="dialog-title">
                    {req().title}
                  </Dialog.Title>
                  <label class="field">
                    <span>{req().label}</span>
                    <input
                      ref={el => {
                        input = el;
                        queueMicrotask(() => el.select());
                      }}
                      value={req().initial}
                    />
                  </label>
                  <Show when={req().choice}>
                    {choice => (
                      <label class="field field-inline">
                        <span>{choice().label}</span>
                        <select
                          ref={el => {
                            select = el;
                          }}
                          class="setting-select"
                        >
                          <For each={choice().options}>
                            {option => (
                              <option
                                value={option.value}
                                selected={option.value === choice().initial}
                              >
                                {option.label}
                              </option>
                            )}
                          </For>
                        </select>
                      </label>
                    )}
                  </Show>
                  <div class="dialog-actions">
                    <button type="button" onClick={() => finish(null)}>
                      Cancel
                    </button>
                    <button type="submit" class="primary">
                      {req().confirm}
                    </button>
                  </div>
                </form>
              )}
            </Show>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
