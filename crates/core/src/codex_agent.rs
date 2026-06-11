use std::str;

use toml_edit::DocumentMut;

use crate::Error;

/// A CodexAgent file: whole-file TOML, fully lossless via `toml_edit`.
///
/// Comments, key order, and quoting are preserved on round-trip. Used by the
/// materializer to read frozen versions and re-emit them byte-exact when the
/// underlying TOML hasn't been edited; used by the editor when fields change.
#[derive(Debug, Clone)]
pub struct CodexAgentFile {
    doc: DocumentMut,
}

impl CodexAgentFile {
    pub fn parse(bytes: &[u8]) -> Result<Self, Error> {
        let s = str::from_utf8(bytes)?;
        let doc: DocumentMut = s.parse()?;
        Ok(Self { doc })
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        self.doc.to_string().into_bytes()
    }

    pub fn doc(&self) -> &DocumentMut {
        &self.doc
    }

    pub fn doc_mut(&mut self) -> &mut DocumentMut {
        &mut self.doc
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_simple_file_byte_exact() {
        let original = b"name = \"diagnose\"\nversion = 1\n";
        let file = CodexAgentFile::parse(original).expect("parse ok");
        assert_eq!(file.to_bytes(), original);
    }

    #[test]
    fn preserves_comments() {
        let original = b"# top comment\nname = \"diagnose\"  # inline\n# trailing\n";
        let file = CodexAgentFile::parse(original).expect("parse ok");
        assert_eq!(file.to_bytes(), original);
    }

    #[test]
    fn preserves_key_order() {
        let original = b"zebra = 1\nalpha = 2\nmonkey = 3\n";
        let file = CodexAgentFile::parse(original).expect("parse ok");
        assert_eq!(file.to_bytes(), original);
    }

    #[test]
    fn preserves_quoting_style() {
        let original = b"single = 'foo'\ndouble = \"bar\"\nliteral = '''raw'''\n";
        let file = CodexAgentFile::parse(original).expect("parse ok");
        assert_eq!(file.to_bytes(), original);
    }

    #[test]
    fn preserves_nested_tables_and_arrays() {
        let original = br#"name = "agent"

[config]
model = "opus"
tools = ["read", "write"]

[[hooks]]
name = "pre"
cmd = "echo hi"

[[hooks]]
name = "post"
cmd = "echo bye"
"#;
        let file = CodexAgentFile::parse(original).expect("parse ok");
        assert_eq!(file.to_bytes(), original.as_slice());
    }

    #[test]
    fn preserves_blank_lines_and_trailing_whitespace() {
        let original = b"\nname = \"diagnose\"\n\n\n[meta]\nfoo = 1\n\n";
        let file = CodexAgentFile::parse(original).expect("parse ok");
        assert_eq!(file.to_bytes(), original);
    }

    #[test]
    fn round_trip_after_edit_preserves_unrelated_lines() {
        let original = br#"# header
name = "old"
version = 1

[meta]
keep = "this"
"#;
        let mut file = CodexAgentFile::parse(original).expect("parse ok");
        file.doc_mut()["name"] = toml_edit::value("new");
        let bytes = file.to_bytes();
        let s = std::str::from_utf8(&bytes).unwrap();
        assert!(s.contains("# header"), "header comment preserved");
        assert!(s.contains("name = \"new\""), "name updated");
        assert!(s.contains("version = 1"), "other field preserved");
        assert!(s.contains("keep = \"this\""), "nested table preserved");
    }

    #[test]
    fn rejects_invalid_toml() {
        CodexAgentFile::parse(b"name = ").expect_err("incomplete TOML rejected");
        CodexAgentFile::parse(b"= bare value").expect_err("bare value rejected");
    }

    #[test]
    fn rejects_invalid_utf8() {
        CodexAgentFile::parse(&[0xff, 0xfe, 0xfd]).expect_err("invalid utf8 rejected");
    }
}
