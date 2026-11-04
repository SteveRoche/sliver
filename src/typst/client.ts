import type {
  Calls,
  CompileResult,
  FromWorker,
  HostReply,
  PackageHost,
  Request,
} from "./protocol";

type Args<K extends keyof Calls> = Calls[K]["args"];
type Result<K extends keyof Calls> = Calls[K]["result"];

/** Talks to the Typst compiler running in a Web Worker. */
export class TypstClient {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private packageListeners = new Set<(specs: string[]) => void>();

  constructor(private packages: PackageHost) {
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if ("event" in message) {
        for (const listener of this.packageListeners) listener(message.specs);
      } else if ("op" in message) {
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
    return this.call("setSource", { path, text });
  }

  removeSource(path: string): Promise<void> {
    return this.call("removeSource", { path });
  }

  compile(main: string): Promise<CompileResult> {
    return this.call("compile", { main });
  }

  /** Fires when packages finish loading, so dependent documents can recompile. */
  onPackagesLoaded(listener: (specs: string[]) => void): () => void {
    this.packageListeners.add(listener);
    return () => this.packageListeners.delete(listener);
  }

  private async serveHost(request: Extract<FromWorker, { op: string }>) {
    if (request.op === "savePackage") {
      await this.packages
        .save(request.spec, request.data)
        .catch((error) =>
          console.warn(`could not cache ${request.spec}:`, error),
        );
      return;
    }
    const value = await this.packages.load(request.spec).catch(() => null);
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

export interface LivePreview {
  /** Replaces the note's source and recompiles. */
  update(text: string): void;
  /** Recompiles with the latest text, e.g. after `links.typ` changed. */
  refresh(): void;
  dispose(): void;
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
  onResult: (result: CompileResult) => void,
  onError: (error: Error) => void,
): LivePreview {
  let running = false;
  let queued: string | undefined;
  let latest: string | undefined;

  const run = async (text: string) => {
    latest = text;
    queued = text;
    if (running) return;
    running = true;
    try {
      while (queued !== undefined) {
        const next = queued;
        queued = undefined;
        await client.setSource(sourcePath, next);
        onResult(await client.compile(mainPath));
      }
    } catch (error) {
      onError(error as Error);
    } finally {
      running = false;
    }
  };

  const refresh = () => {
    if (latest !== undefined) void run(latest);
  };
  const unsubscribe = client.onPackagesLoaded(refresh);
  return {
    update: (text) => void run(text),
    refresh,
    dispose: () => {
      unsubscribe();
    },
  };
}
