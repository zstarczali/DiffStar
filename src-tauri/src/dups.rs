//! Duplicate finder: files with the same content in one or more folders.
//! Files are grouped by size first, then by a hash of the first 64 KB, and
//! only the remaining candidates are hashed in full (SHA-256).

use crate::dirs::{wild, CANCEL, PROGRESS};
use crate::files::mtime_of;
use crate::settings::tr;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering as AO;

const HEAD: usize = 64 * 1024;

#[derive(Deserialize, Debug, Clone)]
#[serde(default)]
pub struct DupOpts {
    /// `;` separated name patterns with * and ? that are skipped
    pub ignore: String,
    /// smaller files are not reported (empty files are always skipped)
    pub min_size: u64,
}

impl Default for DupOpts {
    fn default() -> Self {
        DupOpts { ignore: String::new(), min_size: 1 }
    }
}

#[derive(Serialize, Debug, Clone)]
pub struct DupFile {
    /// index of the folder in the request
    pub root: usize,
    pub path: String,
    /// path inside its folder, with `/`
    pub rel: String,
    pub mtime: f64,
}

#[derive(Serialize, Debug)]
pub struct DupGroup {
    pub size: u64,
    pub files: Vec<DupFile>,
}

#[derive(Serialize, Debug)]
pub struct DupResult {
    pub groups: Vec<DupGroup>,
    /// files looked at
    pub scanned: u64,
    /// bytes that the extra copies take
    pub wasted: u64,
    pub cancelled: bool,
}

struct Cand {
    root: usize,
    path: PathBuf,
    rel: String,
    size: u64,
}

fn walk(root: usize, dir: &Path, rel: &str, ignore: &[String], min: u64, seen: &mut HashSet<PathBuf>, out: &mut Vec<Cand>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if CANCEL.load(AO::Relaxed) {
            return;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if ignore.iter().any(|p| wild(p, &name)) {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue; // links would only report themselves as duplicates
        }
        let path = e.path();
        let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if ft.is_dir() {
            walk(root, &path, &r, ignore, min, seen, out);
        } else if let Ok(m) = e.metadata() {
            PROGRESS.fetch_add(1, AO::Relaxed);
            let size = m.len();
            if size == 0 || size < min {
                continue;
            }
            // overlapping folders (one inside the other): count each file once
            let key = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if seen.insert(key) {
                out.push(Cand { root, path, rel: r, size });
            }
        }
    }
}

fn hash(path: &Path, limit: Option<usize>) -> Option<[u8; 32]> {
    let mut f = fs::File::open(path).ok()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut left = limit.unwrap_or(usize::MAX);
    while left > 0 {
        if CANCEL.load(AO::Relaxed) {
            return None;
        }
        let want = buf.len().min(left);
        let n = f.read(&mut buf[..want]).ok()?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        left -= n;
    }
    Some(h.finalize().into())
}

/// Splits each group by the key; groups of one are dropped.
fn split<K: std::hash::Hash + Eq>(groups: Vec<Vec<Cand>>, key: impl Fn(&Cand) -> Option<K>) -> Vec<Vec<Cand>> {
    let mut out = Vec::new();
    for g in groups {
        if CANCEL.load(AO::Relaxed) {
            break;
        }
        let mut m: HashMap<K, Vec<Cand>> = HashMap::new();
        for c in g {
            if let Some(k) = key(&c) {
                m.entry(k).or_default().push(c);
            }
        }
        out.extend(m.into_values().filter(|v| v.len() > 1));
    }
    out
}

pub fn find(roots: &[String], opts: &DupOpts) -> Result<DupResult, String> {
    if roots.is_empty() {
        return Err(tr("Nincs megadva mappa.", "No folder given."));
    }
    for p in roots {
        if !Path::new(p).is_dir() {
            return Err(tr(&format!("A mappa nem található: {p}"), &format!("Folder not found: {p}")));
        }
    }
    CANCEL.store(false, AO::Relaxed);
    PROGRESS.store(0, AO::Relaxed);
    let ignore: Vec<String> = opts.ignore.split(';').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let mut all = Vec::new();
    let mut seen = HashSet::new();
    for (i, r) in roots.iter().enumerate() {
        walk(i, Path::new(r), "", &ignore, opts.min_size.max(1), &mut seen, &mut all);
    }
    let scanned = PROGRESS.load(AO::Relaxed);

    // 1. same size
    let mut by_size: HashMap<u64, Vec<Cand>> = HashMap::new();
    for c in all {
        by_size.entry(c.size).or_default().push(c);
    }
    let groups: Vec<Vec<Cand>> = by_size.into_values().filter(|v| v.len() > 1).collect();
    // 2. same beginning; 3. same full content (small files are already fully hashed)
    let groups = split(groups, |c| hash(&c.path, Some(HEAD)));
    let groups = split(groups, |c| if c.size as usize <= HEAD { Some([0u8; 32]) } else { hash(&c.path, None) });

    let mut out: Vec<DupGroup> = groups
        .into_iter()
        .map(|mut g| {
            g.sort_by(|a, b| a.root.cmp(&b.root).then_with(|| crate::dirs::natural_cmp(&a.rel, &b.rel)));
            DupGroup {
                size: g[0].size,
                files: g
                    .into_iter()
                    .map(|c| DupFile { root: c.root, mtime: fs::metadata(&c.path).map(|m| mtime_of(&m)).unwrap_or(0.0), path: c.path.to_string_lossy().into_owned(), rel: c.rel })
                    .collect(),
            }
        })
        .collect();
    // the most wasted space first
    out.sort_by(|a, b| (b.size * (b.files.len() as u64 - 1)).cmp(&(a.size * (a.files.len() as u64 - 1))).then_with(|| a.files[0].rel.cmp(&b.files[0].rel)));
    let wasted = out.iter().map(|g| g.size * (g.files.len() as u64 - 1)).sum();
    Ok(DupResult { groups: out, scanned, wasted, cancelled: CANCEL.load(AO::Relaxed) })
}

/// Moves files to the recycle bin / trash.
pub fn to_trash(paths: &[String]) -> Result<(), String> {
    trash::delete_all(paths).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_duplicates_across_folders() {
        let base = std::env::temp_dir().join(format!("diffstar-dups-{}", std::process::id()));
        let (a, b) = (base.join("a"), base.join("b"));
        fs::create_dir_all(a.join("sub")).unwrap();
        fs::create_dir_all(&b).unwrap();
        let big: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let mut big2 = big.clone();
        *big2.last_mut().unwrap() ^= 1; // same size and beginning, different end
        fs::write(a.join("x.txt"), "hello").unwrap();
        fs::write(a.join("sub/y.txt"), "hello").unwrap();
        fs::write(b.join("z.txt"), "hello").unwrap();
        fs::write(b.join("other.txt"), "world").unwrap();
        fs::write(a.join("big.bin"), &big).unwrap();
        fs::write(b.join("big copy.bin"), &big).unwrap();
        fs::write(b.join("big2.bin"), &big2).unwrap();
        fs::write(a.join("empty1"), "").unwrap();
        fs::write(b.join("empty2"), "").unwrap();

        let roots = vec![a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned()];
        let r = find(&roots, &DupOpts::default()).unwrap();
        assert_eq!(r.groups.len(), 2);
        assert_eq!(r.groups[0].size, 200_000); // most wasted space first
        assert_eq!(r.groups[0].files.len(), 2);
        let small = &r.groups[1];
        assert_eq!(small.files.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(), vec!["sub/y.txt", "x.txt", "z.txt"]);
        assert_eq!(small.files[2].root, 1);
        assert_eq!(r.wasted, 200_000 + 2 * 5);

        // the same folder twice: nothing is its own duplicate
        let r = find(&[roots[1].clone(), roots[1].clone()], &DupOpts::default()).unwrap();
        assert_eq!(r.groups.len(), 0);
        let _ = fs::remove_dir_all(&base);
    }
}
