import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createSignal, Match, onCleanup, onMount, Switch } from 'solid-js';
import './App.css';
import { registerAppCommands } from './commands/app';
import { installKeybindings } from './commands/registry';
import { installFileDrop } from './components/fileDrop';
import { Palette } from './components/Palette';
import { PromptHost } from './components/Prompt';
import { SettingsDialog } from './components/SettingsDialog';
import { Welcome } from './components/Welcome';
import { Workspace } from './components/Workspace';
import { installSync } from './state/sync';
import {
  applyDiskChanges,
  firstPreviews,
  flushAll,
  openVault,
  vaultRoot,
} from './state/workspace';
import { type DiskChanges, vault } from './vault/api';

/** Longest the app stays hidden waiting for its first previews. */
const FIRST_PREVIEWS_MS = 3000;

/** Resolves after the next frame has been painted. */
const nextPaint = () =>
  new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

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
    // Changes made outside the app, from the backend's file watcher.
    const unlistenChanges = listen<DiskChanges>('vault-changed', event => {
      void applyDiskChanges(event.payload).catch(error =>
        console.error('could not apply changes from disk:', error),
      );
    });
    onCleanup(() => void unlistenChanges.then(f => f()));
    onCleanup(installFileDrop());
    onCleanup(installSync());

    try {
      const last = await vault.last();
      if (last) await openVault(last);
    } catch (error) {
      console.warn('could not reopen the last vault:', error);
    } finally {
      // The app mounts hidden and fades in once the previews on screen have
      // their first pages, so it doesn't appear in pieces.
      setStarting(false);
      await firstPreviews(FIRST_PREVIEWS_MS);
      await nextPaint();
      document.documentElement.classList.add('app-ready');
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
