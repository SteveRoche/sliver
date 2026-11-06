import { hoverTooltip } from '@codemirror/view';
import type { Hover, Position } from '../typst/protocol';
import { citationsAt, linksAt } from './analysis';
import { appendDocs } from './signature';

/**
 * Typst's own hover (`typst-ide`): a value, or the docs of a function or
 * parameter. Wikilinks and citations show their own hovers instead.
 */
export function typstHover(
  tooltip: (
    text: string,
    position: Position,
    before: boolean,
  ) => Promise<Hover | null>,
) {
  return hoverTooltip(async (view, pos, side) => {
    const state = view.state;
    const inside = (r: { from: number; to: number }) =>
      r.from <= pos && pos <= r.to;
    if (linksAt(state).some(inside) || citationsAt(state).some(inside)) {
      return null;
    }
    const line = state.doc.lineAt(pos);
    const hover = await tooltip(
      state.doc.toString(),
      { line: line.number - 1, column: pos - line.from },
      side < 0,
    );
    if (!hover || view.state.doc !== state.doc) return null;
    return {
      pos,
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-typst-hover';
        if (hover.code) {
          const code = document.createElement('code');
          code.textContent = hover.text;
          dom.appendChild(code);
        } else {
          // The first paragraph; the rest of a function's docs is reference material.
          appendDocs(dom, hover.text.split(/\n\s*\n/)[0]);
        }
        return { dom };
      },
    };
  });
}
