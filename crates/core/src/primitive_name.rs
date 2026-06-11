use serde::{Deserialize, Serialize};

use crate::error::Error;

/// On the wire and in TS bindings, this is just a `string`. Validation
/// runs on every `Deserialize` via `try_from`, so untrusted frontend
/// payloads cannot construct an invalid name.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct PrimitiveName(String);

impl specta::Type for PrimitiveName {
    fn inline(
        type_map: &mut specta::TypeCollection,
        generics: specta::Generics,
    ) -> specta::DataType {
        String::inline(type_map, generics)
    }
}

impl From<PrimitiveName> for String {
    fn from(value: PrimitiveName) -> Self {
        value.0
    }
}

impl TryFrom<String> for PrimitiveName {
    type Error = Error;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::try_new(value)
    }
}

impl PrimitiveName {
    pub fn try_new(s: impl Into<String>) -> Result<Self, Error> {
        let s = s.into();
        let reject = |reason: &'static str| Error::InvalidPrimitiveName {
            name: s.clone(),
            reason,
        };

        if s.is_empty() || s.len() > 64 {
            return Err(reject("must be 1-64 characters"));
        }
        if s.starts_with('.') {
            return Err(reject("leading dot not allowed"));
        }
        for c in s.chars() {
            let allowed = c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-';
            if !allowed {
                return Err(reject("only [A-Za-z0-9._-] allowed"));
            }
        }
        Ok(PrimitiveName(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_simple_lowercase_name() {
        let name = PrimitiveName::try_new("diagnose").expect("simple name should parse");
        assert_eq!(name.as_str(), "diagnose");
    }

    #[test]
    fn rejects_empty_string() {
        let err = PrimitiveName::try_new("").unwrap_err();
        assert!(matches!(
            err,
            Error::InvalidPrimitiveName { name, reason: "must be 1-64 characters" } if name.is_empty()
        ));
    }

    #[test]
    fn accepts_64_chars_rejects_65() {
        let exactly_64 = "a".repeat(64);
        PrimitiveName::try_new(&exactly_64).expect("64 chars accepted");

        let too_long = "a".repeat(65);
        PrimitiveName::try_new(&too_long).expect_err("65 chars rejected");
    }

    #[test]
    fn rejects_path_separators() {
        PrimitiveName::try_new("foo/bar").expect_err("forward slash rejected");
        PrimitiveName::try_new("foo\\bar").expect_err("backslash rejected");
    }

    #[test]
    fn rejects_dot_and_dotdot() {
        PrimitiveName::try_new(".").expect_err("`.` rejected");
        PrimitiveName::try_new("..").expect_err("`..` rejected");
    }

    #[test]
    fn rejects_leading_dot() {
        PrimitiveName::try_new(".hidden").expect_err("leading dot rejected");
    }

    #[test]
    fn rejects_control_chars_and_nul() {
        PrimitiveName::try_new("foo\0bar").expect_err("nul rejected");
        PrimitiveName::try_new("foo\nbar").expect_err("newline rejected");
        PrimitiveName::try_new("foo\tbar").expect_err("tab rejected");
        PrimitiveName::try_new("foo\x07bar").expect_err("bell rejected");
    }

    #[test]
    fn rejects_non_ascii() {
        PrimitiveName::try_new("résumé").expect_err("accented chars rejected");
        PrimitiveName::try_new("foo\u{202E}bar").expect_err("RTL override rejected");
        PrimitiveName::try_new("emoji-\u{1F600}").expect_err("emoji rejected");
    }

    #[test]
    fn rejects_disallowed_punctuation() {
        PrimitiveName::try_new("foo bar").expect_err("space rejected");
        PrimitiveName::try_new("foo:bar").expect_err("colon rejected");
        PrimitiveName::try_new("foo;bar").expect_err("semicolon rejected");
        PrimitiveName::try_new("foo*bar").expect_err("star rejected");
    }

    #[test]
    fn accepts_allowed_punctuation() {
        PrimitiveName::try_new("foo.bar").expect("dot in middle ok");
        PrimitiveName::try_new("foo_bar").expect("underscore ok");
        PrimitiveName::try_new("foo-bar").expect("hyphen ok");
        PrimitiveName::try_new("Foo123").expect("mixed case + digits ok");
    }

    /// Single adversarial fixture table that locks the validator's accept /
    /// reject boundary. Anything that rendering as a filename or library
    /// path could break — path traversal, control codes, bidi/RTL marks,
    /// invisible space characters, homograph look-alikes, length limits —
    /// belongs here. Organized by attack class so a new contributor can
    /// see at a glance what's been considered.
    ///
    /// Per the Phase 7 acceptance criterion (canonical plan §654), this is
    /// the canonical test that future validator changes must keep green.
    #[test]
    fn adversarial_fixtures() {
        struct Case {
            input: &'static str,
            note: &'static str,
        }

        let rejected = &[
            // --- length boundary ---
            Case { input: "", note: "empty string" },
            // 65-char string is constructed below to keep this table 'static.
            // --- path traversal ---
            Case { input: ".", note: "single dot" },
            Case { input: "..", note: "parent-dir traversal" },
            Case { input: "...", note: "triple dot — leading dot" },
            Case { input: "..foo", note: "double leading dot" },
            Case { input: ".hidden", note: "leading dot (POSIX hidden)" },
            Case { input: "foo/bar", note: "forward slash" },
            Case { input: "foo\\bar", note: "backslash" },
            Case { input: "../../etc/passwd", note: "classic path-escape attempt" },
            // --- control codes ---
            Case { input: "foo\0bar", note: "embedded NUL" },
            Case { input: "foo\nbar", note: "embedded newline" },
            Case { input: "foo\rbar", note: "embedded carriage return" },
            Case { input: "foo\tbar", note: "embedded tab" },
            Case { input: "foo\x07bar", note: "BEL (terminal escape)" },
            Case { input: "foo\x1bbar", note: "ESC (terminal escape)" },
            Case { input: "foo\x7fbar", note: "DEL" },
            // --- whitespace ---
            Case { input: " foo", note: "leading space" },
            Case { input: "foo ", note: "trailing space" },
            Case { input: "foo bar", note: "interior space" },
            // --- non-ASCII / bidi / homograph ---
            Case { input: "résumé", note: "Latin-1 accents" },
            Case { input: "café", note: "precomposed accent" },
            Case { input: "cafe\u{0301}", note: "decomposed combining acute" },
            Case { input: "foo\u{202E}bar", note: "RTL override (U+202E)" },
            Case { input: "foo\u{202D}bar", note: "LTR override (U+202D)" },
            Case { input: "foo\u{200E}bar", note: "left-to-right mark (U+200E)" },
            Case { input: "foo\u{200F}bar", note: "right-to-left mark (U+200F)" },
            Case { input: "foo\u{200B}bar", note: "zero-width space" },
            Case { input: "\u{FEFF}foo", note: "leading BOM (zero-width no-break space)" },
            Case { input: "foo\u{2028}bar", note: "line separator" },
            Case { input: "foo\u{2029}bar", note: "paragraph separator" },
            Case { input: "ｆｏｏ", note: "fullwidth Latin look-alike" },
            Case { input: "fо\u{043E}", note: "Cyrillic homograph for 'foo'" },
            Case { input: "emoji-\u{1F600}", note: "emoji" },
            // --- punctuation outside [A-Za-z0-9._-] ---
            Case { input: "foo:bar", note: "colon" },
            Case { input: "foo;bar", note: "semicolon" },
            Case { input: "foo*bar", note: "glob star" },
            Case { input: "foo?bar", note: "glob question" },
            Case { input: "foo|bar", note: "pipe" },
            Case { input: "foo&bar", note: "ampersand (shell)" },
            Case { input: "foo$bar", note: "dollar (shell expansion)" },
            Case { input: "foo`bar", note: "backtick (shell)" },
            Case { input: "foo\"bar", note: "double quote" },
            Case { input: "foo'bar", note: "single quote" },
            Case { input: "foo<bar", note: "less-than (redirect)" },
            Case { input: "foo>bar", note: "greater-than (redirect)" },
            Case { input: "foo(bar", note: "open paren" },
            Case { input: "foo[bar", note: "open bracket" },
            Case { input: "foo{bar", note: "open brace" },
            Case { input: "foo#bar", note: "hash (yaml/comment)" },
            Case { input: "foo!bar", note: "bang" },
            Case { input: "foo@bar", note: "at-sign" },
            Case { input: "foo+bar", note: "plus" },
            Case { input: "foo=bar", note: "equals" },
            Case { input: "foo,bar", note: "comma" },
            Case { input: "foo%bar", note: "percent" },
            Case { input: "foo~bar", note: "tilde (home expansion)" },
        ];

        for case in rejected {
            assert!(
                PrimitiveName::try_new(case.input).is_err(),
                "expected rejection for {} ({:?}), but it parsed",
                case.note,
                case.input,
            );
        }

        // 65-char rejection (constructed; can't go in the 'static table above).
        assert!(
            PrimitiveName::try_new("a".repeat(65)).is_err(),
            "65-char name should be rejected (limit is 64)",
        );
        // 1000-char sanity — make sure a pathological length doesn't crash.
        assert!(
            PrimitiveName::try_new("a".repeat(1000)).is_err(),
            "1000-char name should be rejected without panicking",
        );

        // --- accepted boundary cases ---
        let accepted = &[
            Case { input: "a", note: "single char" },
            Case { input: "9", note: "single digit" },
            Case { input: "A", note: "single uppercase" },
            Case { input: "a-b", note: "hyphen interior" },
            Case { input: "a_b", note: "underscore interior" },
            Case { input: "a.b", note: "dot interior" },
            Case { input: "Foo.Bar-baz_42", note: "all allowed punctuation mixed" },
            Case { input: "name-", note: "trailing hyphen" },
            Case { input: "name.", note: "trailing dot" },
            Case { input: "name_", note: "trailing underscore" },
        ];
        for case in accepted {
            PrimitiveName::try_new(case.input)
                .unwrap_or_else(|e| panic!("expected accept for {} ({:?}): {e:?}", case.note, case.input));
        }
        // 64-char limit (constructed).
        PrimitiveName::try_new("a".repeat(64)).expect("64-char name should be accepted");
    }
}
