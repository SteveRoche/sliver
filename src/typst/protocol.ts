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
  /** Vault files being loaded (images, data); a recompile follows. */
  loadingFiles: string[];
  /** Compile (parse, evaluate, layout) and SVG render times in the worker. */
  compileMs: number;
  renderMs: number;
}

/**
 * A compile as the worker sends it (see `Compiled` in `wasm.rs`): pages in
 * bands, with only the bands not sent before as UTF-8 bytes.
 */
export interface WorkerCompile extends CompileStats {
  /** False when nothing was rendered (failed, or not asked for). */
  rendered: boolean;
  /** Width and height of each page in points, back to back. */
  pageSizes: number[];
  /** Each page's fill as SVG, drawn under its bands. */
  backgrounds: string[];
  /** How many bands each page has; the arrays below list every page's in turn. */
  bandCounts: number[];
  /** Top and height of each band in points, back to back. */
  bandRects: number[];
  bandKeys: string[];
  /** The bands' SVG back to back (none for one sent before); transferred, not copied. */
  svg: Uint8Array;
  /** Where each band's SVG ends in `svg`. */
  svgEnds: number[];
  /** Where the anchor sent with the compile is now, if it was found again. */
  anchor: PagePoint | null;
}

/**
 * A horizontal band of a page: its own SVG, `height` points tall, placed
 * `top` points from the page's top. Only bands on screen are in the DOM.
 */
export interface Band {
  top: number;
  height: number;
  /** Equal keys render the same, wherever the band is. */
  key: string;
  svg: string;
}

/** A rendered page, in points. */
export interface Page {
  width: number;
  height: number;
  /** The page's fill as SVG. */
  background: string;
  bands: Band[];
}

/** A compile with its pages decoded. */
export interface CompileResult extends CompileStats {
  /**
   * The anchor sent with the compile (`from`, in the last layout) and where
   * its text is in this one (`to`), so the preview can keep it in place.
   */
  anchor: { from: PagePoint; to: PagePoint } | null;
  /**
   * The rendered pages, a band's `svg` `null` when it was sent before (in
   * the last render, under the same key); `null` overall when nothing was
   * rendered, so the previous pages stand.
   */
  pages:
    | (Omit<Page, 'bands'> & {
        bands: (Omit<Band, 'svg'> & { svg: string | null })[];
      })[]
    | null;
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

/** What hovering shows: Typst code (e.g. a value) or Markdown docs. */
export interface Hover {
  code: boolean;
  text: string;
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
  /**
   * Drops vault file `path` (an asset changed on disk), so the next compile
   * that reads it loads it again; returns the mains whose last compile read it.
   */
  forgetFile: { args: { path: string }; result: string[] };
  compile: {
    args: {
      main: string;
      render: boolean;
      /** Replaced before compiling, saving a round trip. */
      source?: { path: string; text: string };
      /** A point of the last layout to follow into the new one (`y` only). */
      anchor?: PagePoint | null;
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
  /** `before`: the pointer is on the character before `position`. */
  tooltip: {
    args: {
      main: string;
      path: string;
      text: string;
      position: Position;
      before: boolean;
    };
    result: Hover | null;
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
  /** A package's `.tar.gz` or a vault file, or null if the host doesn't have it. */
  value: ArrayBuffer | null;
}

/** Worker -> main thread. */
export type Response =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

export type HostRequest =
  | { hostId: number; op: 'loadPackage'; spec: string }
  | { hostId: number; op: 'loadFile'; path: string }
  | { hostId: number; op: 'savePackage'; spec: string; data: ArrayBuffer };

/** Packages or vault files finished loading: documents that needed them can recompile. */
export interface Loaded {
  event: 'loaded';
}

export type FromWorker = Response | HostRequest | Loaded;

/**
 * What the worker gets from the app: packages cached between sessions (the
 * open vault's `.sliver/pkg`) and the vault's files (images, data).
 */
export interface WorkerHost {
  load(spec: string): Promise<ArrayBuffer | null>;
  save(spec: string, data: ArrayBuffer): Promise<void>;
  /** A vault file by its vault path, or null if there is none. */
  loadFile(path: string): Promise<ArrayBuffer | null>;
}
