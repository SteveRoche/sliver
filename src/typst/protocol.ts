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
  /** Compile (parse, evaluate, layout) and SVG render times in the engine. */
  compileMs: number;
  renderMs: number;
  /** The whole command in the backend: waiting for the compiler, the source, compile, render. */
  backendMs: number;
}

/**
 * A compile's JSON header as `typst_compile` sends it (`compiler.rs`); the
 * new bands' SVG follows it in the same body.
 */
export interface CompileHeader {
  pages:
    | {
        width: number;
        height: number;
        background: string;
        /** `end`: where the band's SVG stops in the bytes after the header. */
        bands: { top: number; height: number; key: string; end: number }[];
      }[]
    | null;
  anchor: PagePoint | null;
  diagnostics: Diagnostic[];
  missingPackages: string[];
  compileMs: number;
  renderMs: number;
  backendMs: number;
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
