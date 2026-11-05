/**
 * Records on `<html data-input>` whether the user last used the pointer or
 * the keyboard, so CSS can show focus only to keyboard users. `:focus-visible`
 * can't: WebKit counts a dropdown as keyboard-focused after a click.
 */
export function installInputModality() {
  const root = document.documentElement;
  const set = (value: 'pointer' | 'keyboard') => {
    if (root.dataset.input !== value) root.dataset.input = value;
  };
  window.addEventListener('pointerdown', () => set('pointer'), true);
  window.addEventListener(
    'keydown',
    (event) => {
      if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
        set('keyboard');
      }
    },
    true,
  );
}
