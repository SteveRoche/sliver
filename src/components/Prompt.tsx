import { Dialog } from '@ark-ui/solid';
import { createSignal, Show } from 'solid-js';
import { Portal } from 'solid-js/web';

interface PromptRequest {
  title: string;
  label: string;
  initial: string;
  confirm: string;
  resolve: (value: string | null) => void;
}

const [request, setRequest] = createSignal<PromptRequest | null>(null);

/** Asks for one line of text; resolves to null when cancelled. */
export function prompt(options: {
  title: string;
  label: string;
  initial?: string;
  confirm?: string;
}): Promise<string | null> {
  request()?.resolve(null);
  return new Promise((resolve) =>
    setRequest({
      initial: '',
      confirm: 'OK',
      ...options,
      resolve,
    }),
  );
}

/** Mount once at the app root. */
export function PromptHost() {
  let input: HTMLInputElement | undefined;

  const finish = (value: string | null) => {
    request()?.resolve(value);
    setRequest(null);
  };

  return (
    <Dialog.Root
      open={request() !== null}
      onOpenChange={(details) => !details.open && finish(null)}
      initialFocusEl={() => input ?? null}
      lazyMount
      unmountOnExit
    >
      <Portal>
        <Dialog.Backdrop class="dialog-backdrop" />
        <Dialog.Positioner class="dialog-positioner">
          <Dialog.Content class="dialog">
            <Show when={request()}>
              {(req) => (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    finish(input?.value ?? '');
                  }}
                >
                  <Dialog.Title class="dialog-title">
                    {req().title}
                  </Dialog.Title>
                  <label class="field">
                    <span>{req().label}</span>
                    <input
                      ref={(el) => {
                        input = el;
                        queueMicrotask(() => el.select());
                      }}
                      value={req().initial}
                    />
                  </label>
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
