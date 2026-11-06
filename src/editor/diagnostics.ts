import { type Extension, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
} from '@codemirror/view';
import { severityIconNode } from '../components/SeverityIcon';
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

/**
 * Sets warnings found in the syntax (not by compiling) for `text`, as
 * document offsets; kept apart from the compile's, which they don't replace.
 */
export const setLint = StateEffect.define<{
  text: string;
  warnings: { from: number; to: number; message: string }[];
}>();

interface SquiggleState {
  compile: Squiggle[];
  lint: Squiggle[];
  decorations: DecorationSet;
}

function withDecorations(compile: Squiggle[], lint: Squiggle[]): SquiggleState {
  return {
    compile,
    lint,
    decorations: Decoration.set(
      [...compile, ...lint].map(s =>
        Decoration.mark({
          class: `cm-squiggle cm-squiggle-${s.diagnostic.severity}`,
        }).range(s.from, s.to),
      ),
      true,
    ),
  };
}

const squiggleField = StateField.define<SquiggleState>({
  create: () => withDecorations([], []),
  update(value, tr) {
    const doc = tr.state.doc.toString();
    let { compile, lint } = value;
    let changed = false;
    if (tr.docChanged) {
      const map = (squiggles: Squiggle[]) =>
        squiggles
          .map(s => ({
            ...s,
            from: tr.changes.mapPos(s.from, 1),
            to: tr.changes.mapPos(s.to, -1),
          }))
          .filter(s => s.from < s.to);
      compile = map(compile);
      lint = map(lint);
      changed = true;
    }
    for (const effect of tr.effects) {
      if (effect.is(setDiagnostics) && effect.value.text === doc) {
        compile = toSquiggles(
          effect.value.text,
          effect.value.diagnostics,
          tr.state.doc,
        );
        changed = true;
      } else if (effect.is(setLint) && effect.value.text === doc) {
        lint = effect.value.warnings
          .filter(w => w.from < w.to)
          .map(w => ({
            from: w.from,
            to: w.to,
            diagnostic: { severity: 'warning', message: w.message, hints: [] },
          }));
        changed = true;
      }
    }
    return changed ? withDecorations(compile, lint) : value;
  },
  provide: field =>
    EditorView.decorations.from(field, value => value.decorations),
});

const tooltip = hoverTooltip((view, pos, side) => {
  const state = view.state.field(squiggleField);
  const found = [...state.compile, ...state.lint].filter(
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
        const body = document.createElement('div');
        const message = document.createElement('div');
        message.className = 'diagnostic-message';
        message.textContent = diagnostic.message;
        body.appendChild(message);
        for (const hint of diagnostic.hints) {
          const line = document.createElement('div');
          line.className = 'cm-diagnostic-hint';
          line.textContent = `hint: ${hint}`;
          body.appendChild(line);
        }
        item.append(severityIconNode(diagnostic.severity), body);
        dom.appendChild(item);
      }
      return { dom };
    },
  };
});

/** Wavy underlines (and hover messages) for compile errors and warnings. */
export const diagnostics = (): Extension => [squiggleField, tooltip];
