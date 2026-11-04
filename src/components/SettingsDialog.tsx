import { Dialog } from "@ark-ui/solid";
import { createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { type Settings, settings, updateSettings } from "../state/settings";
import { refreshLinks } from "../state/workspace";

const [open, setOpen] = createSignal(false);
export const openSettings = () => setOpen(true);

export function SettingsDialog() {
  const setLinkDisplay = (value: Settings["linkDisplay"]) => {
    updateSettings({ linkDisplay: value });
    void refreshLinks();
  };

  return (
    <Dialog.Root
      open={open()}
      onOpenChange={(details) => setOpen(details.open)}
      lazyMount
      unmountOnExit
    >
      <Portal>
        <Dialog.Backdrop class="dialog-backdrop" />
        <Dialog.Positioner class="dialog-positioner">
          <Dialog.Content class="dialog settings">
            <Dialog.Title class="dialog-title">Settings</Dialog.Title>

            <label class="field row">
              <input
                type="checkbox"
                checked={settings.vim}
                onChange={(e) =>
                  updateSettings({ vim: e.currentTarget.checked })
                }
              />
              <span>Vim key bindings in the editor</span>
            </label>

            <label class="field">
              <span>Wikilinks without custom text show</span>
              <select
                value={settings.linkDisplay}
                onChange={(e) =>
                  setLinkDisplay(
                    e.currentTarget.value as Settings["linkDisplay"],
                  )
                }
              >
                <option value="title">the note's title</option>
                <option value="address">the note's Zettelkasten address</option>
              </select>
            </label>

            <label class="field">
              <span>Deleting a note</span>
              <select
                value={settings.deleteMode}
                onChange={(e) =>
                  updateSettings({
                    deleteMode: e.currentTarget.value as Settings["deleteMode"],
                  })
                }
              >
                <option value="trash">moves it to the system trash</option>
                <option value="permanent">deletes it permanently</option>
              </select>
            </label>

            <div class="dialog-actions">
              <Dialog.CloseTrigger class="primary">Done</Dialog.CloseTrigger>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
