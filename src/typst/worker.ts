import init, {
  type CompileOutput,
  Compiler,
  Severity,
} from './pkg/sliver_typst.js';
import type {
  CompileResult,
  FromWorker,
  HostReply,
  HostRequest,
  Request,
  Response,
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
  return new Promise((resolve) => {
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
        (error) => {
          failedAt.set(spec, Date.now());
          console.warn(`could not load ${spec}:`, error);
        },
      )
      .finally(() => loading.delete(spec));
    loading.set(spec, task);
  }
}

// wasm-bindgen objects can't cross postMessage, so copy out the fields.
// Each getter clones on the Rust side, so read each one once.
function toResult(compiler: Compiler, out: CompileOutput): CompileResult {
  const missing = out.missingPackages;
  ensurePackages(compiler, missing);
  const loadingPackages = missing.filter((spec) => loading.has(spec));
  const result: CompileResult = {
    pages: out.pages,
    loadingPackages,
    compileMs: out.compileMs,
    renderMs: out.renderMs,
    diagnostics: out.diagnostics
      .map((d) => {
        const range = d.range;
        return {
          severity: d.severity === Severity.Error ? 'error' : 'warning',
          message: d.message,
          hints: d.hints,
          path: d.path,
          range: range && {
            start: { line: range.start.line, column: range.start.column },
            end: { line: range.end.line, column: range.end.column },
          },
        } as const;
      })
      .filter((d) => !loadingPackages.some((spec) => d.message.includes(spec))),
  };
  out.free();
  return result;
}

function handle(compiler: Compiler, req: Request): unknown {
  switch (req.kind) {
    case 'setSource':
      return compiler.setSource(req.path, req.text);
    case 'setPrefix':
      return compiler.setPrefix(req.path, req.prefix);
    case 'removeSource':
      return compiler.removeSource(req.path);
    case 'compile':
      return toResult(compiler, compiler.compile(req.main));
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
      const from = found.from;
      const completions = {
        from: { line: from.line, column: from.column },
        items: found.items.map((item) => {
          const plain = {
            kind: item.kind,
            label: item.label,
            apply: item.apply,
            detail: item.detail,
          };
          item.free();
          return plain;
        }),
      };
      found.free();
      return completions;
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
      const signature = {
        name: found.name,
        docs: found.docs,
        active: found.active,
        params: found.params.map((p) => {
          const plain = {
            name: p.name,
            types: p.types,
            docs: p.docs,
            named: p.named,
            positional: p.positional,
            required: p.required,
            variadic: p.variadic,
            default: p.default,
          };
          p.free();
          return plain;
        }),
      };
      found.free();
      return signature;
    }
    case 'jumpFromClick': {
      const found = compiler.jumpFromClick(req.main, req.page, req.x, req.y);
      if (!found) return null;
      const position = found.position;
      const location = {
        path: found.path,
        position: { line: position.line, column: position.column },
      };
      found.free();
      return location;
    }
    case 'jumpFromCursor':
      return compiler
        .jumpFromCursor(
          req.main,
          req.path,
          req.position.line,
          req.position.column,
        )
        .map((point) => {
          const plain = { page: point.page, x: point.x, y: point.y };
          point.free();
          return plain;
        });
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
  try {
    response = {
      id: message.id,
      ok: true,
      value: handle(await ready, message),
    };
  } catch (error) {
    response = { id: message.id, ok: false, error: String(error) };
  }
  post(response);
};
