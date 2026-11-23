//! Sections of the Zettelkasten: optional named headings over one or more
//! consecutive sequences (the leading numbers of addresses: `4` and `5` for
//! `4.1`, `5.2a`, ...). They live in the folder's `.zettelkasten` marker as
//! plain Typst, so they sync with the vault and follow the folder when it's
//! renamed. A key is a sequence or an inclusive range of them:
//!
//! ```typst
//! #let sections = (
//!   "1": "Probability",
//!   "4-5": "Writing",
//! )
//! ```
//!
//! An empty marker (as older vaults have) has no sections.

use std::collections::BTreeMap;

use typst_syntax::ast;

use crate::header::string_literal;

/// A section by its first sequence: its last sequence and its name.
pub type Sections = BTreeMap<u32, (u32, String)>;

/// The sections in a marker's text. Anything unreadable, and a range that
/// overlaps an earlier one, is skipped rather than an error: the marker is
/// also edited by hand.
pub fn parse_sections(text: &str) -> Sections {
    let root = typst_syntax::parse(text);
    let mut out = Sections::new();
    let Some(markup) = root.cast::<ast::Markup>() else {
        return out;
    };
    for expr in markup.exprs() {
        let ast::Expr::LetBinding(binding) = expr else {
            continue;
        };
        let ast::LetBindingKind::Normal(ast::Pattern::Normal(ast::Expr::Ident(name))) =
            binding.kind()
        else {
            continue;
        };
        if name.get() != "sections" {
            continue;
        }
        let Some(ast::Expr::Dict(dict)) = binding.init() else {
            continue;
        };
        for item in dict.items() {
            let ast::DictItem::Keyed(keyed) = item else {
                continue;
            };
            let (ast::Expr::Str(key), ast::Expr::Str(value)) = (keyed.key(), keyed.expr()) else {
                continue;
            };
            let Some((first, last)) = parse_range(&key.get()) else {
                continue;
            };
            if !overlaps(&out, first, last) {
                out.insert(first, (last, value.get().to_string()));
            }
        }
    }
    out
}

fn parse_range(key: &str) -> Option<(u32, u32)> {
    let number = |s: &str| s.trim().parse::<u32>().ok().filter(|&n| n > 0);
    let (first, last) = match key.split_once('-') {
        Some((first, last)) => (number(first)?, number(last)?),
        None => (number(key)?, number(key)?),
    };
    (first <= last).then_some((first, last))
}

/// The first sequence of a section in `sections` that shares a sequence
/// with `first..=last`.
pub fn overlapping(sections: &Sections, first: u32, last: u32) -> Option<u32> {
    sections
        .iter()
        .find(|(start, (end, _))| **start <= last && first <= *end)
        .map(|(start, _)| *start)
}

fn overlaps(sections: &Sections, first: u32, last: u32) -> bool {
    overlapping(sections, first, last).is_some()
}

/// The marker's text for `sections`; empty without any, like a new marker.
pub fn format_sections(sections: &Sections) -> String {
    if sections.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "// Sliver: this folder is the Zettelkasten. Its sections: names of runs of sequences.\n\
         #let sections = (\n",
    );
    for (first, (last, name)) in sections {
        let key = if first == last {
            first.to_string()
        } else {
            format!("{first}-{last}")
        };
        out.push_str(&format!("  \"{key}\": {},\n", string_literal(name)));
    }
    out.push_str(")\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_ranges() {
        let sections = Sections::from([
            (1, (1, "Probability".to_owned())),
            (4, (5, "A \"quote\"".to_owned())),
        ]);
        let text = format_sections(&sections);
        assert!(text.contains("\"4-5\": \"A \\\"quote\\\"\""), "{text}");
        assert_eq!(parse_sections(&text), sections);
        assert_eq!(format_sections(&Sections::new()), "");
        assert!(parse_sections("").is_empty());
    }

    #[test]
    fn skips_what_it_cant_read() {
        let text = "#let sections = (\"1\": \"One\", \"x\": \"No\", \"0\": \"No\", \"3-2\": \"No\", \"1-2\": \"Overlaps\", \"2\": 3, three: \"No\", \"4-6\": \"Run\")\n#let other = (\"9\": \"No\")";
        assert_eq!(
            parse_sections(text),
            Sections::from([(1, (1, "One".to_owned())), (4, (6, "Run".to_owned()))])
        );
    }
}
