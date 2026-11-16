import FolderOpen from 'lucide-solid/icons/folder-open';
import FolderPlus from 'lucide-solid/icons/folder-plus';
import MonitorSmartphone from 'lucide-solid/icons/monitor-smartphone';
import { createSignal, Show } from 'solid-js';
import { chooseAndOpenVault, joinVaultFromDevice } from '../commands/app';
import { syncAvailable } from '../state/sync';

/** Shown when no vault is open (first launch, or the last one is gone). */
export function Welcome() {
  const [error, setError] = createSignal<string | null>(null);

  const [joining, setJoining] = createSignal(false);

  const choose = async (create: boolean) => {
    setError(null);
    try {
      await chooseAndOpenVault(create);
    } catch (e) {
      setError(String(e));
    }
  };

  const join = async () => {
    setError(null);
    setJoining(true);
    try {
      await joinVaultFromDevice();
    } catch (e) {
      setError(String(e));
    } finally {
      setJoining(false);
    }
  };

  return (
    <main class="welcome">
      <h1>Sliver</h1>
      <p>A vault is a folder that holds your notes.</p>
      <div class="welcome-actions">
        <button type="button" class="primary" onClick={() => choose(true)}>
          <FolderPlus size={16} /> Create a new vault...
        </button>
        <button type="button" onClick={() => choose(false)}>
          <FolderOpen size={16} /> Open an existing vault...
        </button>
        <Show when={syncAvailable()}>
          <button type="button" disabled={joining()} onClick={() => join()}>
            <MonitorSmartphone size={16} /> Join a vault from another device…
          </button>
        </Show>
      </div>
      <Show when={error()}>
        <p class="welcome-error" role="alert">
          {error()}
        </p>
      </Show>
    </main>
  );
}
