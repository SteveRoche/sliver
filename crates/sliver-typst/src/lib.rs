//! Typst compilation and rendering for Sliver.
//!
//! Built natively (linked into `src-tauri`) and to `wasm32-unknown-unknown`
//! (live preview in a Web Worker). The output structs are exported to JS
//! directly as wasm-bindgen classes, with no serialization step.

mod engine;
mod tar;
#[cfg(target_arch = "wasm32")]
mod wasm;

pub use engine::{
    CompileOutput, CompletionItem, Completions, Diagnostic, Engine, InvalidPackage, InvalidPath,
    PagePoint, ParamDoc, Position, Severity, Signature, SourceLocation, TextRange,
};
