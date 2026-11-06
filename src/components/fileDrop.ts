import { EditorView } from '@codemirror/view';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { insertAttachments } from '../editor/attachments';
import {
  importAssets,
  importAttachments,
  noteById,
  noteOfView,
} from '../state/workspace';

/**
 * Files dropped from Finder (or Explorer): onto a note's editor they're
 * saved like pasted images (`attachmentLocation`) and referenced at the
 * drop point; onto the sidebar they're copied into the folder under the
 * pointer. Tauri delivers these drops natively (HTML5 drop events don't
 * carry the files), with physical-pixel positions.
 */
export function installFileDrop(): () => void {
  let marked: Element | null = null;
  const mark = (el: Element | null) => {
    if (el === marked) return;
    marked?.classList.remove('file-drop-target');
    el?.classList.add('file-drop-target');
    marked = el;
  };

  const targetAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y);
    const editor = el?.closest<HTMLElement>('.cm-editor');
    if (editor) return { kind: 'editor' as const, el: editor };
    const sidebar = el?.closest('.sidebar-tree');
    if (!sidebar || !el) return null;
    const row = el.closest<HTMLElement>(
      '[data-folder-path], [data-note-id], [data-asset-path]',
    );
    return {
      kind: 'folder' as const,
      el: row ?? sidebar,
      folder: folderOf(row),
    };
  };

  const unlisten = getCurrentWebview().onDragDropEvent(event => {
    const payload = event.payload;
    if (payload.type === 'leave') {
      mark(null);
      return;
    }
    const scale = window.devicePixelRatio || 1;
    const x = payload.position.x / scale;
    const y = payload.position.y / scale;
    const target = targetAt(x, y);
    if (payload.type === 'enter' || payload.type === 'over') {
      mark(target?.el ?? null);
      return;
    }
    mark(null);
    if (!target || payload.paths.length === 0) return;
    void (async () => {
      if (target.kind === 'folder') {
        await importAssets(target.folder, payload.paths);
        return;
      }
      const view = EditorView.findFromDOM(target.el);
      if (!view) return;
      const at = view.posAtCoords({ x, y }) ?? undefined;
      const paths = await importAttachments(noteOfView(view), payload.paths);
      insertAttachments(view, paths, at);
    })().catch(error => console.error('could not add the files:', error));
  });
  return () => {
    mark(null);
    void unlisten.then(f => f());
  };
}

/** The folder a sidebar row stands for: itself, or a note's or file's folder. */
function folderOf(row: HTMLElement | null): string {
  if (!row) return '';
  const { folderPath, noteId, assetPath } = row.dataset;
  if (folderPath !== undefined) return folderPath;
  if (noteId) return noteById(noteId)?.folder ?? '';
  if (assetPath) {
    return assetPath.includes('/')
      ? assetPath.slice(0, assetPath.lastIndexOf('/'))
      : '';
  }
  return '';
}
