//! Path/line enrichment over [`crate::secret_scan::scan`].

use crate::secret_scan::{scan, Finding};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileFinding {
    pub path: PathBuf,
    pub line: u32,
    pub finding: Finding,
}

/// Scan a file's bytes and dedupe findings whose `byte_offset` collides
/// (regex hit + entropy hit on the same span). `scan()` emits regex hits
/// before entropy hits, so first-occurrence-wins keeps the named rule
/// and drops the redundant `HighEntropyString` shadow.
pub fn scan_file(path: &Path, bytes: &[u8]) -> Vec<FileFinding> {
    let mut seen: HashSet<usize> = HashSet::new();
    scan(bytes)
        .into_iter()
        .filter(|finding| seen.insert(finding.byte_offset))
        .map(|finding| FileFinding {
            path: path.to_path_buf(),
            line: line_at(bytes, finding.byte_offset),
            finding,
        })
        .collect()
}

fn line_at(bytes: &[u8], byte_offset: usize) -> u32 {
    1 + bytes[..byte_offset].iter().filter(|&&b| b == b'\n').count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret_scan::FindingKind;

    #[test]
    fn empty_file_yields_empty_vec() {
        assert_eq!(scan_file(Path::new("a.md"), b""), vec![]);
    }

    #[test]
    fn binary_input_no_newlines_stays_line_one() {
        let token = format!("ghp_{}", "a".repeat(36));
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE, 0x00, 0x80, 0xC0, 0xC1];
        bytes.extend_from_slice(token.as_bytes());
        bytes.extend_from_slice(&[0xFF, 0xFE, 0x00, 0x80]);

        let findings = scan_file(Path::new("blob.bin"), &bytes);

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].line, 1);
        assert_eq!(findings[0].finding.kind, FindingKind::GithubClassicPat);
    }

    #[test]
    fn each_finding_keeps_its_own_line() {
        let ghp = format!("ghp_{}", "a".repeat(36));
        let akia = format!("AKIA{}", "0".repeat(16));
        let bytes = format!("intro\n{ghp}\nbetween\nmore\n{akia}\n");
        // ghp is on line 2, akia is on line 5.

        let findings = scan_file(Path::new("a.md"), bytes.as_bytes());

        let mut by_kind: std::collections::HashMap<FindingKind, u32> =
            findings.iter().map(|f| (f.finding.kind, f.line)).collect();
        assert_eq!(by_kind.remove(&FindingKind::GithubClassicPat), Some(2));
        assert_eq!(by_kind.remove(&FindingKind::AwsAccessKey), Some(5));
    }

    #[test]
    fn computes_line_three() {
        let token = format!("ghp_{}", "a".repeat(36));
        let bytes = format!("first line\nsecond line\n{token}\n");

        let findings = scan_file(Path::new("a.md"), bytes.as_bytes());

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].line, 3);
    }

    #[test]
    fn tracer_returns_path_and_line_one() {
        let token = format!("ghp_{}", "a".repeat(36));
        let path = PathBuf::from("a.md");

        let findings = scan_file(&path, token.as_bytes());

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].path, path);
        assert_eq!(findings[0].line, 1);
        assert_eq!(findings[0].finding.kind, FindingKind::GithubClassicPat);
    }

    #[test]
    fn dedups_overlapping_regex_and_entropy_at_same_offset() {
        // A realistic-shape PAT trips both the GithubClassicPat regex
        // (`ghp_[A-Za-z0-9]{36}`) and the high-entropy detector
        // (`[A-Za-z0-9+/=_-]{40,}` with entropy > 4.5) at byte_offset 0.
        // scan_file should keep only the named regex hit.
        let token = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
        assert_eq!(token.len(), 40);

        // Pre-condition: raw scan emits both findings.
        let raw = crate::secret_scan::scan(token.as_bytes());
        assert!(raw.iter().any(|f| f.kind == FindingKind::GithubClassicPat));
        assert!(raw.iter().any(|f| f.kind == FindingKind::HighEntropyString));

        let findings = scan_file(Path::new("a.md"), token.as_bytes());
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].finding.kind, FindingKind::GithubClassicPat);
    }
}
