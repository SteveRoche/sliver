//! Minimal reader for the uncompressed tar archives Typst packages ship as.
//! Handles ustar (with `prefix`), pax `path` records and GNU long names;
//! skips directories, links and anything else that isn't a regular file.

const BLOCK: usize = 512;

pub(crate) fn entries(tar: &[u8]) -> Result<Vec<(String, &[u8])>, String> {
    let mut out = Vec::new();
    let mut long_path: Option<String> = None;
    let mut offset = 0;
    while offset + BLOCK <= tar.len() {
        let header = &tar[offset..offset + BLOCK];
        if header.iter().all(|&b| b == 0) {
            break;
        }
        let size = octal(&header[124..136]).ok_or("bad entry size")?;
        let start = offset + BLOCK;
        let end = start
            .checked_add(size)
            .filter(|&e| e <= tar.len())
            .ok_or("truncated archive")?;
        let data = &tar[start..end];
        offset = start + size.div_ceil(BLOCK) * BLOCK;

        match header[156] {
            b'x' => long_path = pax_path(data).or(long_path),
            b'L' => long_path = Some(cstr(data)),
            b'0' | 0 | b'7' => {
                let path = match long_path.take() {
                    Some(path) => path,
                    None => {
                        let name = cstr(&header[0..100]);
                        let prefix = if &header[257..262] == b"ustar" {
                            cstr(&header[345..500])
                        } else {
                            String::new()
                        };
                        if prefix.is_empty() {
                            name
                        } else {
                            format!("{prefix}/{name}")
                        }
                    }
                };
                out.push((
                    safe_path(&path).ok_or_else(|| format!("unsafe path {path:?}"))?,
                    data,
                ));
            }
            _ => long_path = None,
        }
    }
    Ok(out)
}

fn cstr(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

fn octal(field: &[u8]) -> Option<usize> {
    let text = cstr(field);
    let text = text.trim();
    if text.is_empty() {
        return Some(0);
    }
    usize::from_str_radix(text, 8).ok()
}

/// pax records are `"<len> <key>=<value>\n"`.
fn pax_path(data: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(data).ok()?;
    text.lines()
        .filter_map(|record| record.split_once(' ')?.1.split_once('='))
        .find(|(key, _)| *key == "path")
        .map(|(_, value)| value.to_owned())
}

/// A relative, `/`-separated path without `..`; `./` prefixes are dropped.
fn safe_path(path: &str) -> Option<String> {
    let parts: Vec<&str> = path
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    let ok = !path.starts_with('/')
        && !path.contains('\\')
        && !parts.is_empty()
        && parts.iter().all(|p| *p != "..");
    ok.then(|| parts.join("/"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn header(name: &str, size: usize, kind: u8, prefix: &str) -> Vec<u8> {
        let mut h = vec![0u8; BLOCK];
        h[..name.len()].copy_from_slice(name.as_bytes());
        let size = format!("{size:011o}");
        h[124..135].copy_from_slice(size.as_bytes());
        h[156] = kind;
        h[257..262].copy_from_slice(b"ustar");
        h[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
        h
    }

    fn push(tar: &mut Vec<u8>, name: &str, kind: u8, prefix: &str, data: &[u8]) {
        tar.extend(header(name, data.len(), kind, prefix));
        tar.extend(data);
        tar.resize(tar.len().div_ceil(BLOCK) * BLOCK, 0);
    }

    /// Builds an archive from `(path, contents)`; long paths use a pax record.
    pub(crate) fn archive(files: &[(&str, &str)]) -> Vec<u8> {
        let mut tar = Vec::new();
        push(&mut tar, "dir/", b'5', "", b"");
        for (path, contents) in files {
            if path.len() > 100 {
                let record = format!("path={path}\n");
                let record = format!("{} {record}", record.len() + 3);
                push(&mut tar, "PaxHeader", b'x', "", record.as_bytes());
                push(&mut tar, "ignored", b'0', "", contents.as_bytes());
            } else {
                push(&mut tar, path, b'0', "", contents.as_bytes());
            }
        }
        tar.extend([0u8; BLOCK * 2]);
        tar
    }

    #[test]
    fn reads_files_and_skips_directories() {
        let long = format!("{}/lib.typ", "d".repeat(120));
        let tar = archive(&[
            ("typst.toml", "[package]"),
            ("./src/lib.typ", "#let x = 1"),
            (&long, "y"),
        ]);
        let files: Vec<(String, String)> = entries(&tar)
            .unwrap()
            .into_iter()
            .map(|(p, d)| (p, String::from_utf8(d.to_vec()).unwrap()))
            .collect();
        assert_eq!(
            files,
            vec![
                ("typst.toml".into(), "[package]".into()),
                ("src/lib.typ".into(), "#let x = 1".into()),
                (long, "y".into()),
            ]
        );
    }

    #[test]
    fn joins_ustar_prefix() {
        let mut tar = Vec::new();
        push(&mut tar, "lib.typ", b'0', "src", b"x");
        assert_eq!(entries(&tar).unwrap()[0].0, "src/lib.typ");
    }

    #[test]
    fn rejects_escaping_paths_and_truncation() {
        assert!(entries(&archive(&[("../evil", "x")])).is_err());
        assert!(entries(&archive(&[("/abs", "x")])).is_err());
        let mut tar = archive(&[("a", "contents")]);
        tar.truncate(BLOCK * 2 + 3);
        assert!(entries(&tar).is_err());
    }
}
