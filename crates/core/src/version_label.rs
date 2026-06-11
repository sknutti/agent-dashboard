use serde::{Deserialize, Serialize};

use crate::error::Error;

/// On the wire and in TS bindings, this is just a `string`. Validation
/// runs on every `Deserialize` via `try_from`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct VersionLabel(String);

impl specta::Type for VersionLabel {
    fn inline(
        type_map: &mut specta::TypeCollection,
        generics: specta::Generics,
    ) -> specta::DataType {
        String::inline(type_map, generics)
    }
}

impl From<VersionLabel> for String {
    fn from(value: VersionLabel) -> Self {
        value.0
    }
}

impl TryFrom<String> for VersionLabel {
    type Error = Error;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::try_new(value)
    }
}

impl VersionLabel {
    pub fn try_new(s: impl Into<String>) -> Result<Self, Error> {
        let s = s.into();
        let reject = |reason: &'static str| Error::InvalidVersionLabel {
            label: s.clone(),
            reason,
        };

        let rest = s.strip_prefix('v').ok_or_else(|| reject("must start with `v`"))?;

        let (digits, suffix) = match rest.find('-') {
            Some(i) => (&rest[..i], Some(&rest[i + 1..])),
            None => (rest, None),
        };

        if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
            return Err(reject("`v` must be followed by one or more digits"));
        }

        if let Some(suffix) = suffix {
            if suffix.is_empty() {
                return Err(reject("dash suffix cannot be empty"));
            }
            for c in suffix.chars() {
                let allowed = c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-';
                if !allowed {
                    return Err(reject("suffix only [A-Za-z0-9._-] allowed"));
                }
            }
        }

        Ok(VersionLabel(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_v1() {
        let v = VersionLabel::try_new("v1").expect("v1 ok");
        assert_eq!(v.as_str(), "v1");
    }

    #[test]
    fn accepts_multi_digit() {
        VersionLabel::try_new("v42").expect("v42 ok");
        VersionLabel::try_new("v9999").expect("v9999 ok");
    }

    #[test]
    fn accepts_suffix() {
        VersionLabel::try_new("v1-alpha").expect("alpha suffix ok");
        VersionLabel::try_new("v2-rc.1").expect("rc.1 suffix ok");
        VersionLabel::try_new("v3-feature_x-attempt2").expect("complex suffix ok");
    }

    #[test]
    fn rejects_missing_v_prefix() {
        VersionLabel::try_new("1").expect_err("no v rejected");
        VersionLabel::try_new("V1").expect_err("uppercase V rejected");
    }

    #[test]
    fn rejects_no_digits_after_v() {
        VersionLabel::try_new("v").expect_err("v alone rejected");
        VersionLabel::try_new("v-alpha").expect_err("v-alpha rejected");
        VersionLabel::try_new("vfoo").expect_err("vfoo rejected");
    }

    #[test]
    fn rejects_empty_suffix() {
        VersionLabel::try_new("v1-").expect_err("trailing dash rejected");
    }

    #[test]
    fn rejects_invalid_suffix_chars() {
        VersionLabel::try_new("v1-foo bar").expect_err("space in suffix rejected");
        VersionLabel::try_new("v1-foo/bar").expect_err("slash in suffix rejected");
        VersionLabel::try_new("v1-résumé").expect_err("non-ascii rejected");
    }

    #[test]
    fn rejects_empty() {
        VersionLabel::try_new("").expect_err("empty rejected");
    }
}
