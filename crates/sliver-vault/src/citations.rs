//! Citations: `@key` (Typst's own reference syntax) or `#cite(<key>)`, where
//! the key is a Better BibTeX citation key from the user's Zotero library.
//!
//! The vault keeps `.sliver/references.bib`: BibLaTeX entries for the keys its
//! notes cite, fetched from Zotero and merged in here ([`merge_references`]).
//! The preview wrapper cites from it and gets the known keys from the
//! generated `/.sliver/citations.typ` ([`citation_library`]), so a reference
//! that is neither a label nor a known key shows in red instead of failing
//! the compile.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::ops::Range;

use typst_syntax::{LinkedNode, SyntaxKind, SyntaxNode, ast};

use crate::header::string_literal;

pub const REFERENCES_FILE: &str = ".sliver/references.bib";
pub const REFERENCES_PATH: &str = "/.sliver/references.bib";
pub const CITATIONS_PATH: &str = "/.sliver/citations.typ";
/// Custom CSL styles, relative to the vault root.
pub const STYLES_DIR: &str = ".sliver/styles";
/// Preview links to a cited entry: `sliver-cite:<key>`.
pub const CITE_SCHEME: &str = "sliver-cite:";

/// Fields left out of `references.bib`: `file` holds paths on the machine
/// that exported it, which mean nothing in a synced vault.
const DROPPED_FIELDS: &[&str] = &["file"];

/// A citation in a note's source: `@key`, or the label in `cite(<key>)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Citation {
    pub key: String,
    /// Byte range of `@key` (without a supplement), or of `<key>`.
    pub range: Range<usize>,
}

/// The citations in a note. A reference to a label defined in the same note
/// (`@intro` with `= Intro <intro>`) is a cross-reference, not a citation.
pub fn citations_in(root: &SyntaxNode) -> Vec<Citation> {
    let mut found = Vec::new();
    let mut labels = HashSet::new();
    walk(&LinkedNode::new(root), &mut found, &mut labels);
    found.retain(|c| !labels.contains(c.key.as_str()));
    found
}

fn walk(node: &LinkedNode, found: &mut Vec<Citation>, labels: &mut HashSet<String>) {
    match node.kind() {
        SyntaxKind::RefMarker => {
            let key = node.leaf_text().trim_start_matches('@');
            if !key.is_empty() {
                found.push(Citation {
                    key: key.to_owned(),
                    range: node.range(),
                });
            }
        }
        SyntaxKind::Label => {
            if let Some(label) = node.cast::<ast::Label>() {
                if in_cite_call(node) {
                    found.push(Citation {
                        key: label.get().to_owned(),
                        range: node.range(),
                    });
                } else {
                    labels.insert(label.get().to_owned());
                }
            }
        }
        _ => {}
    }
    for child in node.children() {
        walk(&child, found, labels);
    }
}

fn in_cite_call(label: &LinkedNode) -> bool {
    let Some(args) = label.parent().filter(|p| p.kind() == SyntaxKind::Args) else {
        return false;
    };
    args.parent()
        .and_then(|call| call.cast::<ast::FuncCall>())
        .is_some_and(|call| matches!(call.callee(), ast::Expr::Ident(i) if i.get() == "cite"))
}

/// One entry of a BibLaTeX file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BibEntry<'a> {
    pub key: &'a str,
    /// From `@` to the closing brace.
    pub text: &'a str,
}

/// The entries of a BibLaTeX file, skipping `@comment`, `@string` and
/// `@preamble` blocks and anything that doesn't parse.
pub fn bib_entries(text: &str) -> Vec<BibEntry<'_>> {
    let mut entries = Vec::new();
    let mut at = 0;
    while let Some(found) = text[at..].find('@') {
        let start = at + found;
        at = start + 1;
        let rest = &text[at..];
        let kind_len = rest
            .find(|c: char| !c.is_ascii_alphanumeric())
            .unwrap_or(rest.len());
        let kind = &rest[..kind_len];
        let body = rest[kind_len..].trim_start();
        if kind.is_empty() || !body.starts_with('{') {
            continue;
        }
        let open = text.len() - body.len();
        let Some(close) = matching_brace(text, open) else {
            break;
        };
        at = close + 1;
        if ["comment", "string", "preamble"]
            .iter()
            .any(|k| kind.eq_ignore_ascii_case(k))
        {
            continue;
        }
        let inner = &text[open + 1..close];
        let key = inner.split(',').next().unwrap_or_default().trim();
        if !key.is_empty() && !key.contains(char::is_whitespace) {
            entries.push(BibEntry {
                key,
                text: &text[start..=close],
            });
        }
    }
    entries
}

/// The index of the brace closing the one at `open`.
fn matching_brace(text: &str, open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut escaped = false;
    for (i, c) in text[open..].char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(open + i);
                }
            }
            _ => {}
        }
    }
    None
}

/// `entry` without the [`DROPPED_FIELDS`], one field per line.
fn without_dropped_fields(entry: &str) -> String {
    let (Some(open), Some(close)) = (entry.find('{'), entry.rfind('}')) else {
        return entry.to_owned();
    };
    let inner = &entry[open + 1..close];
    let mut parts = split_top_level(inner).into_iter();
    let key = parts.next().unwrap_or_default().trim();
    let fields: Vec<&str> = parts
        .map(str::trim)
        .filter(|field| {
            let name = field.split('=').next().unwrap_or_default().trim();
            !field.is_empty()
                && !DROPPED_FIELDS
                    .iter()
                    .any(|dropped| name.eq_ignore_ascii_case(dropped))
        })
        .collect();
    let mut out = format!("{}{{{key}", &entry[..open]);
    for field in fields {
        out.push_str(",\n  ");
        out.push_str(field);
    }
    out.push_str("\n}");
    out
}

/// Splits at commas outside braces and quotes.
fn split_top_level(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    let mut start = 0;
    for (i, c) in text.char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            '"' if depth == 0 => quoted = !quoted,
            ',' if depth == 0 && !quoted => {
                parts.push(&text[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&text[start..]);
    parts
}

/// A readable title from an entry's `title` field: braces and TeX commands
/// stripped, whitespace collapsed.
pub fn entry_title(entry: &str) -> Option<String> {
    let open = entry.find('{')?;
    let close = entry.rfind('}')?;
    let field = split_top_level(&entry[open + 1..close])
        .into_iter()
        .skip(1)
        .find(|field| {
            field
                .split('=')
                .next()
                .is_some_and(|name| name.trim().eq_ignore_ascii_case("title"))
        })?;
    let value = field.split_once('=')?.1;
    let mut out = String::new();
    let mut command = false;
    for c in value.chars() {
        match c {
            '\\' => command = true,
            c if command && c.is_ascii_alphabetic() => {}
            '{' | '}' | '"' => command = false,
            c => {
                command = false;
                out.push(c);
            }
        }
    }
    let title = out.split_whitespace().collect::<Vec<_>>().join(" ");
    (!title.is_empty()).then_some(title)
}

/// `existing` with the entries of `exported` added or replacing theirs, and
/// with only the keys in `keep` if given. Entries are sorted by key.
pub fn merge_references(existing: &str, exported: &str, keep: Option<&BTreeSet<String>>) -> String {
    let mut entries: BTreeMap<String, String> = bib_entries(existing)
        .into_iter()
        .map(|e| (e.key.to_owned(), e.text.to_owned()))
        .collect();
    for entry in bib_entries(exported) {
        entries.insert(entry.key.to_owned(), without_dropped_fields(entry.text));
    }
    if let Some(keep) = keep {
        entries.retain(|key, _| keep.contains(key));
    }
    let mut out = String::from(
        "% Generated by Sliver from your Zotero library (Better BibTeX).\n\
         % Refreshed from Zotero, so edits here are overwritten.\n",
    );
    for entry in entries.values() {
        out.push('\n');
        out.push_str(entry);
        out.push('\n');
    }
    out
}

/// What the preview wrapper needs to know about citations.
pub struct CitationOptions<'a> {
    /// A built-in Typst style name, or a vault path to a `.csl` file.
    pub style: &'a str,
    /// Every style a note may name: Typst's built-in names and the custom
    /// styles' paths. A note naming another one keeps the default style and
    /// shows a notice, rather than failing to compile.
    pub styles: &'a [String],
    /// Whether previews end with the note's reference list.
    pub show_references: bool,
    /// False when `references.bib` can't be read; the wrapper then has no
    /// bibliography and every citation shows as unknown.
    pub enabled: bool,
}

/// A Typst array of string literals.
fn str_array<'a>(items: impl IntoIterator<Item = &'a str>) -> String {
    let items: Vec<String> = items.into_iter().map(string_literal).collect();
    match items.len() {
        0 => "()".to_owned(),
        _ => format!("({},)", items.join(", ")),
    }
}

/// Source of the generated `/.sliver/citations.typ`.
pub fn citation_library<'a>(
    keys: impl IntoIterator<Item = &'a str>,
    options: &CitationOptions,
) -> String {
    let keys = if options.enabled {
        str_array(keys)
    } else {
        str_array([])
    };
    format!(
        "// Generated by Sliver. Do not edit.\n\
         #let enabled = {}\n\
         #let keys = {keys}\n\
         #let style = {}\n\
         #let styles = {}\n\
         #let show-references = {}\n",
        options.enabled,
        string_literal(options.style),
        str_array(options.styles.iter().map(String::as_str)),
        options.show_references,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(text: &str) -> Vec<(String, &str)> {
        citations_in(&typst_syntax::parse(text))
            .into_iter()
            .map(|c| (c.key, &text[c.range]))
            .collect()
    }

    #[test]
    fn finds_citations_but_not_cross_references() {
        assert_eq!(
            keys(
                "= Intro <intro>\nSee @doe2020[p. 7] and @intro, #cite(<roe:2021>, form: \"year\")."
            ),
            vec![
                ("doe2020".into(), "@doe2020"),
                ("roe:2021".into(), "<roe:2021>")
            ]
        );
        assert_eq!(keys("`@raw` and // @comment\n"), vec![]);
    }

    const BIB: &str = "% comment\n@string{x = {y}}\n\
        @article{doe2020,\n  title = {A {Study} of \\emph{Things}},\n  file = {/Users/me/x.pdf;/a, b.pdf},\n  year = {2020}\n}\n\
        @book{roe2021, title = \"Another\", year = 2021}\n";

    #[test]
    fn reads_entries_and_titles() {
        let entries = bib_entries(BIB);
        assert_eq!(
            entries.iter().map(|e| e.key).collect::<Vec<_>>(),
            ["doe2020", "roe2021"]
        );
        assert_eq!(
            entry_title(entries[0].text).as_deref(),
            Some("A Study of Things")
        );
        assert_eq!(entry_title(entries[1].text).as_deref(), Some("Another"));
    }

    #[test]
    fn merges_replaces_drops_files_and_prunes() {
        let existing = "@book{old, title = {Old}}\n@book{roe2021, title = {Stale}}\n";
        let merged = merge_references(existing, BIB, None);
        let entries = bib_entries(&merged);
        assert_eq!(
            entries.iter().map(|e| e.key).collect::<Vec<_>>(),
            ["doe2020", "old", "roe2021"]
        );
        assert!(!merged.contains("x.pdf"));
        assert!(merged.contains("year = {2020}"));
        assert_eq!(entry_title(entries[2].text).as_deref(), Some("Another"));

        let keep = BTreeSet::from(["doe2020".to_owned()]);
        let pruned = merge_references(&merged, "", Some(&keep));
        assert_eq!(bib_entries(&pruned).len(), 1);
    }

    #[test]
    fn library_lists_keys_only_when_enabled() {
        let options = CitationOptions {
            style: "apa",
            styles: &[],
            show_references: true,
            enabled: true,
        };
        let text = citation_library(["a\"b"], &options);
        assert!(text.contains("#let keys = (\"a\\\"b\",)"));
        let off = citation_library(
            ["a"],
            &CitationOptions {
                enabled: false,
                ..options
            },
        );
        assert!(off.contains("#let keys = ()"));
    }
}
