import { type Extension, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
} from '@codemirror/view';
import type { Diagnostic } from '../typst/protocol';

interface Squiggle {
  from: number;
  to: number;
  diagnostic: Diagnostic;
}

/**
 * Sets the diagnostics of a compile of `text`. They're applied only if
 * `text` is still the document; otherwise the old squiggles keep following
 * the edits until a compile of the current text arrives.
 */
export const setDiagnostics = StateEffect.define<{
  text: string;
  diagnostics: Diagnostic[];
}>();

function toSquiggles(
  text: string,
  diagnostics: Diagnostic[],
  doc: { lines: number; line(n: number): { from: number; to: number } },
): Squiggle[] {
  const offset = (line: number, column: number) => {
    if (line >= doc.lines) return text.length;
    const l = doc.line(line + 1);
    return Math.min(l.from + column, l.to);
  };
  return diagnostics.flatMap(diagnostic => {
    if (!diagnostic.range) return [];
    const { start, end } = diagnostic.range;
    const from = offset(start.line, start.column);
    let to = offset(end.line, end.column);
    // Zero-width errors (e.g. "expected expression") still get a mark.
    if (to <= from) to = Math.min(from + 1, text.length);
    return to > from ? [{ from, to, diagnostic }] : [];
  });
}

const squiggleField = StateField.define<{
  squiggles: Squiggle[];
  decorations: DecorationSet;
}>({
  create: () => ({ squiggles: [], decorations: Decoration.none }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (
        effect.is(setDiagnostics) &&
        effect.value.text === tr.state.doc.toString()
      ) {
        const squiggles = toSquiggles(
          effect.value.text,
          effect.value.diagnostics,
          tr.state.doc,
        );
        return {
          squiggles,
          decorations: Decoration.set(
            squiggles.map(s =>
              Decoration.mark({
                class: `cm-squiggle cm-squiggle-${s.diagnostic.severity}`,
              }).range(s.from, s.to),
            ),
            true,
          ),
        };
      }
    }
    if (!tr.docChanged) return value;
    return {
      squiggles: value.squiggles
        .map(s => ({
          ...s,
          from: tr.changes.mapPos(s.from, 1),
          to: tr.changes.mapPos(s.to, -1),
        }))
        .filter(s => s.from < s.to),
      decorations: value.decorations.map(tr.changes),
    };
  },
  provide: field =>
    EditorView.decorations.from(field, value => value.decorations),
});

const tooltip = hoverTooltip((view, pos, side) => {
  const found = view.state
    .field(squiggleField)
    .squiggles.filter(
      s =>
        (s.from < pos || (s.from === pos && side > 0)) &&
        (pos < s.to || (pos === s.to && side < 0)),
    );
  if (found.length === 0) return null;
  return {
    pos: Math.min(...found.map(s => s.from)),
    end: Math.max(...found.map(s => s.to)),
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-diagnostic-tooltip';
      for (const { diagnostic } of found) {
        const item = document.createElement('div');
        item.className = `cm-diagnostic ${diagnostic.severity}`;
        item.textContent = diagnostic.message;
        for (const hint of diagnostic.hints) {
          const line = document.createElement('div');
          line.className = 'cm-diagnostic-hint';
          line.textContent = `hint: ${hint}`;
          item.appendChild(line);
        }
        dom.appendChild(item);
      }
      return { dom };
    },
  };
});

/** Wavy underlines (and hover messages) for compile errors and warnings. */
export const diagnostics = (): Extension => [squiggleField, tooltip];
