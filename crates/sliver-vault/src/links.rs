//! Wikilinks: `[[target]]` and `[[target|text]]`, where the target is a
//! Zettelkasten address or a note uuid.
//!
//! In the source they are plain Typst text, so notes compile anywhere. In the
//! app, each note is compiled through [`preview_main`], whose `wikilinks` show
//! rule (from the generated [`link_library`]) turns them into `sliver://<uuid>`
//! links labelled with the target's current title, looked up in the note's
//! own [`link_table`] (only the targets it links to, so its size doesn't
//! grow with the vault). The syntax-tree scan here
//! is what backlinks use; it only accepts plain text between the brackets,
//! which is also all the show rule's regex can match.

use std::ops::Range;

use serde::Serialize;
use typst_syntax::{SyntaxKind, SyntaxNode};

use crate::citations::{CITATIONS_PATH, CITE_SCHEME, REFERENCES_PATH};
use crate::header::{HEADER_LABEL, string_literal};
use crate::theme::THEME_PATH;

pub const LINKS_PATH: &str = "/.sliver/links.typ";
/// The generated table of note `id`'s link targets.
pub fn link_table_path(id: &str) -> String {
    format!("/.sliver/links/{id}.typ")
}
/// The generated file defining `page-width` for note `id`'s preview. Each
/// note has its own, since previews side by side differ in width.
pub fn page_path(id: &str) -> String {
    format!("/.sliver/page/{id}.typ")
}
pub const LINK_SCHEME: &str = "sliver://";

/// Link scheme of broken wikilinks in the preview, followed by the target:
/// Mod-click creates the note.
pub const NEW_LINK_SCHEME: &str = "sliver-new:";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WikiLink {
    pub target: String,
    pub text: Option<String>,
    /// Byte range in the source, brackets included.
    pub range: Range<usize>,
}

/// How resolved links are labelled when they have no custom text.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum LinkDisplay {
    #[default]
    Title,
    Address,
}

/// One entry of a generated link table: what a target names.
pub struct LinkTarget<'a> {
    pub id: String,
    pub title: Option<&'a str>,
    pub address: Option<&'a str>,
}

pub fn links_in(root: &SyntaxNode) -> Vec<WikiLink> {
    let mut out = Vec::new();
    walk(root, 0, &mut out);
    out
}

fn walk(node: &SyntaxNode, offset: usize, out: &mut Vec<WikiLink>) {
    if node.kind() == SyntaxKind::Markup {
        scan_markup(node, offset, out);
    }
    let mut child_offset = offset;
    for child in node.children() {
        walk(child, child_offset, out);
        child_offset += child.len();
    }
}

fn is_text(node: &SyntaxNode, text: &str) -> bool {
    node.kind() == SyntaxKind::Text && node.leaf_text() == text
}

fn scan_markup(markup: &SyntaxNode, offset: usize, out: &mut Vec<WikiLink>) {
    let children: Vec<&SyntaxNode> = markup.children().collect();
    let mut offsets = Vec::with_capacity(children.len() + 1);
    let mut at = offset;
    for child in &children {
        offsets.push(at);
        at += child.len();
    }
    offsets.push(at);

    let mut i = 0;
    while i + 1 < children.len() {
        if !(is_text(children[i], "[") && is_text(children[i + 1], "[")) {
            i += 1;
            continue;
        }
        let mut inner = String::new();
        let mut j = i + 2;
        let close = loop {
            match children.get(j) {
                Some(n)
                    if is_text(n, "]") && children.get(j + 1).is_some_and(|m| is_text(m, "]")) =>
                {
                    break Some(j + 1);
                }
                Some(n)
                    if n.kind() == SyntaxKind::Text
                        && n.leaf_text() != "["
                        && n.leaf_text() != "]" =>
                {
                    inner.push_str(n.leaf_text());
                }
                Some(n) if n.kind() == SyntaxKind::Space && !n.leaf_text().contains('\n') => {
                    inner.push_str(n.leaf_text());
                }
                // `'` and `"` in markup parse as smart quotes, not text.
                Some(n) if n.kind() == SyntaxKind::SmartQuote => inner.push_str(n.leaf_text()),
                _ => break None,
            }
            j += 1;
        };
        match close.and_then(|end| parse_inner(&inner).map(|link| (end, link))) {
            Some((end, (target, text))) => {
                out.push(WikiLink {
                    target,
                    text,
                    range: offsets[i]..offsets[end + 1],
                });
                i = end + 1;
            }
            None => i += 1,
        }
    }
}

fn parse_inner(inner: &str) -> Option<(String, Option<String>)> {
    let (target, text) = match inner.split_once('|') {
        Some((target, text)) => (target, Some(text.trim()).filter(|t| !t.is_empty())),
        None => (inner, None),
    };
    let target = target.trim();
    (!target.is_empty()).then(|| (target.to_owned(), text.map(str::to_owned)))
}

/// Source of a generated link table (see [`link_table_path`]): `notes`, from
/// each link target (as written: an address or a uuid) that resolves to the
/// note's id, title and address. Unresolved targets are left out (broken).
pub fn link_table<'a>(targets: impl IntoIterator<Item = (&'a str, LinkTarget<'a>)>) -> String {
    let mut entries = String::new();
    for (key, target) in targets {
        let title = target.title.or(target.address).unwrap_or("Untitled");
        let address = target.address.map_or("none".to_owned(), string_literal);
        entries.push_str(&format!(
            "  {}: (id: {}, title: {}, address: {address}),\n",
            string_literal(key),
            string_literal(&target.id),
            string_literal(title)
        ));
    }
    let entries = if entries.is_empty() {
        "(:)".to_owned()
    } else {
        format!("(\n{entries})")
    };
    format!("// Generated by Sliver from the note headers. Do not edit.\n#let notes = {entries}\n")
}

/// Source of the generated `/.sliver/links.typ`: the `wikilinks` show rule,
/// which labels links from a note's [`link_table`].
pub fn link_library(display: LinkDisplay) -> String {
    let display = match display {
        LinkDisplay::Title => "title",
        LinkDisplay::Address => "address",
    };
    format!(
        r##"// Generated by Sliver from the note headers. Do not edit.
#import "{THEME_PATH}" as theme
#let display = "{display}"
#let wikilinks(notes) = body => {{
  show regex("\[\[[^\[\]\n]+\]\]"): it => {{
    let inner = it.text.slice(2, -2)
    let bar = inner.position("|")
    let target = (if bar == none {{ inner }} else {{ inner.slice(0, bar) }}).trim()
    let custom = if bar == none {{ "" }} else {{ inner.slice(bar + 1).trim() }}
    let note = notes.at(target, default: none)
    if note == none {{
      link("{NEW_LINK_SCHEME}" + target, text(fill: theme.error, it))
    }} else {{
      let shown = if custom != "" {{ custom }} else if display == "address" and note.address != none {{ note.address }} else {{ note.title }}
      link("{LINK_SCHEME}" + note.id, shown)
    }}
  }}
  // Raw text is never a link. Inside raw, the closer rule runs first and splits
  // the brackets with a zero-width `h(0pt)` so the outer rule no longer matches.
  show raw: it => {{
    show regex("\[\[[^\[\]\n]+\]\]"): t => [#t.text.slice(0, 1)#h(0pt)#t.text.slice(1)]
    it
  }}
  body
}}
"##
    )
}

/// The file the preview compiles for note `id`: applies the wikilink rule, the
/// preview's page (as wide as the pane, as tall as the note) and the app
/// theme without changing the note's source, so diagnostics keep their
/// positions. Page setup and theming stay out of note files so other outputs
/// (export) can choose their own. A note opts out of theming with
/// `theme: false` in its header and is then shown as on light paper.
pub fn preview_main_path(id: &str) -> String {
    format!("/.sliver/view/{id}.typ")
}

/// Source of the file at [`preview_main_path`]. `templates` are the paths of
/// the note's preambles that define `template`, applied in order (common
/// first) inside the theme's defaults; the preview's page size is applied
/// after them, so a preamble's page setup can't break the fit to the pane.
///
/// Citations: the vault's citation style is the default, a template can set
/// its own, and a note's `citation-style` header field wins over both. A
/// reference that is neither a label nor a known key (`citations.keys`)
/// shows in red instead of failing the compile; known ones link to
/// `sliver-cite:<key>`. The style the note ended up with is recorded as
/// `<sliver-citation-style>` metadata, for rendering one entry elsewhere.
pub fn preview_main(id: &str, templates: &[String]) -> String {
    let templates: String = templates
        .iter()
        .enumerate()
        .map(|(i, path)| {
            format!(
                "#import {} as preamble_{i}\n#show: preamble_{i}.template\n",
                crate::header::string_literal(path)
            )
        })
        .collect();
    format!(
        r#"#import "{LINKS_PATH}": wikilinks
#import "/.sliver/links/{id}.typ": notes
#import "/.sliver/page/{id}.typ": page-width
#import "{THEME_PATH}" as theme
#import "{CITATIONS_PATH}" as citations
#let header-field(name, default) = {{
  let header = query(<{HEADER_LABEL}>)
  if header.len() > 0 and type(header.first().value) == dictionary {{
    header.first().value.at(name, default: default)
  }} else {{
    default
  }}
}}
#let unthemed() = header-field("theme", true) == false
#set page(
  width: page-width,
  height: auto,
  margin: 18pt,
  fill: theme.paper,
  background: context if unthemed() {{ rect(width: 100%, height: 100%, fill: theme.light.paper) }},
)
#show: body => context {{
  let ink = if unthemed() {{ theme.light.ink }} else {{ theme.ink }}
  let accent = if unthemed() {{ theme.light.accent }} else {{ theme.accent }}
  set text(fill: ink)
  show link: set text(fill: accent)
  set line(stroke: ink)
  set table(stroke: if unthemed() {{ ink }} else {{ theme.rule }})
  body
}}
#set bibliography(style: citations.style)
{templates}#show: body => context {{
  let style = header-field("citation-style", none)
  if style != none and style not in citations.styles {{
    text(fill: theme.error)[Unknown citation style #repr(style); using the default.]
    parbreak()
  }}
  set bibliography(style: style) if style in citations.styles
  body
}}
#show: body => {{
  set page(width: page-width, height: auto)
  body
}}
#show ref: it => if it.element == none and str(it.target) not in citations.keys {{
  text(fill: theme.error, "@" + str(it.target))
}} else {{
  it
}}
#show cite: it => if str(it.key) not in citations.keys {{
  text(fill: theme.error, "@" + str(it.key))
}} else {{
  link("{CITE_SCHEME}" + str(it.key), it)
}}
#show: wikilinks(notes)
#include "/notes/{id}.typ"
#context [#metadata(bibliography.style) <sliver-citation-style>]
#if citations.enabled {{
  // Shown only when something in the note cites a known entry: otherwise
  // it would be a heading over nothing.
  show bibliography: it => context if citations.show-references and query(cite).any(c => str(c.key) in citations.keys) {{ it }}
  bibliography("{REFERENCES_PATH}")
}}
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn links(text: &str) -> Vec<(String, Option<String>, &str)> {
        links_in(&typst_syntax::parse(text))
            .into_iter()
            .map(|l| (l.target, l.text, &text[l.range]))
            .collect()
    }

    #[test]
    fn finds_targets_and_custom_text() {
        assert_eq!(
            links("See [[1.1a]] and [[ 2 | the second ]] and *[[1.1a1]]*."),
            vec![
                ("1.1a".into(), None, "[[1.1a]]"),
                (
                    "2".into(),
                    Some("the second".into()),
                    "[[ 2 | the second ]]"
                ),
                ("1.1a1".into(), None, "[[1.1a1]]"),
            ]
        );
    }

    #[test]
    fn finds_links_with_quotes() {
        assert_eq!(
            links("[[Markov's \"inequality\"]]"),
            vec![(
                "Markov's \"inequality\"".into(),
                None,
                "[[Markov's \"inequality\"]]"
            )]
        );
    }

    #[test]
    fn finds_links_in_content_blocks() {
        assert_eq!(links("#strong[[[3]]]"), vec![("3".into(), None, "[[3]]")]);
    }

    #[test]
    fn ignores_raw_escapes_styled_and_empty() {
        for text in [
            "`[[1]]`",
            "```\n[[1]]\n```",
            "\\[\\[1\\]\\]",
            "[[a *b* c]]",
            "[[]]",
            "[[ | x]]",
            "[[1]",
            "[[1\n]]",
            "// [[1]]",
            "#\"[[1]]\"",
        ] {
            assert_eq!(links(text), vec![], "{text:?}");
        }
    }
}
