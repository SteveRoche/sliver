//! Reads a note's metadata header from its source without evaluating it.
//!
//! The header is plain Typst, so notes stay valid outside Sliver:
//!
//! ```typst
//! #metadata((title: "On tools", address: "1.1a", tags: ("craft",))) <note>
//! ```
//!
//! Known fields must be literals so they can be read from the syntax tree
//! alone; unknown fields are ignored to leave room for later additions.

use std::fmt;

use typst_syntax::ast::{self, AstNode};
use typst_syntax::{Source, SyntaxNode};

pub const HEADER_LABEL: &str = "note";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NoteHeader {
    pub title: Option<String>,
    pub address: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderError {
    /// `#metadata(..) <note>` was found but its argument isn't a single dictionary.
    NotADict,
    /// A known field holds something other than a literal of the expected type.
    NotLiteral(&'static str),
}

impl fmt::Display for HeaderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotADict => write!(f, "note header must be `#metadata((..)) <note>`"),
            Self::NotLiteral(field) => write!(f, "note header field `{field}` must be a literal"),
        }
    }
}

impl std::error::Error for HeaderError {}

/// Returns the first `#metadata((..)) <note>` in the note, if any.
pub fn read_header(text: &str) -> Result<Option<NoteHeader>, HeaderError> {
    header_in(&typst_syntax::parse(text))
}

/// Like [`read_header`], for a tree that is already parsed.
pub fn header_in(root: &SyntaxNode) -> Result<Option<NoteHeader>, HeaderError> {
    match find_header(root) {
        Some(call) => header_from_dict(header_dict(call)?).map(Some),
        None => Ok(None),
    }
}

/// Renders a header line for a new note. `None` fields and empty tags are omitted.
pub fn format_header(header: &NoteHeader) -> String {
    let mut fields = Vec::new();
    if let Some(title) = &header.title {
        fields.push(format!("title: {}", string_literal(title)));
    }
    if let Some(address) = &header.address {
        fields.push(format!("address: {}", string_literal(address)));
    }
    if !header.tags.is_empty() {
        let tags: Vec<String> = header.tags.iter().map(|t| string_literal(t)).collect();
        let trailing = if tags.len() == 1 { "," } else { "" };
        fields.push(format!("tags: ({}{trailing})", tags.join(", ")));
    }
    let dict = if fields.is_empty() {
        "(:)".to_owned()
    } else {
        format!("({})", fields.join(", "))
    };
    format!("#metadata({dict}) <{HEADER_LABEL}>")
}

/// Sets the header's `title`, editing only that value so the rest of the
/// note (and any unknown header fields) is left byte-for-byte intact. Adds a
/// header if the note has none.
pub fn set_title(text: &str, title: &str) -> Result<String, HeaderError> {
    let source = Source::detached(text);
    let Some(call) = find_header(source.root()) else {
        let header = format_header(&NoteHeader {
            title: Some(title.to_owned()),
            ..NoteHeader::default()
        });
        return Ok(format!("{header}\n{text}"));
    };
    let dict = header_dict(call)?;
    let range = |node: &SyntaxNode| {
        source
            .find(node.span())
            .map(|n| n.range())
            .ok_or(HeaderError::NotADict)
    };

    let literal = string_literal(title);
    let mut out = text.to_owned();
    let existing = dict.items().find_map(|item| match item {
        ast::DictItem::Named(named) if named.name().get() == "title" => Some(named.expr()),
        _ => None,
    });
    match existing {
        Some(expr) => out.replace_range(range(expr.to_untyped())?, &literal),
        None if dict.items().next().is_none() => {
            out.replace_range(range(dict.to_untyped())?, &format!("(title: {literal})"))
        }
        None => out.insert_str(
            range(dict.to_untyped())?.start + 1,
            &format!("title: {literal}, "),
        ),
    }
    Ok(out)
}

fn find_header(root: &SyntaxNode) -> Option<ast::FuncCall<'_>> {
    let markup = root.cast::<ast::Markup>()?;
    let mut exprs = markup
        .exprs()
        .filter(|e| !matches!(e, ast::Expr::Space(_)))
        .peekable();
    while let Some(expr) = exprs.next() {
        if let ast::Expr::FuncCall(call) = expr
            && is_ident(call.callee(), "metadata")
            && matches!(exprs.peek(), Some(ast::Expr::Label(l)) if l.get() == HEADER_LABEL)
        {
            return Some(call);
        }
    }
    None
}

fn header_dict(call: ast::FuncCall<'_>) -> Result<ast::Dict<'_>, HeaderError> {
    let mut items = call.args().items();
    match (items.next(), items.next()) {
        (Some(ast::Arg::Pos(ast::Expr::Dict(dict))), None) => Ok(dict),
        _ => Err(HeaderError::NotADict),
    }
}

pub(crate) fn string_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn is_ident(expr: ast::Expr, name: &str) -> bool {
    matches!(expr, ast::Expr::Ident(ident) if ident.get() == name)
}

fn header_from_dict(dict: ast::Dict) -> Result<NoteHeader, HeaderError> {
    let mut header = NoteHeader::default();
    for item in dict.items() {
        let ast::DictItem::Named(named) = item else {
            continue;
        };
        let value = named.expr();
        match named.name().get().as_str() {
            "title" => header.title = optional_str(value, "title")?,
            "address" => header.address = optional_str(value, "address")?,
            "tags" => header.tags = str_array(value, "tags")?,
            _ => {}
        }
    }
    Ok(header)
}

fn optional_str(expr: ast::Expr, field: &'static str) -> Result<Option<String>, HeaderError> {
    match expr {
        ast::Expr::Str(s) => Ok(Some(s.get().into())),
        ast::Expr::None(_) => Ok(None),
        _ => Err(HeaderError::NotLiteral(field)),
    }
}

fn str_array(expr: ast::Expr, field: &'static str) -> Result<Vec<String>, HeaderError> {
    let ast::Expr::Array(array) = expr else {
        return Err(HeaderError::NotLiteral(field));
    };
    array
        .items()
        .map(|item| match item {
            ast::ArrayItem::Pos(ast::Expr::Str(s)) => Ok(s.get().into()),
            _ => Err(HeaderError::NotLiteral(field)),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_literal_header() {
        let text = "// leading comment\n#metadata((title: \"On \\\"tools\\\"\", address: \"1.1a\", tags: (\"craft\", \"x\"), extra: 1 + 2)) <note>\n= Body\n";
        assert_eq!(
            read_header(text),
            Ok(Some(NoteHeader {
                title: Some("On \"tools\"".into()),
                address: Some("1.1a".into()),
                tags: vec!["craft".into(), "x".into()],
            }))
        );
    }

    #[test]
    fn missing_fields_default() {
        let header = read_header("#metadata((title: none)) <note>")
            .unwrap()
            .unwrap();
        assert_eq!(header, NoteHeader::default());
    }

    #[test]
    fn ignores_metadata_with_other_labels_or_none() {
        assert_eq!(read_header("#metadata((title: \"x\")) <other>"), Ok(None));
        assert_eq!(read_header("#metadata((title: \"x\"))"), Ok(None));
        assert_eq!(read_header("= Just a note"), Ok(None));
    }

    #[test]
    fn rejects_computed_known_fields() {
        assert_eq!(
            read_header("#metadata((title: \"a\" + \"b\")) <note>"),
            Err(HeaderError::NotLiteral("title"))
        );
        assert_eq!(
            read_header("#metadata(\"x\") <note>"),
            Err(HeaderError::NotADict)
        );
    }

    #[test]
    fn header_compiles_as_plain_typst() {
        let mut engine = sliver_typst::Engine::new();
        engine
            .set_source(
                "/n.typ",
                "#metadata((title: \"T\", tags: (\"a\",))) <note>\nBody",
            )
            .unwrap();
        let out = engine.compile("/n.typ").unwrap();
        assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
    }
    #[test]
    fn formats_headers_that_read_back() {
        let header = NoteHeader {
            title: Some("Quote \" and \\ back\nslash".into()),
            address: Some("1.1a".into()),
            tags: vec!["one".into()],
        };
        let line = format_header(&header);
        assert_eq!(read_header(&line), Ok(Some(header)));
        assert_eq!(
            format_header(&NoteHeader::default()),
            "#metadata((:)) <note>"
        );
        assert_eq!(
            read_header("#metadata((:)) <note>"),
            Ok(Some(NoteHeader::default()))
        );
    }

    #[test]
    fn set_title_replaces_only_the_title_value() {
        let text = "#metadata((title: \"Old\", custom: 1 + 1)) <note>\nBody #x";
        assert_eq!(
            set_title(text, "New").unwrap(),
            "#metadata((title: \"New\", custom: 1 + 1)) <note>\nBody #x"
        );
    }

    #[test]
    fn set_title_inserts_missing_title_or_header() {
        assert_eq!(
            set_title("#metadata((address: \"1\")) <note>", "T").unwrap(),
            "#metadata((title: \"T\", address: \"1\")) <note>"
        );
        assert_eq!(
            set_title("#metadata((:)) <note>", "T").unwrap(),
            "#metadata((title: \"T\")) <note>"
        );
        assert_eq!(
            set_title("Body", "T").unwrap(),
            "#metadata((title: \"T\")) <note>\nBody"
        );
    }
}
