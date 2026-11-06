//! Folgezettel addresses in Bob Doto's style: `1.1`, `1.1a`, `1.1a1`,
//! `1.1b`, `1.2`, ... The first number names a **sequence** (`1`), which
//! isn't a note: notes start one level below it (`1.1`, `1.2`).
//!
//! Grammar: `num "." num (alpha num)* alpha?`. Numbers have no leading
//! zeros; letter runs are bijective base 26 (`z` is followed by `aa`).
//! Ordering is segment by segment with a parent sorting before its children,
//! which yields the tree's depth-first order.

use std::fmt;
use std::str::FromStr;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Address(Vec<u32>);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddressError(pub String);

impl fmt::Display for AddressError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid Zettelkasten address: {:?}", self.0)
    }
}

impl std::error::Error for AddressError {}

/// Segments 0 and 1 are numbers; after that letters and numbers alternate.
fn is_alpha(index: usize) -> bool {
    index >= 2 && index.is_multiple_of(2)
}

impl Address {
    /// The first note's place in sequence `number`: `3` -> `3.1`.
    pub fn first_in_sequence(number: u32) -> Address {
        Address(vec![number.max(1), 1])
    }

    /// The sequence the address is in: `3` for `3.2a`.
    pub fn sequence(&self) -> u32 {
        self.0[0]
    }

    /// The note this one follows from; none for a sequence's first-level
    /// notes (`1.2`), since a sequence number isn't a note.
    pub fn parent(&self) -> Option<Address> {
        (self.0.len() > 2).then(|| Address(self.0[..self.0.len() - 1].to_vec()))
    }

    /// Same depth, one further along: `1.1a` -> `1.1b` (the place for an aside).
    pub fn next_sibling(&self) -> Address {
        let mut segments = self.0.clone();
        if let Some(last) = segments.last_mut() {
            *last += 1;
        }
        Address(segments)
    }

    /// One level deeper: `1.1` -> `1.1a`, `1.1a` -> `1.1a1` (the place for a next note).
    pub fn first_child(&self) -> Address {
        let mut segments = self.0.clone();
        segments.push(1);
        Address(segments)
    }

    pub fn depth(&self) -> usize {
        self.0.len()
    }

    /// True for `prefix` itself and every address in its subtree.
    pub fn starts_with(&self, prefix: &Address) -> bool {
        self.0.starts_with(&prefix.0)
    }

    /// Moves an address in `from`'s subtree under `to`: `1.1a2` rebased from
    /// `1.1a` to `3.1` is `3.1a`. Letter and number segments follow from the
    /// depth, so nothing but the segment values carries over.
    pub fn rebase(&self, from: &Address, to: &Address) -> Option<Address> {
        let rest = self.0.strip_prefix(from.0.as_slice())?;
        Some(Address([to.0.as_slice(), rest].concat()))
    }
}

impl FromStr for Address {
    type Err = AddressError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let err = || AddressError(s.to_owned());
        let (head, rest) = match s.split_once('.') {
            Some((head, rest)) => (head, Some(rest)),
            None => (s, None),
        };

        let mut segments = vec![parse_num(head).ok_or_else(err)?];
        // A bare number is a sequence, not a note's address.
        let rest = rest.ok_or_else(err)?;
        {
            if rest.is_empty() {
                return Err(err());
            }
            let mut remaining = rest;
            while !remaining.is_empty() {
                let alpha = is_alpha(segments.len());
                let run_len = remaining
                    .find(|c: char| {
                        if alpha {
                            !c.is_ascii_lowercase()
                        } else {
                            !c.is_ascii_digit()
                        }
                    })
                    .unwrap_or(remaining.len());
                let (run, tail) = remaining.split_at(run_len);
                let value = if alpha {
                    parse_alpha(run)
                } else {
                    parse_num(run)
                };
                segments.push(value.ok_or_else(err)?);
                remaining = tail;
            }
        }
        Ok(Address(segments))
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, &value) in self.0.iter().enumerate() {
            if index == 1 {
                f.write_str(".")?;
            }
            if is_alpha(index) {
                f.write_str(&format_alpha(value))?;
            } else {
                write!(f, "{value}")?;
            }
        }
        Ok(())
    }
}

fn parse_num(run: &str) -> Option<u32> {
    if run.is_empty() || run.starts_with('0') || !run.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    run.parse().ok()
}

fn parse_alpha(run: &str) -> Option<u32> {
    if run.is_empty() {
        return None;
    }
    run.bytes().try_fold(0u32, |acc, b| {
        acc.checked_mul(26)?.checked_add(u32::from(b - b'a') + 1)
    })
}

fn format_alpha(mut value: u32) -> String {
    let mut letters = Vec::new();
    while value > 0 {
        value -= 1;
        letters.push(b'a' + (value % 26) as u8);
        value /= 26;
    }
    letters.reverse();
    String::from_utf8(letters).expect("ASCII letters")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(s: &str) -> Address {
        s.parse().unwrap()
    }

    #[test]
    fn round_trips_valid_addresses() {
        for s in [
            "12.1", "1.1", "1.10", "1.1a", "1.1z", "1.1aa", "1.1a1", "3.2b14c",
        ] {
            assert_eq!(a(s).to_string(), s);
        }
    }

    #[test]
    fn rejects_invalid_addresses() {
        for s in [
            "", "0", "01", "1", "12", "1.", ".1", "1.a", "1a", "1.1A", "1..1", "1.01", "1.1a0",
            "1.1-a", "1.1a 1", "1.2.3",
        ] {
            assert!(s.parse::<Address>().is_err(), "{s:?} should be invalid");
        }
    }

    #[test]
    fn sorts_depth_first_with_numeric_segments() {
        let mut addresses: Vec<Address> = [
            "2.1", "1.10", "1.1b", "1.1a1", "1.2", "1.1", "1.1a", "1.1z", "1.1aa", "1.1a2", "1.9",
        ]
        .into_iter()
        .map(a)
        .collect();
        addresses.sort();
        let sorted: Vec<String> = addresses.iter().map(ToString::to_string).collect();
        assert_eq!(
            sorted,
            [
                "1.1", "1.1a", "1.1a1", "1.1a2", "1.1b", "1.1z", "1.1aa", "1.2", "1.9", "1.10",
                "2.1"
            ]
        );
    }

    #[test]
    fn next_sibling_increments_last_segment() {
        assert_eq!(a("1.1").next_sibling(), a("1.2"));
        assert_eq!(a("1.9").next_sibling(), a("1.10"));
        assert_eq!(a("1.1a").next_sibling(), a("1.1b"));
        assert_eq!(a("1.1z").next_sibling(), a("1.1aa"));
        assert_eq!(a("1.1az").next_sibling(), a("1.1ba"));
        assert_eq!(a("1.1a1").next_sibling(), a("1.1a2"));
    }

    #[test]
    fn first_child_appends_the_next_segment_kind() {
        assert_eq!(Address::first_in_sequence(1), a("1.1"));
        assert_eq!(a("1.1").first_child(), a("1.1a"));
        assert_eq!(a("1.1a").first_child(), a("1.1a1"));
        assert_eq!(a("1.1a1").first_child(), a("1.1a1a"));
    }

    #[test]
    fn parent_drops_last_segment() {
        assert_eq!(a("1.1a1").parent(), Some(a("1.1a")));
        assert_eq!(a("1.1a").parent(), Some(a("1.1")));
        assert_eq!(a("1.1").parent(), None);
    }

    #[test]
    fn rebase_moves_a_subtree() {
        assert_eq!(a("1.1a2").rebase(&a("1.1a"), &a("3.1")), Some(a("3.1b")));
        assert_eq!(a("1.1a").rebase(&a("1.1a"), &a("2.1")), Some(a("2.1")));
        assert_eq!(a("1.2").rebase(&a("1.1"), &a("2.1")), None);

        assert!(a("1.1a1").starts_with(&a("1.1")));
        assert!(!a("1.10").starts_with(&a("1.1a")));
    }
}
