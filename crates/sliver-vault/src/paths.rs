//! File paths in Typst sources: relative ones (which resolve against a
//! note's compile location, not its folder, so notes use paths from the
//! vault root) and rewriting paths when an asset or folder moves.

use std::ops::Range;

use typst_syntax::ast;
use typst_syntax::{LinkedNode, SyntaxKind};

use crate::header::string_literal;

/// Functions whose first argument is a path.
const PATH_FUNCS: &[&str] = &[
    "image",
    "read",
    "json",
    "csv",
    "yaml",
    "toml",
    "xml",
    "cbor",
    "plugin",
    "bibliography",
];

/// The string literals in `root` that are relative paths: the path of an
/// import or include, or the first argument of a call like `image(...)`.
pub fn relative_paths<'a>(root: &'a LinkedNode<'a>) -> Vec<LinkedNode<'a>> {
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(node) = stack.pop() {
        if let Some(path) = path_argument(&node)
            && let Some(ast::Expr::Str(s)) = path.cast::<ast::Expr>()
            && !s.get().starts_with('/')
            && !s.get().starts_with('@')
        {
            out.push(path);
        }
        stack.extend(node.children());
    }
    out.sort_by_key(|node| node.range().start);
    out
}

/// The node holding the path of an import, an include or a call like `image(...)`.
fn path_argument<'a>(node: &LinkedNode<'a>) -> Option<LinkedNode<'a>> {
    match node.kind() {
        SyntaxKind::ModuleImport | SyntaxKind::ModuleInclude => {
            node.children().find(|c| c.kind() == SyntaxKind::Str)
        }
        SyntaxKind::FuncCall => {
            let call = node.cast::<ast::FuncCall>()?;
            let ast::Expr::Ident(callee) = call.callee() else {
                return None;
            };
            if !PATH_FUNCS.contains(&callee.get().as_str()) {
                return None;
            }
            let args = node.children().find(|c| c.kind() == SyntaxKind::Args)?;
            args.children().find(|c| c.kind() == SyntaxKind::Str)
        }
        _ => None,
    }
}

/// `path` (vault-absolute, `/a/b.png`) after `from` moved to `to` (both
/// vault-relative, no leading slash): `from` itself or anything under it.
pub fn moved_path(path: &str, from: &str, to: &str) -> Option<String> {
    let rest = path.strip_prefix('/')?.strip_prefix(from)?;
    (rest.is_empty() || rest.starts_with('/')).then(|| format!("/{to}{rest}"))
}

/// Byte ranges of the string literals in `text` naming `from` or something
/// under it, each with the literal that replaces it. Any string literal
/// counts, not only call arguments, so `#let logo = "/logo.png"` moves too;
/// text in markup and raw isn't a string literal and stays.
pub fn path_edits(text: &str, from: &str, to: &str) -> Vec<(Range<usize>, String)> {
    let root = typst_syntax::parse(text);
    let mut out = Vec::new();
    let mut stack = vec![LinkedNode::new(&root)];
    while let Some(node) = stack.pop() {
        if node.kind() == SyntaxKind::Str
            && let Some(ast::Expr::Str(s)) = node.cast::<ast::Expr>()
            && let Some(new) = moved_path(&s.get(), from, to)
        {
            out.push((node.range(), string_literal(&new)));
        }
        stack.extend(node.children());
    }
    out.sort_by_key(|(range, _)| range.start);
    out
}

/// `text` with [`path_edits`] applied, if there were any.
pub fn rewrite_paths(text: &str, from: &str, to: &str) -> Option<String> {
    let edits = path_edits(text, from, to);
    if edits.is_empty() {
        return None;
    }
    let mut text = text.to_owned();
    for (range, new) in edits.into_iter().rev() {
        text.replace_range(range, &new);
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_relative_paths_only() {
        let text = "#image(\"a.png\") #image(\"/b.png\") #import \"@preview/x:0.1.0\"\n#read(\"../c.txt\")";
        let root = typst_syntax::parse(text);
        let linked = LinkedNode::new(&root);
        let found: Vec<&str> = relative_paths(&linked)
            .iter()
            .map(|n| &text[n.range()])
            .collect();
        assert_eq!(found, ["\"a.png\"", "\"../c.txt\""]);
    }

    #[test]
    fn moves_files_and_folders() {
        assert_eq!(
            moved_path("/a/b.png", "a/b.png", "c.png").as_deref(),
            Some("/c.png")
        );
        assert_eq!(
            moved_path("/a/b.png", "a", "x/y").as_deref(),
            Some("/x/y/b.png")
        );
        assert_eq!(moved_path("/ab/b.png", "a", "x"), None);
        assert_eq!(moved_path("a/b.png", "a", "x"), None);
    }

    #[test]
    fn rewrites_string_literals_but_not_markup() {
        let text = "#let logo = \"/img/logo.png\"\n#image(\"/img/logo.png\", width: 50%)\n/img/logo.png `\"/img/logo.png\"`";
        let out = rewrite_paths(text, "img", "Assets/Images").unwrap();
        assert_eq!(
            out,
            "#let logo = \"/Assets/Images/logo.png\"\n#image(\"/Assets/Images/logo.png\", width: 50%)\n/img/logo.png `\"/img/logo.png\"`"
        );
        assert_eq!(rewrite_paths(text, "other", "x"), None);
    }
}
