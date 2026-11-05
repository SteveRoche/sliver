import init, { type Compiled, Compiler } from './pkg/sliver_typst.js';
import type {
  CompletionItem,
  Completions,
  Diagnostic,
  FromWorker,
  HostReply,
  HostRequest,
  PagePoint,
  Request,
  Response,
  Signature,
  SourceLocation,
  WorkerCompile,
} from './protocol';

// The DOM lib types `self` as Window; this file only runs as a module worker.
const scope = self as unknown as Worker;
const post = (message: FromWorker, transfer: Transferable[] = []) =>
  scope.postMessage(message, transfer);
const ready = init().then(() => new Compiler());

const RETRY_MS = 30_000;
const loading = new Map<string, Promise<void>>();
const failedAt = new Map<string, number>();

// Requests to the main thread, which forwards them to the Tauri backend.
let nextHostId = 0;
const hostReplies = new Map<number, (value: ArrayBuffer | null) => void>();

function host(request: {
  op: 'loadPackage';
  spec: string;
}): Promise<ArrayBuffer | null> {
  const hostId = nextHostId++;
  return new Promise(resolve => {
    hostReplies.set(hostId, resolve);
    post({ hostId, ...request } satisfies HostRequest);
  });
}

function packageUrl(spec: string): string {
  const match = /^@preview\/([a-z0-9-]+):(\d+\.\d+\.\d+)$/.exec(spec);
  if (!match)
    throw new Error(`only @preview packages can be downloaded: ${spec}`);
  return `https://packages.typst.org/preview/${match[1]}-${match[2]}.tar.gz`;
}

async function gunzip(gz: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([gz])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The vault cache is a local read, so it's tried first; the network download
// goes straight into the compiler and is saved to the vault off the critical path.
async function loadPackage(compiler: Compiler, spec: string): Promise<void> {
  const cached = await host({ op: 'loadPackage', spec });
  if (cached && cached.byteLength > 0) {
    compiler.addPackage(spec, await gunzip(cached));
    return;
  }
  const response = await fetch(packageUrl(spec));
  if (!response.ok) throw new Error(`${spec}: HTTP ${response.status}`);
  const gz = await response.arrayBuffer();
  compiler.addPackage(spec, await gunzip(gz));
  post({ hostId: nextHostId++, op: 'savePackage', spec, data: gz }, [gz]);
}

function ensurePackages(compiler: Compiler, specs: string[]) {
  for (const spec of specs) {
    if (compiler.hasPackage(spec) || loading.has(spec)) continue;
    if (Date.now() - (failedAt.get(spec) ?? -Infinity) < RETRY_MS) continue;
    const task = loadPackage(compiler, spec)
      .then(
        () => post({ event: 'packagesLoaded', specs: [spec] }),
        error => {
          failedAt.set(spec, Date.now());
          console.warn(`could not load ${spec}:`, error);
        },
      )
      .finally(() => loading.delete(spec));
    loading.set(spec, task);
  }
}

/** Matches `NONE` in `wasm.rs`: a missing number. */
const NONE = 0xffffffff;
// Parameter flag bits, as in `wasm.rs`.
const PARAM_NAMED = 1;
const PARAM_POSITIONAL = 2;
const PARAM_REQUIRED = 4;
const PARAM_VARIADIC = 8;

/**
 * Calls `read` on a wasm result, then frees it whatever happens. Results are
 * one object of flat arrays (see `wasm.rs`), so this is the only `free()`;
 * each getter copies, so `read` takes each field once.
 */
function using<T extends { free(): void }, R>(value: T, read: (v: T) => R): R {
  try {
    return read(value);
  } finally {
    value.free();
  }
}

function toCompile(compiler: Compiler, out: Compiled): WorkerCompile {
  return using(out, out => {
    const missing = out.missingPackages;
    ensurePackages(compiler, missing);
    const loadingPackages = missing.filter(spec => loading.has(spec));
    const severities = out.diagnosticSeverities;
    const messages = out.diagnosticMessages;
    const paths = out.diagnosticPaths;
    const ranges = out.diagnosticRanges;
    const hints = out.diagnosticHints;
    const hintCounts = out.diagnosticHintCounts;
    const diagnostics: Diagnostic[] = [];
    let hint = 0;
    for (let i = 0; i < messages.length; i++) {
      const own = hints.slice(hint, hint + hintCounts[i]);
      hint += hintCounts[i];
      // "Not found" errors of packages being fetched are left out.
      if (loadingPackages.some(spec => messages[i].includes(spec))) continue;
      const r = ranges.subarray(4 * i, 4 * i + 4);
      diagnostics.push({
        severity: severities[i] === 0 ? 'error' : 'warning',
        message: messages[i],
        hints: own,
        path: paths[i] || undefined,
        range:
          r[0] === NONE
            ? undefined
            : {
                start: { line: r[0], column: r[1] },
                end: { line: r[2], column: r[3] },
              },
      });
    }
    return {
      rendered: out.rendered,
      pageCount: out.pageCount,
      changedPages: [...out.changedPages],
      svg: out.svg,
      svgEnds: [...out.svgEnds],
      diagnostics,
      loadingPackages,
      compileMs: out.compileMs,
      renderMs: out.renderMs,
    };
  });
}

/** Buffers to transfer (not copy) with the current response. */
let transfer: Transferable[] = [];

function handle(compiler: Compiler, req: Request): unknown {
  switch (req.kind) {
    case 'setSource':
      return compiler.setSource(req.path, req.text);
    case 'setPrefix':
      return compiler.setPrefix(req.path, req.prefix);
    case 'removeSource':
      return compiler.removeSource(req.path);
    case 'affectedMains':
      return compiler.affectedMains(req.path);
    case 'compile': {
      if (req.source) compiler.setSource(req.source.path, req.source.text);
      const result = toCompile(
        compiler,
        compiler.compile(req.main, req.render),
      );
      transfer = [result.svg.buffer];
      return result;
    }
    case 'complete': {
      const found = compiler.complete(
        req.main,
        req.path,
        req.text,
        req.position.line,
        req.position.column,
        req.explicit,
      );
      if (!found) return null;
      return using(found, found => {
        const kinds = found.kinds;
        const labels = found.labels;
        const applies = found.applies;
        const details = found.details;
        return {
          from: { line: found.fromLine, column: found.fromColumn },
          items: labels.map((label, i) => ({
            kind: kinds[i] as CompletionItem['kind'],
            label,
            apply: applies[i],
            detail: details[i] || undefined,
          })),
        } satisfies Completions;
      });
    }
    case 'signature': {
      const found = compiler.signature(
        req.main,
        req.path,
        req.text,
        req.position.line,
        req.position.column,
      );
      if (!found) return null;
      return using(found, found => {
        const names = found.paramNames;
        const types = found.paramTypes;
        const docs = found.paramDocs;
        const defaults = found.paramDefaults;
        const flags = found.paramFlags;
        const active = found.active;
        return {
          name: found.name,
          docs: found.docs || undefined,
          active: active < 0 ? undefined : active,
          params: names.map((name, i) => ({
            name,
            types: types[i],
            docs: docs[i] || undefined,
            default: defaults[i] || undefined,
            named: (flags[i] & PARAM_NAMED) !== 0,
            positional: (flags[i] & PARAM_POSITIONAL) !== 0,
            required: (flags[i] & PARAM_REQUIRED) !== 0,
            variadic: (flags[i] & PARAM_VARIADIC) !== 0,
          })),
        } satisfies Signature;
      });
    }
    case 'jumpFromClick': {
      const found = compiler.jumpFromClick(req.main, req.page, req.x, req.y);
      if (!found) return null;
      return using(
        found,
        found =>
          ({
            path: found.path,
            position: { line: found.line, column: found.column },
          }) satisfies SourceLocation,
      );
    }
    case 'jumpFromCursor': {
      const flat = compiler.jumpFromCursor(
        req.main,
        req.path,
        req.position.line,
        req.position.column,
      );
      const points: PagePoint[] = [];
      for (let i = 0; i + 2 < flat.length; i += 3) {
        points.push({ page: flat[i], x: flat[i + 1], y: flat[i + 2] });
      }
      return points;
    }
  }
}

scope.onmessage = async (event: MessageEvent<Request | HostReply>) => {
  const message = event.data;
  if ('hostId' in message) {
    hostReplies.get(message.hostId)?.(message.value);
    hostReplies.delete(message.hostId);
    return;
  }
  let response: Response;
  transfer = [];
  try {
    response = {
      id: message.id,
      ok: true,
      value: handle(await ready, message),
    };
  } catch (error) {
    response = { id: message.id, ok: false, error: String(error) };
  }
  post(response, transfer);
};
