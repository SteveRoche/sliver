/**
 * Every user-facing action is a command: the palette lists them and default
 * keybindings dispatch them. Keybindings use `Mod` for Cmd on macOS and Ctrl
 * elsewhere, e.g. `Mod+Shift+P`. User overrides come in M5.
 */
export interface Command {
  id: string;
  title: string;
  keybinding?: string;
  run: () => unknown;
  /** Hidden from the palette and ignored by keybindings when false. */
  enabled?: () => boolean;
}

const commands = new Map<string, Command>();

export const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

export function registerCommands(list: Command[]): () => void {
  for (const command of list) commands.set(command.id, command);
  return () => {
    for (const command of list) commands.delete(command.id);
  };
}

export function availableCommands(): Command[] {
  return [...commands.values()].filter((c) => c.enabled?.() ?? true);
}

export function runCommand(id: string) {
  const command = commands.get(id);
  if (command && (command.enabled?.() ?? true)) void command.run();
}

interface Chord {
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parse(keybinding: string): Chord {
  const parts = keybinding.split("+");
  const has = (name: string) => parts.includes(name);
  return {
    mod: has("Mod"),
    ctrl: has("Ctrl"),
    shift: has("Shift"),
    alt: has("Alt"),
    key: parts[parts.length - 1].toLowerCase(),
  };
}

function matches(event: KeyboardEvent, chord: Chord): boolean {
  const ctrl = chord.ctrl || (chord.mod && !isMac);
  const meta = chord.mod && isMac;
  // `event.code` keeps Shift/Alt from changing the key (Shift+, is "<").
  const key =
    event.code.startsWith("Key") || event.code.startsWith("Digit")
      ? event.code.slice(event.code.startsWith("Key") ? 3 : 5).toLowerCase()
      : event.code === "Comma"
        ? ","
        : event.key.toLowerCase();
  return (
    event.ctrlKey === ctrl &&
    event.metaKey === meta &&
    event.shiftKey === chord.shift &&
    event.altKey === chord.alt &&
    key === chord.key
  );
}

export function formatKeybinding(keybinding: string): string {
  const parts = keybinding.split("+");
  if (!isMac) return parts.map((p) => (p === "Mod" ? "Ctrl" : p)).join("+");
  const symbols: Record<string, string> = {
    Mod: "⌘",
    Ctrl: "⌃",
    Shift: "⇧",
    Alt: "⌥",
  };
  return parts.map((p) => symbols[p] ?? p.toUpperCase()).join("");
}

/** Dispatches keybindings before the editor sees the key. */
export function installKeybindings(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    for (const command of commands.values()) {
      if (!command.keybinding || !(command.enabled?.() ?? true)) continue;
      if (!matches(event, parse(command.keybinding))) continue;
      event.preventDefault();
      event.stopPropagation();
      void command.run();
      return;
    }
  };
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
