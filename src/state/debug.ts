import { createSignal } from 'solid-js';
import type { CompileTiming } from '../typst/client';
import type { NoteId } from '../vault/api';

/** How many recent samples the debug view keeps per kind. */
const KEEP = 60;

export interface Sample extends CompileTiming {
  note: NoteId;
}

const [debugVisible, setDebugVisible] = createSignal(false);
const [compiles, setCompiles] = createSignal<Sample[]>([]);
/** Round trips of the editor's syntax analysis (highlighting, links), in ms. */
const [analyses, setAnalyses] = createSignal<number[]>([]);

export { analyses, compiles, debugVisible };

export const toggleDebug = () => setDebugVisible(v => !v);

export function recordCompile(sample: Sample) {
  if (!debugVisible()) return;
  setCompiles(list => [...list.slice(1 - KEEP), sample]);
}

export function recordAnalysis(ms: number) {
  if (!debugVisible()) return;
  setAnalyses(list => [...list.slice(1 - KEEP), ms]);
}
