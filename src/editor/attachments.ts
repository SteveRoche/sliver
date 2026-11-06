import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** Images Typst's `image` can show (it reads PDFs too). */
const isTypstImage = (path: string) =>
  /\.(png|jpe?g|gif|svg|webp|pdf)$/i.test(path);

/**
 * What goes into a note for a file saved into the vault: images as
 * `#image(...)`, anything else as a path string to wrap in `csv(...)`,
 * `read(...)` and the like. Paths start at the vault root, so moving the
 * note breaks nothing, and moving the file rewrites them.
 */
export function attachmentText(path: string): string {
  const literal = JSON.stringify(`/${path}`);
  return isTypstImage(path) ? `#image(${literal})` : `#${literal}`;
}

/** Inserts references to `paths` at `at`, or in place of the selection. */
export function insertAttachments(
  view: EditorView,
  paths: string[],
  at?: number,
) {
  if (paths.length === 0) return;
  const text = paths.map(attachmentText).join('\n');
  if (at === undefined) {
    view.dispatch(view.state.replaceSelection(text));
  } else {
    view.dispatch({
      changes: { from: at, insert: text },
      selection: { anchor: at + text.length },
    });
  }
  view.focus();
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/**
 * Pasting an image (a screenshot, an image copied in a browser) saves it
 * into the vault with `save` and inserts a reference to it. Other pastes
 * are CodeMirror's.
 */
export function pasteImages(
  save: (name: string, data: ArrayBuffer) => Promise<string>,
): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const images = [...(event.clipboardData?.files ?? [])].filter(
        file => file.type in EXTENSIONS,
      );
      if (images.length === 0) return false;
      event.preventDefault();
      void (async () => {
        const paths: string[] = [];
        for (const image of images) {
          const name = `Pasted image ${timestamp()}.${EXTENSIONS[image.type]}`;
          paths.push(await save(name, await image.arrayBuffer()));
        }
        insertAttachments(view, paths);
      })().catch(error => console.error('could not paste the image:', error));
      return true;
    },
  });
}

/** `20261106153012`, like Obsidian's pasted image names. */
function timestamp(date = new Date()) {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}
