import { type Extension, StateEffect, StateField } from '@codemirror/state';
import {
  type EditorView,
  showTooltip,
  type Tooltip,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import type { Position, Signature } from '../typst/protocol';

/** How long the cursor must rest before signature help is fetched. */
const DELAY_MS = 120;

const setSignature = StateEffect.define<{
  pos: number;
  signature: Signature;
} | null>();

/** Renders inline `code` in docs as <code>; everything else is plain text. */
export function appendDocs(parent: HTMLElement, docs: string) {
  const text = docs.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  for (const [i, part] of text.split('`').entries()) {
    if (i % 2 === 1) {
      const code = document.createElement('code');
      code.textContent = part;
      parent.appendChild(code);
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  }
}

function render(signature: Signature): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'cm-signature';

  const head = document.createElement('div');
  head.className = 'cm-signature-head';
  head.append(`${signature.name}(`);
  signature.params.forEach((param, i) => {
    if (i > 0) head.append(', ');
    const span = document.createElement('span');
    span.className = 'cm-signature-param';
    if (i === signature.active) span.classList.add('active');
    if (!param.required) span.classList.add('optional');
    span.textContent = `${param.variadic ? '..' : ''}${param.name}${
      param.types ? `: ${param.types}` : ''
    }`;
    head.appendChild(span);
  });
  head.append(')');
  dom.appendChild(head);

  const active =
    signature.active === undefined
      ? undefined
      : signature.params[signature.active];
  const docs = active?.docs ?? signature.docs;
  if (active?.default) {
    const line = document.createElement('div');
    line.className = 'cm-signature-default';
    line.textContent = `default: ${active.default}`;
    dom.appendChild(line);
  }
  if (docs) {
    const body = document.createElement('div');
    body.className = 'cm-signature-docs';
    appendDocs(body, docs);
    dom.appendChild(body);
  }
  return dom;
}

const signatureField = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSignature)) {
        const found = effect.value;
        return (
          found && {
            pos: found.pos,
            above: true,
            create: () => ({ dom: render(found.signature) }),
          }
        );
      }
    }
    if (!value || !tr.docChanged) return value;
    return { ...value, pos: tr.changes.mapPos(value.pos) };
  },
  provide: field => showTooltip.from(field),
});

/**
 * Signature help: while the cursor is inside a function call's parentheses,
 * a tooltip shows the function's parameters with their types, highlights
 * the one being written, and gives its documentation (or the function's).
 */
export function signatureHelp(
  fetch: (text: string, position: Position) => Promise<Signature | null>,
): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | undefined;
      private request = 0;

      constructor(private view: EditorView) {}

      update(update: ViewUpdate) {
        if (
          !update.docChanged &&
          !update.selectionSet &&
          !update.focusChanged
        ) {
          return;
        }
        clearTimeout(this.timer);
        const request = ++this.request;
        if (!update.view.hasFocus || !update.state.selection.main.empty) {
          this.clear();
          return;
        }
        this.timer = setTimeout(() => void this.fetch(request), DELAY_MS);
      }

      private async fetch(request: number) {
        const state = this.view.state;
        const pos = state.selection.main.head;
        const line = state.doc.lineAt(pos);
        const signature = await fetch(state.doc.toString(), {
          line: line.number - 1,
          column: pos - line.from,
        }).catch(() => null);
        // A newer move or edit has its own request coming.
        if (request !== this.request) return;
        this.view.dispatch({
          effects: setSignature.of(signature && { pos, signature }),
        });
      }

      private clear() {
        if (this.view.state.field(signatureField)) {
          queueMicrotask(() =>
            this.view.dispatch({ effects: setSignature.of(null) }),
          );
        }
      }

      destroy() {
        clearTimeout(this.timer);
        this.request++;
      }
    },
  );
  return [signatureField, plugin];
}
