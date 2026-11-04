import { invoke } from "@tauri-apps/api/core";
import type { PackageHost } from "../typst/protocol";

/**
 * Caches packages in the open vault's `.sliver/pkg/`. Both commands move raw
 * bytes (no JSON) and are no-ops when no vault is open.
 */
export const vaultPackages: PackageHost = {
  async load(spec) {
    const bytes = await invoke<ArrayBuffer>("load_package", { spec });
    return bytes.byteLength > 0 ? bytes : null;
  },
  async save(spec, data) {
    await invoke("save_package", new Uint8Array(data), {
      headers: { "x-package-spec": spec },
    });
  },
};
