import { invoke } from '@tauri-apps/api/core';
import type {
  CitationMark,
  CompileHeader,
  CompileResult,
  Completions,
  Hover,
  PagePoint,
  Position,
  Signature,
  SourceLocation,
} from './protocol';

const decoder = new TextDecoder();

/** How long a package that failed to load waits before it's tried again. */
const RETRY_MS = 30_000;

function packageUrl(spec: string): string {
  const match = /^@preview\/([a-z0-9-]+):(\d+\.\d+\.\d+)$/.exec(spec);
  if (!match) {
    throw new Error(`only @preview packages can be downloaded: ${spec}`);
  }
  return `https://packages.typst.org/preview/${match[1]}-${match[2]}.tar.gz`;
}

async function gunzip(gz: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([gz])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Talks to the Typst compiler, which runs natively in the backend
 * (`src-tauri/src/compiler.rs`): one engine for every open note. Vault
 * files a compile reads are loaded there too; packages are fetched here
 * (the open vault's `.sliver/pkg` cache first, else packages.typst.org) and
 * handed over.
 */
export class TypstClient {
  private loadedListeners = new Set<() => void>();
  private loading = new Map<string, Promise<void>>();
  private loaded = new Set<string>();
  private failedAt = new Map<string, number>();

  setSource(path: string, text: string): Promise<void> {
    return invoke('typst_set_source', { path, text });
  }

  /**
   * Hidden whole lines compiled before `path`'s text (a note's preamble
   * imports). Positions in results stay relative to the text itself.
   */
  setPrefix(path: string, prefix: string): Promise<void> {
    return invoke('typst_set_prefix', { path, prefix });
  }

  removeSource(path: string): Promise<void> {
    return invoke('typst_remove_source', { path });
  }

  /** Forgets vault file `path`; resolves to the mains that read it. */
  forgetFile(path: string): Promise<string[]> {
    return invoke('typst_forget_file', { path });
  }

  /** Compiles `main`; with `render`, also renders its changed pages. */
  async compile(
    main: string,
    render: boolean,
    /** A source file to replace first, in the same call. */
    source?: { path: string; text: string },
    /** A point of the last layout to follow into the new one. */
    anchor?: PagePoint | null,
  ): Promise<CompileResult> {
    const body = await invoke<ArrayBuffer>('typst_compile', {
      main,
      render,
      source: source ?? null,
      anchor: anchor ? { page: anchor.page, y: anchor.y } : null,
    });
    const length = new DataView(body).getUint32(0, true);
    const header: CompileHeader = JSON.parse(
      decoder.decode(new Uint8Array(body, 4, length)),
    );
    const svg = new Uint8Array(body, 4 + length);
    const loadingPackages = this.ensurePackages(header.missingPackages);
    const diagnostics = header.diagnostics.filter(
      // "Not found" errors of packages being fetched are left out.
      d => !loadingPackages.some(spec => d.message.includes(spec)),
    );
    const moved =
      anchor && header.anchor ? { from: anchor, to: header.anchor } : null;
    let start = 0;
    const pages =
      header.pages?.map(page => ({
        width: page.width,
        height: page.height,
        background: page.background,
        bands: page.bands.map(band => {
          const out = {
            top: band.top,
            height: band.height,
            key: band.key,
            svg:
              band.end > start
                ? decoder.decode(svg.subarray(start, band.end))
                : null,
          };
          start = band.end;
          return out;
        }),
      })) ?? null;
    return {
      diagnostics,
      loadingPackages,
      compileMs: header.compileMs,
      renderMs: header.renderMs,
      anchor: moved,
      pages,
    };
  }

  /** Main files whose last compile read `path`, i.e. those a change to it affects. */
  affectedMains(path: string): Promise<string[]> {
    return invoke('typst_affected_mains', { path });
  }

  /**
   * Typst completions for `text` (the current, maybe uncompiled contents of
   * `path`) at `position`, as part of `main`.
   */
  complete(
    main: string,
    path: string,
    text: string,
    position: Position,
    explicit: boolean,
  ): Promise<Completions | null> {
    return invoke('typst_complete', { main, path, text, position, explicit });
  }

  /** What hovering `position` in `text` shows. */
  tooltip(
    main: string,
    path: string,
    text: string,
    position: Position,
    before: boolean,
  ): Promise<Hover | null> {
    return invoke('typst_tooltip', { main, path, text, position, before });
  }

  /** Signature help for the call around `position` in `text`. */
  signature(
    main: string,
    path: string,
    text: string,
    position: Position,
  ): Promise<Signature | null> {
    return invoke('typst_signature', { main, path, text, position });
  }

  /** The source behind a click on page `page` at (`x`, `y`) points. */
  jumpFromClick(
    main: string,
    page: number,
    x: number,
    y: number,
  ): Promise<SourceLocation | null> {
    return invoke('typst_jump_from_click', { main, page, x, y });
  }

  /** Where the text at `position` in `path` appears in `main`'s pages. */
  jumpFromCursor(
    main: string,
    path: string,
    position: Position,
  ): Promise<PagePoint[]> {
    return invoke('typst_jump_from_cursor', { main, path, position });
  }

  /** The string metadata labelled `label` in `main`'s last good compile. */
  metadataText(main: string, label: string): Promise<string | null> {
    return invoke('typst_metadata_text', { main, label });
  }

  /** Compiles `text` as a main file of its own, which is then forgotten. */
  standalone(
    path: string,
    text: string,
    render: boolean,
  ): Promise<{ pages: string[]; errors: string[] }> {
    return invoke('typst_standalone', { path, text, render });
  }

  /** Where citations and cross-references start in `main`'s last good layout. */
  citationMarks(main: string): Promise<CitationMark[]> {
    return invoke('typst_citation_marks', { main });
  }

  /** Typst's built-in citation styles. */
  citationStyles(): Promise<{ name: string; label: string }[]> {
    return invoke('typst_citation_styles');
  }

  /**
   * Fires when packages finish loading, so documents that needed them can
   * recompile.
   */
  onLoaded(listener: () => void): () => void {
    this.loadedListeners.add(listener);
    return () => this.loadedListeners.delete(listener);
  }

  /** Starts loading the packages `specs` the engine lacks; returns those loading. */
  private ensurePackages(specs: string[]): string[] {
    for (const spec of specs) {
      if (this.loaded.has(spec) || this.loading.has(spec)) continue;
      if (Date.now() - (this.failedAt.get(spec) ?? -Infinity) < RETRY_MS) {
        continue;
      }
      const task = this.loadPackage(spec)
        .then(
          () => {
            this.loaded.add(spec);
            for (const listener of this.loadedListeners) listener();
          },
          error => {
            this.failedAt.set(spec, Date.now());
            console.warn(`could not load ${spec}:`, error);
          },
        )
        .finally(() => this.loading.delete(spec));
      this.loading.set(spec, task);
    }
    return specs.filter(spec => this.loading.has(spec));
  }

  // The vault cache is a local read, so it's tried first; a download goes
  // straight to the engine and is saved to the vault off the critical path.
  private async loadPackage(spec: string): Promise<void> {
    const cached = await invoke<ArrayBuffer>('load_package', { spec }).catch(
      () => null,
    );
    if (cached && cached.byteLength > 0) {
      await this.addPackage(spec, await gunzip(cached));
      return;
    }
    const response = await fetch(packageUrl(spec));
    if (!response.ok) throw new Error(`${spec}: HTTP ${response.status}`);
    const gz = await response.arrayBuffer();
    await this.addPackage(spec, await gunzip(gz));
    void invoke('save_package', new Uint8Array(gz), {
      headers: { 'x-package-spec': spec },
    }).catch(error => console.warn(`could not cache ${spec}:`, error));
  }

  private addPackage(spec: string, tar: Uint8Array): Promise<void> {
    return invoke('typst_add_package', tar, {
      headers: { 'x-package-spec': spec },
    });
  }
}

/** One compile as the live preview saw it, for the debug view. */
export interface CompileTiming {
  compileMs: number;
  renderMs: number;
  /** From the latest edit it includes to its result arriving. */
  totalMs: number;
}

export interface LivePreview {
  /** Replaces the note's source and recompiles. */
  update(text: string): void;
  /** Recompiles with the latest text, e.g. after `links.typ` changed. */
  refresh(): void;
  dispose(): void;
}

/** How long typing must pause before a note whose preview isn't shown compiles. */
const HIDDEN_DELAY_MS = 400;

export interface LivePreviewOptions {
  /**
   * Whether the preview is on screen. If not, edits compile only after a
   * pause and without rendering pages (diagnostics still come back).
   */
  visible: () => boolean;
  /**
   * The point of the shown layout to keep in place across a compile (the
   * top of what the preview shows), if any.
   */
  anchor?: () => PagePoint | null;
  /** `text` is the source the result was compiled from. */
  onResult: (
    result: CompileResult,
    text: string,
    timing: CompileTiming,
  ) => void;
  onError: (error: Error) => void;
}

/**
 * Keeps at most one compile in flight; edits made meanwhile are collapsed
 * into a single follow-up compile of the latest text, so typing never queues
 * up stale work. `sourcePath` is the note's own file and `mainPath` the file
 * compiled (the wikilink wrapper that includes it). Recompiles by itself when
 * a package the document needed finishes loading.
 */
export function livePreview(
  client: TypstClient,
  sourcePath: string,
  mainPath: string,
  options: LivePreviewOptions,
): LivePreview {
  let running = false;
  let queued: string | undefined;
  let queuedAt = 0;
  let latest: string | undefined;
  /** The text the engine has for `sourcePath`, so it's only sent when it changed. */
  let sent: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async (text: string) => {
    clearTimeout(timer);
    latest = text;
    queued = text;
    queuedAt = performance.now();
    if (running) return;
    running = true;
    try {
      while (queued !== undefined) {
        const next = queued;
        const since = queuedAt;
        queued = undefined;
        const source =
          next === sent ? undefined : { path: sourcePath, text: next };
        const visible = options.visible();
        const result = await client.compile(
          mainPath,
          visible,
          source,
          visible ? options.anchor?.() : null,
        );
        sent = next;
        options.onResult(result, next, {
          compileMs: result.compileMs,
          renderMs: result.renderMs,
          totalMs: performance.now() - since,
        });
      }
    } catch (error) {
      options.onError(error as Error);
    } finally {
      running = false;
    }
  };

  const refresh = () => {
    if (latest !== undefined) void run(latest);
  };
  const unsubscribe = client.onLoaded(refresh);
  return {
    update: text => {
      latest = text;
      clearTimeout(timer);
      if (options.visible()) void run(text);
      else timer = setTimeout(() => void run(text), HIDDEN_DELAY_MS);
    },
    refresh,
    dispose: () => {
      clearTimeout(timer);
      unsubscribe();
    },
  };
}
