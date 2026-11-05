import { getCurrentWindow } from '@tauri-apps/api/window';
import { createSignal, Match, onCleanup, onMount, Switch } from 'solid-js';
import './App.css';
import { registerAppCommands } from './commands/app';
import { installKeybindings } from './commands/registry';
import { Palette } from './components/Palette';
import { PromptHost } from './components/Prompt';
import { SettingsDialog } from './components/SettingsDialog';
import { Welcome } from './components/Welcome';
import { Workspace } from './components/Workspace';
import { flushAll, openVault, vaultRoot } from './state/workspace';
import { vault } from './vault/api';

function App() {
  const [starting, setStarting] = createSignal(true);

  onMount(async () => {
    onCleanup(registerAppCommands());
    onCleanup(installKeybindings());
    // Unsaved edits are written before the window goes away.
    const unlisten = getCurrentWindow().onCloseRequested(() => flushAll());
    onCleanup(() => void unlisten.then(f => f()));

    try {
      const last = await vault.last();
      if (last) await openVault(last);
    } catch (error) {
      console.warn('could not reopen the last vault:', error);
    } finally {
      setStarting(false);
    }
  });

  return (
    <>
      <Switch>
        <Match when={starting()}>
          <main class="welcome" />
        </Match>
        <Match when={vaultRoot()}>
          <Workspace />
        </Match>
        <Match when={!vaultRoot()}>
          <Welcome />
        </Match>
      </Switch>
      <Palette />
      <PromptHost />
      <SettingsDialog />
    </>
  );
}

export default App;
