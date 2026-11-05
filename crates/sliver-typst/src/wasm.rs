use wasm_bindgen::prelude::*;

use crate::{CompileOutput, Completions, Engine, PagePoint, Position, Signature, SourceLocation};

#[wasm_bindgen]
pub struct Compiler(Engine);

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

    pub fn compile(&mut self, main: &str) -> Result<CompileOutput, JsError> {
        Ok(self.0.compile(main)?)
    }

    pub fn complete(
        &self,
        main: &str,
        path: &str,
        text: &str,
        line: u32,
        column: u32,
        explicit: bool,
    ) -> Result<Option<Completions>, JsError> {
        Ok(self
            .0
            .complete(main, path, text, Position { line, column }, explicit)?)
    }

    pub fn signature(
        &self,
        main: &str,
        path: &str,
        text: &str,
        line: u32,
        column: u32,
    ) -> Result<Option<Signature>, JsError> {
        Ok(self
            .0
            .signature(main, path, text, Position { line, column })?)
    }

    #[wasm_bindgen(js_name = jumpFromClick)]
    pub fn jump_from_click(
        &self,
        main: &str,
        page: u32,
        x: f64,
        y: f64,
    ) -> Result<Option<SourceLocation>, JsError> {
        Ok(self.0.jump_from_click(main, page, x, y)?)
    }

    #[wasm_bindgen(js_name = jumpFromCursor)]
    pub fn jump_from_cursor(
        &self,
        main: &str,
        path: &str,
        line: u32,
        column: u32,
    ) -> Result<Vec<PagePoint>, JsError> {
        Ok(self
            .0
            .jump_from_cursor(main, path, Position { line, column })?)
    }
}
