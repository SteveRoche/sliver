import { invoke } from '@tauri-apps/api/core';
import type { WorkerHost } from '../typst/protocol';

/**
 * Caches packages in the open vault's `.sliver/pkg/` and reads its files.
 * The commands move raw bytes (no JSON); without an open vault there are no
 * files and the package cache is a no-op.
 */
export const vaultHost: WorkerHost = {
  async load(spec) {
    const bytes = await invoke<ArrayBuffer>('load_package', { spec });
    return bytes.byteLength > 0 ? bytes : null;
  },
  async save(spec, data) {
    await invoke('save_package', new Uint8Array(data), {
      headers: { 'x-package-spec': spec },
    });
  },
  async loadFile(path) {
    try {
      return await invoke<ArrayBuffer>('read_file', { path });
    } catch {
      return null;
    }
  },
};
