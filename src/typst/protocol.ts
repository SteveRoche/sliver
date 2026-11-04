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
  /** Packages being fetched; their "not found" errors are left out. */
  loadingPackages: string[];
}

export interface Calls {
  setSource: { args: { path: string; text: string }; result: undefined };
  removeSource: { args: { path: string }; result: undefined };
  compile: { args: { main: string }; result: CompileResult };
}

/** Main thread -> worker. */
export type Request = {
  [K in keyof Calls]: { id: number; kind: K } & Calls[K]["args"];
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
  | { hostId: number; op: "loadPackage"; spec: string }
  | { hostId: number; op: "savePackage"; spec: string; data: ArrayBuffer };

export interface PackagesLoaded {
  event: "packagesLoaded";
  specs: string[];
}

export type FromWorker = Response | HostRequest | PackagesLoaded;

/** Where packages are cached between sessions (the open vault's `.sliver/pkg`). */
export interface PackageHost {
  load(spec: string): Promise<ArrayBuffer | null>;
  save(spec: string, data: ArrayBuffer): Promise<void>;
}
