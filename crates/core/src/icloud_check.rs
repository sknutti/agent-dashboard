//! Detect when the library path lives inside iCloud Drive.
//!
//! iCloud Drive's offload-to-cloud / `.icloud` placeholder files break git
//! and Tauri filesystem assumptions in subtle ways (lookups can transiently
//! ENOENT a file the user thinks exists). We don't block the user — they may
//! genuinely want the library synced — but a Settings warning is cheap.

use camino::Utf8Path;

/// True if `library_path` is inside `<home>/Library/Mobile Documents/`. Pure
/// path math; does not stat the filesystem.
///
/// `library_path` should be canonicalised by the caller (the Tauri command
/// path comes from settings.json which stores absolute UTF-8 paths).
pub fn is_in_icloud_drive(library_path: &Utf8Path, home: &Utf8Path) -> bool {
    library_path.starts_with(home.join("Library/Mobile Documents"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use camino::Utf8PathBuf;

    fn home() -> Utf8PathBuf {
        Utf8PathBuf::from("/Users/sknutti")
    }

    #[test]
    fn library_inside_icloud_root_is_detected() {
        let lib = Utf8PathBuf::from(
            "/Users/sknutti/Library/Mobile Documents/com~apple~CloudDocs/library",
        );
        assert!(is_in_icloud_drive(&lib, &home()));
    }

    #[test]
    fn library_at_icloud_root_itself_is_detected() {
        let lib = Utf8PathBuf::from("/Users/sknutti/Library/Mobile Documents");
        assert!(is_in_icloud_drive(&lib, &home()));
    }

    #[test]
    fn unrelated_library_is_not_flagged() {
        let lib = Utf8PathBuf::from("/Users/sknutti/code/library");
        assert!(!is_in_icloud_drive(&lib, &home()));
    }

    #[test]
    fn library_outside_home_is_not_flagged() {
        let lib = Utf8PathBuf::from("/tmp/library");
        assert!(!is_in_icloud_drive(&lib, &home()));
    }

    #[test]
    fn near_miss_path_does_not_partial_match() {
        // `Library/Mobile` (without the trailing 'Documents') must not match —
        // `starts_with` works on full path components, not raw substrings.
        let lib = Utf8PathBuf::from("/Users/sknutti/Library/Mobile/something");
        assert!(!is_in_icloud_drive(&lib, &home()));
    }

    #[test]
    fn different_home_dir_does_not_match() {
        let lib = Utf8PathBuf::from(
            "/Users/other/Library/Mobile Documents/com~apple~CloudDocs/library",
        );
        assert!(!is_in_icloud_drive(&lib, &home()));
    }
}
