//! Typst compilation and rendering for Sliver.
//!
//! Native, linked into `src-tauri`, which hosts one long-lived [`Engine`]
//! for every open note (`src-tauri/src/compiler.rs`).

mod bands;
mod engine;
mod tar;
mod text_layer;

pub use engine::{
    CitationMark, CompileOutput, CompletionItem, Completions, Diagnostic, Engine, Hover,
    InvalidPackage, InvalidPath, PagePoint, ParamDoc, Position, RenderedBand, RenderedPage,
    Severity, Signature, SourceLocation, TextRange, citation_styles,
};
