//! Moving notes between places: filing a folder note into the Zettelkasten,
//! re-addressing a Zettelkasten note (with its subtree), and unfiling one
//! into a folder. Wikilinks that pointed at a changed address are rewritten
//! so they keep resolving to the same note.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use uuid::Uuid;

use super::{Placement, Result, Vault, VaultError};
use crate::Address;
use crate::header::set_address;
use crate::links::links_in;

/// What [`Vault::apply_move`] would do, for a confirmation prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovePlan {
    pub moves: Vec<AddressChange>,
    pub link_edits: Vec<LinkEdits>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AddressChange {
    pub id: Uuid,
    pub from: Option<String>,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkEdits {
    pub id: Uuid,
    pub count: usize,
}

/// Old address -> the link target that replaces it.
type LinkMap = HashMap<Address, String>;

impl Vault {
    /// Dry run of [`Vault::apply_move`].
    pub fn plan_move(&self, id: Uuid, placement: &Placement) -> Result<MovePlan> {
        let moves = self.address_moves(id, placement)?;
        let map = self.link_map(&moves);
        let mut link_edits: Vec<LinkEdits> = self
            .links
            .iter()
            .map(|(&id, links)| LinkEdits {
                id,
                count: links
                    .iter()
                    .filter(|l| replacement(&map, &l.target).is_some())
                    .count(),
            })
            .filter(|edits| edits.count > 0)
            .collect();
        link_edits.sort_by_key(|e| e.id);
        Ok(MovePlan {
            moves: moves
                .into_iter()
                .map(|(id, from, to)| AddressChange {
                    id,
                    from,
                    to: to.to_string(),
                })
                .collect(),
            link_edits,
        })
    }

    /// Gives note `id` the address `placement` asks for, moving its file into
    /// the Zettelkasten if it isn't there yet. A Zettelkasten note takes its
    /// whole subtree along (`1.1a` -> `3.1` renumbers `1.1a1` to `3.1a`).
    /// Returns every note whose file changed.
    ///
    /// Not transactional across files: if it fails partway, some links may
    /// still name old addresses (they show as broken), but no file is ever
    /// half-written.
    pub fn apply_move(&mut self, id: Uuid, placement: &Placement) -> Result<Vec<Uuid>> {
        let moves = self.address_moves(id, placement)?;
        let map = self.link_map(&moves);
        let zettelkasten = self.zettelkasten()?.to_owned();
        self.relocate(id, &zettelkasten)?;
        let mut changed = Vec::new();
        for (note, _, to) in &moves {
            let text = set_address(&self.read_note(*note)?, Some(&to.to_string()))?;
            self.write_note(*note, &text)?;
            changed.push(*note);
        }
        changed.extend(self.rewrite_links(&map)?);
        Ok(dedup(changed))
    }

    /// Moves note `id` into `folder` (not the Zettelkasten: that's
    /// [`Vault::apply_move`]). Leaving the Zettelkasten drops its address,
    /// and links to that address are rewritten to the note's uuid; notes
    /// under it keep their addresses and attach to the nearest remaining
    /// ancestor. Returns every note whose file changed.
    pub fn move_to_folder(&mut self, id: Uuid, folder: &str) -> Result<Vec<Uuid>> {
        self.require_folder(folder)?;
        if self.zettelkasten.as_deref() == Some(folder) {
            return Err(VaultError::Refused(
                "notes enter the Zettelkasten by filing them at an address".into(),
            ));
        }
        let note = self.note(id)?;
        let unfiled = self.address_of(note).filter(|a| self.owns(id, a));
        let leaving = self.in_zettelkasten(note);
        self.relocate(id, folder)?;
        if !leaving {
            return Ok(Vec::new());
        }
        let text = set_address(&self.read_note(id)?, None)?;
        self.write_note(id, &text)?;
        let mut changed = vec![id];
        if let Some(address) = unfiled {
            changed.extend(self.rewrite_links(&HashMap::from([(address, id.to_string())]))?);
        }
        Ok(dedup(changed))
    }

    /// `(note, old address, new address)` for everything a move renumbers.
    fn address_moves(
        &self,
        id: Uuid,
        placement: &Placement,
    ) -> Result<Vec<(Uuid, Option<String>, Address)>> {
        let zettelkasten = self.zettelkasten()?;
        let note = self.note(id)?;
        let subtree: Vec<(Uuid, Address)> = match self.address_of(note) {
            Some(root) => self
                .notes
                .values()
                .filter(|n| n.folder == zettelkasten)
                .filter_map(|n| {
                    let a: Address = n.address.as_deref()?.parse().ok()?;
                    a.starts_with(&root).then_some((n.id, a))
                })
                .collect(),
            None => Vec::new(),
        };
        let members: HashSet<Uuid> = subtree.iter().map(|(n, _)| *n).chain([id]).collect();
        if let Placement::Aside { of } | Placement::Next { of } = placement
            && members.contains(of)
        {
            return Err(VaultError::Refused(
                "a note can't be moved next to or under itself".into(),
            ));
        }
        let new_root = self.allocate(placement, &self.taken_addresses(&members))?;
        let old = |n: Uuid| self.notes[&n].address.clone();
        Ok(match self.address_of(note) {
            Some(root) => {
                let mut moves: Vec<_> = subtree
                    .into_iter()
                    .filter_map(|(n, a)| Some((n, old(n), a.rebase(&root, &new_root)?)))
                    .collect();
                moves.sort_by(|x, y| x.2.cmp(&y.2));
                moves
            }
            None => vec![(id, old(id), new_root)],
        })
    }

    /// Only addresses that currently resolve to the moving note are
    /// rewritten; a stray duplicate address belongs to someone else.
    fn link_map(&self, moves: &[(Uuid, Option<String>, Address)]) -> LinkMap {
        moves
            .iter()
            .filter_map(|(id, from, to)| {
                let from: Address = from.as_deref()?.parse().ok()?;
                self.owns(*id, &from).then(|| (from, to.to_string()))
            })
            .collect()
    }

    fn owns(&self, id: Uuid, address: &Address) -> bool {
        self.resolve(&address.to_string()) == Some(id)
    }

    /// Rewrites the target of every wikilink whose address is in `map`,
    /// keeping the rest of the link (custom text, spacing) as it was.
    fn rewrite_links(&mut self, map: &LinkMap) -> Result<Vec<Uuid>> {
        if map.is_empty() {
            return Ok(Vec::new());
        }
        let mut sources: Vec<Uuid> = self
            .links
            .iter()
            .filter(|(_, links)| links.iter().any(|l| replacement(map, &l.target).is_some()))
            .map(|(id, _)| *id)
            .collect();
        sources.sort();
        for &id in &sources {
            // Re-read rather than trust cached ranges: the file is what gets edited.
            let mut text = self.read_note(id)?;
            let edits: Vec<_> = links_in(&typst_syntax::parse(&text))
                .into_iter()
                .filter_map(|link| {
                    let new = replacement(map, &link.target)?;
                    let inner = link.range.start + 2;
                    let at = inner + text[inner..link.range.end].find(&link.target)?;
                    Some((at..at + link.target.len(), new.to_owned()))
                })
                .collect();
            for (range, new) in edits.into_iter().rev() {
                text.replace_range(range, &new);
            }
            self.write_note(id, &text)?;
        }
        Ok(sources)
    }
}

fn replacement<'a>(map: &'a LinkMap, target: &str) -> Option<&'a str> {
    map.get(&target.parse::<Address>().ok()?)
        .map(String::as_str)
}

fn dedup(mut ids: Vec<Uuid>) -> Vec<Uuid> {
    let mut seen = HashSet::new();
    ids.retain(|id| seen.insert(*id));
    ids
}

#[cfg(test)]
mod tests {
    use super::super::tests::TempDir;
    use super::*;
    use crate::vault::{FolderNode, TreeNode};

    fn addresses(tree: &[TreeNode]) -> Vec<String> {
        tree.iter()
            .map(|node| {
                let own = node.note.address.clone().unwrap_or_else(|| "-".into());
                let kids = addresses(&node.children);
                if kids.is_empty() {
                    own
                } else {
                    format!("{own}[{}]", kids.join(" "))
                }
            })
            .collect()
    }

    fn zettelkasten(tree: &FolderNode) -> &FolderNode {
        tree.folders
            .iter()
            .find(|f| f.path == "Zettelkasten")
            .unwrap()
    }

    fn note(vault: &mut Vault, placement: Placement, body: &str) -> Uuid {
        let id = vault.create_note(None, placement).unwrap().id;
        let text = format!("{}\n{body}", vault.read_note(id).unwrap().trim_end());
        vault.write_note(id, &text).unwrap();
        id
    }

    #[test]
    fn filing_assigns_an_address_and_moves_the_file() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        vault.create_folder("", "Inbox").unwrap();
        let one = note(&mut vault, Placement::Top, "");
        let fleeting = note(
            &mut vault,
            Placement::Unaddressed {
                folder: "Inbox".into(),
            },
            "",
        );
        let linker = note(&mut vault, Placement::Top, &format!("[[{fleeting}]]"));

        let next = Placement::Next { of: one };
        let plan = vault.plan_move(fleeting, &next).unwrap();
        assert_eq!(plan.moves[0].to, "1.1");
        assert!(plan.link_edits.is_empty(), "uuid links need no rewrite");

        let changed = vault.apply_move(fleeting, &next).unwrap();
        assert_eq!(changed, vec![fleeting]);
        assert!(dir.0.join(format!("Zettelkasten/{fleeting}.typ")).is_file());
        assert!(!dir.0.join(format!("Inbox/{fleeting}.typ")).exists());
        assert_eq!(vault.resolve(&fleeting.to_string()), Some(fleeting));
        assert_eq!(vault.backlinks(fleeting).unwrap()[0].id, linker);

        let reopened = Vault::open(&dir.0).unwrap();
        assert_eq!(
            addresses(&zettelkasten(&reopened.tree()).notes),
            ["1[1.1]", "2"]
        );
    }

    #[test]
    fn readdressing_moves_the_subtree_and_rewrites_links() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        let one = note(&mut vault, Placement::Top, "");
        let one_one = note(&mut vault, Placement::Next { of: one }, "");
        let child = note(&mut vault, Placement::Next { of: one_one }, "");
        let two = note(&mut vault, Placement::Top, "");
        // An orphan under 2.1 blocks it, so the move lands on 2.2.
        let orphan = note(&mut vault, Placement::Top, "");
        let text = vault
            .read_note(orphan)
            .unwrap()
            .replace("\"3\"", "\"2.1a\"");
        vault.write_note(orphan, &text).unwrap();
        let linker = note(
            &mut vault,
            Placement::Top,
            "[[1.1]] [[ 1.1a | the child ]] `[[1.1]]` [[1]]",
        );

        let next = Placement::Next { of: two };
        let plan = vault.plan_move(one_one, &next).unwrap();
        let moved: Vec<_> = plan.moves.iter().map(|m| m.to.as_str()).collect();
        assert_eq!(moved, ["2.2", "2.2a"]);
        assert_eq!(
            plan.link_edits,
            vec![LinkEdits {
                id: linker,
                count: 2
            }]
        );

        let mut changed = vault.apply_move(one_one, &next).unwrap();
        changed.sort();
        let mut expected = vec![one_one, child, linker];
        expected.sort();
        assert_eq!(changed, expected);
        assert!(
            vault
                .read_note(linker)
                .unwrap()
                .ends_with("[[2.2]] [[ 2.2a | the child ]] `[[1.1]]` [[1]]")
        );
        assert_eq!(vault.resolve("2.2a"), Some(child));
        assert_eq!(
            addresses(&zettelkasten(&vault.tree()).notes),
            ["1", "2[2.1a 2.2[2.2a]]", "3"]
        );

        assert!(matches!(
            vault.apply_move(one, &Placement::Next { of: one }),
            Err(VaultError::Refused(_))
        ));
        assert!(matches!(
            vault.apply_move(two, &Placement::Aside { of: child }),
            Err(VaultError::Refused(_))
        ));
    }

    #[test]
    fn unfiling_drops_the_address_and_points_links_at_the_uuid() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        vault.create_folder("", "Inbox").unwrap();
        let one = note(&mut vault, Placement::Top, "");
        let child = note(&mut vault, Placement::Next { of: one }, "");
        let linker = note(&mut vault, Placement::Top, "[[1|first]]");

        let changed = vault.move_to_folder(one, "Inbox").unwrap();
        assert_eq!(changed, vec![one, linker]);
        assert_eq!(vault.note(one).unwrap().address, None);
        assert_eq!(vault.note(one).unwrap().folder, "Inbox");
        assert!(
            vault
                .read_note(linker)
                .unwrap()
                .ends_with(&format!("[[{one}|first]]"))
        );
        assert_eq!(vault.resolve("1.1"), Some(child));
        assert_eq!(addresses(&zettelkasten(&vault.tree()).notes), ["1.1", "2"]);
        assert!(matches!(
            vault.move_to_folder(child, "Zettelkasten"),
            Err(VaultError::Refused(_))
        ));
    }
}
