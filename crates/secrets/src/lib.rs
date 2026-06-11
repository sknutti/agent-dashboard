//! Personal Access Token storage interface. Tests use [`InMemoryStore`]
//! against the [`SecretStore`] trait. The production binary uses
//! [`KeychainStore`] on macOS, which writes to the data-protection
//! keychain (`kSecUseDataProtectionKeychain`).

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("keychain error: {0}")]
    Keychain(String),
}

#[cfg(target_os = "macos")]
mod keychain;
#[cfg(target_os = "macos")]
pub use keychain::KeychainStore;

pub trait SecretStore: Send + Sync {
    fn set_pat(&self, token: &str) -> Result<(), SecretError>;
    fn get_pat(&self) -> Result<Option<String>, SecretError>;
    fn delete_pat(&self) -> Result<(), SecretError>;
}

pub struct InMemoryStore {
    pat: std::sync::Mutex<Option<String>>,
}

impl InMemoryStore {
    pub fn new() -> Self {
        Self {
            pat: std::sync::Mutex::new(None),
        }
    }
}

impl Default for InMemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for InMemoryStore {
    fn set_pat(&self, token: &str) -> Result<(), SecretError> {
        *self.pat.lock().unwrap() = Some(token.to_string());
        Ok(())
    }

    fn get_pat(&self) -> Result<Option<String>, SecretError> {
        Ok(self.pat.lock().unwrap().clone())
    }

    fn delete_pat(&self) -> Result<(), SecretError> {
        *self.pat.lock().unwrap() = None;
        Ok(())
    }
}

/// Format a PAT for UI display: keep the 4-char type prefix and the
/// last 4 chars, replace the middle with bullets. Tokens shorter than
/// 8 chars are fully bulleted.
pub fn redact_pat(pat: &str) -> String {
    if pat.len() < 8 {
        return "•".repeat(pat.chars().count());
    }
    let prefix: String = pat.chars().take(4).collect();
    let suffix: String = pat
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{prefix}••••••••{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_replaces_prior_value() {
        let store = InMemoryStore::new();
        store.set_pat("first").unwrap();
        store.set_pat("second").unwrap();
        assert_eq!(store.get_pat().unwrap(), Some("second".to_string()));
    }

    #[test]
    fn delete_clears_stored_token() {
        let store = InMemoryStore::new();
        store.set_pat("ghp_xyz").unwrap();
        store.delete_pat().unwrap();
        assert_eq!(store.get_pat().unwrap(), None);
    }

    #[test]
    fn set_then_get_round_trips_token() {
        let store = InMemoryStore::new();
        store.set_pat("ghp_xyz").unwrap();
        assert_eq!(store.get_pat().unwrap(), Some("ghp_xyz".to_string()));
    }

    #[test]
    fn redacts_classic_pat_keeping_prefix_and_last_four() {
        let pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
        assert_eq!(redact_pat(pat), "ghp_••••••••6789");
    }

    #[test]
    fn redacts_fine_grained_pat_with_first_four_chars() {
        let pat = "github_pat_aaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbb";
        let out = redact_pat(pat);
        assert!(out.starts_with("gith"), "got {out:?}");
        assert!(out.ends_with("bbbb"), "got {out:?}");
        assert!(out.contains("••••••••"));
    }

    #[test]
    fn redacts_short_pat_to_all_bullets() {
        assert_eq!(redact_pat("abc"), "•••");
        assert_eq!(redact_pat(""), "");
    }

    #[test]
    fn redact_pat_does_not_leak_middle_substrings() {
        let pat = "ghp_supersecrettoken1234567890abcdefghij";
        let out = redact_pat(pat);
        assert!(!out.contains("supersecret"), "leaked middle: {out:?}");
        assert!(!out.contains("token1234"), "leaked middle: {out:?}");
    }
}
