export interface Position {
  line: number;
  /** UTF-16 code units, like JS string indices. */
  column: number;
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  hints: string[];
  path?: string;
  range?: { start: Position; end: Position };
}

interface CompileStats {
  diagnostics: Diagnostic[];
  /** Packages being fetched; their "not found" errors are left out. */
  loadingPackages: string[];
  /** Compile (parse, evaluate, layout) and SVG render times in the worker. */
  compileMs: number;
  renderMs: number;
}

/** A compile as the worker sends it: only changed pages, as UTF-8 bytes. */
export interface WorkerCompile extends CompileStats {
  /** False when nothing was rendered (failed, or not asked for). */
  rendered: boolean;
  pageCount: number;
  /** Pages whose SVG is in `svg`; the others are unchanged since the last render. */
  changedPages: number[];
  /** The changed pages' SVG back to back; transferred, not copied. */
  svg: Uint8Array;
  /** Where each changed page ends in `svg`. */
  svgEnds: number[];
}

/** A compile with its pages decoded. */
export interface CompileResult extends CompileStats {
  /**
   * One entry per page, `null` for a page unchanged since the last render;
   * `null` overall when nothing was rendered, so the previous pages stand.
   */
  pages: (string | null)[] | null;
}

/** A place in a source file. */
export interface SourceLocation {
  path: string;
  position: Position;
}

/** A point on a page (zero-based), in points from its top left. */
export interface PagePoint {
  page: number;
  x: number;
  y: number;
}

export interface CompletionItem {
  kind:
    | 'syntax'
    | 'func'
    | 'type'
    | 'param'
    | 'constant'
    | 'path'
    | 'package'
    | 'label'
    | 'font'
    | 'symbol';
  label: string;
  /** What to insert, possibly with `${placeholder}` snippet fields. */
  apply: string;
  detail?: string;
}

/** Completions replacing the text from `from` to the cursor. */
export interface Completions {
  from: Position;
  items: CompletionItem[];
}

export interface ParamDoc {
  name: string;
  /** Accepted types and values, e.g. `length | auto`. */
  types: string;
  docs?: string;
  named: boolean;
  positional: boolean;
  required: boolean;
  variadic: boolean;
  default?: string;
}

/** Where a citation (or, with `key` null, a cross-reference) starts, in points. */
export interface CitationMark {
  key: string | null;
  page: number;
  x: number;
  y: number;
}

/** The function call around the cursor, for signature help. */
export interface Signature {
  name: string;
  /** First paragraph of the function's docs (Markdown). */
  docs?: string;
  params: ParamDoc[];
  /** Index into `params` of the argument at the cursor. */
  active?: number;
}

export interface Calls {
  setSource: { args: { path: string; text: string }; result: undefined };
  setPrefix: { args: { path: string; prefix: string }; result: undefined };
  removeSource: { args: { path: string }; result: undefined };
  /** Main files whose last compile read `path`. */
  affectedMains: { args: { path: string }; result: string[] };
  compile: {
    args: {
      main: string;
      render: boolean;
      /** Replaced before compiling, saving a round trip. */
      source?: { path: string; text: string };
    };
    result: WorkerCompile;
  };
  complete: {
    args: {
      main: string;
      path: string;
      text: string;
      position: Position;
      explicit: boolean;
    };
    result: Completions | null;
  };
  signature: {
    args: { main: string; path: string; text: string; position: Position };
    result: Signature | null;
  };
  jumpFromClick: {
    args: { main: string; page: number; x: number; y: number };
    result: SourceLocation | null;
  };
  jumpFromCursor: {
    args: { main: string; path: string; position: Position };
    result: PagePoint[];
  };
  /** The string metadata labelled `label` in `main`'s last good compile. */
  metadataText: {
    args: { main: string; label: string };
    result: string | null;
  };
  /**
   * Compiles a throwaway main file and forgets it again, e.g. to render one
   * bibliography entry; `pages` is empty without `render` or on errors.
   */
  standalone: {
    args: { path: string; text: string; render: boolean };
    result: { pages: string[]; errors: string[] };
  };
  /** Where citations (and, without a key, cross-references) start. */
  citationMarks: {
    args: { main: string };
    result: CitationMark[];
  };
  /** Typst's built-in citation styles. */
  citationStyles: {
    args: Record<string, never>;
    result: { name: string; label: string }[];
  };
}

/** Main thread -> worker. */
export type Request = {
  [K in keyof Calls]: { id: number; kind: K } & Calls[K]['args'];
}[keyof Calls];

export interface HostReply {
  hostId: number;
  /** A package's `.tar.gz`, or null if the host doesn't have it. */
  value: ArrayBuffer | null;
}

/** Worker -> main thread. */
export type Response =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

export type HostRequest =
  | { hostId: number; op: 'loadPackage'; spec: string }
  | { hostId: number; op: 'savePackage'; spec: string; data: ArrayBuffer };

export interface PackagesLoaded {
  event: 'packagesLoaded';
  specs: string[];
}

export type FromWorker = Response | HostRequest | PackagesLoaded;

/** Where packages are cached between sessions (the open vault's `.sliver/pkg`). */
export interface PackageHost {
  load(spec: string): Promise<ArrayBuffer | null>;
  save(spec: string, data: ArrayBuffer): Promise<void>;
}
