use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::Mutex;

use typst::diag::{FileError, FileResult, PackageError, SourceDiagnostic};
use typst::foundations::{Bytes, CastInfo, Datetime, Duration, Repr, Value};
use typst::introspection::PagedPosition;
use typst::layout::{Abs, Point};
use typst::syntax::package::PackageSpec;
use typst::syntax::{
    DiagSpan, FileId, LinkedNode, RootedPath, Side, Source, SyntaxKind, VirtualPath, VirtualRoot,
    ast,
};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World, WorldExt};
use typst_ide::{CompletionKind, IdeWorld, Jump};
use typst_layout::PagedDocument;
use typst_svg::SvgOptions;

/// Long-lived compiler state shared by every open tab: the file map, fonts and
/// the standard library. Each `compile` call picks one file as the main file.
pub struct Engine {
    library: LazyHash<Library>,
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
    sources: HashMap<FileId, Source>,
    /// Non-UTF-8 files (images, fonts, data) from packages.
    binaries: HashMap<FileId, Bytes>,
    packages: HashSet<PackageSpec>,
    /// Files each main file read during its last compile.
    deps: HashMap<FileId, HashSet<FileId>>,
    /// Each main file's last successful layout, for jumping between source and preview.
    documents: HashMap<FileId, PagedDocument>,
    /// Hidden whole lines compiled before a file's own text (a note's preamble
    /// imports). Positions crossing the API are in the file's own text.
    prefixes: HashMap<FileId, String>,
    /// Hashes of each main file's last rendered pages, so unchanged pages
    /// aren't rendered (or sent) again.
    rendered: HashMap<FileId, Vec<u128>>,
}

#[derive(Debug)]
pub struct InvalidPath(pub String);

impl fmt::Display for InvalidPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid path: {}", self.0)
    }
}

impl std::error::Error for InvalidPath {}

#[derive(Debug)]
pub struct InvalidPackage(pub String);

impl fmt::Display for InvalidPackage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid package: {}", self.0)
    }
}

impl std::error::Error for InvalidPackage {}

#[derive(Debug, Clone)]
pub struct CompileOutput {
    /// One entry per page when the document was rendered: its SVG, or `None`
    /// when the page is unchanged since this main file's last render. `None`
    /// when nothing was rendered (the compile failed, or no render was asked
    /// for), so the previous pages still stand.
    pub pages: Option<Vec<Option<String>>>,
    pub diagnostics: Vec<Diagnostic>,
    /// Packages the document imports that aren't loaded yet, as
    /// `@namespace/name:version`. Load them with `add_package` and recompile.
    pub missing_packages: Vec<String>,
    /// Time spent compiling (parse, evaluate, layout), in milliseconds.
    pub compile_ms: f64,
    /// Time spent rendering pages to SVG, in milliseconds.
    pub render_ms: f64,
}

/// A place in a source file, e.g. where a click in the preview came from.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceLocation {
    pub path: String,
    pub position: Position,
}

/// Completions at a cursor: they replace the text from `from` to the cursor.
#[derive(Debug, Clone, PartialEq)]
pub struct Completions {
    pub from: Position,
    pub items: Vec<CompletionItem>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompletionItem {
    /// `syntax`, `func`, `type`, `param`, `constant`, `path`, `package`,
    /// `label`, `font` or `symbol`.
    pub kind: String,
    pub label: String,
    /// What to insert, possibly with `${placeholder}` snippet fields.
    pub apply: String,
    pub detail: Option<String>,
}

/// A point on a rendered page, in points from its top left.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PagePoint {
    /// Zero-based.
    pub page: u32,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone)]
pub struct Diagnostic {
    pub severity: Severity,
    pub message: String,
    pub hints: Vec<String>,
    pub path: Option<String>,
    pub range: Option<TextRange>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextRange {
    pub start: Position,
    pub end: Position,
}

/// Zero-based; `column` counts UTF-16 code units to match JS strings and CodeMirror.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Position {
    pub line: u32,
    pub column: u32,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    pub fn new() -> Self {
        let fonts: Vec<Font> = typst_assets::fonts()
            .flat_map(|data| Font::iter(Bytes::new(data)))
            .collect();
        Self {
            library: LazyHash::new(Library::default()),
            book: LazyHash::new(FontBook::from_fonts(&fonts)),
            fonts,
            sources: HashMap::new(),
            binaries: HashMap::new(),
            packages: HashSet::new(),
            deps: HashMap::new(),
            documents: HashMap::new(),
            prefixes: HashMap::new(),
            rendered: HashMap::new(),
        }
    }

    /// Adds or replaces a source file. Replacing reparses incrementally.
    pub fn set_source(&mut self, path: &str, text: &str) -> Result<(), InvalidPath> {
        let id = file_id(path)?;
        let full = self.with_prefix(id, text);
        match self.sources.get_mut(&id) {
            Some(source) => {
                source.replace(&full);
            }
            None => {
                self.sources.insert(id, Source::new(id, full));
            }
        }
        Ok(())
    }

    /// Sets the hidden lines compiled before `path`'s text, e.g. a note's
    /// preamble imports. A non-empty prefix gets a final newline, so it only
    /// ever shifts the text by whole lines.
    pub fn set_prefix(&mut self, path: &str, prefix: &str) -> Result<(), InvalidPath> {
        let id = file_id(path)?;
        let mut prefix = prefix.to_owned();
        if !prefix.is_empty() && !prefix.ends_with('\n') {
            prefix.push('\n');
        }
        let old = self.prefixes.get(&id).map_or(0, String::len);
        let text = self
            .sources
            .get(&id)
            .map(|source| source.text()[old..].to_owned());
        if prefix.is_empty() {
            self.prefixes.remove(&id);
        } else {
            self.prefixes.insert(id, prefix);
        }
        if let Some(text) = text {
            self.set_source(path, &text)?;
        }
        Ok(())
    }

    fn with_prefix(&self, id: FileId, text: &str) -> String {
        match self.prefixes.get(&id) {
            Some(prefix) => format!("{prefix}{text}"),
            None => text.to_owned(),
        }
    }

    /// How many lines of `id`'s source are its hidden prefix.
    fn prefix_lines(&self, id: FileId) -> u32 {
        self.prefixes
            .get(&id)
            .map_or(0, |p| p.matches('\n').count() as u32)
    }

    /// A byte offset in `source` as a position in its file's own text; the
    /// prefix maps to the start.
    fn position_in(&self, source: &Source, byte: usize) -> Option<Position> {
        let position = position_in(source, byte)?;
        let hidden = self.prefix_lines(source.id());
        Some(match position.line.checked_sub(hidden) {
            Some(line) => Position {
                line,
                column: position.column,
            },
            None => Position { line: 0, column: 0 },
        })
    }

    /// A position in a file's own text as a byte offset in its `source`.
    fn offset_in(&self, source: &Source, position: Position) -> Option<usize> {
        offset_in(
            source,
            Position {
                line: position.line + self.prefix_lines(source.id()),
                column: position.column,
            },
        )
    }

    pub fn remove_source(&mut self, path: &str) -> Result<(), InvalidPath> {
        let id = file_id(path)?;
        self.sources.remove(&id);
        self.prefixes.remove(&id);
        self.deps.remove(&id);
        self.documents.remove(&id);
        self.rendered.remove(&id);
        Ok(())
    }

    /// Loads a package from its uncompressed tar archive.
    pub fn add_package(&mut self, spec: &str, tar: &[u8]) -> Result<(), InvalidPackage> {
        let spec: PackageSpec = spec
            .parse()
            .map_err(|e| InvalidPackage(format!("{spec}: {e}")))?;
        let entries =
            crate::tar::entries(tar).map_err(|e| InvalidPackage(format!("{spec}: {e}")))?;
        for (path, data) in entries {
            let vpath =
                VirtualPath::new(&path).map_err(|_| InvalidPackage(format!("{spec}: {path}")))?;
            let id = RootedPath::new(VirtualRoot::Package(spec.clone()), vpath).intern();
            match std::str::from_utf8(data) {
                Ok(text) => {
                    self.sources.insert(id, Source::new(id, text.to_owned()));
                }
                Err(_) => {
                    self.binaries.insert(id, Bytes::new(data.to_vec()));
                }
            }
        }
        self.packages.insert(spec);
        Ok(())
    }

    pub fn has_package(&self, spec: &str) -> bool {
        spec.parse::<PackageSpec>()
            .is_ok_and(|spec| self.packages.contains(&spec))
    }

    /// Main files whose last compile read `path`, i.e. the tabs to recompile
    /// after it changes.
    pub fn affected_mains(&self, path: &str) -> Result<Vec<String>, InvalidPath> {
        let id = file_id(path)?;
        Ok(self
            .deps
            .iter()
            .filter(|(_, deps)| deps.contains(&id))
            .map(|(main, _)| path_of(*main))
            .collect())
    }

    /// Compiles `main`. With `render`, pages that changed since its last
    /// render are rendered to SVG; without, only diagnostics come back (for a
    /// preview that isn't on screen).
    pub fn compile(&mut self, main: &str, render: bool) -> Result<CompileOutput, InvalidPath> {
        let main = file_id(main)?;
        let world = self.world(main);

        let started = now_ms();
        let warned = typst::compile::<PagedDocument>(&world);
        let compiled = now_ms();
        let mut diagnostics: Vec<Diagnostic> = warned
            .warnings
            .iter()
            .map(|d| convert_diagnostic(&world, d))
            .collect();
        let document = match warned.output {
            Ok(document) => Some(document),
            Err(errors) => {
                diagnostics.extend(errors.iter().map(|d| convert_diagnostic(&world, d)));
                None
            }
        };
        let pages = document.as_ref().filter(|_| render).map(|document| {
            let opts = SvgOptions::default();
            let previous = self.rendered.get(&main);
            let hashes: Vec<u128> = document.pages().iter().map(typst::utils::hash128).collect();
            let pages = document
                .pages()
                .iter()
                .zip(&hashes)
                .enumerate()
                .map(|(i, (page, hash))| {
                    let unchanged = previous.and_then(|p| p.get(i)) == Some(hash);
                    (!unchanged).then(|| typst_svg::svg(page, &opts))
                })
                .collect();
            (pages, hashes)
        });
        let rendered = now_ms();

        let mut missing_packages: Vec<String> = world
            .missing
            .into_inner()
            .unwrap_or_default()
            .iter()
            .map(ToString::to_string)
            .collect();
        missing_packages.sort();
        let accessed = world.accessed.into_inner().unwrap_or_default();
        self.deps.insert(main, accessed);
        let pages = pages.map(|(pages, hashes)| {
            self.rendered.insert(main, hashes);
            pages
        });
        // A failed compile keeps the last good layout, which the preview still shows.
        if let Some(document) = document {
            self.documents.insert(main, document);
        }
        typst::comemo::evict(10);

        Ok(CompileOutput {
            pages,
            diagnostics,
            missing_packages,
            compile_ms: compiled - started,
            render_ms: rendered - compiled,
        })
    }

    /// The source location behind a click at (`x`, `y`) points on page
    /// `page` (zero-based) of `main`'s last layout. Links and blank space
    /// have none.
    pub fn jump_from_click(
        &self,
        main: &str,
        page: u32,
        x: f64,
        y: f64,
    ) -> Result<Option<SourceLocation>, InvalidPath> {
        let main = file_id(main)?;
        let Some(document) = self.documents.get(&main) else {
            return Ok(None);
        };
        let Some(page) = std::num::NonZeroUsize::new(page as usize + 1) else {
            return Ok(None);
        };
        let position = PagedPosition {
            page,
            point: Point::new(Abs::pt(x), Abs::pt(y)),
        };
        let world = self.world(main);
        let Some(Jump::File(id, offset)) = typst_ide::jump_from_click(&world, document, &position)
        else {
            return Ok(None);
        };
        Ok(self.sources.get(&id).and_then(|source| {
            Some(SourceLocation {
                path: path_of(id),
                position: self.position_in(source, offset)?,
            })
        }))
    }

    /// Where the text at `position` in `path` appears in `main`'s last layout.
    pub fn jump_from_cursor(
        &self,
        main: &str,
        path: &str,
        position: Position,
    ) -> Result<Vec<PagePoint>, InvalidPath> {
        let main = file_id(main)?;
        let id = file_id(path)?;
        let (Some(document), Some(source)) = (self.documents.get(&main), self.sources.get(&id))
        else {
            return Ok(Vec::new());
        };
        let Some(offset) = self.offset_in(source, position) else {
            return Ok(Vec::new());
        };
        Ok(typst_ide::jump_from_cursor(document, source, offset)
            .into_iter()
            .map(|p| PagePoint {
                page: p.page.get() as u32 - 1,
                x: p.point.x.to_pt(),
                y: p.point.y.to_pt(),
            })
            .collect())
    }

    /// Typst completions for `text` (the current, possibly uncompiled
    /// contents of `path`) at `position`, compiled as part of `main`.
    /// `explicit` is a user request (e.g. Ctrl+Space) rather than typing.
    pub fn complete(
        &self,
        main: &str,
        path: &str,
        text: &str,
        position: Position,
        explicit: bool,
    ) -> Result<Option<Completions>, InvalidPath> {
        let main = file_id(main)?;
        let id = file_id(path)?;
        let source = Source::new(id, self.with_prefix(id, text));
        let Some(cursor) = self.offset_in(&source, position) else {
            return Ok(None);
        };
        let world = self.world_with(main, Some(source.clone()));
        let Some((from, completions)) =
            typst_ide::autocomplete(&world, self.documents.get(&main), &source, cursor, explicit)
        else {
            return Ok(None);
        };
        let Some(from) = self.position_in(&source, from) else {
            return Ok(None);
        };
        let items = completions
            .into_iter()
            .map(|c| {
                let kind = match &c.kind {
                    CompletionKind::Syntax => "syntax",
                    CompletionKind::Func => "func",
                    CompletionKind::Type => "type",
                    CompletionKind::Param => "param",
                    CompletionKind::Constant => "constant",
                    CompletionKind::Path => "path",
                    CompletionKind::Package => "package",
                    CompletionKind::Label => "label",
                    CompletionKind::Font => "font",
                    CompletionKind::Symbol(_) => "symbol",
                };
                let detail = match (&c.kind, c.detail) {
                    (CompletionKind::Symbol(glyph), None) => Some(glyph.to_string()),
                    (_, detail) => detail.map(|d| d.to_string()),
                };
                CompletionItem {
                    kind: kind.to_owned(),
                    apply: c.apply.unwrap_or_else(|| c.label.clone()).to_string(),
                    label: c.label.to_string(),
                    detail,
                }
            })
            .collect();
        Ok(Some(Completions { from, items }))
    }

    /// The function call whose parentheses hold `position` in `text` (the
    /// current contents of `path`), with its parameters and which one the
    /// cursor is on: signature help.
    pub fn signature(
        &self,
        main: &str,
        path: &str,
        text: &str,
        position: Position,
    ) -> Result<Option<Signature>, InvalidPath> {
        let main = file_id(main)?;
        let id = file_id(path)?;
        let source = Source::new(id, self.with_prefix(id, text));
        let Some(cursor) = self.offset_in(&source, position) else {
            return Ok(None);
        };
        let world = self.world_with(main, Some(source.clone()));
        Ok(signature_at(&world, &source, cursor))
    }

    fn world(&self, main: FileId) -> CompileWorld<'_> {
        self.world_with(main, None)
    }

    /// A world where `overlay` replaces the engine's copy of its file, so
    /// analysis sees the editor's latest text without disturbing compiles.
    fn world_with(&self, main: FileId, overlay: Option<Source>) -> CompileWorld<'_> {
        CompileWorld {
            engine: self,
            main,
            overlay,
            accessed: Mutex::default(),
            missing: Mutex::default(),
        }
    }
}

/// A function's signature, for signature help.
#[derive(Debug, Clone, PartialEq)]
pub struct Signature {
    pub name: String,
    /// The first paragraph of the function's documentation (Markdown).
    pub docs: Option<String>,
    pub params: Vec<ParamDoc>,
    /// Index into `params` of the argument at the cursor.
    pub active: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParamDoc {
    pub name: String,
    /// Accepted types and values, e.g. `length | auto`.
    pub types: String,
    pub docs: Option<String>,
    pub named: bool,
    pub positional: bool,
    pub required: bool,
    pub variadic: bool,
    pub default: Option<String>,
}

fn first_paragraph(docs: &str) -> Option<String> {
    let paragraph = docs.trim().split("\n\n").next()?.trim();
    (!paragraph.is_empty()).then(|| paragraph.replace('\n', " "))
}

fn describe_types(info: &CastInfo) -> String {
    const MAX: usize = 6;
    let mut parts: Vec<String> = Vec::new();
    info.walk(|info| {
        let part = match info {
            CastInfo::Any => "any".to_owned(),
            CastInfo::Value(value, _) => value.repr().to_string(),
            CastInfo::Type(ty) => ty.to_string(),
            CastInfo::Union(_) => return,
        };
        if !parts.contains(&part) {
            parts.push(part);
        }
    });
    if parts.len() > MAX {
        parts.truncate(MAX);
        parts.push("…".to_owned());
    }
    parts.join(" | ")
}

/// `name` or `module.name` from the standard library (markup and math scopes).
fn library_value(world: &CompileWorld, node: &LinkedNode) -> Option<Value> {
    let library = world.library();
    let lookup = |name: &str| {
        [&library.global, &library.math]
            .into_iter()
            .find_map(|module| module.scope().get(name))
            .map(|binding| binding.read().clone())
    };
    match node.cast::<ast::Expr>()? {
        ast::Expr::Ident(ident) => lookup(ident.get()),
        ast::Expr::MathIdent(ident) => lookup(ident.get()),
        ast::Expr::FieldAccess(access) => {
            let ast::Expr::Ident(target) = access.target() else {
                return None;
            };
            let field = access.field();
            lookup(target.get())?
                .scope()?
                .get(field.get())
                .map(|binding| binding.read().clone())
        }
        _ => None,
    }
}

fn signature_at(world: &CompileWorld, source: &Source, cursor: usize) -> Option<Signature> {
    let root = LinkedNode::new(source.root());
    // Whitespace typed after an unclosed `(` ends up outside the call's
    // node, so look for the call from before it.
    let probe = source.text()[..cursor].trim_end().len();
    let leaf = root.leaf_at(probe, Side::Before)?;
    // The innermost call whose parentheses contain the cursor. An unclosed
    // `(` parses as an error node.
    let args = std::iter::successors(Some(leaf), |node| node.parent().cloned()).find(|node| {
        if node.kind() != SyntaxKind::Args || node.parent_kind() != Some(SyntaxKind::FuncCall) {
            return false;
        }
        let open = node.children().find(|c| {
            c.kind() == SyntaxKind::LeftParen
                || (c.kind() == SyntaxKind::Error && c.leaf_text() == "(")
        });
        let close = node.children().find(|c| c.kind() == SyntaxKind::RightParen);
        open.is_some_and(|open| cursor >= open.range().end)
            && close.is_none_or(|close| cursor <= close.range().start)
    })?;
    let callee = args.parent()?.children().next()?;
    // Tracing needs a document that evaluates; while the call is still
    // being typed it usually doesn't, so fall back to the standard library.
    let func = typst_ide::analyze_expr(world, &callee)
        .into_iter()
        .map(|(value, _)| value)
        .chain(library_value(world, &callee))
        .find_map(|value| match value {
            Value::Func(func) => Some(func),
            _ => None,
        })?;

    let params: Vec<ParamDoc> = func
        .params()
        .map(|param| {
            let native = param.to_native();
            ParamDoc {
                name: param.name().unwrap_or("..").to_owned(),
                types: native.map(|n| describe_types(&n.input)).unwrap_or_default(),
                docs: native.and_then(|n| first_paragraph(n.docs)),
                named: param.named(),
                positional: param.positional(),
                required: param.required(),
                variadic: param.variadic(),
                default: param.default().map(|d| d.repr().to_string()),
            }
        })
        .collect();

    // Which argument the cursor is in: a named one by its name, else the
    // number of positional arguments before it.
    let mut positional_before = 0;
    let mut segment_positional = false;
    let mut segment_named: Option<String> = None;
    for child in args.children() {
        if child.range().start >= cursor {
            break;
        }
        match child.kind() {
            SyntaxKind::LeftParen | SyntaxKind::RightParen => {}
            SyntaxKind::Comma => {
                if segment_positional {
                    positional_before += 1;
                }
                segment_positional = false;
                segment_named = None;
            }
            SyntaxKind::Named => {
                segment_named = child
                    .cast::<ast::Named>()
                    .map(|named| named.name().get().to_string());
            }
            kind if kind.is_trivia() => {}
            _ => segment_positional = true,
        }
    }
    let active = match segment_named {
        Some(name) => params.iter().position(|p| p.name == name),
        None => {
            let positional: Vec<usize> = (0..params.len())
                .filter(|&i| params[i].positional)
                .collect();
            positional
                .get(positional_before)
                .or_else(|| positional.last().filter(|&&i| params[i].variadic))
                .copied()
        }
    };

    Some(Signature {
        name: func.name().unwrap_or("function").to_owned(),
        docs: func.docs().and_then(first_paragraph),
        params,
        active: active.map(|i| i as u32),
    })
}

/// Milliseconds from an arbitrary start, for timing compiles.
#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
    use wasm_bindgen::prelude::wasm_bindgen;
    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = performance, js_name = now)]
        fn performance_now() -> f64;
    }
    performance_now()
}

#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

fn position_in(source: &Source, byte: usize) -> Option<Position> {
    let lines = source.lines();
    let line = lines.byte_to_line(byte)?;
    let line_start = lines.line_to_byte(line)?;
    let column = lines.byte_to_utf16(byte)? - lines.byte_to_utf16(line_start)?;
    Some(Position {
        line: line as u32,
        column: column as u32,
    })
}

fn offset_in(source: &Source, position: Position) -> Option<usize> {
    let lines = source.lines();
    let line_start = lines.line_to_byte(position.line as usize)?;
    let utf16 = lines.byte_to_utf16(line_start)? + position.column as usize;
    lines.utf16_to_byte(utf16)
}

fn file_id(path: &str) -> Result<FileId, InvalidPath> {
    let vpath = VirtualPath::new(path).map_err(|_| InvalidPath(path.to_owned()))?;
    Ok(RootedPath::new(VirtualRoot::Project, vpath).intern())
}

fn path_of(id: FileId) -> String {
    id.vpath().get_with_slash().to_owned()
}

fn convert_diagnostic(world: &CompileWorld, diag: &SourceDiagnostic) -> Diagnostic {
    Diagnostic {
        severity: match diag.severity {
            typst::diag::Severity::Error => Severity::Error,
            typst::diag::Severity::Warning => Severity::Warning,
        },
        message: diag.message.to_string(),
        hints: diag.hints.iter().map(|h| h.v.to_string()).collect(),
        path: diag.span.id().map(path_of),
        range: text_range(world, diag.span),
    }
}

fn text_range(world: &CompileWorld, span: DiagSpan) -> Option<TextRange> {
    let source = world.engine.sources.get(&span.id()?)?;
    let bytes = world.range(span)?;
    Some(TextRange {
        start: world.engine.position_in(source, bytes.start)?,
        end: world.engine.position_in(source, bytes.end)?,
    })
}

struct CompileWorld<'a> {
    engine: &'a Engine,
    main: FileId,
    overlay: Option<Source>,
    accessed: Mutex<HashSet<FileId>>,
    missing: Mutex<HashSet<PackageSpec>>,
}

impl CompileWorld<'_> {
    fn record(&self, id: FileId) {
        if let Ok(mut accessed) = self.accessed.lock() {
            accessed.insert(id);
        }
    }

    fn not_found(&self, id: FileId) -> FileError {
        if let VirtualRoot::Package(spec) = id.root()
            && !self.engine.packages.contains(spec)
        {
            if let Ok(mut missing) = self.missing.lock() {
                missing.insert(spec.clone());
            }
            return FileError::Package(PackageError::NotFound(spec.clone()));
        }
        FileError::NotFound(id.vpath().get_without_slash().into())
    }

    fn lookup(&self, id: FileId) -> FileResult<&Source> {
        self.record(id);
        if let Some(overlay) = self.overlay.as_ref().filter(|s| s.id() == id) {
            return Ok(overlay);
        }
        self.engine
            .sources
            .get(&id)
            .ok_or_else(|| self.not_found(id))
    }
}

impl IdeWorld for CompileWorld<'_> {
    fn upcast(&self) -> &dyn World {
        self
    }
}

impl World for CompileWorld<'_> {
    fn library(&self) -> &LazyHash<Library> {
        &self.engine.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.engine.book
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        self.lookup(id).cloned()
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if let Some(bytes) = self.engine.binaries.get(&id) {
            self.record(id);
            return Ok(bytes.clone());
        }
        self.lookup(id)
            .map(|source| Bytes::from_string(source.clone()))
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.engine.fonts.get(index).cloned()
    }

    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiles_to_svg_pages() {
        let mut engine = Engine::new();
        engine
            .set_source("/main.typ", "= Hello\n#pagebreak()\nWorld")
            .unwrap();
        let out = engine.compile("/main.typ", true).unwrap();
        assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
        let pages = out.pages.unwrap();
        assert_eq!(pages.len(), 2);
        assert!(pages[0].as_ref().unwrap().starts_with("<svg"));
    }

    #[test]
    fn reports_error_with_utf16_range() {
        let mut engine = Engine::new();
        // U+1D400 is one char but two UTF-16 code units.
        engine
            .set_source("/main.typ", "ok\n\u{1D400} #nope")
            .unwrap();
        let out = engine.compile("/main.typ", true).unwrap();
        assert!(out.pages.is_none());
        let diag = &out.diagnostics[0];
        assert_eq!(diag.severity, Severity::Error);
        assert_eq!(diag.path.as_deref(), Some("/main.typ"));
        let range = diag.range.unwrap();
        assert_eq!(range.start, Position { line: 1, column: 4 });
        assert_eq!(range.end, Position { line: 1, column: 8 });
    }

    #[test]
    fn renders_only_changed_pages() {
        let mut engine = Engine::new();
        engine
            .set_source("/main.typ", "One\n#pagebreak()\nTwo")
            .unwrap();
        assert!(engine.compile("/main.typ", false).unwrap().pages.is_none());
        let first = engine.compile("/main.typ", true).unwrap().pages.unwrap();
        assert!(first.iter().all(Option::is_some));
        engine
            .set_source("/main.typ", "One\n#pagebreak()\nTwo, changed")
            .unwrap();
        let second = engine.compile("/main.typ", true).unwrap().pages.unwrap();
        assert!(second[0].is_none() && second[1].is_some());
        // Forgetting the file forgets what was rendered.
        engine.remove_source("/main.typ").unwrap();
        engine
            .set_source("/main.typ", "One\n#pagebreak()\nTwo, changed")
            .unwrap();
        let again = engine.compile("/main.typ", true).unwrap().pages.unwrap();
        assert!(again.iter().all(Option::is_some));
    }

    #[test]
    fn missing_main_is_a_diagnostic() {
        let mut engine = Engine::new();
        let out = engine.compile("/absent.typ", true).unwrap();
        assert!(out.pages.is_none());
        assert_eq!(out.diagnostics.len(), 1);
    }

    #[test]
    fn tracks_which_mains_depend_on_a_file() {
        let mut engine = Engine::new();
        engine.set_source("/lib.typ", "#let x = 1").unwrap();
        engine
            .set_source("/a.typ", "#import \"lib.typ\": x\n#x")
            .unwrap();
        engine.set_source("/b.typ", "standalone").unwrap();
        engine.compile("/a.typ", true).unwrap();
        engine.compile("/b.typ", true).unwrap();

        assert_eq!(engine.affected_mains("/lib.typ").unwrap(), vec!["/a.typ"]);
        let mut for_b = engine.affected_mains("/b.typ").unwrap();
        for_b.sort();
        assert_eq!(for_b, vec!["/b.typ"]);
    }

    #[test]
    fn recompiles_after_edit() {
        let mut engine = Engine::new();
        engine.set_source("/main.typ", "#nope").unwrap();
        assert!(engine.compile("/main.typ", true).unwrap().pages.is_none());
        engine.set_source("/main.typ", "fixed").unwrap();
        let out = engine.compile("/main.typ", true).unwrap();
        assert_eq!(out.pages.unwrap().len(), 1);
        assert!(out.diagnostics.is_empty());
    }
    #[test]
    fn reports_and_loads_missing_packages() {
        let mut engine = Engine::new();
        engine
            .set_source(
                "/main.typ",
                "#import \"@preview/demo:0.1.0\": hello\n#hello",
            )
            .unwrap();
        let out = engine.compile("/main.typ", true).unwrap();
        assert!(out.pages.is_none());
        assert_eq!(out.missing_packages, vec!["@preview/demo:0.1.0"]);

        let tar = crate::tar::tests::archive(&[
            (
                "typst.toml",
                "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nentrypoint = \"lib.typ\"\n",
            ),
            ("lib.typ", "#let hello = [Hello]"),
        ]);
        engine.add_package("@preview/demo:0.1.0", &tar).unwrap();
        assert!(engine.has_package("@preview/demo:0.1.0"));
        let out = engine.compile("/main.typ", true).unwrap();
        assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
        assert!(out.missing_packages.is_empty());
        assert_eq!(out.pages.unwrap().len(), 1);
    }

    #[test]
    fn jumps_between_source_and_layout() {
        let mut engine = Engine::new();
        engine
            .set_source(
                "/main.typ",
                "#set page(width: 200pt, height: auto, margin: 10pt)\nFirst line\n\nSecond paragraph",
            )
            .unwrap();
        let out = engine.compile("/main.typ", true).unwrap();
        assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
        assert!(out.compile_ms >= 0.0 && out.render_ms >= 0.0);

        let second = Position { line: 3, column: 3 };
        let points = engine
            .jump_from_cursor("/main.typ", "/main.typ", second)
            .unwrap();
        assert_eq!(points.len(), 1);
        let point = points[0];
        assert_eq!(point.page, 0);

        // Clicking just right of where the cursor maps lands in the same word.
        let back = engine
            .jump_from_click("/main.typ", 0, point.x + 1.0, point.y - 2.0)
            .unwrap()
            .expect("a source location");
        assert_eq!(back.path, "/main.typ");
        assert_eq!(back.position.line, 3);
        assert!(
            engine
                .jump_from_click("/main.typ", 0, 190.0, 1.0)
                .unwrap()
                .is_none(),
            "blank margin"
        );
    }

    #[test]
    fn completes_functions_at_a_hash() {
        let mut engine = Engine::new();
        engine.set_source("/main.typ", "").unwrap();
        let text = "Some text #hea";
        let found = engine
            .complete(
                "/main.typ",
                "/main.typ",
                text,
                Position {
                    line: 0,
                    column: 14,
                },
                false,
            )
            .unwrap()
            .expect("completions after #");
        assert_eq!(
            found.from,
            Position {
                line: 0,
                column: 11
            }
        );
        assert!(
            found
                .items
                .iter()
                .any(|c| c.label == "heading" && c.kind == "func")
        );
    }

    #[test]
    fn prefix_is_hidden_from_positions() {
        let mut engine = Engine::new();
        engine
            .set_source("/lib.typ", "#let shout(x) = upper(x)")
            .unwrap();
        engine
            .set_source(
                "/main.typ",
                "#set page(width: 200pt, height: auto, margin: 10pt)\n#shout[hi] #nope",
            )
            .unwrap();
        engine
            .set_prefix("/main.typ", "#import \"/lib.typ\": *")
            .unwrap();
        let out = engine.compile("/main.typ", true).unwrap();
        // `shout` comes from the prefix; the error is on the text's own line 1.
        assert_eq!(out.diagnostics.len(), 1, "{:?}", out.diagnostics);
        let range = out.diagnostics[0].range.unwrap();
        assert_eq!(
            range.start,
            Position {
                line: 1,
                column: 12
            }
        );

        engine
            .set_source(
                "/main.typ",
                "#set page(width: 200pt, height: auto, margin: 10pt)\n#shout[hi] there",
            )
            .unwrap();
        let out = engine.compile("/main.typ", true).unwrap();
        assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
        let points = engine
            .jump_from_cursor(
                "/main.typ",
                "/main.typ",
                Position {
                    line: 1,
                    column: 13,
                },
            )
            .unwrap();
        let back = engine
            .jump_from_click("/main.typ", 0, points[0].x + 1.0, points[0].y - 2.0)
            .unwrap()
            .expect("a source location");
        assert_eq!(back.position.line, 1);

        let found = engine
            .complete(
                "/main.typ",
                "/main.typ",
                "#sho",
                Position { line: 0, column: 4 },
                false,
            )
            .unwrap()
            .expect("completions");
        assert_eq!(found.from, Position { line: 0, column: 1 });
        assert!(found.items.iter().any(|c| c.label == "shout"));

        engine.set_prefix("/main.typ", "").unwrap();
        let out = engine.compile("/main.typ", true).unwrap();
        assert_eq!(out.diagnostics.len(), 1, "unknown variable: shout");
    }

    #[test]
    fn signature_help_tracks_the_argument() {
        let mut engine = Engine::new();
        engine.set_source("/main.typ", "").unwrap();
        let text = "#rect(10pt, fill: red, ";
        let at = |column| Position { line: 0, column };

        let sig = engine
            .signature("/main.typ", "/main.typ", text, at(7))
            .unwrap()
            .expect("inside rect(");
        assert_eq!(sig.name, "rect");
        assert!(sig.docs.is_some());
        let active = |sig: &Signature| sig.params[sig.active.unwrap() as usize].name.clone();
        assert_eq!(active(&sig), "body", "the first positional parameter");

        let sig = engine
            .signature("/main.typ", "/main.typ", text, at(20))
            .unwrap()
            .unwrap();
        assert_eq!(active(&sig), "fill");
        let fill = sig.params.iter().find(|p| p.name == "fill").unwrap();
        assert!(fill.named && fill.types.contains("color"), "{fill:?}");

        assert!(
            engine
                .signature("/main.typ", "/main.typ", "plain text", at(3))
                .unwrap()
                .is_none()
        );
    }
}
