//! The engine for JS. Results cross the boundary as flat arrays of numbers
//! and strings on one object, never as nested wasm objects: every nested
//! object would need its own `free()`, and every getter on one copies.

use wasm_bindgen::prelude::*;

use crate::{Engine, PagePoint, Position, Severity};

/// Marks a missing number in the flat arrays below.
const NONE: u32 = u32::MAX;

#[wasm_bindgen]
pub struct Compiler(Engine);

/// A compile. Diagnostic `i` is `diagnosticMessages[i]` and so on; its range
/// is `diagnosticRanges[4i..4i+4]` (start line and column, end line and
/// column; `NONE` without one) and its hints come next in `diagnosticHints`,
/// `diagnosticHintCounts[i]` of them.
#[wasm_bindgen(getter_with_clone)]
pub struct Compiled {
    /// Whether pages were rendered; if not (failed, or not asked for), the
    /// previous pages still stand.
    pub rendered: bool,
    /// Width and height of each page in points, back to back.
    #[wasm_bindgen(js_name = pageSizes)]
    pub page_sizes: Vec<f64>,
    /// Each page's background (its fill) as SVG.
    pub backgrounds: Vec<String>,
    /// How many bands each page has; the bands of all pages follow each
    /// other in the arrays below.
    #[wasm_bindgen(js_name = bandCounts)]
    pub band_counts: Vec<u32>,
    /// Each band's top and height in points, back to back.
    #[wasm_bindgen(js_name = bandRects)]
    pub band_rects: Vec<f64>,
    /// Each band's key (hex); equal keys render the same.
    #[wasm_bindgen(js_name = bandKeys)]
    pub band_keys: Vec<String>,
    /// The bands' SVG as UTF-8, back to back. A band sent before (same key
    /// in the last render) has none: it ends where the previous one does.
    pub svg: Vec<u8>,
    /// Where each band's SVG ends in `svg`.
    #[wasm_bindgen(js_name = svgEnds)]
    pub svg_ends: Vec<u32>,
    /// Where the anchor passed to `compile` is now (see
    /// [`crate::Engine::compile_anchored`]): page, or `NONE`, and y.
    #[wasm_bindgen(js_name = anchorPage)]
    pub anchor_page: u32,
    #[wasm_bindgen(js_name = anchorY)]
    pub anchor_y: f64,
    /// 0 for an error, 1 for a warning.
    #[wasm_bindgen(js_name = diagnosticSeverities)]
    pub diagnostic_severities: Vec<u8>,
    #[wasm_bindgen(js_name = diagnosticMessages)]
    pub diagnostic_messages: Vec<String>,
    /// Empty when the diagnostic has no file.
    #[wasm_bindgen(js_name = diagnosticPaths)]
    pub diagnostic_paths: Vec<String>,
    #[wasm_bindgen(js_name = diagnosticRanges)]
    pub diagnostic_ranges: Vec<u32>,
    #[wasm_bindgen(js_name = diagnosticHints)]
    pub diagnostic_hints: Vec<String>,
    #[wasm_bindgen(js_name = diagnosticHintCounts)]
    pub diagnostic_hint_counts: Vec<u32>,
    #[wasm_bindgen(js_name = missingPackages)]
    pub missing_packages: Vec<String>,
    #[wasm_bindgen(js_name = compileMs)]
    pub compile_ms: f64,
    #[wasm_bindgen(js_name = renderMs)]
    pub render_ms: f64,
}

/// Completions replacing the text from (`fromLine`, `fromColumn`) to the
/// cursor; item `i` is `kinds[i]`, `labels[i]` and so on (`details[i]` is
/// empty without one).
#[wasm_bindgen(getter_with_clone)]
pub struct CompletionList {
    #[wasm_bindgen(js_name = fromLine)]
    pub from_line: u32,
    #[wasm_bindgen(js_name = fromColumn)]
    pub from_column: u32,
    pub kinds: Vec<String>,
    pub labels: Vec<String>,
    pub applies: Vec<String>,
    pub details: Vec<String>,
}

/// A hover tooltip: Typst `code` (e.g. a value) or Markdown docs.
#[wasm_bindgen(getter_with_clone)]
pub struct HoverInfo {
    pub code: bool,
    pub text: String,
}

/// Signature help; parameter `i` is `paramNames[i]` and so on. Empty strings
/// stand for missing docs and defaults; `paramFlags` holds `PARAM_*` bits.
#[wasm_bindgen(getter_with_clone)]
pub struct SignatureInfo {
    pub name: String,
    pub docs: String,
    /// Index of the parameter at the cursor, or -1.
    pub active: i32,
    #[wasm_bindgen(js_name = paramNames)]
    pub param_names: Vec<String>,
    #[wasm_bindgen(js_name = paramTypes)]
    pub param_types: Vec<String>,
    #[wasm_bindgen(js_name = paramDocs)]
    pub param_docs: Vec<String>,
    #[wasm_bindgen(js_name = paramDefaults)]
    pub param_defaults: Vec<String>,
    #[wasm_bindgen(js_name = paramFlags)]
    pub param_flags: Vec<u8>,
}

pub const PARAM_NAMED: u8 = 1;
pub const PARAM_POSITIONAL: u8 = 2;
pub const PARAM_REQUIRED: u8 = 4;
pub const PARAM_VARIADIC: u8 = 8;

#[wasm_bindgen(getter_with_clone)]
pub struct Location {
    pub path: String,
    pub line: u32,
    pub column: u32,
}

/// Where citations start: mark `i` is `keys[i]` (empty for a
/// cross-reference) on page `pages[i]` at `points[2i..2i+2]`.
#[wasm_bindgen(getter_with_clone)]
pub struct CitationMarks {
    pub keys: Vec<String>,
    pub pages: Vec<u32>,
    pub points: Vec<f64>,
}

/// Typst's built-in citation styles: `names[i]` is accepted as a style,
/// `labels[i]` describes it.
#[wasm_bindgen(getter_with_clone)]
pub struct StyleList {
    pub names: Vec<String>,
    pub labels: Vec<String>,
}

#[wasm_bindgen(js_name = citationStyles)]
pub fn citation_styles() -> StyleList {
    let (names, labels) = crate::citation_styles().into_iter().unzip();
    StyleList { names, labels }
}

#[wasm_bindgen]
impl Compiler {
    #[wasm_bindgen(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self(Engine::new())
    }

    #[wasm_bindgen(js_name = setSource)]
    pub fn set_source(&mut self, path: &str, text: &str) -> Result<(), JsError> {
        Ok(self.0.set_source(path, text)?)
    }

    #[wasm_bindgen(js_name = setPrefix)]
    pub fn set_prefix(&mut self, path: &str, prefix: &str) -> Result<(), JsError> {
        Ok(self.0.set_prefix(path, prefix)?)
    }

    #[wasm_bindgen(js_name = removeSource)]
    pub fn remove_source(&mut self, path: &str) -> Result<(), JsError> {
        Ok(self.0.remove_source(path)?)
    }

    #[wasm_bindgen(js_name = affectedMains)]
    pub fn affected_mains(&self, path: &str) -> Result<Vec<String>, JsError> {
        Ok(self.0.affected_mains(path)?)
    }

    /// Loads a package from its uncompressed tar archive.
    #[wasm_bindgen(js_name = addPackage)]
    pub fn add_package(&mut self, spec: &str, tar: &[u8]) -> Result<(), JsError> {
        Ok(self.0.add_package(spec, tar)?)
    }

    #[wasm_bindgen(js_name = hasPackage)]
    pub fn has_package(&self, spec: &str) -> bool {
        self.0.has_package(spec)
    }

    /// See [`crate::Engine::page_svgs`].
    #[wasm_bindgen(js_name = pageSvgs)]
    pub fn page_svgs(&self, main: &str) -> Result<Vec<String>, JsError> {
        Ok(self.0.page_svgs(main)?)
    }

    /// The string metadata labelled `label` in `main`'s last good compile.
    #[wasm_bindgen(js_name = metadataText)]
    pub fn metadata_text(&self, main: &str, label: &str) -> Result<Option<String>, JsError> {
        Ok(self.0.metadata_text(main, label)?)
    }

    /// See [`crate::Engine::citation_marks`].
    #[wasm_bindgen(js_name = citationMarks)]
    pub fn citation_marks(&self, main: &str) -> Result<CitationMarks, JsError> {
        let mut marks = CitationMarks {
            keys: Vec::new(),
            pages: Vec::new(),
            points: Vec::new(),
        };
        for mark in self.0.citation_marks(main)? {
            marks.keys.push(mark.key.unwrap_or_default());
            marks.pages.push(mark.page as u32);
            marks.points.extend([mark.x, mark.y]);
        }
        Ok(marks)
    }

    /// Compiles `main`, following the point (`anchorPage`, `anchorY`) of its
    /// last layout into the new one when given.
    pub fn compile(
        &mut self,
        main: &str,
        render: bool,
        anchor_page: Option<u32>,
        anchor_y: f64,
    ) -> Result<Compiled, JsError> {
        let anchor = anchor_page.map(|page| PagePoint {
            page,
            x: 0.0,
            y: anchor_y,
        });
        let out = self.0.compile_anchored(main, render, anchor)?;
        let mut compiled = Compiled {
            rendered: out.pages.is_some(),
            page_sizes: Vec::new(),
            backgrounds: Vec::new(),
            band_counts: Vec::new(),
            band_rects: Vec::new(),
            band_keys: Vec::new(),
            svg: Vec::new(),
            svg_ends: Vec::new(),
            anchor_page: out.anchor.map_or(NONE, |a| a.page),
            anchor_y: out.anchor.map_or(0.0, |a| a.y),
            diagnostic_severities: Vec::new(),
            diagnostic_messages: Vec::new(),
            diagnostic_paths: Vec::new(),
            diagnostic_ranges: Vec::new(),
            diagnostic_hints: Vec::new(),
            diagnostic_hint_counts: Vec::new(),
            missing_packages: out.missing_packages,
            compile_ms: out.compile_ms,
            render_ms: out.render_ms,
        };
        for page in out.pages.into_iter().flatten() {
            compiled.page_sizes.extend([page.width, page.height]);
            compiled.backgrounds.push(page.background);
            compiled.band_counts.push(page.bands.len() as u32);
            for band in page.bands {
                compiled.band_rects.extend([band.top, band.height]);
                compiled.band_keys.push(format!("{:x}", band.key));
                if let Some(svg) = band.svg {
                    compiled.svg.extend_from_slice(svg.as_bytes());
                }
                compiled.svg_ends.push(compiled.svg.len() as u32);
            }
        }
        for d in out.diagnostics {
            compiled.diagnostic_severities.push(match d.severity {
                Severity::Error => 0,
                Severity::Warning => 1,
            });
            compiled.diagnostic_messages.push(d.message);
            compiled.diagnostic_paths.push(d.path.unwrap_or_default());
            compiled.diagnostic_ranges.extend(match d.range {
                Some(r) => [r.start.line, r.start.column, r.end.line, r.end.column],
                None => [NONE; 4],
            });
            compiled.diagnostic_hint_counts.push(d.hints.len() as u32);
            compiled.diagnostic_hints.extend(d.hints);
        }
        Ok(compiled)
    }

    pub fn complete(
        &self,
        main: &str,
        path: &str,
        text: &str,
        line: u32,
        column: u32,
        explicit: bool,
    ) -> Result<Option<CompletionList>, JsError> {
        let Some(found) = self
            .0
            .complete(main, path, text, Position { line, column }, explicit)?
        else {
            return Ok(None);
        };
        let mut list = CompletionList {
            from_line: found.from.line,
            from_column: found.from.column,
            kinds: Vec::with_capacity(found.items.len()),
            labels: Vec::with_capacity(found.items.len()),
            applies: Vec::with_capacity(found.items.len()),
            details: Vec::with_capacity(found.items.len()),
        };
        for item in found.items {
            list.kinds.push(item.kind);
            list.labels.push(item.label);
            list.applies.push(item.apply);
            list.details.push(item.detail.unwrap_or_default());
        }
        Ok(Some(list))
    }

    /// See [`crate::Engine::tooltip`].
    pub fn tooltip(
        &self,
        main: &str,
        path: &str,
        text: &str,
        line: u32,
        column: u32,
        before: bool,
    ) -> Result<Option<HoverInfo>, JsError> {
        Ok(self
            .0
            .tooltip(main, path, text, Position { line, column }, before)?
            .map(|hover| HoverInfo {
                code: hover.code,
                text: hover.text,
            }))
    }

    pub fn signature(
        &self,
        main: &str,
        path: &str,
        text: &str,
        line: u32,
        column: u32,
    ) -> Result<Option<SignatureInfo>, JsError> {
        let Some(sig) = self
            .0
            .signature(main, path, text, Position { line, column })?
        else {
            return Ok(None);
        };
        let mut info = SignatureInfo {
            name: sig.name,
            docs: sig.docs.unwrap_or_default(),
            active: sig.active.map_or(-1, |a| a as i32),
            param_names: Vec::new(),
            param_types: Vec::new(),
            param_docs: Vec::new(),
            param_defaults: Vec::new(),
            param_flags: Vec::new(),
        };
        for p in sig.params {
            let flag = |on: bool, bit: u8| if on { bit } else { 0 };
            info.param_flags.push(
                flag(p.named, PARAM_NAMED)
                    | flag(p.positional, PARAM_POSITIONAL)
                    | flag(p.required, PARAM_REQUIRED)
                    | flag(p.variadic, PARAM_VARIADIC),
            );
            info.param_names.push(p.name);
            info.param_types.push(p.types);
            info.param_docs.push(p.docs.unwrap_or_default());
            info.param_defaults.push(p.default.unwrap_or_default());
        }
        Ok(Some(info))
    }

    #[wasm_bindgen(js_name = jumpFromClick)]
    pub fn jump_from_click(
        &self,
        main: &str,
        page: u32,
        x: f64,
        y: f64,
    ) -> Result<Option<Location>, JsError> {
        Ok(self.0.jump_from_click(main, page, x, y)?.map(|l| Location {
            path: l.path,
            line: l.position.line,
            column: l.position.column,
        }))
    }

    /// Where the cursor's text appears: `page, x, y` triples.
    #[wasm_bindgen(js_name = jumpFromCursor)]
    pub fn jump_from_cursor(
        &self,
        main: &str,
        path: &str,
        line: u32,
        column: u32,
    ) -> Result<Vec<f64>, JsError> {
        Ok(self
            .0
            .jump_from_cursor(main, path, Position { line, column })?
            .into_iter()
            .flat_map(|p| [p.page as f64, p.x, p.y])
            .collect())
    }
}
