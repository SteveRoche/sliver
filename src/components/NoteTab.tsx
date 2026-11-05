import { createResource, Match, Switch } from "solid-js";
import { settings } from "../state/settings";
import { openNote, resolveTarget, sessionFor } from "../state/workspace";
import type { NoteId } from "../vault/api";
import { Editor } from "./Editor";
import { wikilinkClick } from "./wikilinks";

const linkClicks = wikilinkClick((target) => {
  const id = resolveTarget(target);
  if (id) openNote(id);
});

/**
 * The editor for one open tab. Inactive tabs stay mounted (hidden) so each
 * keeps its own cursor, selection and undo history.
 */
export function NoteTab(props: { id: NoteId; hidden: boolean }) {
  const session = sessionFor(props.id);
  const [text] = createResource(() => session?.text);

  return (
    <div class="note-tab" hidden={props.hidden}>
      <Switch>
        <Match when={text.error}>
          <p class="pane-message">Could not open note: {String(text.error)}</p>
        </Match>
        <Match when={text() !== undefined && session}>
          {(s) => (
            <Editor
              initialDoc={text() ?? ""}
              onChange={(next) => s().edit(next)}
              onView={(view) => s().attachView(view)}
              extensions={[linkClicks]}
              vim={settings.vim}
              lineNumbers={settings.lineNumbers}
            />
          )}
        </Match>
      </Switch>
    </div>
  );
}
