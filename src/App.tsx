import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
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
    // Quit in the macOS menu waits for this (or gives up after a while).
    const unlistenQuit = listen('quit-requested', async () => {
      await flushAll().catch(error => console.error('could not save:', error));
      await invoke('quit');
    });
    onCleanup(() => void unlistenQuit.then(f => f()));

    try {
      const last = await vault.last();
      if (last) await openVault(last);
    } catch (error) {
      console.warn('could not reopen the last vault:', error);
    } finally {
      setStarting(false);
      document.getElementById('startup')?.remove();
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
