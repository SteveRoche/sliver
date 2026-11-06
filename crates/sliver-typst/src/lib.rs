//! Typst compilation and rendering for Sliver.
//!
//! Built natively (linked into `src-tauri`) and to `wasm32-unknown-unknown`
//! (live preview in a Web Worker). For JS, `wasm.rs` returns each result as
//! one wasm-bindgen class of flat arrays, with no serialization step.

mod bands;
mod engine;
mod tar;
#[cfg(target_arch = "wasm32")]
mod wasm;

pub use engine::{
    CitationMark, CompileOutput, CompletionItem, Completions, Diagnostic, Engine, Hover,
    InvalidPackage, InvalidPath, PagePoint, ParamDoc, Position, RenderedBand, RenderedPage,
    Severity, Signature, SourceLocation, TextRange, citation_styles,
};
