use camino::{Utf8Path, Utf8PathBuf};
use serde::{Deserialize, Serialize};

use crate::fs_helpers::atomic_write;
use crate::Error;

/// App-level user settings persisted to a JSON file in `app_data_dir()`.
///
/// Stays minimal — extend with care; the file is hand-editable.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library_path: Option<Utf8PathBuf>,

    /// Validated GitHub remote URL the library is mirrored to. Stored
    /// in normalized form (see [`crate::remote_url::validate_remote_url`]).
    /// PAT lives in the OS keychain — never on disk here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
}

impl Settings {
    /// Load settings from `path`. Returns `Settings::default()` if the file
    /// does not exist (first launch).
    pub fn load(path: &Utf8Path) -> Result<Self, Error> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| Error::SettingsParse(e.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(source) => Err(Error::Io {
                path: path.to_string(),
                source,
            }),
        }
    }

    /// Save settings to `path`, atomically (temp file + rename). Creates
    /// parent directories if missing.
    pub fn save(&self, path: &Utf8Path) -> Result<(), Error> {
        let body = serde_json::to_vec_pretty(self)
            .map_err(|e| Error::SettingsSerialize(e.to_string()))?;
        atomic_write(path, &body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn settings_path(tmp: &TempDir) -> Utf8PathBuf {
        Utf8PathBuf::from_path_buf(tmp.path().join("settings.json")).unwrap()
    }

    #[test]
    fn load_returns_default_when_file_missing() {
        let tmp = TempDir::new().unwrap();
        let loaded = Settings::load(&settings_path(&tmp)).unwrap();
        assert_eq!(loaded, Settings::default());
        assert_eq!(loaded.library_path, None);
    }

    #[test]
    fn save_then_load_round_trips_library_path() {
        let tmp = TempDir::new().unwrap();
        let path = settings_path(&tmp);
        let original = Settings {
            library_path: Some(Utf8PathBuf::from("/Users/scott/Library")),
            remote_url: None,
        };
        original.save(&path).unwrap();
        let loaded = Settings::load(&path).unwrap();
        assert_eq!(loaded, original);
    }

    #[test]
    fn save_then_load_round_trips_remote_url() {
        let tmp = TempDir::new().unwrap();
        let path = settings_path(&tmp);
        let original = Settings {
            library_path: None,
            remote_url: Some("https://github.com/scott/prompts.git".into()),
        };
        original.save(&path).unwrap();
        let loaded = Settings::load(&path).unwrap();
        assert_eq!(loaded, original);
    }

    #[test]
    fn save_omits_none_remote_url() {
        let tmp = TempDir::new().unwrap();
        let path = settings_path(&tmp);
        Settings::default().save(&path).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            !raw.contains("remote_url"),
            "None should be omitted, got:\n{raw}"
        );
    }

    #[test]
    fn save_creates_parent_dirs() {
        let tmp = TempDir::new().unwrap();
        let nested = Utf8PathBuf::from_path_buf(
            tmp.path().join("does/not/exist/yet/settings.json"),
        )
        .unwrap();
        Settings::default().save(&nested).unwrap();
        assert!(nested.exists());
    }

    #[test]
    fn save_omits_none_library_path() {
        let tmp = TempDir::new().unwrap();
        let path = settings_path(&tmp);
        Settings::default().save(&path).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            !raw.contains("library_path"),
            "None should be omitted, got:\n{raw}"
        );
    }

    #[test]
    fn load_surfaces_parse_error_on_garbage() {
        let tmp = TempDir::new().unwrap();
        let path = settings_path(&tmp);
        std::fs::write(&path, b"not valid json").unwrap();
        let err = Settings::load(&path).unwrap_err();
        assert!(matches!(err, Error::SettingsParse(_)));
    }
}
