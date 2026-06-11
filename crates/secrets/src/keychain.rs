//! macOS login-keychain backed [`SecretStore`].
//!
//! Persists a single GitHub PAT under (service, account) =
//! (`com.sknutti.promptlibrary`, `github-pat`) in the file-based login
//! keychain (`~/Library/Keychains/login.keychain-db`). `set_pat` is
//! upsert (security-framework retries `SecItemAdd` as `SecItemUpdate`
//! on `errSecDuplicateItem`).
//!
//! Why not the data-protection keychain: it requires a code-signed
//! binary (the entitlement scopes items to the signing identity).
//! This app is unsigned, so the legacy login keychain is the only
//! option that works in dev and in distribution.
//!
//! Side effect of unsigned-binary + login-keychain: macOS prompts the
//! user "PromptLibrary wants to access the keychain" the first time
//! a given binary touches the item. Click "Always Allow" once. The
//! prompt re-appears whenever the binary hash changes (e.g. after
//! `cargo build`), because the ACL is bound to the binary's
//! signature/path. Annoying in dev, fine for a stable installed app.
//!
//! No automated test: keychain access from an interactive `cargo
//! test` would block on the user-consent prompt. Verify by hand.

use security_framework::passwords::{
    delete_generic_password_options, generic_password, set_generic_password_options,
    PasswordOptions,
};
use security_framework_sys::base::errSecItemNotFound;

use crate::{SecretError, SecretStore};

const SERVICE: &str = "com.sknutti.promptlibrary";
const ACCOUNT: &str = "github-pat";

pub struct KeychainStore;

impl KeychainStore {
    pub fn new() -> Self {
        Self
    }

    fn options() -> PasswordOptions {
        PasswordOptions::new_generic_password(SERVICE, ACCOUNT)
    }
}

impl Default for KeychainStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for KeychainStore {
    fn set_pat(&self, token: &str) -> Result<(), SecretError> {
        set_generic_password_options(token.as_bytes(), Self::options())
            .map_err(|e| SecretError::Keychain(e.to_string()))
    }

    fn get_pat(&self) -> Result<Option<String>, SecretError> {
        match generic_password(Self::options()) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|e| SecretError::Keychain(format!("stored PAT is not valid UTF-8: {e}"))),
            Err(e) if e.code() == errSecItemNotFound => Ok(None),
            Err(e) => Err(SecretError::Keychain(e.to_string())),
        }
    }

    fn delete_pat(&self) -> Result<(), SecretError> {
        match delete_generic_password_options(Self::options()) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == errSecItemNotFound => Ok(()),
            Err(e) => Err(SecretError::Keychain(e.to_string())),
        }
    }
}
