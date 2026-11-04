use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::Mutex;

use typst::diag::{FileError, FileResult, PackageError, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::package::PackageSpec;
use typst::syntax::{DiagSpan, FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World, WorldExt};
use typst_layout::PagedDocument;
use typst_svg::SvgOptions;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::wasm_bindgen;

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

#[cfg_attr(target_arch = "wasm32", wasm_bindgen(getter_with_clone))]
#[derive(Debug, Clone)]
pub struct CompileOutput {
    /// One SVG per page. Empty when compilation failed.
    pub pages: Vec<String>,
    pub diagnostics: Vec<Diagnostic>,
    /// Packages the document imports that aren't loaded yet, as
    /// `@namespace/name:version`. Load them with `add_package` and recompile.
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(js_name = missingPackages))]
    pub missing_packages: Vec<String>,
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen(getter_with_clone))]
#[derive(Debug, Clone)]
pub struct Diagnostic {
    pub severity: Severity,
    pub message: String,
    pub hints: Vec<String>,
    pub path: Option<String>,
    pub range: Option<TextRange>,
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextRange {
    pub start: Position,
    pub end: Position,
}

/// Zero-based; `column` counts UTF-16 code units to match JS strings and CodeMirror.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
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
        }
    }

    /// Adds or replaces a source file. Replacing reparses incrementally.
    pub fn set_source(&mut self, path: &str, text: &str) -> Result<(), InvalidPath> {
        let id = file_id(path)?;
        match self.sources.get_mut(&id) {
            Some(source) => {
                source.replace(text);
            }
            None => {
                self.sources.insert(id, Source::new(id, text.to_owned()));
            }
        }
        Ok(())
    }

    pub fn remove_source(&mut self, path: &str) -> Result<(), InvalidPath> {
        let id = file_id(path)?;
        self.sources.remove(&id);
        self.deps.remove(&id);
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

    pub fn compile(&mut self, main: &str) -> Result<CompileOutput, InvalidPath> {
        let main = file_id(main)?;
        let world = CompileWorld {
            engine: self,
            main,
            accessed: Mutex::default(),
            missing: Mutex::default(),
        };

        let warned = typst::compile::<PagedDocument>(&world);
        let mut diagnostics: Vec<Diagnostic> = warned
            .warnings
            .iter()
            .map(|d| convert_diagnostic(&world, d))
            .collect();
        let pages = match warned.output {
            Ok(document) => {
                let opts = SvgOptions::default();
                document
                    .pages()
                    .iter()
                    .map(|page| typst_svg::svg(page, &opts))
                    .collect()
            }
            Err(errors) => {
                diagnostics.extend(errors.iter().map(|d| convert_diagnostic(&world, d)));
                Vec::new()
            }
        };

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
        typst::comemo::evict(10);

        Ok(CompileOutput {
            pages,
            diagnostics,
            missing_packages,
        })
    }
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
    let lines = source.lines();
    let position = |byte: usize| {
        let line = lines.byte_to_line(byte)?;
        let line_start = lines.line_to_byte(line)?;
        let column = lines.byte_to_utf16(byte)? - lines.byte_to_utf16(line_start)?;
        Some(Position {
            line: line as u32,
            column: column as u32,
        })
    };
    Some(TextRange {
        start: position(bytes.start)?,
        end: position(bytes.end)?,
    })
}

struct CompileWorld<'a> {
    engine: &'a Engine,
    main: FileId,
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
        self.engine
            .sources
            .get(&id)
            .ok_or_else(|| self.not_found(id))
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
        let out = engine.compile("/main.typ").unwrap();
        assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
        assert_eq!(out.pages.len(), 2);
        assert!(out.pages[0].starts_with("<svg"));
    }

    #[test]
    fn reports_error_with_utf16_range() {
        let mut engine = Engine::new();
        // U+1D400 is one char but two UTF-16 code units.
        engine
            .set_source("/main.typ", "ok\n\u{1D400} #nope")
            .unwrap();
        let out = engine.compile("/main.typ").unwrap();
        assert!(out.pages.is_empty());
        let diag = &out.diagnostics[0];
        assert_eq!(diag.severity, Severity::Error);
        assert_eq!(diag.path.as_deref(), Some("/main.typ"));
        let range = diag.range.unwrap();
        assert_eq!(range.start, Position { line: 1, column: 4 });
        assert_eq!(range.end, Position { line: 1, column: 8 });
    }

    #[test]
    fn missing_main_is_a_diagnostic() {
        let mut engine = Engine::new();
        let out = engine.compile("/absent.typ").unwrap();
        assert!(out.pages.is_empty());
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
        engine.compile("/a.typ").unwrap();
        engine.compile("/b.typ").unwrap();

        assert_eq!(engine.affected_mains("/lib.typ").unwrap(), vec!["/a.typ"]);
        let mut for_b = engine.affected_mains("/b.typ").unwrap();
        for_b.sort();
        assert_eq!(for_b, vec!["/b.typ"]);
    }

    #[test]
    fn recompiles_after_edit() {
        let mut engine = Engine::new();
        engine.set_source("/main.typ", "#nope").unwrap();
        assert!(engine.compile("/main.typ").unwrap().pages.is_empty());
        engine.set_source("/main.typ", "fixed").unwrap();
        let out = engine.compile("/main.typ").unwrap();
        assert_eq!(out.pages.len(), 1);
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
        let out = engine.compile("/main.typ").unwrap();
        assert!(out.pages.is_empty());
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
        let out = engine.compile("/main.typ").unwrap();
        assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
        assert!(out.missing_packages.is_empty());
        assert_eq!(out.pages.len(), 1);
    }
}
