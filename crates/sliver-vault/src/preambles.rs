//! Preambles: shared Typst code for every note (`common.typ`) and for each
//! kind of note (`kinds/<kind>.typ`), in `.sliver/preambles/`.
//!
//! A preamble reaches a note two ways. Its names (imports, `let`) come from
//! a hidden `#import "...": *` line the engine puts before the note's source
//! ([`note_prefix`]), since Typst modules don't inherit scope. Its styles come
//! from its `template` function, which the preview wrapper applies with
//! `#show:`, since set rules inside an imported module don't reach the
//! importer. So a preamble's top level should hold definitions only; an
//! export that inlines it would otherwise behave differently from the app.

use serde::Serialize;
use typst_syntax::ast;
use typst_syntax::{Lines, LinkedNode};

use crate::header::string_literal;
use crate::paths::relative_paths;

/// The preambles' directory, relative to the vault root.
pub const PREAMBLES_DIR: &str = ".sliver/preambles";
pub const KINDS_DIR: &str = ".sliver/preambles/kinds";
pub const COMMON_FILE: &str = ".sliver/preambles/common.typ";

/// Where the preamble for `kind` (or the common one, for `None`) lives,
/// relative to the vault root.
pub fn preamble_file(kind: Option<&str>) -> String {
    match kind {
        None => COMMON_FILE.to_owned(),
        Some(kind) => format!("{KINDS_DIR}/{kind}.typ"),
    }
}

/// The preamble's path as Typst sees it, with the vault as root.
pub fn preamble_path(kind: Option<&str>) -> String {
    format!("/{}", preamble_file(kind))
}

/// Note templates: what a new note starts with below its header, by
/// default (`default.typ`) or for a kind (`kinds/<kind>.typ`).
pub const TEMPLATES_DIR: &str = ".sliver/templates";

/// The default template a new vault starts with.
pub const DEFAULT_TEMPLATE: &str = "= {{title}}\n";

/// Where the template for `kind` (or the default one, for `None`) lives,
/// relative to the vault root.
pub fn template_file(kind: Option<&str>) -> String {
    match kind {
        None => format!("{TEMPLATES_DIR}/default.typ"),
        Some(kind) => format!("{TEMPLATES_DIR}/kinds/{kind}.typ"),
    }
}

/// The hidden lines put before a note's source: one wildcard import per
/// preamble path. Whole lines, so positions in the note only shift by lines.
pub fn note_prefix(paths: &[String]) -> String {
    paths
        .iter()
        .map(|path| format!("#import {}: *\n", string_literal(path)))
        .collect()
}

/// Whether the preamble defines `template` at its top level.
pub fn defines_template(text: &str) -> bool {
    let root = typst_syntax::parse(text);
    let Some(markup) = root.cast::<ast::Markup>() else {
        return false;
    };
    markup.exprs().any(|expr| {
        let ast::Expr::LetBinding(binding) = expr else {
            return false;
        };
        match binding.kind() {
            ast::LetBindingKind::Closure(ident) => ident.get() == "template",
            ast::LetBindingKind::Normal(ast::Pattern::Normal(ast::Expr::Ident(ident))) => {
                ident.get() == "template"
            }
            ast::LetBindingKind::Normal(_) => false,
        }
    })
}

/// Something in a preamble that would behave differently in the app and in
/// an export. Offsets are UTF-16 code units, like CodeMirror's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PreambleWarning {
    pub from: u32,
    pub to: u32,
    pub message: String,
}

pub fn preamble_warnings(text: &str) -> Vec<PreambleWarning> {
    let root = typst_syntax::parse(text);
    let lines = Lines::new(text.to_owned());
    let mut out = Vec::new();
    let mut warn = |node: &LinkedNode, message: &str| {
        let utf16 = |byte: usize| lines.byte_to_utf16(byte).unwrap_or(0) as u32;
        out.push(PreambleWarning {
            from: utf16(node.range().start),
            to: utf16(node.range().end),
            message: message.to_owned(),
        });
    };

    let linked = LinkedNode::new(&root);
    for child in linked.children() {
        let Some(expr) = child.cast::<ast::Expr>() else {
            continue;
        };
        match expr {
            ast::Expr::Space(_)
            | ast::Expr::Parbreak(_)
            | ast::Expr::LetBinding(_)
            | ast::Expr::ModuleImport(_) => {}
            ast::Expr::SetRule(_) | ast::Expr::ShowRule(_) => warn(
                &child,
                "Set and show rules at the top level don't reach notes; put them in `template`.",
            ),
            _ => warn(
                &child,
                "Content at the top level doesn't appear in notes; a preamble holds only definitions.",
            ),
        }
    }

    for path in relative_paths(&linked) {
        warn(
            &path,
            "Relative paths resolve differently once the preamble is exported with a note; start the path at the vault root (`/...`).",
        );
    }
    out.sort_by_key(|w| w.from);
    out
}

/// What "Restore default" puts back: the starter preamble, or the default
/// template (a kind's template is empty, so the default one applies).
pub fn default_text(kind: Option<&str>, template: bool) -> String {
    match (template, kind) {
        (false, kind) => starter(kind),
        (true, None) => DEFAULT_TEMPLATE.to_owned(),
        (true, Some(_)) => String::new(),
    }
}

/// The starter text of a new preamble. The common one sets the preview's
/// defaults: a tighter page margin and a larger font than Typst's, and more
/// room below level-one headings (a note's title, in the default template).
pub fn starter(kind: Option<&str>) -> String {
    let (scope, styles) = match kind {
        None => (
            "every note".to_owned(),
            "  set page(margin: 12pt)\n  set text(size: 12pt)\n  \
             show heading.where(level: 1): set block(below: 1.2em)\n",
        ),
        Some(kind) => (format!("every note of kind {}", string_literal(kind)), ""),
    };
    format!(
        "// Definitions here (imports, `#let`) are available in {scope}.\n\
         // Styles go in `template`, which is applied to the whole note.\n\
         // Use paths from the vault root, e.g. `/images/logo.png`.\n\
         #let template(body) = {{\n{styles}  body\n}}\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_imports_each_path_on_its_own_line() {
        assert_eq!(note_prefix(&[]), "");
        assert_eq!(
            note_prefix(&[preamble_path(None), preamble_path(Some("literature"))]),
            "#import \"/.sliver/preambles/common.typ\": *\n\
             #import \"/.sliver/preambles/kinds/literature.typ\": *\n"
        );
    }

    #[test]
    fn finds_template_definitions() {
        assert!(defines_template("#let template(body) = body"));
        assert!(defines_template("#let template = it => it"));
        assert!(!defines_template("#let other(body) = body"));
        assert!(!defines_template("#{ let template(body) = body }"));
        assert!(defines_template(&starter(None)));
    }

    #[test]
    fn warns_about_top_level_styles_content_and_relative_paths() {
        let text = "// comment\n#import \"@preview/cetz:0.3.0\": canvas\n#import \"/lib.typ\": x\n#let f(x) = image(\"logo.png\")\n#set text(red)\nHello\n#import \"util.typ\"\n";
        let found: Vec<(String, &str)> = preamble_warnings(text)
            .into_iter()
            .map(|w| {
                let units: Vec<u16> = text.encode_utf16().collect();
                let slice = String::from_utf16_lossy(&units[w.from as usize..w.to as usize]);
                let what = if w.message.starts_with("Set") {
                    "rule"
                } else if w.message.starts_with("Content") {
                    "content"
                } else {
                    "path"
                };
                (slice, what)
            })
            .collect();
        assert_eq!(
            found,
            vec![
                ("\"logo.png\"".into(), "path"),
                ("set text(red)".into(), "rule"),
                ("Hello".into(), "content"),
                ("\"util.typ\"".into(), "path"),
            ]
        );
        assert!(preamble_warnings(&starter(Some("x"))).is_empty());
    }
}
