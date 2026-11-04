import init, {
  type CompileOutput,
  Compiler,
  Severity,
} from "./pkg/sliver_typst.js";
import type { CompileResult, Request, Response } from "./protocol";

// The DOM lib types `self` as Window; this file only runs as a module worker.
const scope = self as unknown as Worker;
const ready = init().then(() => new Compiler());

// wasm-bindgen objects can't cross postMessage, so copy out the fields.
// Each getter clones on the Rust side, so read each one once.
function toResult(out: CompileOutput): CompileResult {
  const result: CompileResult = {
    pages: out.pages,
    diagnostics: out.diagnostics.map((d) => {
      const range = d.range;
      return {
        severity: d.severity === Severity.Error ? "error" : "warning",
        message: d.message,
        hints: d.hints,
        path: d.path,
        range: range && {
          start: { line: range.start.line, column: range.start.column },
          end: { line: range.end.line, column: range.end.column },
        },
      };
    }),
  };
  out.free();
  return result;
}

function handle(compiler: Compiler, req: Request): unknown {
  switch (req.kind) {
    case "setSource":
      return compiler.setSource(req.path, req.text);
    case "removeSource":
      return compiler.removeSource(req.path);
    case "compile":
      return toResult(compiler.compile(req.main));
  }
}

scope.onmessage = async (event: MessageEvent<Request>) => {
  const req = event.data;
  let response: Response;
  try {
    response = { id: req.id, ok: true, value: handle(await ready, req) };
  } catch (error) {
    response = { id: req.id, ok: false, error: String(error) };
  }
  scope.postMessage(response);
};
