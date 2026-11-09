//! Reading and writing compared files: encoding and line-ending detection,
//! binary detection, raw bytes for the hex / image views.

use crate::settings::tr;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// Text files above this size are not loaded as text.
pub const MAX_TEXT_BYTES: u64 = 96 * 1024 * 1024;

#[derive(Serialize, Debug, Default)]
pub struct FileStat {
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
    /// seconds since the epoch (fractional)
    pub mtime: f64,
}

pub fn stat(path: &str) -> FileStat {
    match fs::metadata(path) {
        Ok(m) => FileStat { exists: true, is_dir: m.is_dir(), size: m.len(), mtime: mtime_of(&m) },
        Err(_) => FileStat::default(),
    }
}

pub fn mtime_of(m: &fs::Metadata) -> f64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

#[derive(Serialize, Debug, Default)]
pub struct Loaded {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime: f64,
    /// "text" | "binary"
    pub kind: String,
    /// "utf-8" | "utf-16le" | "utf-16be" | an encoding_rs label (windows-1250…)
    pub encoding: String,
    pub bom: bool,
    /// "LF" | "CRLF" | "CR" | "mixed" | "none"
    pub eol: String,
    /// line ending used when saving (the most common one; LF when there is none)
    pub eol_save: String,
    pub final_newline: bool,
    pub lines: Vec<String>,
    /// Text was not valid in the detected encoding (replacement characters).
    pub lossy: bool,
}

fn name_of(path: &str) -> String {
    Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

/// Decodes the bytes to text; None = binary.
fn decode(bytes: &[u8], fallback: &str) -> Option<(String, String, bool, bool)> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (t, bad) = encoding_rs::UTF_8.decode_without_bom_handling(&bytes[3..]);
        return Some((t.into_owned(), "utf-8".into(), true, bad));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (t, bad) = encoding_rs::UTF_16LE.decode_without_bom_handling(&bytes[2..]);
        return Some((t.into_owned(), "utf-16le".into(), true, bad));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (t, bad) = encoding_rs::UTF_16BE.decode_without_bom_handling(&bytes[2..]);
        return Some((t.into_owned(), "utf-16be".into(), true, bad));
    }
    // NUL bytes: binary (UTF-16 without BOM is rare enough to accept this)
    let probe = &bytes[..bytes.len().min(64 * 1024)];
    if probe.contains(&0) {
        return None;
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return Some((s.to_string(), "utf-8".into(), false, false));
    }
    // many control characters besides tab / CR / LF / FF / ESC: binary
    let ctrl = probe.iter().filter(|&&b| b < 0x20 && !matches!(b, 9 | 10 | 12 | 13 | 27)).count();
    if ctrl * 20 > probe.len().max(1) {
        return None;
    }
    let enc = encoding_rs::Encoding::for_label(fallback.as_bytes()).unwrap_or(encoding_rs::WINDOWS_1252);
    let (t, bad) = enc.decode_without_bom_handling(bytes);
    Some((t.into_owned(), enc.name().to_lowercase(), false, bad))
}

/// Decodes with the encoding the user picked ("Reload as…"); a matching BOM is dropped.
fn decode_as(bytes: &[u8], label: &str) -> (String, String, bool, bool) {
    let l = label.to_lowercase();
    let (enc, bom_len) = match l.as_str() {
        "utf-16le" => (encoding_rs::UTF_16LE, if bytes.starts_with(&[0xFF, 0xFE]) { 2 } else { 0 }),
        "utf-16be" => (encoding_rs::UTF_16BE, if bytes.starts_with(&[0xFE, 0xFF]) { 2 } else { 0 }),
        "utf-8" => (encoding_rs::UTF_8, if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { 3 } else { 0 }),
        other => (encoding_rs::Encoding::for_label(other.as_bytes()).unwrap_or(encoding_rs::WINDOWS_1252), 0),
    };
    let (t, bad) = enc.decode_without_bom_handling(&bytes[bom_len..]);
    let name = if l.starts_with("utf-") { l } else { enc.name().to_lowercase() };
    (t.into_owned(), name, bom_len > 0, bad)
}

/// Splits into lines (LF, CRLF and lone CR all end a line) and reports the endings.
fn split_lines(text: &str) -> (Vec<String>, String, String, bool) {
    let (mut crlf, mut lf, mut cr) = (0usize, 0usize, 0usize);
    let mut lines = Vec::new();
    let mut cur = String::new();
    let mut it = text.chars().peekable();
    let mut ended_with_eol = false;
    while let Some(c) = it.next() {
        match c {
            '\r' => {
                if it.peek() == Some(&'\n') {
                    it.next();
                    crlf += 1;
                } else {
                    cr += 1;
                }
                lines.push(std::mem::take(&mut cur));
                ended_with_eol = true;
            }
            '\n' => {
                lf += 1;
                lines.push(std::mem::take(&mut cur));
                ended_with_eol = true;
            }
            _ => {
                cur.push(c);
                ended_with_eol = false;
            }
        }
    }
    if !cur.is_empty() || (!ended_with_eol && !lines.is_empty()) {
        lines.push(cur);
    }
    let kinds = [(crlf, "CRLF"), (lf, "LF"), (cr, "CR")];
    let used = kinds.iter().filter(|k| k.0 > 0).count();
    let top = kinds.iter().max_by_key(|k| k.0).map(|k| k.1).unwrap_or("LF");
    let eol = match used {
        0 => "none",
        1 => top,
        _ => "mixed",
    };
    let save = if used == 0 { default_eol() } else { top };
    (lines, eol.to_string(), save.to_string(), ended_with_eol)
}

fn default_eol() -> &'static str {
    if cfg!(windows) { "CRLF" } else { "LF" }
}

pub fn load(path: &str, fallback: &str, force: Option<&str>) -> Result<Loaded, String> {
    let meta = fs::metadata(path).map_err(|e| format!("{}: {e}", path))?;
    if meta.is_dir() {
        return Err(tr(&format!("Ez egy mappa, nem fájl: {path}"), &format!("This is a folder, not a file: {path}")));
    }
    let mut out = Loaded {
        path: path.to_string(),
        name: name_of(path),
        size: meta.len(),
        mtime: mtime_of(&meta),
        kind: "binary".into(),
        eol: "none".into(),
        eol_save: default_eol().into(),
        ..Default::default()
    };
    if meta.len() > MAX_TEXT_BYTES {
        return Ok(out);
    }
    let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path))?;
    let decoded = match force.filter(|f| !f.is_empty()) {
        Some(f) => Some(decode_as(&bytes, f)),
        None => decode(&bytes, fallback),
    };
    if let Some((text, enc, bom, lossy)) = decoded {
        let (lines, eol, eol_save, final_nl) = split_lines(&text);
        out.kind = "text".into();
        out.encoding = enc;
        out.bom = bom;
        out.lossy = lossy;
        out.eol = eol;
        out.eol_save = eol_save;
        out.final_newline = final_nl;
        out.lines = lines;
    }
    Ok(out)
}

#[derive(Deserialize, Debug)]
pub struct SaveReq {
    pub path: String,
    pub lines: Vec<String>,
    pub final_newline: bool,
    pub encoding: String,
    pub bom: bool,
    /// "LF" | "CRLF" | "CR"
    pub eol: String,
}

pub fn encode(req: &SaveReq) -> Result<Vec<u8>, String> {
    let nl = match req.eol.as_str() {
        "CRLF" => "\r\n",
        "CR" => "\r",
        _ => "\n",
    };
    let mut text = req.lines.join(nl);
    if req.final_newline && !req.lines.is_empty() {
        text.push_str(nl);
    }
    let enc = req.encoding.to_lowercase();
    let mut out = Vec::with_capacity(text.len() + 4);
    match enc.as_str() {
        "utf-8" | "" => {
            if req.bom {
                out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            out.extend_from_slice(text.as_bytes());
        }
        "utf-16le" => {
            out.extend_from_slice(&[0xFF, 0xFE]);
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
        }
        "utf-16be" => {
            out.extend_from_slice(&[0xFE, 0xFF]);
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_be_bytes());
            }
        }
        label => {
            let e = encoding_rs::Encoding::for_label(label.as_bytes())
                .ok_or_else(|| tr(&format!("Ismeretlen kódolás: {label}"), &format!("Unknown encoding: {label}")))?;
            let (bytes, _, bad) = e.encode(&text);
            if bad {
                return Err(tr(
                    &format!("A szöveg olyan karaktert tartalmaz, ami {label} kódolásban nem írható le. Mentsd UTF-8 kódolással."),
                    &format!("The text contains characters that {label} cannot store. Save it as UTF-8."),
                ));
            }
            out.extend_from_slice(&bytes);
        }
    }
    Ok(out)
}

/// Writes through a temporary file next to the target, then renames it over.
pub fn save(req: &SaveReq) -> Result<FileStat, String> {
    let bytes = encode(req)?;
    let target = Path::new(&req.path);
    if let Some(dir) = target.parent().filter(|d| !d.as_os_str().is_empty()) {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = target.with_file_name(format!(".{}.diffstar-tmp", name_of(&req.path)));
    fs::write(&tmp, &bytes).map_err(|e| format!("{}: {e}", req.path))?;
    // keep the original permissions (Unix executable bit…)
    if let Ok(m) = fs::metadata(target) {
        let _ = fs::set_permissions(&tmp, m.permissions());
    }
    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        // rename can fail across odd file systems: plain write as a fallback
        fs::write(target, &bytes).map_err(|e2| format!("{}: {e} / {e2}", req.path))?;
    }
    Ok(stat(&req.path))
}

/// First `max` bytes of a file.
pub fn read_head(path: &str, max: u64) -> Result<(Vec<u8>, u64), String> {
    let f = fs::File::open(path).map_err(|e| format!("{}: {e}", path))?;
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut buf = Vec::with_capacity(size.min(max) as usize);
    f.take(max).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok((buf, size))
}

#[derive(Serialize, Debug, Default)]
pub struct BinSummary {
    pub left_size: u64,
    pub right_size: u64,
    pub identical: bool,
    /// bytes that differ at the same offset (within the common length)
    pub diff_bytes: u64,
    /// offset of the first difference (-1 = none in the common part)
    pub first_diff: i64,
}

/// Compares two files byte by byte, streaming.
pub fn binary_summary(a: &str, b: &str) -> Result<BinSummary, String> {
    let mut fa = fs::File::open(a).map_err(|e| format!("{a}: {e}"))?;
    let mut fb = fs::File::open(b).map_err(|e| format!("{b}: {e}"))?;
    let mut s = BinSummary {
        left_size: fa.metadata().map(|m| m.len()).unwrap_or(0),
        right_size: fb.metadata().map(|m| m.len()).unwrap_or(0),
        first_diff: -1,
        ..Default::default()
    };
    let mut ba = vec![0u8; 256 * 1024];
    let mut bb = vec![0u8; 256 * 1024];
    let mut off = 0u64;
    loop {
        let na = read_full(&mut fa, &mut ba)?;
        let nb = read_full(&mut fb, &mut bb)?;
        let n = na.min(nb);
        for i in 0..n {
            if ba[i] != bb[i] {
                s.diff_bytes += 1;
                if s.first_diff < 0 {
                    s.first_diff = (off + i as u64) as i64;
                }
            }
        }
        off += n as u64;
        if na < ba.len() || nb < bb.len() {
            break;
        }
    }
    s.identical = s.diff_bytes == 0 && s.left_size == s.right_size;
    if s.first_diff < 0 && s.left_size != s.right_size {
        s.first_diff = s.left_size.min(s.right_size) as i64;
    }
    Ok(s)
}

pub fn read_full(f: &mut fs::File, buf: &mut [u8]) -> Result<usize, String> {
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_endings() {
        let (l, eol, save, fin) = split_lines("a\r\nb\r\n");
        assert_eq!(l, vec!["a", "b"]);
        assert_eq!((eol.as_str(), save.as_str(), fin), ("CRLF", "CRLF", true));
        let (l, eol, _, fin) = split_lines("a\nb");
        assert_eq!(l, vec!["a", "b"]);
        assert_eq!((eol.as_str(), fin), ("LF", false));
        let (l, eol, _, _) = split_lines("a\nb\r\nc\n");
        assert_eq!(l, vec!["a", "b", "c"]);
        assert_eq!(eol, "mixed");
        let (l, eol, _, _) = split_lines("");
        assert!(l.is_empty());
        assert_eq!(eol, "none");
        let (l, _, _, fin) = split_lines("\n");
        assert_eq!(l, vec![""]);
        assert!(fin);
    }

    #[test]
    fn decoding() {
        assert!(decode(b"a\0b", "windows-1250").is_none());
        let (t, enc, bom, _) = decode(&[0xEF, 0xBB, 0xBF, b'h', b'i'], "windows-1250").unwrap();
        assert_eq!((t.as_str(), enc.as_str(), bom), ("hi", "utf-8", true));
        // "ő" in windows-1250 is 0xF5
        let (t, enc, _, _) = decode(&[b'x', 0xF5], "windows-1250").unwrap();
        assert_eq!(t, "xő");
        assert_eq!(enc, "windows-1250");
        let (t, enc, _, _) = decode(&[0xFF, 0xFE, b'a', 0, b'b', 0], "x").unwrap();
        assert_eq!((t.as_str(), enc.as_str()), ("ab", "utf-16le"));
    }

    #[test]
    fn encode_roundtrip() {
        let req = SaveReq {
            path: String::new(),
            lines: vec!["árvíztűrő".into(), "x".into()],
            final_newline: true,
            encoding: "windows-1250".into(),
            bom: false,
            eol: "CRLF".into(),
        };
        let bytes = encode(&req).unwrap();
        let (t, _, _, _) = decode(&bytes, "windows-1250").unwrap();
        assert_eq!(t, "árvíztűrő\r\nx\r\n");
        let req = SaveReq { encoding: "windows-1250".into(), lines: vec!["漢".into()], ..req };
        assert!(encode(&req).is_err());
    }
}
