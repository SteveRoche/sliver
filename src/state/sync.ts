import { listen } from '@tauri-apps/api/event';
import { createSignal } from 'solid-js';
import { type SyncedFiles, type SyncStatus, sync } from '../vault/api';
import { loadCitations } from './citations';
import { loadSettings } from './settings';

const [status, setStatus] = createSignal<SyncStatus | null>(null);
/** The name of the device paired last, until the pairing dialog shows it. */
const [justPaired, setJustPaired] = createSignal<string | null>(null);

export const syncStatus = status;
export { justPaired, setJustPaired };

export const syncAvailable = () => status()?.available ?? false;

export async function refreshSyncStatus() {
  setStatus(await sync.status());
}

/**
 * Follows the backend's sync: its status, and what rounds change that the
 * vault's own `vault-changed` doesn't cover (settings, references, styles;
 * templates are read when a note is created, so they need nothing).
 */
export function installSync() {
  const unlisten = [
    listen<SyncStatus>('sync-status', event => setStatus(event.payload)),
    listen<SyncedFiles>('sync-applied', event => {
      const files = event.payload;
      if (files.settings) void loadSettings();
      if (files.references || files.styles) void loadCitations();
    }),
    listen<string>('sync-paired', event => setJustPaired(event.payload)),
  ];
  void refreshSyncStatus().catch(error =>
    console.warn('could not read the sync status:', error),
  );
  return () => {
    for (const off of unlisten) void off.then(f => f());
  };
}

/** A device's state in words, for tooltips and the device list. */
export function describePeer(peer: SyncStatus['peers'][number]): string {
  switch (peer.state) {
    case 'syncing':
      return 'Syncing…';
    case 'offline':
      return 'Not reachable';
    case 'error':
      return peer.error ? `Failed: ${peer.error}` : 'Failed';
    default:
      return peer.lastSync
        ? `Synced ${new Date(peer.lastSync).toLocaleString()}`
        : 'Not synced yet';
  }
}
