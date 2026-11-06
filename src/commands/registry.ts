import { settings } from '../state/settings';

/**
 * Every user-facing action is a command: the palette lists them and
 * keybindings dispatch them. Keybindings use `Mod` for Cmd on macOS and Ctrl
 * elsewhere, e.g. `Mod+Shift+P`; each command has a default, which the
 * vault's settings can change (`settings.keybindings`).
 */
export interface Command {
  id: string;
  title: string;
  /** The default keybinding. */
  keybinding?: string;
  run: () => unknown;
  /** Hidden from the palette and ignored by keybindings when false. */
  enabled?: () => boolean;
  /**
   * Acts on the sidebar's right-clicked item, from its context menu only:
   * no keybinding, and not listed in the palette or keybinding settings.
   */
  contextMenu?: boolean;
}

const commands = new Map<string, Command>();

export const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

export function registerCommands(list: Command[]): () => void {
  for (const command of list) commands.set(command.id, command);
  return () => {
    for (const command of list) commands.delete(command.id);
  };
}

/** Commands that can have a keybinding, enabled or not. */
export const bindableCommands = (): Command[] =>
  [...commands.values()].filter(c => !c.contextMenu);

export function availableCommands(): Command[] {
  return bindableCommands().filter(c => c.enabled?.() ?? true);
}

export function runCommand(id: string) {
  const command = commands.get(id);
  if (command && (command.enabled?.() ?? true)) void command.run();
}

/** The keybinding `command` has: the vault's own, else its default. */
export function keybindingOf(command: Command): string | undefined {
  if (command.contextMenu) return undefined;
  const own = settings.keybindings[command.id];
  return own === undefined ? command.keybinding : own || undefined;
}

/** The keybinding of the command with id `id`, for hints. */
export function keybindingFor(id: string): string | undefined {
  const command = commands.get(id);
  return command && keybindingOf(command);
}

/** Keys whose `event.code` names them regardless of Shift (Shift+, is "<"). */
const CODE_KEYS: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

/** The key of a key press, unchanged by modifiers: `p`, `,`, `arrowright`. */
function eventKey(event: KeyboardEvent): string {
  const code = event.code;
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  return CODE_KEYS[code] ?? event.key.toLowerCase();
}

/**
 * The keybinding a key press is, e.g. `Mod+Shift+P`; null for a modifier
 * alone. Keys without a modifier only count for function keys.
 */
export function eventKeybinding(event: KeyboardEvent): string | null {
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) return null;
  const parts = [
    isMac && event.ctrlKey && 'Ctrl',
    (isMac ? event.metaKey : event.ctrlKey) && 'Mod',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
  ].filter((p): p is string => p !== false);
  if (parts.length === 0 && !/^F\d+$/.test(event.key)) return null;
  const key = eventKey(event);
  return [...parts, key.length === 1 ? key.toUpperCase() : event.key].join('+');
}

/** A keybinding in one spelling, to compare two: `Ctrl` on other platforms is `Mod`. */
export function normalizeKeybinding(keybinding: string): string {
  const parts = keybinding.split('+');
  const has = (name: string) => parts.includes(name);
  const ctrl = has('Ctrl') || (has('Mod') && !isMac);
  const meta = has('Mod') && isMac;
  return [
    ctrl && 'ctrl',
    meta && 'meta',
    has('Alt') && 'alt',
    has('Shift') && 'shift',
    parts[parts.length - 1].toLowerCase(),
  ]
    .filter(Boolean)
    .join('+');
}

const matches = (event: KeyboardEvent, keybinding: string) => {
  const pressed = eventKeybinding(event);
  return (
    pressed !== null &&
    normalizeKeybinding(pressed) === normalizeKeybinding(keybinding)
  );
};

/** The keys of a keybinding as the platform labels them: `["⌘", "⇧", "P"]`. */
export function keybindingKeys(keybinding: string): string[] {
  const names: Record<string, string> = isMac
    ? { Mod: '⌘', Ctrl: '⌃', Shift: '⇧', Alt: '⌥' }
    : { Mod: 'Ctrl', Alt: 'Alt' };
  return keybinding
    .split('+')
    .map(p => names[p] ?? (p.length === 1 ? p.toUpperCase() : p));
}

/** Ctrl+<key> chords Vim uses itself (scrolling, jumps, insert-mode editing). */
const VIM_CTRL_KEYS = new Set('abcdefinopqrtuvwxy['.split(''));

/** Whether Vim uses `keybinding` (Ctrl with a letter, nothing else). */
export function vimUses(keybinding: string): boolean {
  const [ctrl, key, ...rest] = normalizeKeybinding(keybinding).split('+');
  return ctrl === 'ctrl' && rest.length === 0 && VIM_CTRL_KEYS.has(key);
}

/**
 * Whether a key press goes to Vim instead of `command`: it's in a Vim
 * editor, Vim uses the keys, and the binding is a default (one set in the
 * settings was chosen over Vim's).
 */
const forVim = (event: KeyboardEvent, command: Command, keybinding: string) =>
  settings.vim &&
  settings.keybindings[command.id] === undefined &&
  vimUses(keybinding) &&
  (event.target as Element | null)?.closest?.('.cm-editor') != null;

/**
 * Whether a modal dialog (settings, the palette, a prompt) is open: app
 * keybindings then stay off, so they can't act on the panes behind it.
 */
const dialogOpen = () =>
  document.querySelector(
    '[data-scope="dialog"][data-part="content"][data-state="open"]',
  ) !== null;

/** Dispatches keybindings before the editor sees the key. */
export function installKeybindings(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (dialogOpen()) return;
    for (const command of commands.values()) {
      const keybinding = keybindingOf(command);
      if (!keybinding || !(command.enabled?.() ?? true)) continue;
      if (!matches(event, keybinding)) continue;
      if (forVim(event, command, keybinding)) return;
      event.preventDefault();
      event.stopPropagation();
      void command.run();
      return;
    }
  };
  window.addEventListener('keydown', onKeyDown, true);
  return () => window.removeEventListener('keydown', onKeyDown, true);
}
