//! Text diff engine.
//!
//! The UI sends both sides as line arrays (already split, no line endings).
//! The result is a list of blocks: `eq` blocks (identical under the chosen
//! ignore options) and `chg` blocks. Inside a change block the lines are
//! aligned (similar lines side by side, the rest padded) and each aligned pair
//! carries an in-line word or character diff.

use serde::{Deserialize, Serialize};
use similar::{capture_diff_slices_deadline, Algorithm, DiffTag};
use std::time::{Duration, Instant};

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct DiffOpts {
    /// "none" | "change" | "all"
    pub ignore_ws: String,
    pub ignore_case: bool,
    /// "patience" | "myers" | "lcs"
    pub algorithm: String,
    /// "word" | "char"
    pub inline: String,
}

impl Default for DiffOpts {
    fn default() -> Self {
        DiffOpts { ignore_ws: "none".into(), ignore_case: false, algorithm: "patience".into(), inline: "word".into() }
    }
}

/// One in-line segment: text and whether it is a change.
pub type Seg = (String, bool);

#[derive(Serialize, Debug, PartialEq)]
pub struct Block {
    /// "eq" | "chg"
    pub kind: &'static str,
    pub l0: usize,
    pub l1: usize,
    pub r0: usize,
    pub r1: usize,
    /// chg only: aligned rows, indices relative to l0 / r0, -1 = no line on that side
    pub rows: Vec<[i64; 2]>,
    /// chg only: per row, the in-line segments of both sides (only for similar pairs)
    pub inline: Vec<Option<(Vec<Seg>, Vec<Seg>)>>,
}

#[derive(Serialize, Debug, Default)]
pub struct Stats {
    /// number of change blocks
    pub changes: usize,
    /// lines only on the left / only on the right / changed pairs
    pub deleted: usize,
    pub added: usize,
    pub modified: usize,
    pub equal: usize,
}

#[derive(Serialize, Debug)]
pub struct DiffResult {
    pub blocks: Vec<Block>,
    pub stats: Stats,
    /// The diff hit its time limit; the result is correct but may not be minimal.
    pub approximate: bool,
}

/// Lines longer than this get no in-line diff (whole-line highlight).
const INLINE_MAX_CHARS: usize = 4000;
/// Change blocks up to this many line pairs get the similarity alignment.
const ALIGN_MAX_PAIRS: usize = 4000;
/// Minimum similarity for two lines to be shown as a "modified" pair.
const PAIR_MIN_RATIO: f64 = 0.4;

fn algorithm(name: &str) -> Algorithm {
    match name {
        "myers" => Algorithm::Myers,
        "lcs" => Algorithm::Lcs,
        _ => Algorithm::Patience,
    }
}

/// Comparison key of a line under the ignore options.
fn line_key(s: &str, o: &DiffOpts) -> String {
    let mut k = match o.ignore_ws.as_str() {
        "all" => s.chars().filter(|c| !c.is_whitespace()).collect(),
        "change" => s.split_whitespace().collect::<Vec<_>>().join(" "),
        _ => s.to_string(),
    };
    if o.ignore_case {
        k = k.to_lowercase();
    }
    k
}

pub fn diff_lines(left: &[String], right: &[String], o: &DiffOpts) -> DiffResult {
    let lk: Vec<String> = left.iter().map(|s| line_key(s, o)).collect();
    let rk: Vec<String> = right.iter().map(|s| line_key(s, o)).collect();
    let started = Instant::now();
    let deadline = started + Duration::from_secs(8);
    let ops = capture_diff_slices_deadline(algorithm(&o.algorithm), &lk, &rk, Some(deadline));
    let approximate = Instant::now() >= deadline;

    // merge consecutive non-equal ops into one change block
    let mut blocks: Vec<Block> = Vec::new();
    for op in &ops {
        let (tag, lr, rr) = op.as_tag_tuple();
        if lr.is_empty() && rr.is_empty() {
            continue;
        }
        let kind = if tag == DiffTag::Equal { "eq" } else { "chg" };
        if let Some(last) = blocks.last_mut() {
            if last.kind == kind && last.l1 == lr.start && last.r1 == rr.start {
                last.l1 = lr.end;
                last.r1 = rr.end;
                continue;
            }
        }
        blocks.push(Block { kind, l0: lr.start, l1: lr.end, r0: rr.start, r1: rr.end, rows: vec![], inline: vec![] });
    }

    let mut stats = Stats::default();
    for b in blocks.iter_mut() {
        if b.kind == "eq" {
            stats.equal += b.l1 - b.l0;
            continue;
        }
        stats.changes += 1;
        let ls = &left[b.l0..b.l1];
        let rs = &right[b.r0..b.r1];
        let rows = align(ls, rs, o);
        for (li, ri) in &rows {
            match (li, ri) {
                (Some(_), Some(_)) => stats.modified += 1,
                (Some(_), None) => stats.deleted += 1,
                (None, Some(_)) => stats.added += 1,
                _ => {}
            }
        }
        b.inline = rows
            .iter()
            .map(|(li, ri)| match (li, ri) {
                (Some(a), Some(c)) => inline_diff(&ls[*a], &rs[*c], o),
                _ => None,
            })
            .collect();
        b.rows = rows
            .into_iter()
            .map(|(a, c)| [a.map(|x| x as i64).unwrap_or(-1), c.map(|x| x as i64).unwrap_or(-1)])
            .collect();
    }
    DiffResult { blocks, stats, approximate }
}

// ───────────────────────── tokens & similarity ─────────────────────────

#[derive(PartialEq, Eq, Clone, Copy)]
enum Class {
    Word,
    Space,
    Other,
}

fn class(c: char) -> Class {
    if c.is_alphanumeric() || c == '_' {
        Class::Word
    } else if c.is_whitespace() {
        Class::Space
    } else {
        Class::Other
    }
}

/// Words, whitespace runs and single punctuation characters (char mode: every char).
fn tokens<'a>(s: &'a str, chars: bool) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut prev: Option<Class> = None;
    for (i, c) in s.char_indices() {
        let cl = class(c);
        let split = chars || match prev {
            None => false,
            Some(p) => p != cl || cl == Class::Other,
        };
        if split && i > start {
            out.push(&s[start..i]);
            start = i;
        }
        prev = Some(cl);
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

fn token_key(t: &str, o: &DiffOpts) -> String {
    if o.ignore_ws != "none" && t.chars().all(char::is_whitespace) {
        return " ".into();
    }
    if o.ignore_case { t.to_lowercase() } else { t.to_string() }
}

/// Share of the characters (0..1) that are unchanged between two lines.
fn similarity(a: &str, b: &str, o: &DiffOpts) -> f64 {
    if a.len() + b.len() > INLINE_MAX_CHARS * 2 {
        return if line_key(a, o) == line_key(b, o) { 1.0 } else { 0.0 };
    }
    let ta: Vec<String> = tokens(a, false).iter().map(|t| token_key(t, o)).collect();
    let tb: Vec<String> = tokens(b, false).iter().map(|t| token_key(t, o)).collect();
    let total: usize = ta.iter().map(|t| t.len()).sum::<usize>() + tb.iter().map(|t| t.len()).sum::<usize>();
    if total == 0 {
        return 1.0;
    }
    let ops = capture_diff_slices_deadline(Algorithm::Myers, &ta, &tb, Some(Instant::now() + Duration::from_millis(50)));
    let same: usize = ops
        .iter()
        .filter(|op| op.tag() == DiffTag::Equal)
        .map(|op| op.old_range().map(|i| ta[i].len()).sum::<usize>())
        .sum();
    (2 * same) as f64 / total as f64
}

/// Aligns the lines of a change block: similar lines on the same row.
fn align(ls: &[String], rs: &[String], o: &DiffOpts) -> Vec<(Option<usize>, Option<usize>)> {
    let (n, m) = (ls.len(), rs.len());
    let mut matches: Vec<(usize, usize)> = Vec::new();
    if n > 0 && m > 0 && n * m <= ALIGN_MAX_PAIRS {
        // order-preserving maximum-similarity matching (DP)
        let mut sim = vec![0f64; n * m];
        for i in 0..n {
            for j in 0..m {
                let s = similarity(&ls[i], &rs[j], o);
                sim[i * m + j] = if s >= PAIR_MIN_RATIO { s } else { -1.0 };
            }
        }
        let w = m + 1;
        let mut dp = vec![0f64; (n + 1) * w];
        for i in 1..=n {
            for j in 1..=m {
                let mut best = dp[(i - 1) * w + j].max(dp[i * w + j - 1]);
                let s = sim[(i - 1) * m + j - 1];
                if s >= 0.0 {
                    best = best.max(dp[(i - 1) * w + j - 1] + s);
                }
                dp[i * w + j] = best;
            }
        }
        let (mut i, mut j) = (n, m);
        while i > 0 && j > 0 {
            let s = sim[(i - 1) * m + j - 1];
            if s >= 0.0 && (dp[i * w + j] - (dp[(i - 1) * w + j - 1] + s)).abs() < 1e-9 {
                matches.push((i - 1, j - 1));
                i -= 1;
                j -= 1;
            } else if (dp[i * w + j] - dp[(i - 1) * w + j]).abs() < 1e-9 {
                i -= 1;
            } else {
                j -= 1;
            }
        }
        matches.reverse();
    } else {
        for k in 0..n.min(m) {
            matches.push((k, k));
        }
    }
    // between the matched pairs, the leftover lines share rows positionally
    let mut rows = Vec::new();
    let (mut li, mut ri) = (0, 0);
    let push_gap = |rows: &mut Vec<(Option<usize>, Option<usize>)>, l_end: usize, r_end: usize, li: &mut usize, ri: &mut usize| {
        while *li < l_end || *ri < r_end {
            let a = if *li < l_end { let v = Some(*li); *li += 1; v } else { None };
            let b = if *ri < r_end { let v = Some(*ri); *ri += 1; v } else { None };
            rows.push((a, b));
        }
    };
    for (a, b) in matches {
        push_gap(&mut rows, a, b, &mut li, &mut ri);
        rows.push((Some(a), Some(b)));
        li = a + 1;
        ri = b + 1;
    }
    push_gap(&mut rows, n, m, &mut li, &mut ri);
    rows
}

/// In-line diff of two similar lines; None when they are too different to
/// highlight word by word (the whole line is marked instead).
fn inline_diff(a: &str, b: &str, o: &DiffOpts) -> Option<(Vec<Seg>, Vec<Seg>)> {
    if a.len() > INLINE_MAX_CHARS || b.len() > INLINE_MAX_CHARS {
        return None;
    }
    let chars = o.inline == "char";
    let ta = tokens(a, chars);
    let tb = tokens(b, chars);
    let ka: Vec<String> = ta.iter().map(|t| token_key(t, o)).collect();
    let kb: Vec<String> = tb.iter().map(|t| token_key(t, o)).collect();
    let ops = capture_diff_slices_deadline(Algorithm::Myers, &ka, &kb, Some(Instant::now() + Duration::from_millis(100)));
    let mut ma = vec![true; ta.len()];
    let mut mb = vec![true; tb.len()];
    let mut same = 0usize;
    for op in &ops {
        if op.tag() == DiffTag::Equal {
            for i in op.old_range() {
                ma[i] = false;
                same += ta[i].len();
            }
            for j in op.new_range() {
                mb[j] = false;
            }
        }
    }
    let total = a.len().max(b.len()).max(1);
    if (same as f64) / (total as f64) < 0.3 {
        return None;
    }
    let ignore_ws = o.ignore_ws != "none";
    let segs = |toks: &[&str], marks: &[bool]| -> Vec<Seg> {
        let mut out: Vec<Seg> = Vec::new();
        for (t, &m) in toks.iter().zip(marks) {
            let m = m && !(ignore_ws && t.chars().all(char::is_whitespace));
            match out.last_mut() {
                Some(last) if last.1 == m => last.0.push_str(t),
                _ => out.push((t.to_string(), m)),
            }
        }
        out
    };
    Some((segs(&ta, &ma), segs(&tb, &mb)))
}

// ───────────────────────── unified patch ─────────────────────────

/// Unified diff text (for the AI, "Copy as patch" and the .patch export).
pub fn unified(left: &[String], right: &[String], left_name: &str, right_name: &str, context: usize) -> String {
    let mut a = left.join("\n");
    let mut b = right.join("\n");
    if !a.is_empty() {
        a.push('\n');
    }
    if !b.is_empty() {
        b.push('\n');
    }
    let d = similar::TextDiff::configure()
        .algorithm(Algorithm::Patience)
        .timeout(Duration::from_secs(8))
        .diff_lines(&a, &b);
    d.unified_diff().context_radius(context).header(left_name, right_name).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn identical_is_one_eq_block() {
        let a = v(&["a", "b", "c"]);
        let r = diff_lines(&a, &a, &DiffOpts::default());
        assert_eq!(r.blocks.len(), 1);
        assert_eq!(r.blocks[0].kind, "eq");
        assert_eq!(r.stats.changes, 0);
    }

    #[test]
    fn replace_is_aligned_and_highlighted() {
        let a = v(&["one", "let x = 1;", "three"]);
        let b = v(&["one", "let x = 2;", "three"]);
        let r = diff_lines(&a, &b, &DiffOpts::default());
        assert_eq!(r.blocks.len(), 3);
        let c = &r.blocks[1];
        assert_eq!(c.kind, "chg");
        assert_eq!(c.rows, vec![[0, 0]]);
        let (l, rr) = c.inline[0].clone().unwrap();
        assert!(l.contains(&("1".to_string(), true)));
        assert!(rr.contains(&("2".to_string(), true)));
        assert_eq!(r.stats.modified, 1);
    }

    #[test]
    fn alignment_pairs_similar_lines() {
        let a = v(&["fn alpha() {}", "fn beta() {}"]);
        let b = v(&["// new comment", "fn alpha() { 1 }", "fn beta() { 2 }"]);
        let r = diff_lines(&a, &b, &DiffOpts::default());
        let c = r.blocks.iter().find(|b| b.kind == "chg").unwrap();
        assert!(c.rows.contains(&[0, 1]));
        assert!(c.rows.contains(&[1, 2]));
    }

    #[test]
    fn ignore_whitespace_and_case() {
        let a = v(&["Hello   World", "x"]);
        let b = v(&["hello world", "x"]);
        let mut o = DiffOpts::default();
        assert_eq!(diff_lines(&a, &b, &o).stats.changes, 1);
        o.ignore_ws = "change".into();
        o.ignore_case = true;
        assert_eq!(diff_lines(&a, &b, &o).stats.changes, 0);
    }

    #[test]
    fn pure_insert_and_delete() {
        let a = v(&["a", "b"]);
        let b = v(&["a", "x", "b", "c"]);
        let r = diff_lines(&a, &b, &DiffOpts::default());
        assert_eq!(r.stats.added, 2);
        assert_eq!(r.stats.deleted, 0);
        let r = diff_lines(&b, &a, &DiffOpts::default());
        assert_eq!(r.stats.deleted, 2);
    }

    #[test]
    fn tokens_split_words_and_punctuation() {
        assert_eq!(tokens("a.b  cd", false), vec!["a", ".", "b", "  ", "cd"]);
        assert_eq!(tokens("ab", true), vec!["a", "b"]);
    }

    #[test]
    fn unified_has_headers() {
        let p = unified(&v(&["a"]), &v(&["b"]), "L", "R", 3);
        assert!(p.contains("--- L"));
        assert!(p.contains("+++ R"));
        assert!(p.contains("-a"));
        assert!(p.contains("+b"));
    }
}
