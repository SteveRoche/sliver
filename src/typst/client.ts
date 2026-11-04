import type { Calls, CompileResult, Request, Response } from "./protocol";

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

  constructor() {
    this.worker.onmessage = (event: MessageEvent<Response>) => {
      const res = event.data;
      const call = this.pending.get(res.id);
      this.pending.delete(res.id);
      if (res.ok) call?.resolve(res.value);
      else call?.reject(new Error(res.error));
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

/**
 * Returns an `update(text)` that keeps at most one compile in flight; edits
 * made meanwhile are collapsed into a single follow-up compile of the latest
 * text, so typing never queues up stale work.
 */
export function livePreview(
  client: TypstClient,
  main: string,
  onResult: (result: CompileResult) => void,
  onError: (error: Error) => void,
): (text: string) => void {
  let running = false;
  let queued: string | undefined;

  return async (text) => {
    queued = text;
    if (running) return;
    running = true;
    try {
      while (queued !== undefined) {
        const next = queued;
        queued = undefined;
        await client.setSource(main, next);
        onResult(await client.compile(main));
      }
    } catch (error) {
      onError(error as Error);
    } finally {
      running = false;
    }
  };
}
