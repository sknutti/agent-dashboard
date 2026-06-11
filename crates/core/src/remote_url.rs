//! Validation for the GitHub remote URL the user pastes into Settings.
//!
//! The PAT is supplied via `GIT_ASKPASS` so it never appears in the URL,
//! but the URL still has to be locked down: only `https`, only the
//! github.com host (no enterprise hosts in v1), no userinfo (`@` before
//! host), no control chars, no whitespace. We hand-roll the parser
//! rather than pull in `url` for what amounts to six rules.

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RemoteUrlError {
    #[error("URL is empty")]
    Empty,
    #[error("URL must use https://, got `{scheme}`")]
    NonHttps { scheme: String },
    #[error("URL must not embed credentials (no `@` before host)")]
    EmbeddedCredentials,
    #[error("URL contains a control character")]
    ControlCharacter,
    #[error("URL contains whitespace")]
    Whitespace,
    #[error("host `{host}` is not allowed (only github.com)")]
    HostNotAllowed { host: String },
    #[error("URL is missing a host")]
    MissingHost,
    #[error("URL must include a repository path, e.g. https://github.com/<owner>/<repo>")]
    MissingPath,
}

/// Allowed host. Enterprise hosts intentionally not supported in v1.
const ALLOWED_HOST: &str = "github.com";

/// Validate `input`, returning the trimmed, normalized form.
///
/// Normalization is conservative: trim surrounding whitespace, lowercase
/// the host. The path is left as-is (case-sensitive on github.com).
pub fn validate_remote_url(input: &str) -> Result<String, RemoteUrlError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(RemoteUrlError::Empty);
    }

    if trimmed.chars().any(char::is_whitespace) {
        return Err(RemoteUrlError::Whitespace);
    }
    if trimmed.chars().any(|c| (c as u32) < 0x20 || (c as u32) == 0x7F) {
        return Err(RemoteUrlError::ControlCharacter);
    }

    let after_scheme = trimmed
        .strip_prefix("https://")
        .ok_or_else(|| RemoteUrlError::NonHttps {
            scheme: trimmed
                .split_once("://")
                .map(|(s, _)| s.to_string())
                .unwrap_or_else(|| "<missing>".into()),
        })?;

    let (authority, path) = match after_scheme.find('/') {
        Some(i) => after_scheme.split_at(i),
        None => return Err(RemoteUrlError::MissingPath),
    };

    if authority.contains('@') {
        return Err(RemoteUrlError::EmbeddedCredentials);
    }
    if authority.is_empty() {
        return Err(RemoteUrlError::MissingHost);
    }

    let (host, port) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    if !host.eq_ignore_ascii_case(ALLOWED_HOST) {
        return Err(RemoteUrlError::HostNotAllowed {
            host: host.to_string(),
        });
    }
    if path.len() < 2 {
        return Err(RemoteUrlError::MissingPath);
    }
    let host_lower = host.to_ascii_lowercase();
    let authority_norm = match port {
        Some(p) => format!("{host_lower}:{p}"),
        None => host_lower,
    };
    Ok(format!("https://{authority_norm}{path}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_canonical_github_url() {
        let out = validate_remote_url("https://github.com/scott/prompts.git").unwrap();
        assert_eq!(out, "https://github.com/scott/prompts.git");
    }

    #[test]
    fn lowercases_host_and_trims_whitespace() {
        let out = validate_remote_url("  https://GitHub.com/Scott/Prompts.git  ").unwrap();
        assert_eq!(out, "https://github.com/Scott/Prompts.git");
    }

    #[test]
    fn rejects_empty() {
        assert_eq!(validate_remote_url("   ").unwrap_err(), RemoteUrlError::Empty);
    }

    #[test]
    fn rejects_http_scheme() {
        let err = validate_remote_url("http://github.com/x/y").unwrap_err();
        assert!(matches!(err, RemoteUrlError::NonHttps { .. }));
    }

    #[test]
    fn rejects_ssh_scheme() {
        let err = validate_remote_url("git@github.com:x/y.git").unwrap_err();
        assert!(matches!(err, RemoteUrlError::NonHttps { .. }));
    }

    #[test]
    fn rejects_embedded_credentials() {
        let err =
            validate_remote_url("https://user:token@github.com/x/y.git").unwrap_err();
        assert_eq!(err, RemoteUrlError::EmbeddedCredentials);
    }

    #[test]
    fn rejects_token_username_form() {
        let err = validate_remote_url("https://ghp_xxx@github.com/x/y.git").unwrap_err();
        assert_eq!(err, RemoteUrlError::EmbeddedCredentials);
    }

    #[test]
    fn rejects_disallowed_host() {
        let err = validate_remote_url("https://gitlab.com/x/y.git").unwrap_err();
        assert_eq!(
            err,
            RemoteUrlError::HostNotAllowed {
                host: "gitlab.com".into()
            }
        );
    }

    #[test]
    fn rejects_enterprise_host_in_v1() {
        let err = validate_remote_url("https://github.acme.com/x/y.git").unwrap_err();
        assert!(matches!(err, RemoteUrlError::HostNotAllowed { .. }));
    }

    #[test]
    fn rejects_control_characters() {
        let err = validate_remote_url("https://github.com/x/y\x07").unwrap_err();
        assert_eq!(err, RemoteUrlError::ControlCharacter);
    }

    #[test]
    fn rejects_internal_whitespace() {
        let err = validate_remote_url("https://github.com /x/y").unwrap_err();
        assert_eq!(err, RemoteUrlError::Whitespace);
    }

    #[test]
    fn rejects_missing_path() {
        let err = validate_remote_url("https://github.com").unwrap_err();
        assert_eq!(err, RemoteUrlError::MissingPath);
    }

    #[test]
    fn rejects_missing_path_after_slash() {
        let err = validate_remote_url("https://github.com/").unwrap_err();
        assert_eq!(err, RemoteUrlError::MissingPath);
    }

    #[test]
    fn allows_explicit_port() {
        let out = validate_remote_url("https://github.com:443/x/y.git").unwrap();
        assert_eq!(out, "https://github.com:443/x/y.git");
    }
}
