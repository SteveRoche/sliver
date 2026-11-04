use wasm_bindgen::prelude::*;

use crate::{CompileOutput, Engine};

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
}
