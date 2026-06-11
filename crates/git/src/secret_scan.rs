//! Detects API-key-shaped tokens and high-entropy strings in arbitrary bytes.
//!
//! This is the pure-function half of the pre-push secret-scan gate. It does
//! not touch git or the filesystem — callers feed it bytes and decide what to
//! do with the findings.

use regex::bytes::{Match, Regex};
use std::sync::OnceLock;

/// One match against the input. Multiple findings may overlap when the same
/// span trips both a regex rule and the entropy detector — callers may
/// dedupe by `byte_offset` if that matters for their UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub kind: FindingKind,
    pub byte_offset: usize,
    pub matched: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FindingKind {
    GithubClassicPat,
    GithubFineGrainedPat,
    GithubOauth,
    OpenAiKey,
    AwsAccessKey,
    SlackToken,
    PrivateKeyBlock,
    JsonApiKeyField,
    HighEntropyString,
}

/// Returns every regex hit and high-entropy run in `input`. Order is
/// regex-rules first (in declaration order), then entropy hits.
pub fn scan(input: &[u8]) -> Vec<Finding> {
    let mut findings: Vec<Finding> = rules()
        .iter()
        .flat_map(|(kind, re)| re.find_iter(input).map(|m| finding(*kind, m)))
        .collect();
    findings.extend(scan_high_entropy_runs(input));
    findings
}

const ENTROPY_THRESHOLD: f64 = 4.5;

fn finding(kind: FindingKind, m: Match<'_>) -> Finding {
    Finding {
        kind,
        byte_offset: m.start(),
        matched: String::from_utf8_lossy(m.as_bytes()).into_owned(),
    }
}

fn scan_high_entropy_runs(input: &[u8]) -> Vec<Finding> {
    static CANDIDATE: OnceLock<Regex> = OnceLock::new();
    let re = CANDIDATE.get_or_init(|| Regex::new(r"[A-Za-z0-9+/=_-]{40,}").unwrap());
    re.find_iter(input)
        .filter(|m| shannon_entropy(m.as_bytes()) > ENTROPY_THRESHOLD)
        .map(|m| finding(FindingKind::HighEntropyString, m))
        .collect()
}

fn shannon_entropy(bytes: &[u8]) -> f64 {
    if bytes.is_empty() {
        return 0.0;
    }
    let mut counts = [0u32; 256];
    for &b in bytes {
        counts[b as usize] += 1;
    }
    let len = bytes.len() as f64;
    counts
        .iter()
        .filter(|&&c| c > 0)
        .map(|&c| {
            let p = c as f64 / len;
            -p * p.log2()
        })
        .sum()
}

fn rules() -> &'static [(FindingKind, Regex)] {
    static RULES: OnceLock<Vec<(FindingKind, Regex)>> = OnceLock::new();
    RULES.get_or_init(|| {
        vec![
            // Order: longer/more-specific prefixes first so they aren't shadowed.
            (
                FindingKind::GithubFineGrainedPat,
                Regex::new(r"github_pat_[A-Za-z0-9_]{82}").unwrap(),
            ),
            (
                FindingKind::GithubClassicPat,
                Regex::new(r"ghp_[A-Za-z0-9]{36}").unwrap(),
            ),
            (
                FindingKind::GithubOauth,
                Regex::new(r"gho_[A-Za-z0-9]{36}").unwrap(),
            ),
            (
                FindingKind::OpenAiKey,
                Regex::new(r"\bsk-[A-Za-z0-9_-]{20,}").unwrap(),
            ),
            (
                FindingKind::AwsAccessKey,
                Regex::new(r"AKIA[A-Z0-9]{16}").unwrap(),
            ),
            (
                FindingKind::SlackToken,
                Regex::new(r"xox[baprs]-[A-Za-z0-9-]{10,}").unwrap(),
            ),
            (
                FindingKind::PrivateKeyBlock,
                Regex::new(r"-----BEGIN [A-Z ]*PRIVATE KEY-----").unwrap(),
            ),
            (
                FindingKind::JsonApiKeyField,
                Regex::new(r#"(?i)"api[_-]?key"\s*:"#).unwrap(),
            ),
        ]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_github_classic_pat() {
        let token = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let input = format!("oh no {token} leaked");

        let findings = scan(input.as_bytes());

        assert_eq!(
            findings,
            vec![Finding {
                kind: FindingKind::GithubClassicPat,
                byte_offset: 6,
                matched: token.to_string(),
            }]
        );
    }

    #[test]
    fn detects_github_fine_grained_pat() {
        // github_pat_ + 22 alphanumeric + _ + 59 alphanumeric/underscore (official format).
        let token = format!("github_pat_{}_{}", "A".repeat(22), "a".repeat(59));
        assert_eq!(token.len(), 93);
        let input = format!("config: {token}");

        let findings = scan(input.as_bytes());

        assert_eq!(
            findings,
            vec![Finding {
                kind: FindingKind::GithubFineGrainedPat,
                byte_offset: 8,
                matched: token,
            }]
        );
    }

    #[test]
    fn detects_github_oauth_token() {
        let token = format!("gho_{}", "Z".repeat(36));
        let input = format!("token={token}");

        let findings = scan(input.as_bytes());

        assert_eq!(
            findings,
            vec![Finding {
                kind: FindingKind::GithubOauth,
                byte_offset: 6,
                matched: token,
            }]
        );
    }

    #[test]
    fn detects_openai_key() {
        let token = format!("sk-proj-{}", "A".repeat(40));
        let input = format!("OPENAI_API_KEY={token}");

        let findings = scan(input.as_bytes());

        assert_eq!(
            findings,
            vec![Finding {
                kind: FindingKind::OpenAiKey,
                byte_offset: 15,
                matched: token,
            }]
        );
    }

    #[test]
    fn ignores_prose_with_embedded_sk_substring() {
        // "ask-something..." must NOT match — sk- isn't at a word boundary.
        let input = "ask-something-long-enough-to-look-like-a-key";
        assert_eq!(scan(input.as_bytes()), vec![]);
    }

    #[test]
    fn detects_aws_access_key() {
        let token = format!("AKIA{}", "0".repeat(16));
        let input = format!("aws_access_key_id={token}");

        let findings = scan(input.as_bytes());

        assert_eq!(
            findings,
            vec![Finding {
                kind: FindingKind::AwsAccessKey,
                byte_offset: 18,
                matched: token,
            }]
        );
    }

    #[test]
    fn detects_slack_bot_token() {
        let token = "xoxb-1234567890-1234567890-AbCdEfGhIjKlMnOpQrStUvWx";
        let input = format!("slack_token={token}");

        let findings = scan(input.as_bytes());

        assert!(
            findings.iter().any(|f| f.kind == FindingKind::SlackToken
                && f.byte_offset == 12
                && f.matched == token),
            "expected SlackToken at offset 12, got {findings:?}",
        );
    }

    #[test]
    fn detects_slack_user_token() {
        let token = "xoxp-987654321-AbCdEfGhIjKlMnOpQr";
        let findings = scan(token.as_bytes());

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].kind, FindingKind::SlackToken);
    }

    #[test]
    fn detects_pem_private_key_block() {
        let input = "config:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBA...\n";

        let findings = scan(input.as_bytes());

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].kind, FindingKind::PrivateKeyBlock);
        assert_eq!(findings[0].matched, "-----BEGIN RSA PRIVATE KEY-----");
    }

    #[test]
    fn detects_pem_private_key_block_unlabeled() {
        // PKCS#8 has no algorithm prefix.
        let input = "-----BEGIN PRIVATE KEY-----";
        let findings = scan(input.as_bytes());
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].kind, FindingKind::PrivateKeyBlock);
    }

    #[test]
    fn detects_json_api_key_field_snake_case() {
        let input = r#"{"api_key": "abcd1234"}"#;
        let findings = scan(input.as_bytes());
        assert!(findings.iter().any(|f| f.kind == FindingKind::JsonApiKeyField));
    }

    #[test]
    fn detects_json_api_key_field_camel_case() {
        let input = r#"{"apiKey":"abcd1234"}"#;
        let findings = scan(input.as_bytes());
        assert!(findings.iter().any(|f| f.kind == FindingKind::JsonApiKeyField));
    }

    #[test]
    fn detects_json_api_key_field_kebab_uppercase() {
        let input = r#"{"API-KEY" : "abcd1234"}"#;
        let findings = scan(input.as_bytes());
        assert!(findings.iter().any(|f| f.kind == FindingKind::JsonApiKeyField));
    }

    #[test]
    fn detects_multiple_distinct_secrets() {
        let ghp = format!("ghp_{}", "a".repeat(36));
        let akia = format!("AKIA{}", "0".repeat(16));
        let input = format!("first {ghp} then {akia} done");

        let findings = scan(input.as_bytes());

        let kinds: std::collections::HashSet<_> = findings.iter().map(|f| f.kind).collect();
        assert!(kinds.contains(&FindingKind::GithubClassicPat));
        assert!(kinds.contains(&FindingKind::AwsAccessKey));
    }

    #[test]
    fn empty_input_yields_no_findings() {
        assert_eq!(scan(b""), vec![]);
    }

    #[test]
    fn plain_prose_yields_no_findings() {
        let input = "This is a markdown file describing how to set up an agent. \
                     It contains no API keys, just instructions like 'run the script' \
                     and references to ghp_ tokens (without an actual token).";
        assert_eq!(scan(input.as_bytes()), vec![]);
    }

    #[test]
    fn detects_high_entropy_base64_run() {
        // 50 distinct base64-alphabet chars — entropy log2(50) ≈ 5.64.
        let token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN";
        let input = format!("password = {token}");

        let findings = scan(input.as_bytes());

        assert!(
            findings
                .iter()
                .any(|f| f.kind == FindingKind::HighEntropyString && f.matched == token),
            "expected HighEntropyString matching {token}, got {findings:?}",
        );
    }

    #[test]
    fn ignores_low_entropy_long_run() {
        // 50 'a's — passes the length gate, but entropy is 0.
        let input = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let findings = scan(input.as_bytes());
        assert!(!findings.iter().any(|f| f.kind == FindingKind::HighEntropyString));
    }
}
