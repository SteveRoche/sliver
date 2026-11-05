import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { settings } from "./settings";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/** Whether the app is dark right now: the vault's setting, else the system's. */
export const isDark = createRoot(() => {
  const [systemDark, setSystemDark] = createSignal(darkQuery.matches);
  darkQuery.addEventListener("change", (event) => setSystemDark(event.matches));
  return createMemo(
    () =>
      settings.theme === "dark" ||
      (settings.theme === "system" && systemDark()),
  );
});

/** Whether note previews are dark: the app's theme unless the vault fixes it. */
export const isPreviewDark = createRoot(() =>
  createMemo(() =>
    settings.previewTheme === "app"
      ? isDark()
      : settings.previewTheme === "dark",
  ),
);

/**
 * Applies the theme: `data-theme` on the root element for the CSS, and the
 * native window theme so the title bar matches. Call once.
 */
export function installTheme() {
  createRoot(() => {
    createEffect(() => {
      document.documentElement.dataset.theme = isDark() ? "dark" : "light";
    });
    createEffect(() => {
      const choice = settings.theme;
      void getCurrentWindow()
        .setTheme(choice === "system" ? null : choice)
        .catch((error) =>
          console.warn("could not set the window theme:", error),
        );
    });
  });
}
