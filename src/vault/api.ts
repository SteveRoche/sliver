import { invoke } from "@tauri-apps/api/core";

export type NoteId = string;

export interface NoteSummary {
  id: NoteId;
  title: string | null;
  /** As written in the header; may not be a valid address. */
  address: string | null;
  tags: string[];
  headerError: string | null;
}

export interface TreeNode extends NoteSummary {
  children: TreeNode[];
}

export type Placement =
  | { kind: "unaddressed" }
  | { kind: "top" }
  | { kind: "continuation"; of: NoteId }
  | { kind: "branch"; of: NoteId };

export type DeleteMode = "trash" | "permanent";

export const vault = {
  create: (path: string) => invoke<TreeNode[]>("create_vault", { path }),
  open: (path: string) => invoke<TreeNode[]>("open_vault", { path }),
  last: () => invoke<string | null>("last_vault"),
  tree: () => invoke<TreeNode[]>("list_tree"),
  createNote: (placement: Placement, title?: string) =>
    invoke<NoteSummary>("create_note", { placement, title }),
  readNote: (id: NoteId) => invoke<string>("read_note", { id }),
  writeNote: (id: NoteId, text: string) =>
    invoke<NoteSummary>("write_note", { id, text }),
  renameNote: (id: NoteId, title: string) =>
    invoke<NoteSummary>("rename_note", { id, title }),
  deleteNote: (id: NoteId, mode?: DeleteMode) =>
    invoke<void>("delete_note", { id, mode }),
};

/**
 * Saves `id` once typing pauses for `delayMs`. Writes never overlap, and
 * `flush()` saves anything pending immediately (call it on tab close/blur).
 */
export function autosave(
  id: NoteId,
  onSaved: (summary: NoteSummary) => void,
  onError: (error: unknown) => void,
  delayMs = 500,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | undefined;
  let saving: Promise<void> = Promise.resolve();

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const text = pending;
    if (text === undefined) return saving;
    pending = undefined;
    saving = saving
      .then(() => vault.writeNote(id, text))
      .then(onSaved, onError);
    return saving;
  };

  return {
    update(text: string) {
      pending = text;
      clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush,
  };
}
