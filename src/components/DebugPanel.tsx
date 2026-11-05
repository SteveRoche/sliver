import { createMemo, For, Show } from 'solid-js';
import { analyses, compiles, debugVisible } from '../state/debug';
import { activeNote } from '../state/workspace';

const fmt = (ms: number | undefined) =>
  ms === undefined ? '-' : `${ms.toFixed(1)} ms`;

/**
 * Live compile latency for the visible note ("Toggle debug view"): the
 * latest compile and SVG render times in the worker, the edit-to-preview
 * round trip, and the editor's syntax analysis, with the recent maximum and
 * a bar per sample to spot spikes while typing.
 */
export function DebugPanel() {
  const samples = createMemo(() =>
    compiles().filter((s) => s.note === activeNote()),
  );
  const latest = () => samples()[samples().length - 1];
  const worst = () => Math.max(0, ...samples().map((s) => s.totalMs));
  const scale = () => Math.max(16, worst());

  return (
    <Show when={debugVisible()}>
      <section class="debug-panel" aria-label="Compile timings">
        <div class="debug-row">
          <span>compile {fmt(latest()?.compileMs)}</span>
          <span>render {fmt(latest()?.renderMs)}</span>
          <span>edit → preview {fmt(latest()?.totalMs)}</span>
          <span>max {fmt(samples().length ? worst() : undefined)}</span>
        </div>
        <div class="debug-bars" title="Edit → preview, last 60 compiles">
          <For each={samples()}>
            {(s) => (
              <span
                class="debug-bar"
                classList={{ slow: s.totalMs > 50 }}
                style={{ height: `${(s.totalMs / scale()) * 100}%` }}
              />
            )}
          </For>
        </div>
        <div class="debug-row">
          <span>syntax analysis {fmt(analyses()[analyses().length - 1])}</span>
          <span>
            max {fmt(analyses().length ? Math.max(...analyses()) : undefined)}
          </span>
        </div>
      </section>
    </Show>
  );
}
