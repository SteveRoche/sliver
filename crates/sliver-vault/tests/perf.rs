//! Timings of the vault's hot paths on generated vaults (never a personal
//! one). Ignored by default; run with
//! `cargo test --release -p sliver-vault --test perf -- --ignored --nocapture`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sliver_vault::{Uuid, Vault};

struct TempVault(PathBuf);

impl Drop for TempVault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Address of the `i`th Zettelkasten note: sequences of 100 notes, each a
/// train of `1.k`, `1.ka`, `1.ka1`, ...
fn address(i: usize) -> String {
    let sequence = i / 100 + 1;
    let within = i % 100;
    let (top, depth) = (within / 4 + 1, within % 4);
    let mut out = format!("{sequence}.{top}");
    if depth >= 1 {
        out.push('a');
    }
    if depth >= 2 {
        out.push('1');
    }
    if depth >= 3 {
        out.push('a');
    }
    out
}

/// Half the notes in the Zettelkasten, the rest in 20 folders; each links to
/// five others by address and has a few paragraphs of text.
fn generate(notes: usize) -> (TempVault, Vec<Uuid>) {
    let root = std::env::temp_dir().join(format!("sliver-perf-{}", Uuid::new_v4()));
    fs::create_dir_all(root.join(".sliver")).unwrap();
    fs::create_dir_all(root.join("Zettelkasten")).unwrap();
    fs::write(root.join("Zettelkasten/.zettelkasten"), "").unwrap();
    let addressed = notes / 2;
    let mut ids = Vec::with_capacity(notes);
    for i in 0..notes {
        let id = Uuid::new_v4();
        ids.push(id);
        let (folder, header) = if i < addressed {
            (
                "Zettelkasten".to_owned(),
                format!(
                    "#metadata((title: \"Note {i}\", address: \"{}\", tags: (\"t{}\",))) <note>",
                    address(i),
                    i % 7
                ),
            )
        } else {
            (
                format!("Folder {}", i % 20),
                format!("#metadata((title: \"Note {i}\",)) <note>"),
            )
        };
        let links: String = (1..=5)
            .map(|k| format!("[[{}]] ", address((i * 7 + k * 13) % addressed)))
            .collect();
        let body = "Some prose with *emphasis* and a formula $x^2$.\n\n".repeat(8);
        let dir = root.join(&folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{id}.typ")),
            format!("{header}\n= Note {i}\n\n{links}\n\n{body}"),
        )
        .unwrap();
    }
    (TempVault(root), ids)
}

fn time<T>(label: &str, runs: u32, mut f: impl FnMut() -> T) -> T {
    let mut best = Duration::MAX;
    let mut out = None;
    for _ in 0..runs {
        let started = Instant::now();
        out = Some(f());
        best = best.min(started.elapsed());
    }
    println!("  {label:<38} {:>9.2} ms", best.as_secs_f64() * 1000.0);
    out.unwrap()
}

fn run(notes: usize) {
    println!("{notes} notes:");
    let (dir, ids) = generate(notes);
    let root: &Path = &dir.0;
    let mut vault = time("Vault::open", 3, || Vault::open(root).unwrap());
    let resolved = (0..notes / 2)
        .filter(|i| vault.resolve(&address(*i)).is_some())
        .count();
    assert_eq!(resolved, notes / 2, "every generated address resolves");
    time("tree()", 5, || vault.tree());
    time("refresh() (nothing changed)", 3, || {
        vault.refresh().unwrap()
    });

    let targets: Vec<String> = (0..50).map(|i| address(i * 3)).collect();
    let former = HashMap::new();
    time("link_table (50 targets)", 5, || {
        vault.link_table(&targets, &former)
    });
    time("resolve x 10,000", 3, || {
        (0..10_000)
            .filter(|i| vault.resolve(&address(i % (notes / 2))).is_some())
            .count()
    });

    let id = ids[0];
    let text = fs::read_to_string(root.join(format!("Zettelkasten/{id}.typ"))).unwrap();
    let mut n = 0;
    time("write_note (with fsync)", 5, || {
        n += 1;
        vault.write_note(id, &format!("{text}\nedit {n}")).unwrap()
    });
    let path = vec![format!("Zettelkasten/{id}.typ")];
    time("matches_disk (own write)", 5, || {
        assert!(vault.matches_disk(&path))
    });
}

#[test]
#[ignore]
fn vault_timings() {
    for notes in [2_000, 10_000] {
        run(notes);
    }
}
