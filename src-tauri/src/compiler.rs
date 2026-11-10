//! The Typst compiler, hosted natively: one long-lived [`Engine`] holds every
//! open note's sources and compiles them per tab (`sliver-typst`). Commands
//! run off the async runtime (`spawn_blocking`) one at a time, behind a
//! mutex. Compile results cross as one binary body (a JSON header plus the
//! band SVG bytes); everything else as JSON.
//!
//! A panic inside Typst doesn't take the app down: it's caught, and the
//! engine is rebuilt from the inputs it was given (sources, prefixes, files,
//! packages), so the next call works again.

use std::collections::{HashMap, HashSet};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{Value, json};
use sliver_typst::{CompileOutput, Engine, PagePoint, Position, Severity};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};

use crate::commands::{OpenVault, lock};

type CommandResult<T> = Result<T, String>;

/// The engine and what it was given, to rebuild it after a panic.
struct Host {
    engine: Engine,
    sources: HashMap<String, String>,
    prefixes: HashMap<String, String>,
    files: HashMap<String, Vec<u8>>,
    packages: HashMap<String, Vec<u8>>,
    /// Vault files a compile read that the vault doesn't have, until forgotten.
    absent: HashSet<String>,
}

pub struct Compiler(Mutex<Option<Host>>);

impl Default for Compiler {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

impl Host {
    fn new() -> Self {
        Self {
            engine: Engine::new(),
            sources: HashMap::new(),
            prefixes: HashMap::new(),
            files: HashMap::new(),
            packages: HashMap::new(),
            absent: HashSet::new(),
        }
    }

    /// A fresh engine with every input given so far.
    fn rebuild(&mut self) {
        let mut engine = Engine::new();
        for (spec, tar) in &self.packages {
            let _ = engine.add_package(spec, tar);
        }
        for (path, data) in &self.files {
            let _ = engine.set_file(path, data);
        }
        for (path, text) in &self.sources {
            let _ = engine.set_source(path, text);
        }
        for (path, prefix) in &self.prefixes {
            let _ = engine.set_prefix(path, prefix);
        }
        self.engine = engine;
    }

    fn set_source(&mut self, path: &str, text: &str) -> CommandResult<()> {
        self.engine
            .set_source(path, text)
            .map_err(|e| e.to_string())?;
        self.sources.insert(path.to_owned(), text.to_owned());
        Ok(())
    }

    fn remove_source(&mut self, path: &str) -> CommandResult<()> {
        self.engine.remove_source(path).map_err(|e| e.to_string())?;
        self.sources.remove(path);
        self.prefixes.remove(path);
        Ok(())
    }

    fn set_file(&mut self, path: &str, data: Vec<u8>) -> CommandResult<()> {
        self.engine
            .set_file(path, &data)
            .map_err(|e| e.to_string())?;
        self.files.insert(path.to_owned(), data);
        Ok(())
    }

    /// Compiles `main`, first loading the vault files it read but the engine
    /// lacks (images, data, other `.typ` files) and compiling again with them.
    fn compile(
        &mut self,
        app: &AppHandle,
        main: &str,
        render: bool,
        anchor: Option<PagePoint>,
    ) -> CommandResult<CompileOutput> {
        // Each round loads at least one file, and a file is tried once.
        loop {
            let out = self
                .engine
                .compile_anchored(main, render, anchor)
                .map_err(|e| e.to_string())?;
            let wanted: Vec<String> = out
                .missing_files
                .iter()
                .filter(|path| !self.absent.contains(*path))
                .cloned()
                .collect();
            if wanted.is_empty() {
                return Ok(out);
            }
            let read: Vec<(String, Option<Vec<u8>>)> = {
                let open = app.state::<OpenVault>();
                let guard = lock(&open);
                wanted
                    .into_iter()
                    .map(|path| {
                        let data = guard.as_ref().and_then(|v| v.read_file(&path).ok());
                        (path, data)
                    })
                    .collect()
            };
            for (path, data) in read {
                match data {
                    None => {
                        self.absent.insert(path);
                    }
                    Some(data) if path.ends_with(".typ") => {
                        let text = String::from_utf8_lossy(&data).into_owned();
                        self.set_source(&path, &text)?;
                    }
                    Some(data) => self.set_file(&path, data)?,
                }
            }
        }
    }
}

/// Runs `f` on the host off the async runtime. A panic rebuilds the engine
/// and comes back as an error.
async fn with_host<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&mut Host, &AppHandle) -> CommandResult<T> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let compiler = app.state::<Compiler>();
        let mut guard = compiler
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let host = guard.get_or_insert_with(Host::new);
        match catch_unwind(AssertUnwindSafe(|| f(host, &app))) {
            Ok(result) => result,
            Err(panic) => {
                let message = panic
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_owned())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".to_owned());
                host.rebuild();
                Err(format!(
                    "the Typst compiler crashed and was restarted: {message}"
                ))
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
pub struct SourceText {
    path: String,
    text: String,
}

#[derive(Deserialize)]
pub struct Anchor {
    page: u32,
    y: f64,
}

#[derive(Deserialize)]
pub struct At {
    line: u32,
    column: u32,
}

impl From<At> for Position {
    fn from(at: At) -> Self {
        Position {
            line: at.line,
            column: at.column,
        }
    }
}

/// `value` without its null fields (recursively), which JS reads as
/// missing (`undefined`) rather than `null`.
fn compact(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k, compact(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(compact).collect()),
        other => other,
    }
}

fn position(p: Position) -> Value {
    json!({ "line": p.line, "column": p.column })
}

#[tauri::command]
pub async fn typst_set_source(app: AppHandle, path: String, text: String) -> CommandResult<()> {
    with_host(app, move |host, _| host.set_source(&path, &text)).await
}

/// Hidden whole lines compiled before `path`'s text (a note's preamble imports).
#[tauri::command]
pub async fn typst_set_prefix(app: AppHandle, path: String, prefix: String) -> CommandResult<()> {
    with_host(app, move |host, _| {
        host.engine
            .set_prefix(&path, &prefix)
            .map_err(|e| e.to_string())?;
        host.prefixes.insert(path, prefix);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn typst_remove_source(app: AppHandle, path: String) -> CommandResult<()> {
    with_host(app, move |host, _| host.remove_source(&path)).await
}

/// Main files whose last compile read `path`.
#[tauri::command]
pub async fn typst_affected_mains(app: AppHandle, path: String) -> CommandResult<Vec<String>> {
    with_host(app, move |host, _| {
        host.engine.affected_mains(&path).map_err(|e| e.to_string())
    })
    .await
}

/// Drops vault file `path` (it changed on disk), so the next compile that
/// reads it loads it again; returns the mains whose last compile read it.
#[tauri::command]
pub async fn typst_forget_file(app: AppHandle, path: String) -> CommandResult<Vec<String>> {
    with_host(app, move |host, _| {
        let mains = host
            .engine
            .affected_mains(&path)
            .map_err(|e| e.to_string())?;
        host.absent.remove(&path);
        host.engine.remove_file(&path).map_err(|e| e.to_string())?;
        host.files.remove(&path);
        if path.ends_with(".typ") {
            host.remove_source(&path)?;
        }
        Ok(mains)
    })
    .await
}

/// Loads a package: the raw body is its uncompressed tar archive, the spec
/// is in the `x-package-spec` header.
#[tauri::command]
pub async fn typst_add_package(app: AppHandle, request: Request<'_>) -> CommandResult<()> {
    let InvokeBody::Raw(tar) = request.body() else {
        return Err("expected a raw package body".into());
    };
    let spec = request
        .headers()
        .get("x-package-spec")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-package-spec header")?
        .to_owned();
    let tar = tar.clone();
    with_host(app, move |host, _| {
        host.engine
            .add_package(&spec, &tar)
            .map_err(|e| e.to_string())?;
        host.packages.insert(spec, tar);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn typst_has_package(app: AppHandle, spec: String) -> CommandResult<bool> {
    with_host(app, move |host, _| Ok(host.engine.has_package(&spec))).await
}

/// Compiles `main` (replacing `source` first, saving a round trip). The body
/// is a little-endian `u32` header length, the JSON header, then the new
/// bands' SVG back to back (UTF-8; each band's `end` says where it stops,
/// and a band sent before ends where the previous one does).
#[tauri::command]
pub async fn typst_compile(
    app: AppHandle,
    main: String,
    render: bool,
    source: Option<SourceText>,
    anchor: Option<Anchor>,
) -> CommandResult<Response> {
    with_host(app, move |host, app| {
        if let Some(source) = source {
            host.set_source(&source.path, &source.text)?;
        }
        let anchor = anchor.map(|a| PagePoint {
            page: a.page,
            x: 0.0,
            y: a.y,
        });
        let out = host.compile(app, &main, render, anchor)?;
        Ok(Response::new(encode_compile(out)))
    })
    .await
}

fn encode_compile(out: CompileOutput) -> Vec<u8> {
    let mut svg = Vec::new();
    let pages = out.pages.map(|pages| {
        pages
            .into_iter()
            .map(|page| {
                let bands: Vec<Value> = page
                    .bands
                    .into_iter()
                    .map(|band| {
                        if let Some(text) = band.svg {
                            svg.extend_from_slice(text.as_bytes());
                        }
                        json!({
                            "top": band.top,
                            "height": band.height,
                            "key": format!("{:x}", band.key),
                            "end": svg.len(),
                        })
                    })
                    .collect();
                json!({
                    "width": page.width,
                    "height": page.height,
                    "background": page.background,
                    "bands": bands,
                })
            })
            .collect::<Vec<_>>()
    });
    let diagnostics: Vec<Value> = out
        .diagnostics
        .into_iter()
        .map(|d| {
            compact(json!({
                "severity": match d.severity {
                    Severity::Error => "error",
                    Severity::Warning => "warning",
                },
                "message": d.message,
                "hints": d.hints,
                "path": d.path,
                "range": d.range.map(|r| json!({
                    "start": position(r.start),
                    "end": position(r.end),
                })),
            }))
        })
        .collect();
    let header = json!({
        "pages": pages,
        "anchor": out.anchor.map(|a| json!({ "page": a.page, "x": a.x, "y": a.y })),
        "diagnostics": diagnostics,
        "missingPackages": out.missing_packages,
        "compileMs": out.compile_ms,
        "renderMs": out.render_ms,
    });
    let header = serde_json::to_vec(&header).unwrap_or_default();
    let mut body = Vec::with_capacity(4 + header.len() + svg.len());
    body.extend_from_slice(&(header.len() as u32).to_le_bytes());
    body.extend_from_slice(&header);
    body.extend_from_slice(&svg);
    body
}

/// Typst completions for `text` (the editor's contents of `path`) at
/// `position`, compiled as part of `main`.
#[tauri::command]
pub async fn typst_complete(
    app: AppHandle,
    main: String,
    path: String,
    text: String,
    position: At,
    explicit: bool,
) -> CommandResult<Option<Value>> {
    with_host(app, move |host, _| {
        let found = host
            .engine
            .complete(&main, &path, &text, position.into(), explicit)
            .map_err(|e| e.to_string())?;
        Ok(found.map(|found| {
            compact(json!({
                "from": self::position(found.from),
                "items": found.items.into_iter().map(|item| json!({
                    "kind": item.kind,
                    "label": item.label,
                    "apply": item.apply,
                    "detail": item.detail,
                })).collect::<Vec<_>>(),
            }))
        }))
    })
    .await
}

/// What hovering `position` in `text` shows; `before`: the pointer is on
/// the character before it.
#[tauri::command]
pub async fn typst_tooltip(
    app: AppHandle,
    main: String,
    path: String,
    text: String,
    position: At,
    before: bool,
) -> CommandResult<Option<Value>> {
    with_host(app, move |host, _| {
        let found = host
            .engine
            .tooltip(&main, &path, &text, position.into(), before)
            .map_err(|e| e.to_string())?;
        Ok(found.map(|h| json!({ "code": h.code, "text": h.text })))
    })
    .await
}

/// Signature help for the call around `position` in `text`.
#[tauri::command]
pub async fn typst_signature(
    app: AppHandle,
    main: String,
    path: String,
    text: String,
    position: At,
) -> CommandResult<Option<Value>> {
    with_host(app, move |host, _| {
        let found = host
            .engine
            .signature(&main, &path, &text, position.into())
            .map_err(|e| e.to_string())?;
        Ok(found.map(|sig| {
            compact(json!({
                "name": sig.name,
                "docs": sig.docs,
                "active": sig.active,
                "params": sig.params.into_iter().map(|p| json!({
                    "name": p.name,
                    "types": p.types,
                    "docs": p.docs,
                    "named": p.named,
                    "positional": p.positional,
                    "required": p.required,
                    "variadic": p.variadic,
                    "default": p.default,
                })).collect::<Vec<_>>(),
            }))
        }))
    })
    .await
}

/// The source behind a click on page `page` at (`x`, `y`) points.
#[tauri::command]
pub async fn typst_jump_from_click(
    app: AppHandle,
    main: String,
    page: u32,
    x: f64,
    y: f64,
) -> CommandResult<Option<Value>> {
    with_host(app, move |host, _| {
        let found = host
            .engine
            .jump_from_click(&main, page, x, y)
            .map_err(|e| e.to_string())?;
        Ok(found.map(|l| json!({ "path": l.path, "position": position(l.position) })))
    })
    .await
}

/// Where the text at `position` in `path` appears in `main`'s pages.
#[tauri::command]
pub async fn typst_jump_from_cursor(
    app: AppHandle,
    main: String,
    path: String,
    position: At,
) -> CommandResult<Vec<Value>> {
    with_host(app, move |host, _| {
        let points = host
            .engine
            .jump_from_cursor(&main, &path, position.into())
            .map_err(|e| e.to_string())?;
        Ok(points
            .into_iter()
            .map(|p| json!({ "page": p.page, "x": p.x, "y": p.y }))
            .collect())
    })
    .await
}

/// The string metadata labelled `label` in `main`'s last good compile.
#[tauri::command]
pub async fn typst_metadata_text(
    app: AppHandle,
    main: String,
    label: String,
) -> CommandResult<Option<String>> {
    with_host(app, move |host, _| {
        host.engine
            .metadata_text(&main, &label)
            .map_err(|e| e.to_string())
    })
    .await
}

/// Compiles a throwaway main file and forgets it again (e.g. to render one
/// bibliography entry); `pages` is empty without `render` or on errors.
#[tauri::command]
pub async fn typst_standalone(
    app: AppHandle,
    path: String,
    text: String,
    render: bool,
) -> CommandResult<Value> {
    with_host(app, move |host, app| {
        host.set_source(&path, &text)?;
        let result = (|| {
            let out = host.compile(app, &path, false, None)?;
            let errors: Vec<String> = out
                .diagnostics
                .into_iter()
                .filter(|d| d.severity == Severity::Error)
                .map(|d| d.message)
                .collect();
            let pages = if render && errors.is_empty() {
                host.engine.page_svgs(&path).map_err(|e| e.to_string())?
            } else {
                Vec::new()
            };
            Ok(json!({ "pages": pages, "errors": errors }))
        })();
        host.remove_source(&path)?;
        result
    })
    .await
}

/// Where citations (and, without a key, cross-references) start in `main`'s
/// last good layout.
#[tauri::command]
pub async fn typst_citation_marks(app: AppHandle, main: String) -> CommandResult<Vec<Value>> {
    with_host(app, move |host, _| {
        let marks = host
            .engine
            .citation_marks(&main)
            .map_err(|e| e.to_string())?;
        Ok(marks
            .into_iter()
            .map(|m| json!({ "key": m.key, "page": m.page, "x": m.x, "y": m.y }))
            .collect())
    })
    .await
}

/// Typst's built-in citation styles.
#[tauri::command]
pub fn typst_citation_styles() -> Vec<Value> {
    sliver_typst::citation_styles()
        .into_iter()
        .map(|(name, label)| json!({ "name": name, "label": label }))
        .collect()
}
