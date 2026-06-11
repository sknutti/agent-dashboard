use serde::de::DeserializeOwned;

use crate::Error;

const FENCE: &[u8] = b"---";

/// A markdown primitive: YAML frontmatter (between `---` fences) followed by body.
///
/// Stores the original frontmatter bytes verbatim so that body-only edits
/// (the dominant prose-editing case) round-trip byte-exact. Frontmatter
/// reads parse the bytes via `serde_yaml_ng` on demand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MdPrimitive {
    frontmatter_bytes: Vec<u8>,
    body_bytes: Vec<u8>,
}

impl MdPrimitive {
    /// Parse a frontmatter+body markdown file.
    ///
    /// Accepts:
    /// ```text
    /// ---\n
    /// <yaml>\n
    /// ---\n
    /// <body bytes...>
    /// ```
    pub fn parse(bytes: &[u8]) -> Result<Self, Error> {
        let after_open = strip_open_fence(bytes)
            .ok_or(Error::MdFrontmatter("missing opening `---` fence"))?;
        let (frontmatter, body) = split_close_fence(after_open)
            .ok_or(Error::MdFrontmatter("missing closing `---` fence"))?;
        Ok(Self {
            frontmatter_bytes: frontmatter.to_vec(),
            body_bytes: body.to_vec(),
        })
    }

    pub fn frontmatter_bytes(&self) -> &[u8] {
        &self.frontmatter_bytes
    }

    pub fn body(&self) -> &[u8] {
        &self.body_bytes
    }

    /// Parse the frontmatter into a typed value (read-only).
    pub fn parse_frontmatter<T: DeserializeOwned>(&self) -> Result<T, Error> {
        let s = std::str::from_utf8(&self.frontmatter_bytes)?;
        Ok(serde_yaml_ng::from_str(s)?)
    }

    /// Body-only edit fast path: replace body, preserve frontmatter byte-exact.
    pub fn with_body(mut self, new_body: Vec<u8>) -> Self {
        self.body_bytes = new_body;
        self
    }

    /// Reconstruct the file bytes: `---\n{fm}---\n{body}`.
    ///
    /// If neither frontmatter nor body has been edited since `parse`, the
    /// output equals the original input byte-for-byte.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out =
            Vec::with_capacity(8 + self.frontmatter_bytes.len() + self.body_bytes.len());
        out.extend_from_slice(b"---\n");
        out.extend_from_slice(&self.frontmatter_bytes);
        out.extend_from_slice(b"---\n");
        out.extend_from_slice(&self.body_bytes);
        out
    }
}

/// Strip the opening fence `---` followed by `\n`. Returns the bytes after
/// the fence, or `None` if the file doesn't start with `---\n`.
fn strip_open_fence(bytes: &[u8]) -> Option<&[u8]> {
    let after_dashes = bytes.strip_prefix(FENCE)?;
    // Allow `---\n` or `---` followed only by whitespace+newline on the same line.
    if let Some(rest) = after_dashes.strip_prefix(b"\n") {
        return Some(rest);
    }
    None
}

/// Find the closing fence: a line consisting solely of `---`. Returns
/// `(frontmatter_bytes_inclusive_of_trailing_newline, body_bytes)`.
///
/// The frontmatter bytes always end with `\n` so that `to_bytes` reconstructs
/// `---\n{fm}---\n{body}` correctly.
fn split_close_fence(after_open: &[u8]) -> Option<(&[u8], &[u8])> {
    // Empty frontmatter: closing fence is the very first line of the remainder.
    if let Some(body) = after_open.strip_prefix(b"---\n") {
        return Some((b"", body));
    }
    if after_open == b"---" {
        return Some((b"", b""));
    }
    let needle = b"\n---\n";
    if let Some(idx) = find_subslice(after_open, needle) {
        // frontmatter = after_open[..idx + 1] (include the `\n` before `---`)
        // body        = after_open[idx + needle.len()..]
        let fm = &after_open[..idx + 1];
        let body = &after_open[idx + needle.len()..];
        return Some((fm, body));
    }
    // Allow EOF-terminated closing fence (no trailing newline after `---`).
    let needle_eof = b"\n---";
    if after_open.ends_with(needle_eof) {
        let idx = after_open.len() - needle_eof.len();
        let fm = &after_open[..idx + 1];
        let body = &after_open[after_open.len()..];
        return Some((fm, body));
    }
    None
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[test]
    fn parses_simple_file() {
        let src = b"---\nname: diagnose\n---\nbody text\n";
        let md = MdPrimitive::parse(src).expect("parse ok");
        assert_eq!(md.frontmatter_bytes(), b"name: diagnose\n");
        assert_eq!(md.body(), b"body text\n");
    }

    #[test]
    fn round_trip_byte_exact() {
        let src = b"---\nname: diagnose\ndescription: hello\n---\nThis is the body.\n";
        let md = MdPrimitive::parse(src).expect("parse ok");
        assert_eq!(md.to_bytes(), src.as_slice());
    }

    #[test]
    fn body_only_edit_preserves_frontmatter_bytes() {
        let src = b"---\n# yaml comment preserved\nname: diagnose\n---\nold body\n";
        let md = MdPrimitive::parse(src).expect("parse ok");
        let edited = md.with_body(b"new body content\n".to_vec());
        let out = edited.to_bytes();
        assert_eq!(
            out,
            b"---\n# yaml comment preserved\nname: diagnose\n---\nnew body content\n"
                .as_slice()
        );
    }

    #[test]
    fn preserves_weird_yaml_quoting_and_blank_lines() {
        let src = b"---\nsingle: 'foo'\ndouble: \"bar\"\n\nlist:\n  - one\n  - two\n---\nbody\n";
        let md = MdPrimitive::parse(src).expect("parse ok");
        assert_eq!(md.to_bytes(), src.as_slice());
    }

    #[test]
    fn typed_frontmatter_read() {
        #[derive(Debug, Deserialize, PartialEq)]
        struct Meta {
            name: String,
            description: Option<String>,
        }
        let src = b"---\nname: diagnose\ndescription: a thing\n---\nbody\n";
        let md = MdPrimitive::parse(src).expect("parse ok");
        let meta: Meta = md.parse_frontmatter().expect("typed parse ok");
        assert_eq!(
            meta,
            Meta {
                name: "diagnose".into(),
                description: Some("a thing".into()),
            }
        );
    }

    #[test]
    fn empty_body_ok() {
        let src = b"---\nname: diagnose\n---\n";
        let md = MdPrimitive::parse(src).expect("parse ok");
        assert_eq!(md.body(), b"");
        assert_eq!(md.to_bytes(), src.as_slice());
    }

    #[test]
    fn body_without_trailing_newline() {
        let src = b"---\nname: diagnose\n---\nfinal line";
        let md = MdPrimitive::parse(src).expect("parse ok");
        assert_eq!(md.body(), b"final line");
        assert_eq!(md.to_bytes(), src.as_slice());
    }

    #[test]
    fn rejects_no_opening_fence() {
        let src = b"name: diagnose\n---\nbody\n";
        MdPrimitive::parse(src).expect_err("no opening fence");
    }

    #[test]
    fn rejects_unclosed_frontmatter() {
        let src = b"---\nname: diagnose\nbody with no closing fence\n";
        MdPrimitive::parse(src).expect_err("missing closing fence");
    }

    #[test]
    fn rejects_empty_file() {
        MdPrimitive::parse(b"").expect_err("empty file");
    }

    #[test]
    fn body_with_three_dashes_inside_paragraph_not_treated_as_close() {
        // Closing fence requires a line consisting solely of `---`.
        // `---inline` should not match.
        let src = b"---\nname: diagnose\n---\n## body\n\n---inline not a fence\n\nmore body\n";
        let md = MdPrimitive::parse(src).expect("parse ok");
        assert_eq!(md.frontmatter_bytes(), b"name: diagnose\n");
        assert!(md.body().starts_with(b"## body"));
    }

    #[test]
    fn empty_frontmatter_round_trips() {
        let src = b"---\n---\n";
        let md = MdPrimitive::parse(src).expect("empty fm parses");
        assert_eq!(md.frontmatter_bytes(), b"");
        assert_eq!(md.body(), b"");
        assert_eq!(md.to_bytes(), src.as_slice());
    }

    #[test]
    fn empty_frontmatter_with_body() {
        let src = b"---\n---\njust the body\n";
        let md = MdPrimitive::parse(src).expect("empty fm + body parses");
        assert_eq!(md.frontmatter_bytes(), b"");
        assert_eq!(md.body(), b"just the body\n");
    }

    #[test]
    fn closing_fence_at_eof_without_trailing_newline() {
        let src = b"---\nname: diagnose\n---";
        let md = MdPrimitive::parse(src).expect("parse ok");
        assert_eq!(md.frontmatter_bytes(), b"name: diagnose\n");
        assert_eq!(md.body(), b"");
    }
}
