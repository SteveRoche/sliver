//! What the editor needs from a note's syntax tree: highlighting, wikilink
//! and citation ranges. Offsets are UTF-16 code units, like CodeMirror's.

use serde::Serialize;
use typst_syntax::{Lines, LinkedNode, Tag, highlight};

use crate::citations::citations_in;
use crate::links::links_in;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    /// Flat `from, to, tag` triples, nested ranges after their parents;
    /// `tag` indexes [`Analysis::tag_classes`].
    pub highlights: Vec<u32>,
    /// CSS class per highlight tag (`typ-heading`, `typ-str`, ...).
    pub tag_classes: Vec<&'static str>,
    pub links: Vec<LinkRange>,
    pub citations: Vec<CitationRange>,
}

/// A citation key: `@key` (without a supplement) or the `<key>` in `cite(<key>)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CitationRange {
    pub from: u32,
    pub to: u32,
    pub key: String,
}

/// A wikilink as the syntax tree sees it, so never one inside raw text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRange {
    /// The whole `[[...]]`, brackets included.
    pub from: u32,
    pub to: u32,
    pub target: String,
    pub target_from: u32,
    pub target_to: u32,
    pub text: Option<String>,
}

pub fn analyze(text: &str) -> Analysis {
    let root = typst_syntax::parse(text);
    let lines = Lines::new(text.to_owned());
    let utf16 = |byte: usize| lines.byte_to_utf16(byte).unwrap_or(0) as u32;

    let mut highlights = Vec::new();
    collect(&LinkedNode::new(&root), &utf16, &mut highlights);

    let links = links_in(&root)
        .into_iter()
        .filter_map(|link| {
            let inner = link.range.start + 2;
            let target_from = inner + text[inner..link.range.end].find(&link.target)?;
            Some(LinkRange {
                from: utf16(link.range.start),
                to: utf16(link.range.end),
                target_from: utf16(target_from),
                target_to: utf16(target_from + link.target.len()),
                target: link.target,
                text: link.text,
            })
        })
        .collect();

    let citations = citations_in(&root)
        .into_iter()
        .map(|c| CitationRange {
            from: utf16(c.range.start),
            to: utf16(c.range.end),
            key: c.key,
        })
        .collect();

    Analysis {
        highlights,
        tag_classes: Tag::LIST.iter().map(|t| t.css_class()).collect(),
        links,
        citations,
    }
}

fn collect(node: &LinkedNode, utf16: &impl Fn(usize) -> u32, out: &mut Vec<u32>) {
    if let Some(tag) = highlight(node)
        && tag != Tag::Error
        && !node.range().is_empty()
        && let Some(index) = Tag::LIST.iter().position(|t| *t == tag)
    {
        out.extend([
            utf16(node.range().start),
            utf16(node.range().end),
            index as u32,
        ]);
    }
    for child in node.children() {
        collect(&child, utf16, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classes(analysis: &Analysis, text: &str) -> Vec<(String, &'static str)> {
        let units: Vec<u16> = text.encode_utf16().collect();
        analysis
            .highlights
            .chunks(3)
            .map(|c| {
                let slice = String::from_utf16_lossy(&units[c[0] as usize..c[1] as usize]);
                (slice, analysis.tag_classes[c[2] as usize])
            })
            .collect()
    }

    #[test]
    fn highlights_markup_and_code() {
        let text = "= Title\n#let x = \"s\"\n*bold*";
        let analysis = analyze(text);
        let found = classes(&analysis, text);
        assert!(found.contains(&("= Title".into(), "typ-heading")));
        assert!(found.contains(&("let".into(), "typ-key")));
        assert!(found.contains(&("\"s\"".into(), "typ-str")));
        assert!(found.contains(&("*bold*".into(), "typ-strong")));
    }

    #[test]
    fn links_use_utf16_offsets_and_skip_raw() {
        // U+1D400 takes two UTF-16 units, shifting everything after it.
        let text = "\u{1D400} [[ 1.1a | the one ]] `[[2]]`";
        let analysis = analyze(text);
        assert_eq!(analysis.links.len(), 1);
        let link = &analysis.links[0];
        assert_eq!((link.from, link.to), (3, 23));
        assert_eq!(link.target, "1.1a");
        assert_eq!((link.target_from, link.target_to), (6, 10));
        assert_eq!(link.text.as_deref(), Some("the one"));
    }
}
