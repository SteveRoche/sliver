import { ask } from '@tauri-apps/plugin-dialog';
import CloudOff from 'lucide-solid/icons/cloud-off';
import Copy from 'lucide-solid/icons/copy';
import RefreshCw from 'lucide-solid/icons/refresh-cw';
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import {
  describePeer,
  justPaired,
  refreshSyncStatus,
  setJustPaired,
  syncStatus,
} from '../state/sync';
import { sync } from '../vault/api';
import { openSettings } from './SettingsDialog';
import { SectionBody, SettingText } from './settingControls';

/**
 * The sidebar's sync status, while the vault syncs with other devices:
 * spinning during a round, red after a failure, a crossed-out cloud while
 * no device is reachable. Opens the Sync settings.
 */
export function SyncIndicator() {
  const peers = () =>
    syncStatus()?.running ? (syncStatus()?.peers ?? []) : [];
  const state = () => {
    const all = peers();
    if (all.some(p => p.state === 'syncing')) return 'syncing';
    if (all.some(p => p.state === 'error')) return 'error';
    if (all.length > 0 && all.every(p => p.state === 'offline'))
      return 'offline';
    return 'idle';
  };
  const title = () =>
    ['Sync', ...peers().map(p => `${p.name}: ${describePeer(p)}`)].join('\n');
  return (
    <Show when={peers().length > 0}>
      <button
        type="button"
        class="icon-button sync-indicator"
        classList={{
          syncing: state() === 'syncing',
          error: state() === 'error',
        }}
        title={title()}
        aria-label={title()}
        onClick={() => openSettings('sync')}
      >
        <Show when={state() === 'offline'} fallback={<RefreshCw size={16} />}>
          <CloudOff size={16} />
        </Show>
      </button>
    </Show>
  );
}

/** The settings' Sync section: this device, its paired devices, pairing. */
export function SyncSettings() {
  const [ticket, setTicket] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [name, setName] = createSignal(syncStatus()?.deviceName ?? '');

  createEffect(() => {
    const status = syncStatus();
    if (status && document.activeElement?.id !== 'sync-device-name')
      setName(status.deviceName);
  });
  // A pairing only lasts while it's on screen.
  onCleanup(() => {
    if (ticket()) void sync.pairCancel();
  });
  createEffect(() => {
    if (justPaired()) setTicket(null);
  });

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      void refreshSyncStatus();
    }
  };

  const pair = () =>
    run(async () => {
      setJustPaired(null);
      setCopied(false);
      setTicket(await sync.pairStart());
    });

  const cancelPairing = () => {
    setTicket(null);
    void sync.pairCancel();
  };

  const saveName = () => {
    const value = name().trim();
    if (value && value !== syncStatus()?.deviceName)
      void run(() => sync.setDeviceName(value));
  };

  const remove = async (id: string, peerName: string) => {
    const ok = await ask(
      `Stop syncing this vault with ${peerName}? Its notes stay on both devices. To sync again, pair it again.`,
      { title: 'Remove device', kind: 'warning', okLabel: 'Remove' },
    );
    if (ok) await run(() => sync.removeDevice(id));
  };

  return (
    <SectionBody title="Sync">
      <p class="setting-note">
        Keep this vault in sync with your other devices, directly between them:
        no server stores your notes, and connections are end-to-end encrypted.
        Devices find each other through public relays when they aren't on the
        same network; the relays only pass on encrypted traffic.
      </p>
      <div class="setting">
        <label class="setting-text" for="sync-device-name">
          <SettingText
            name="This device"
            description="The name your other devices show for it, and in the titles of conflict copies."
          />
        </label>
        <input
          id="sync-device-name"
          class="setting-input"
          value={name()}
          onInput={event => setName(event.currentTarget.value)}
          onBlur={saveName}
          onKeyDown={event => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      </div>
      <div class="setting">
        <div class="setting-text">
          <SettingText
            name="Pair a device"
            description='Shows a ticket to enter on the other device, under "Join a vault from another device…" on its welcome screen. It works once, for five minutes.'
          />
        </div>
        <Show
          when={ticket()}
          fallback={
            <button type="button" disabled={busy()} onClick={() => pair()}>
              Pair a device…
            </button>
          }
        >
          <button type="button" onClick={cancelPairing}>
            Cancel
          </button>
        </Show>
      </div>
      <Show when={ticket()}>
        {current => (
          <div class="sync-ticket">
            <textarea
              readOnly
              rows={4}
              value={current()}
              onFocus={event => event.currentTarget.select()}
            />
            <div class="sync-ticket-actions">
              <span class="setting-description">
                Waiting for the other device…
              </span>
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(current());
                  setCopied(true);
                }}
              >
                <Copy size={14} /> {copied() ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}
      </Show>
      <Show when={justPaired()}>
        <p class="setting-note sync-paired" role="status">
          Paired with {justPaired()}. The vault syncs to it now.
        </p>
      </Show>
      <Show when={(syncStatus()?.peers.length ?? 0) > 0}>
        <div class="setting">
          <div class="setting-text">
            <SettingText
              name="Paired devices"
              description="Changes sync a moment after they're saved, and every minute while both devices are online."
            />
          </div>
          <button
            type="button"
            disabled={busy()}
            onClick={() => run(() => sync.now())}
          >
            Sync now
          </button>
        </div>
        <ul class="sync-devices">
          <For each={syncStatus()?.peers ?? []}>
            {peer => (
              <li classList={{ [`sync-${peer.state}`]: true }}>
                <div class="setting-text">
                  <span class="setting-name">{peer.name}</span>
                  <span class="setting-description">{describePeer(peer)}</span>
                </div>
                <button
                  type="button"
                  onClick={() => void remove(peer.id, peer.name)}
                >
                  Remove
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={error()}>
        <p class="setting-note sync-error" role="alert">
          {error()}
        </p>
      </Show>
    </SectionBody>
  );
}
