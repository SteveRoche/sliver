export interface Position {
  line: number;
  /** UTF-16 code units, like JS string indices. */
  column: number;
}

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  hints: string[];
  path?: string;
  range?: { start: Position; end: Position };
}

export interface CompileResult {
  /** One SVG per page; empty when compilation failed. */
  pages: string[];
  diagnostics: Diagnostic[];
}

export interface Calls {
  setSource: { args: { path: string; text: string }; result: undefined };
  removeSource: { args: { path: string }; result: undefined };
  compile: { args: { main: string }; result: CompileResult };
}

export type Request = {
  [K in keyof Calls]: { id: number; kind: K } & Calls[K]["args"];
}[keyof Calls];

export type Response =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
