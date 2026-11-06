import type {
  Calls,
  CitationMark,
  CompileResult,
  Completions,
  FromWorker,
  HostReply,
  Hover,
  PagePoint,
  Position,
  Request,
  Signature,
  SourceLocation,
  WorkerHost,
} from './protocol';

type Args<K extends keyof Calls> = Calls[K]['args'];
type Result<K extends keyof Calls> = Calls[K]['result'];

const decoder = new TextDecoder();

/** Talks to the Typst compiler running in a Web Worker. */
export class TypstClient {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
  });
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private loadedListeners = new Set<() => void>();

  constructor(private host: WorkerHost) {
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if ('event' in message) {
        for (const listener of this.loadedListeners) listener();
      } else if ('op' in message) {
        void this.serveHost(message);
      } else {
        const call = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.ok) call?.resolve(message.value);
        else call?.reject(new Error(message.error));
      }
    };
  }

  setSource(path: string, text: string): Promise<void> {
    return this.call('setSource', { path, text });
  }

  /**
   * Hidden whole lines compiled before `path`'s text (a note's preamble
   * imports). Positions in results stay relative to the text itself.
   */
  setPrefix(path: string, prefix: string): Promise<void> {
    return this.call('setPrefix', { path, prefix });
  }

  removeSource(path: string): Promise<void> {
    return this.call('removeSource', { path });
  }

  /** Forgets vault file `path`; resolves to the mains that read it. */
  forgetFile(path: string): Promise<string[]> {
    return this.call('forgetFile', { path });
  }

  /** Compiles `main`; with `render`, also renders its changed pages. */
  async compile(
    main: string,
    render: boolean,
    /** A source file to replace first, in the same message. */
    source?: { path: string; text: string },
    /** A point of the last layout to follow into the new one. */
    anchor?: PagePoint | null,
  ): Promise<CompileResult> {
    const raw = await this.call('compile', { main, render, source, anchor });
    const moved =
      anchor && raw.anchor ? { from: anchor, to: raw.anchor } : null;
    const {
      anchor: _,
      rendered,
      pageSizes,
      backgrounds,
      bandCounts,
      bandRects,
      bandKeys,
      svg,
      svgEnds,
      ...stats
    } = raw;
    if (!rendered) return { ...stats, anchor: moved, pages: null };
    let band = 0;
    let start = 0;
    const pages = bandCounts.map((count, page) => ({
      width: pageSizes[2 * page],
      height: pageSizes[2 * page + 1],
      background: backgrounds[page],
      bands: Array.from({ length: count }, () => {
        const end = svgEnds[band];
        const out = {
          top: bandRects[2 * band],
          height: bandRects[2 * band + 1],
          key: bandKeys[band],
          svg: end > start ? decoder.decode(svg.subarray(start, end)) : null,
        };
        start = end;
        band++;
        return out;
      }),
    }));
    return { ...stats, anchor: moved, pages };
  }

  /** Main files whose last compile read `path`, i.e. those a change to it affects. */
  affectedMains(path: string): Promise<string[]> {
    return this.call('affectedMains', { path });
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
    return this.call('complete', { main, path, text, position, explicit });
  }

  /** What hovering `position` in `text` shows. */
  tooltip(
    main: string,
    path: string,
    text: string,
    position: Position,
    before: boolean,
  ): Promise<Hover | null> {
    return this.call('tooltip', { main, path, text, position, before });
  }

  /** Signature help for the call around `position` in `text`. */
  signature(
    main: string,
    path: string,
    text: string,
    position: Position,
  ): Promise<Signature | null> {
    return this.call('signature', { main, path, text, position });
  }

  /** The source behind a click on page `page` at (`x`, `y`) points. */
  jumpFromClick(
    main: string,
    page: number,
    x: number,
    y: number,
  ): Promise<SourceLocation | null> {
    return this.call('jumpFromClick', { main, page, x, y });
  }

  /** Where the text at `position` in `path` appears in `main`'s pages. */
  jumpFromCursor(
    main: string,
    path: string,
    position: Position,
  ): Promise<PagePoint[]> {
    return this.call('jumpFromCursor', { main, path, position });
  }

  /** The string metadata labelled `label` in `main`'s last good compile. */
  metadataText(main: string, label: string): Promise<string | null> {
    return this.call('metadataText', { main, label });
  }

  /** Compiles `text` as a main file of its own, which is then forgotten. */
  standalone(
    path: string,
    text: string,
    render: boolean,
  ): Promise<{ pages: string[]; errors: string[] }> {
    return this.call('standalone', { path, text, render });
  }

  /** Where citations and cross-references start in `main`'s last good layout. */
  citationMarks(main: string): Promise<CitationMark[]> {
    return this.call('citationMarks', { main });
  }

  /** Typst's built-in citation styles. */
  citationStyles(): Promise<{ name: string; label: string }[]> {
    return this.call('citationStyles', {});
  }

  /**
   * Fires when packages or vault files finish loading, so documents that
   * needed them can recompile.
   */
  onLoaded(listener: () => void): () => void {
    this.loadedListeners.add(listener);
    return () => this.loadedListeners.delete(listener);
  }

  private async serveHost(request: Extract<FromWorker, { op: string }>) {
    if (request.op === 'savePackage') {
      await this.host
        .save(request.spec, request.data)
        .catch(error =>
          console.warn(`could not cache ${request.spec}:`, error),
        );
      return;
    }
    const value = await (request.op === 'loadFile'
      ? this.host.loadFile(request.path)
      : this.host.load(request.spec)
    ).catch(() => null);
    const reply: HostReply = { hostId: request.hostId, value };
    this.worker.postMessage(reply, value ? [value] : []);
  }

  private call<K extends keyof Calls>(
    kind: K,
    args: Args<K>,
  ): Promise<Result<K>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.worker.postMessage({ id, kind, ...args } as Request);
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
