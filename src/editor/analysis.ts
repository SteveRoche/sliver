import {
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { recordAnalysis } from '../state/debug';
import { type Analysis, type LinkRange, vault } from '../vault/api';

/**
 * The note's syntax as `sliver-vault` sees it (`analyze`): highlighting and
 * wikilink ranges. Requests run off the editor (native, over IPC), at most
 * one at a time, always for the latest text; between results the previous
 * one is mapped through edits so nothing flickers.
 */
interface SyntaxState {
  highlights: DecorationSet;
  links: LinkRange[];
  /** Ranges of raw text, where `[[` doesn't start a link. */
  raw: { from: number; to: number }[];
}

const setAnalysis = StateEffect.define<{ text: string; analysis: Analysis }>();

export const syntaxField = StateField.define<SyntaxState>({
  create: () => ({ highlights: Decoration.none, links: [], raw: [] }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (
        effect.is(setAnalysis) &&
        effect.value.text === tr.state.doc.toString()
      ) {
        return fromAnalysis(effect.value.analysis);
      }
    }
    if (!tr.docChanged) return value;
    const map = (from: number, to: number) => ({
      from: tr.changes.mapPos(from, 1),
      to: tr.changes.mapPos(to, -1),
    });
    return {
      highlights: value.highlights.map(tr.changes),
      links: value.links
        .map(link => {
          const whole = map(link.from, link.to);
          const target = map(link.targetFrom, link.targetTo);
          return {
            ...link,
            from: whole.from,
            to: whole.to,
            targetFrom: target.from,
            targetTo: target.to,
          };
        })
        .filter(link => link.from < link.to),
      raw: value.raw.map(r => map(r.from, r.to)),
    };
  },
  provide: field => EditorView.decorations.from(field, s => s.highlights),
});

const marks = new Map<string, Decoration>();
const mark = (cls: string) => {
  let decoration = marks.get(cls);
  if (!decoration) {
    decoration = Decoration.mark({ class: cls });
    marks.set(cls, decoration);
  }
  return decoration;
};

function fromAnalysis(analysis: Analysis): SyntaxState {
  const ranges = [];
  const raw = [];
  const h = analysis.highlights;
  for (let i = 0; i + 2 < h.length; i += 3) {
    const cls = analysis.tagClasses[h[i + 2]];
    ranges.push(mark(cls).range(h[i], h[i + 1]));
    if (cls === 'typ-raw') raw.push({ from: h[i], to: h[i + 1] });
  }
  return {
    highlights: Decoration.set(ranges, true),
    links: analysis.links,
    raw,
  };
}

export const linksAt = (state: EditorState) => state.field(syntaxField).links;

export const inRaw = (state: EditorState, pos: number) =>
  state.field(syntaxField).raw.some(r => r.from < pos && pos < r.to);

const analyzer = ViewPlugin.fromClass(
  class {
    private running = false;
    private stale = true;
    private destroyed = false;

    constructor(private view: EditorView) {
      void this.run();
    }

    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      this.stale = true;
      void this.run();
    }

    destroy() {
      this.destroyed = true;
    }

    private async run() {
      if (this.running) return;
      this.running = true;
      try {
        while (this.stale && !this.destroyed) {
          this.stale = false;
          const text = this.view.state.doc.toString();
          const started = performance.now();
          const analysis = await vault.analyze(text);
          recordAnalysis(performance.now() - started);
          // A result for older text is dropped; the loop fetches the latest.
          if (!this.destroyed && text === this.view.state.doc.toString()) {
            this.view.dispatch({ effects: setAnalysis.of({ text, analysis }) });
          }
        }
      } catch (error) {
        console.warn('could not analyze the note:', error);
      } finally {
        this.running = false;
      }
    }
  },
);

export const syntax = (): Extension => [syntaxField, analyzer];
