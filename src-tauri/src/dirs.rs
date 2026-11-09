//! Folder comparison: walks both trees, pairs the entries by name and
//! compares the files (content byte by byte, or quickly by size + date).

use crate::files::{mtime_of, read_full};
use crate::settings::tr;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering as AO};

pub static CANCEL: AtomicBool = AtomicBool::new(false);
pub static PROGRESS: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize, Debug, Clone)]
#[serde(default)]
pub struct DirOpts {
    /// "content" | "quick"
    pub mode: String,
    /// `;` separated name patterns with * and ?
    pub ignore: String,
}

impl Default for DirOpts {
    fn default() -> Self {
        DirOpts { mode: "content".into(), ignore: String::new() }
    }
}

#[derive(Serialize, Debug, Clone)]
pub struct Side {
    pub size: u64,
    pub mtime: f64,
}

#[derive(Serialize, Debug)]
pub struct Entry {
    pub name: String,
    /// path relative to the compared folders, with `/`
    pub rel: String,
    pub is_dir: bool,
    pub left: Option<Side>,
    pub right: Option<Side>,
    /// "same" | "diff" | "left" | "right" | "error"
    pub status: String,
    pub error: String,
    pub children: Vec<Entry>,
    /// files below (dirs only), per status
    pub counts: Counts,
}

#[derive(Serialize, Debug, Default, Clone, Copy)]
pub struct Counts {
    pub same: u64,
    pub diff: u64,
    pub left: u64,
    pub right: u64,
}

impl Counts {
    fn add(&mut self, o: &Counts) {
        self.same += o.same;
        self.diff += o.diff;
        self.left += o.left;
        self.right += o.right;
    }
}

#[derive(Serialize, Debug)]
pub struct DirResult {
    pub root: Entry,
    pub cancelled: bool,
}

/// Simple wildcard match (* and ?), case-insensitive.
pub fn wild(pat: &str, name: &str) -> bool {
    let p: Vec<char> = pat.to_lowercase().chars().collect();
    let n: Vec<char> = name.to_lowercase().chars().collect();
    let (mut pi, mut ni, mut star, mut mark) = (0usize, 0usize, usize::MAX, 0usize);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            mark = ni;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Natural, case-insensitive order (file2 < file10).
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut ia, mut ib) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ia.peek().copied(), ib.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ia.peek().copied().filter(|c| c.is_ascii_digit()) {
                    na.push(c);
                    ia.next();
                }
                let mut nb = String::new();
                while let Some(c) = ib.peek().copied().filter(|c| c.is_ascii_digit()) {
                    nb.push(c);
                    ib.next();
                }
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let o = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if o != Ordering::Equal {
                    return o;
                }
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(&y);
                }
                ia.next();
                ib.next();
            }
        }
    }
}

struct Walker {
    mode: String,
    ignore: Vec<String>,
}

fn list(dir: &Path, w: &Walker) -> BTreeMap<String, (PathBuf, fs::Metadata)> {
    let mut out = BTreeMap::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if w.ignore.iter().any(|p| wild(p, &name)) {
                continue;
            }
            let path = e.path();
            // follow links (metadata), fall back to the link itself
            if let Ok(m) = fs::metadata(&path).or_else(|_| fs::symlink_metadata(&path)) {
                out.insert(name, (path, m));
            }
        }
    }
    out
}

fn same_content(a: &Path, b: &Path) -> Result<bool, String> {
    let mut fa = fs::File::open(a).map_err(|e| e.to_string())?;
    let mut fb = fs::File::open(b).map_err(|e| e.to_string())?;
    let mut ba = vec![0u8; 128 * 1024];
    let mut bb = vec![0u8; 128 * 1024];
    loop {
        if CANCEL.load(AO::Relaxed) {
            return Ok(false);
        }
        let na = read_full(&mut fa, &mut ba)?;
        let nb = read_full(&mut fb, &mut bb)?;
        if na != nb || ba[..na] != bb[..nb] {
            return Ok(false);
        }
        if na < ba.len() {
            return Ok(true);
        }
    }
}

fn side(m: &fs::Metadata) -> Side {
    Side { size: if m.is_dir() { 0 } else { m.len() }, mtime: mtime_of(m) }
}

/// One-sided subtree (only in the left or only in the right folder).
fn one_side(path: &Path, rel: &str, name: &str, m: &fs::Metadata, left: bool, w: &Walker, depth: u32) -> Entry {
    let status = if left { "left" } else { "right" };
    let mut e = Entry {
        name: name.to_string(),
        rel: rel.to_string(),
        is_dir: m.is_dir(),
        left: if left { Some(side(m)) } else { None },
        right: if left { None } else { Some(side(m)) },
        status: status.into(),
        error: String::new(),
        children: vec![],
        counts: Counts::default(),
    };
    if m.is_dir() && depth < 64 {
        for (n, (p, cm)) in list(path, w) {
            if CANCEL.load(AO::Relaxed) {
                break;
            }
            let c = one_side(&p, &format!("{rel}/{n}"), &n, &cm, left, w, depth + 1);
            e.counts.add(&c.counts);
            e.children.push(c);
        }
        sort(&mut e.children);
    } else if !m.is_dir() {
        PROGRESS.fetch_add(1, AO::Relaxed);
        if left { e.counts.left = 1 } else { e.counts.right = 1 }
    }
    e
}

fn sort(v: &mut [Entry]) {
    v.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| natural_cmp(&a.name, &b.name)));
}

fn compare_dir(l: &Path, r: &Path, rel: &str, name: &str, w: &Walker, depth: u32) -> Entry {
    let lm = fs::metadata(l).ok();
    let rm = fs::metadata(r).ok();
    let mut e = Entry {
        name: name.to_string(),
        rel: rel.to_string(),
        is_dir: true,
        left: lm.as_ref().map(side),
        right: rm.as_ref().map(side),
        status: "same".into(),
        error: String::new(),
        children: vec![],
        counts: Counts::default(),
    };
    if depth >= 64 {
        return e;
    }
    let ll = list(l, w);
    let rl = list(r, w);
    let mut names: Vec<&String> = ll.keys().chain(rl.keys()).collect();
    names.sort();
    names.dedup();
    for n in names {
        if CANCEL.load(AO::Relaxed) {
            break;
        }
        let crel = if rel.is_empty() { n.clone() } else { format!("{rel}/{n}") };
        let c = match (ll.get(n), rl.get(n)) {
            (Some((lp, lmeta)), Some((rp, rmeta))) => {
                if lmeta.is_dir() && rmeta.is_dir() {
                    compare_dir(lp, rp, &crel, n, w, depth + 1)
                } else if lmeta.is_dir() != rmeta.is_dir() {
                    // a file on one side, a folder on the other
                    let mut x = Entry {
                        name: n.clone(),
                        rel: crel.clone(),
                        is_dir: false,
                        left: Some(side(lmeta)),
                        right: Some(side(rmeta)),
                        status: "diff".into(),
                        error: tr("Az egyik oldalon fájl, a másikon mappa.", "A file on one side, a folder on the other."),
                        children: vec![],
                        counts: Counts::default(),
                    };
                    x.counts.diff = 1;
                    x
                } else {
                    compare_file(lp, rp, lmeta, rmeta, &crel, n, w)
                }
            }
            (Some((lp, lmeta)), None) => one_side(lp, &crel, n, lmeta, true, w, depth + 1),
            (None, Some((rp, rmeta))) => one_side(rp, &crel, n, rmeta, false, w, depth + 1),
            (None, None) => continue,
        };
        e.counts.add(&c.counts);
        e.children.push(c);
    }
    sort(&mut e.children);
    if e.counts.diff + e.counts.left + e.counts.right > 0 {
        e.status = "diff".into();
    }
    e
}

fn compare_file(lp: &Path, rp: &Path, lm: &fs::Metadata, rm: &fs::Metadata, rel: &str, name: &str, w: &Walker) -> Entry {
    PROGRESS.fetch_add(1, AO::Relaxed);
    let (ls, rs) = (side(lm), side(rm));
    let mut error = String::new();
    let same = if ls.size != rs.size {
        false
    } else if w.mode == "quick" {
        (ls.mtime - rs.mtime).abs() < 2.0
    } else {
        match same_content(lp, rp) {
            Ok(v) => v,
            Err(e) => {
                error = e;
                false
            }
        }
    };
    let status = if !error.is_empty() { "error" } else if same { "same" } else { "diff" };
    let mut counts = Counts::default();
    if same { counts.same = 1 } else { counts.diff = 1 }
    Entry {
        name: name.to_string(),
        rel: rel.to_string(),
        is_dir: false,
        left: Some(ls),
        right: Some(rs),
        status: status.into(),
        error,
        children: vec![],
        counts,
    }
}

pub fn compare(left: &str, right: &str, opts: &DirOpts) -> Result<DirResult, String> {
    for p in [left, right] {
        if !Path::new(p).is_dir() {
            return Err(tr(&format!("A mappa nem található: {p}"), &format!("Folder not found: {p}")));
        }
    }
    CANCEL.store(false, AO::Relaxed);
    PROGRESS.store(0, AO::Relaxed);
    let w = Walker {
        mode: opts.mode.clone(),
        ignore: opts.ignore.split(';').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
    };
    let root = compare_dir(Path::new(left), Path::new(right), "", "", &w, 0);
    Ok(DirResult { root, cancelled: CANCEL.load(AO::Relaxed) })
}

/// Copies a file or a whole folder (overwrites files that exist).
pub fn copy_entry(from: &str, to: &str) -> Result<(), String> {
    let src = Path::new(from);
    let dst = Path::new(to);
    let m = fs::metadata(src).map_err(|e| format!("{from}: {e}"))?;
    if m.is_dir() {
        fs::create_dir_all(dst).map_err(|e| format!("{to}: {e}"))?;
        for e in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
            let name = e.file_name();
            copy_entry(&e.path().to_string_lossy(), &dst.join(&name).to_string_lossy())?;
        }
        Ok(())
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        fs::copy(src, dst).map(|_| ()).map_err(|e| format!("{to}: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcards() {
        assert!(wild("*.log", "a.LOG"));
        assert!(wild("node_modules", "node_modules"));
        assert!(wild("a?c", "abc"));
        assert!(!wild("*.log", "a.txt"));
        assert!(wild("*", ""));
    }

    #[test]
    fn natural_order() {
        assert_eq!(natural_cmp("file2", "file10"), Ordering::Less);
        assert_eq!(natural_cmp("B", "a"), Ordering::Greater);
    }

    #[test]
    fn compares_two_trees() {
        let base = std::env::temp_dir().join(format!("diffstar-test-{}", std::process::id()));
        let (l, r) = (base.join("l"), base.join("r"));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(l.join("sub")).unwrap();
        fs::create_dir_all(r.join("sub")).unwrap();
        fs::write(l.join("same.txt"), "x").unwrap();
        fs::write(r.join("same.txt"), "x").unwrap();
        fs::write(l.join("sub/diff.txt"), "a").unwrap();
        fs::write(r.join("sub/diff.txt"), "b").unwrap();
        fs::write(l.join("only-left.txt"), "1").unwrap();
        fs::write(r.join("only-right.txt"), "2").unwrap();
        let res = compare(&l.to_string_lossy(), &r.to_string_lossy(), &DirOpts::default()).unwrap();
        let c = res.root.counts;
        assert_eq!((c.same, c.diff, c.left, c.right), (1, 1, 1, 1));
        assert_eq!(res.root.children[0].name, "sub");
        assert_eq!(res.root.children[0].status, "diff");
        let _ = fs::remove_dir_all(&base);
    }
}
