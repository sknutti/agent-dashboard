//! Pull a primitive's primary file (and, for Skills, its containing folder)
//! in by URL.
//!
//! Accepts canonical GitHub URLs (`github.com/{owner}/{repo}/blob/{ref}/{path}`)
//! and rewrites them to the raw form before fetching. `raw.githubusercontent.com`
//! URLs pass through unchanged. Anything else is rejected — there's no point
//! pretending we can handle gists or arbitrary hosts in v1.
//!
//! **Single-file fetches** (Agent / Command / CodexAgent / non-`SKILL.md`
//! URLs) stay on `raw.githubusercontent.com` and never touch the GitHub
//! API. Folder import (`SKILL.md` URLs) calls the GitHub Contents API to
//! enumerate the containing folder, then concurrently fetches each
//! supporting file via `download_url`. The Contents API dependence is a
//! deliberate reversal of the prior "no GitHub API" stance — see
//! `docs/adr/0005-folder-import-uses-github-contents-api.md` for the
//! tradeoffs (proportional bandwidth at the cost of 60/hr anonymous
//! rate limits and offline-fragility).
//!
//! Author resolution: if the fetched bytes parse as MD with a frontmatter
//! `author:` string, use that. Otherwise fall back to the GitHub repo owner
//! from the URL path. Same on both code paths.

use camino::Utf8Path;
use futures::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;

use crate::md_primitive::MdPrimitive;
use crate::working_files::validate_ref_path;
use crate::{is_ignored, Error, PrimitiveKind, PrimitiveName};

const MAX_BYTES: usize = 1 << 20; // 1 MiB
const MAX_BUNDLE_BYTES: usize = 4 << 20; // 4 MiB
const MAX_BUNDLE_FILES: usize = 200;
const TIMEOUT: Duration = Duration::from_secs(10);
const GITHUB_API_BASE: &str = "https://api.github.com";

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct FetchedPrimitive {
    /// Raw file bytes interpreted as UTF-8. Validated as UTF-8 at fetch time
    /// so the frontend never has to handle byte-level errors.
    pub content: String,
    /// Filename stem from the URL, sanitized to fit `PrimitiveName`'s rules.
    /// Empty if the stem couldn't be made valid — frontend falls back to
    /// "let user type a name".
    pub suggested_name: String,
    /// MD frontmatter `author:` field if present, else the URL's GitHub
    /// owner segment, else `None`.
    pub author: Option<String>,
    /// Canonical fetched URL (raw form for GitHub blob URLs).
    pub source_url: String,
    /// Supporting files for Skill folder imports — populated when the URL's
    /// filename is `SKILL.md` and the folder has additional content. Empty
    /// for single-file imports (the dominant path).
    pub ref_files: Vec<RefFile>,
}

/// One supporting file pulled from a Skill's containing folder during
/// folder import. `rel_path` is relative to the primitive's `working/base/`
/// (the same shape `working_files::list_working_files` returns); `content`
/// holds the raw bytes — UTF-8 is **not** enforced for ref files, matching
/// the disk-import path's tolerance for binary assets like PNGs in
/// `assets/`.
///
/// `rel_path` is a `String` rather than `Utf8PathBuf` so the type can cross
/// the IPC boundary via specta — same constraint as `Installer::FilePlan`.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct RefFile {
    pub rel_path: String,
    pub content: Vec<u8>,
}

pub async fn fetch_from_url(input: &str) -> Result<FetchedPrimitive, Error> {
    fetch_from_url_with_api_base(input, GITHUB_API_BASE).await
}

/// Test-only override for the GitHub Contents API base URL. Production
/// callers use `fetch_from_url`, which fixes `api_base` to `https://api.github.com`.
#[doc(hidden)]
pub async fn fetch_from_url_for_tests(
    input: &str,
    api_base: &str,
) -> Result<FetchedPrimitive, Error> {
    fetch_from_url_with_api_base(input, api_base).await
}

async fn fetch_from_url_with_api_base(
    input: &str,
    api_base: &str,
) -> Result<FetchedPrimitive, Error> {
    let trimmed = input.trim();
    let normalized = normalize_url(trimmed)?;
    let owner_from_url = github_owner(&normalized);

    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| Error::FetchFailed {
            url: normalized.clone(),
            message: format!("client build: {e}"),
        })?;

    let resp = client
        .get(&normalized)
        .send()
        .await
        .map_err(|e| Error::FetchFailed {
            url: normalized.clone(),
            message: e.to_string(),
        })?;
    let status = resp.status();
    if !status.is_success() {
        return Err(Error::FetchFailed {
            url: normalized,
            message: format!("HTTP {status}"),
        });
    }
    let bytes = resp.bytes().await.map_err(|e| Error::FetchFailed {
        url: normalized.clone(),
        message: e.to_string(),
    })?;
    if bytes.len() > MAX_BYTES {
        return Err(Error::FetchFailed {
            url: normalized,
            message: format!("response exceeded {MAX_BYTES} bytes"),
        });
    }
    let content = std::str::from_utf8(&bytes).map_err(|_| Error::FetchFailed {
        url: normalized.clone(),
        message: "response is not valid UTF-8".to_string(),
    })?;

    let suggested_name = suggested_name_from_url(&normalized).unwrap_or_default();
    let author = author_from_md(content.as_bytes()).or(owner_from_url);

    // Folder-import branch: SKILL.md URLs walk the containing folder and
    // pull the rest of its files in. Any error short-circuits the whole
    // fetch — no fallback to a single-file primitive (decision #3, #13).
    let ref_files = if is_skill_md_url(&normalized) {
        walk_skill_folder(&client, api_base, &normalized).await?
    } else {
        Vec::new()
    };

    Ok(FetchedPrimitive {
        content: content.to_string(),
        suggested_name,
        author,
        source_url: normalized,
        ref_files,
    })
}

/// Decomposed view of a normalized raw GitHub URL — `(owner, repo, ref,
/// path)` carved out of `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`.
/// Used by the folder-import walk to construct Contents API URLs.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RepoSlug {
    owner: String,
    repo: String,
    git_ref: String,
    /// Repo-relative path of the file that was fetched (e.g. `skills/diagnose/SKILL.md`).
    path: String,
}

fn parse_repo_slug(normalized_raw_url: &str) -> Option<RepoSlug> {
    let after = normalized_raw_url.strip_prefix("https://raw.githubusercontent.com/")?;
    let segments: Vec<&str> = after.splitn(4, '/').collect();
    if segments.len() < 4 {
        return None;
    }
    let [owner, repo, git_ref, path] = [segments[0], segments[1], segments[2], segments[3]];
    if owner.is_empty() || repo.is_empty() || git_ref.is_empty() || path.is_empty() {
        return None;
    }
    Some(RepoSlug {
        owner: owner.to_string(),
        repo: repo.to_string(),
        git_ref: git_ref.to_string(),
        path: path.to_string(),
    })
}

/// Repo-relative directory containing the fetched file. For
/// `skills/diagnose/SKILL.md` returns `skills/diagnose`. Returns `""` if
/// the file is at the repo root.
fn parent_repo_path(repo_path: &str) -> &str {
    repo_path.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

/// One entry in a Contents API listing response. We only consume the
/// fields we need; extras are tolerated by serde's default.
#[derive(Debug, Clone, Deserialize)]
struct ContentsEntry {
    #[serde(rename = "type")]
    entry_type: String, // "file" | "dir" | "symlink" | "submodule"
    /// Repo-relative path (e.g. `skills/diagnose/references/foo.md`).
    path: String,
    /// File size in bytes; meaningful only for `entry_type == "file"`.
    #[serde(default)]
    size: u64,
    /// Pre-signed download URL. Null for non-file entries.
    download_url: Option<String>,
}

/// Walk a Skill folder via the GitHub Contents API and return its non-primary
/// files as a `Vec<RefFile>`. The caller has already fetched `SKILL.md` itself.
///
/// `api_base` is the API host root (production: `https://api.github.com`;
/// tests: an httpmock server URL). `skill_url` is the normalized raw URL of
/// the SKILL.md file — its parent directory is the walk's root.
///
/// Steps: enumerate every file recursively, pre-flight count + size against
/// the bundle caps, validate each rel-path via `validate_ref_path`, then
/// fetch bytes concurrently with `buffer_unordered(8)`. Output is sorted by
/// rel-path. Any error short-circuits the walk; partial bundles never reach
/// the caller.
/// Test-only re-export of the internal walk for integration tests in
/// `tests/folder_import.rs`. Production callers go through
/// `fetch_from_url`, which is the only path that supplies the production
/// API base URL.
#[doc(hidden)]
pub async fn walk_skill_folder_for_tests(
    client: &reqwest::Client,
    api_base: &str,
    skill_url: &str,
) -> Result<Vec<RefFile>, Error> {
    walk_skill_folder(client, api_base, skill_url).await
}

async fn walk_skill_folder(
    client: &reqwest::Client,
    api_base: &str,
    skill_url: &str,
) -> Result<Vec<RefFile>, Error> {
    let slug = parse_repo_slug(skill_url).ok_or_else(|| Error::FetchFailed {
        url: skill_url.to_string(),
        message: "could not derive owner/repo/ref from URL".to_string(),
    })?;
    let root_dir = parent_repo_path(&slug.path).to_string();
    let primary_full_path = slug.path.clone();
    let skill_name = PrimitiveName::try_new("skill").map_err(|e| Error::FetchFailed {
        url: skill_url.to_string(),
        message: format!("internal: {e}"),
    })?;

    // 1) Enumerate all entries recursively. Symlinks/submodules are dropped.
    let mut all_files: Vec<ContentsEntry> = Vec::new();
    let mut to_visit: Vec<String> = vec![root_dir.clone()];
    while let Some(dir) = to_visit.pop() {
        let listing = fetch_contents_listing(client, api_base, &slug, &dir).await?;
        for entry in listing {
            // Drop ignored leaves (.DS_Store, ~suffix, etc.). Use the leaf
            // name only, matching `is_ignored`'s contract.
            let leaf = entry.path.rsplit('/').next().unwrap_or(&entry.path);
            if is_ignored(Utf8Path::new(leaf)) {
                continue;
            }
            match entry.entry_type.as_str() {
                "dir" => to_visit.push(entry.path.clone()),
                "file" => all_files.push(entry),
                _ => {} // symlinks, submodules: ignored
            }
        }
    }

    // 2) Pre-flight count + total size against the bundle caps. Run BEFORE
    //    any byte fetching so a 100 MiB bundle fails in milliseconds.
    let file_count = all_files.len();
    if file_count > MAX_BUNDLE_FILES {
        return Err(Error::BundleInvalid {
            reason: format!(
                "folder has {file_count} files; the limit is {MAX_BUNDLE_FILES}"
            ),
        });
    }
    let total_bytes: u64 = all_files.iter().map(|e| e.size).sum();
    if total_bytes as usize > MAX_BUNDLE_BYTES {
        return Err(Error::BundleInvalid {
            reason: format!(
                "folder is {total_bytes} bytes; the limit is {MAX_BUNDLE_BYTES}"
            ),
        });
    }

    // 3) Compute rel-paths (strip the root_dir prefix) and validate each.
    //    Skip the primary file at the root — it's already in `content`.
    let mut to_fetch: Vec<(String, String)> = Vec::new(); // (rel_path, download_url)
    for entry in all_files {
        if entry.path == primary_full_path {
            continue;
        }
        let rel = strip_root_prefix(&entry.path, &root_dir).ok_or_else(|| {
            Error::BundleInvalid {
                reason: format!("entry `{}` is outside the skill folder", entry.path),
            }
        })?;
        validate_ref_path(Utf8Path::new(&rel), PrimitiveKind::Skill, &skill_name).map_err(
            |e| Error::BundleInvalid {
                reason: format!("invalid ref path `{rel}`: {e}"),
            },
        )?;
        let download_url = entry.download_url.ok_or_else(|| Error::BundleInvalid {
            reason: format!("file `{rel}` has no download_url"),
        })?;
        to_fetch.push((rel, download_url));
    }

    // 4) Fetch bytes concurrently. Any per-file error short-circuits the
    //    whole walk (decision #3: hard error, no partial imports).
    let fetched: Vec<Result<RefFile, Error>> = stream::iter(to_fetch.into_iter().map(
        |(rel, url)| {
            let client = client.clone();
            async move {
                let bytes = fetch_ref_file_bytes(&client, &url).await?;
                Ok(RefFile {
                    rel_path: rel,
                    content: bytes,
                })
            }
        },
    ))
    .buffer_unordered(8)
    .collect()
    .await;

    let mut ref_files: Vec<RefFile> = fetched.into_iter().collect::<Result<_, _>>()?;
    ref_files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(ref_files)
}

async fn fetch_contents_listing(
    client: &reqwest::Client,
    api_base: &str,
    slug: &RepoSlug,
    dir: &str,
) -> Result<Vec<ContentsEntry>, Error> {
    let RepoSlug { owner, repo, git_ref, .. } = slug;
    // Trailing slash on `dir == ""` (root) is fine; GitHub treats both forms identically.
    let url = format!(
        "{api_base}/repos/{owner}/{repo}/contents/{dir}?ref={git_ref}"
    );
    let resp = client
        .get(&url)
        .header("User-Agent", "prompt-library/0.1")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| Error::FetchFailed {
            url: url.clone(),
            message: e.to_string(),
        })?;
    let status = resp.status();
    if status.as_u16() == 403 {
        if let Some(remaining) = resp.headers().get("x-ratelimit-remaining") {
            if remaining.to_str().map(|s| s == "0").unwrap_or(false) {
                return Err(Error::GitHubRateLimited);
            }
        }
    }
    if !status.is_success() {
        return Err(Error::FetchFailed {
            url,
            message: format!("HTTP {status}"),
        });
    }
    resp.json::<Vec<ContentsEntry>>().await.map_err(|e| Error::FetchFailed {
        url,
        message: format!("parse listing: {e}"),
    })
}

async fn fetch_ref_file_bytes(
    client: &reqwest::Client,
    download_url: &str,
) -> Result<Vec<u8>, Error> {
    let resp = client
        .get(download_url)
        .send()
        .await
        .map_err(|e| Error::FetchFailed {
            url: download_url.to_string(),
            message: e.to_string(),
        })?;
    let status = resp.status();
    if !status.is_success() {
        return Err(Error::FetchFailed {
            url: download_url.to_string(),
            message: format!("HTTP {status}"),
        });
    }
    let bytes = resp.bytes().await.map_err(|e| Error::FetchFailed {
        url: download_url.to_string(),
        message: e.to_string(),
    })?;
    if bytes.len() > MAX_BYTES {
        return Err(Error::BundleInvalid {
            reason: format!(
                "file at `{download_url}` is {} bytes; per-file limit is {MAX_BYTES}",
                bytes.len()
            ),
        });
    }
    Ok(bytes.to_vec())
}

fn strip_root_prefix(full_path: &str, root_dir: &str) -> Option<String> {
    if root_dir.is_empty() {
        return Some(full_path.to_string());
    }
    let prefix = format!("{root_dir}/");
    full_path.strip_prefix(&prefix).map(|s| s.to_string())
}

/// Rewrite recognized URLs to a fetchable form, or reject.
pub fn normalize_url(input: &str) -> Result<String, Error> {
    if input.is_empty() {
        return Err(Error::UnsupportedSourceUrl {
            reason: "URL is empty".to_string(),
        });
    }
    let lower = input.to_ascii_lowercase();
    if !lower.starts_with("https://") {
        return Err(Error::UnsupportedSourceUrl {
            reason: "URL must start with https://".to_string(),
        });
    }
    let after_scheme = &input[8..];
    let (authority, path) = match after_scheme.split_once('/') {
        Some((a, p)) => (a, p),
        None => {
            return Err(Error::UnsupportedSourceUrl {
                reason: "URL is missing a path".to_string(),
            })
        }
    };
    let host = authority
        .split_once(':')
        .map(|(h, _)| h)
        .unwrap_or(authority);
    let host_lower = host.to_ascii_lowercase();

    match host_lower.as_str() {
        "raw.githubusercontent.com" => Ok(input.to_string()),
        "github.com" => rewrite_github_blob(path).map(|p| format!("https://raw.githubusercontent.com{p}")),
        "gist.github.com" | "gist.githubusercontent.com" => Err(Error::UnsupportedSourceUrl {
            reason: "GitHub Gists are not supported in v1".to_string(),
        }),
        other => Err(Error::UnsupportedSourceUrl {
            reason: format!("host `{other}` is not supported (only github.com and raw.githubusercontent.com)"),
        }),
    }
}

/// Rewrite `/{owner}/{repo}/blob/{ref}/{path}` to `/{owner}/{repo}/{ref}/{path}`.
fn rewrite_github_blob(path: &str) -> Result<String, Error> {
    let segments: Vec<&str> = path.splitn(5, '/').collect();
    if segments.len() < 5 || segments[2] != "blob" {
        return Err(Error::UnsupportedSourceUrl {
            reason: "GitHub URL must be of the form github.com/{owner}/{repo}/blob/{ref}/{path}"
                .to_string(),
        });
    }
    let owner = segments[0];
    let repo = segments[1];
    let git_ref = segments[3];
    let file_path = segments[4];
    if owner.is_empty() || repo.is_empty() || git_ref.is_empty() || file_path.is_empty() {
        return Err(Error::UnsupportedSourceUrl {
            reason: "GitHub URL has empty owner, repo, ref, or path".to_string(),
        });
    }
    Ok(format!("/{owner}/{repo}/{git_ref}/{file_path}"))
}

/// Extract the GitHub repo owner from a normalized raw URL.
fn github_owner(url: &str) -> Option<String> {
    let path = url
        .strip_prefix("https://raw.githubusercontent.com/")
        .or_else(|| url.strip_prefix("https://github.com/"))?;
    path.split('/').next().filter(|s| !s.is_empty()).map(|s| s.to_string())
}

/// Pull `author:` from MD frontmatter, only if it parses as a string.
fn author_from_md(bytes: &[u8]) -> Option<String> {
    let md = MdPrimitive::parse(bytes).ok()?;
    let value: serde_yaml_ng::Value = serde_yaml_ng::from_slice(md.frontmatter_bytes()).ok()?;
    value
        .get("author")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Sanitize the URL's filename stem to fit `PrimitiveName` rules
/// (`^[A-Za-z0-9._-]{1,64}$`). Returns `None` if nothing usable remains.
///
/// Special case: when the filename is exactly `SKILL.md` (the conventional
/// Skill primary), prefer the parent directory name — `…/diagnose/SKILL.md`
/// becomes `diagnose`, not `SKILL`. Falls back to the stem if the parent
/// can't be sanitized into a valid name.
fn suggested_name_from_url(url: &str) -> Option<String> {
    if is_skill_md_url(url) {
        if let Some(parent) = parent_dir_name(url) {
            if let Some(cleaned) = sanitize_name(&parent) {
                return Some(cleaned);
            }
        }
    }
    let last = url.rsplit('/').next()?;
    let stem = last.rsplit_once('.').map(|(s, _)| s).unwrap_or(last);
    sanitize_name(stem)
}

fn sanitize_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(64)
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        None
    } else {
        Some(cleaned)
    }
}

fn parent_dir_name(url: &str) -> Option<String> {
    let mut segments = url.rsplit('/');
    let _filename = segments.next()?;
    let parent = segments.next()?;
    if parent.is_empty() {
        None
    } else {
        Some(parent.to_string())
    }
}

/// Predicate: does this URL's last path segment equal `SKILL.md` exactly?
/// Case-sensitive — Skills use uppercase `SKILL.md` by convention, and we
/// don't want to accidentally trigger folder-import on near-misses.
pub fn is_skill_md_url(url: &str) -> bool {
    url.rsplit('/').next() == Some("SKILL.md")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_blob_to_raw() {
        let url = "https://github.com/anthropic/skills/blob/main/skills/diagnose/SKILL.md";
        assert_eq!(
            normalize_url(url).unwrap(),
            "https://raw.githubusercontent.com/anthropic/skills/main/skills/diagnose/SKILL.md"
        );
    }

    #[test]
    fn passes_raw_through() {
        let url = "https://raw.githubusercontent.com/anthropic/skills/main/SKILL.md";
        assert_eq!(normalize_url(url).unwrap(), url);
    }

    #[test]
    fn rejects_gist() {
        let err = normalize_url("https://gist.github.com/foo/abc123").unwrap_err();
        assert!(matches!(err, Error::UnsupportedSourceUrl { .. }));
    }

    #[test]
    fn rejects_non_github_host() {
        let err = normalize_url("https://gitlab.com/x/y/raw/main/file.md").unwrap_err();
        assert!(matches!(err, Error::UnsupportedSourceUrl { .. }));
    }

    #[test]
    fn rejects_http() {
        let err = normalize_url("http://github.com/x/y/blob/main/file.md").unwrap_err();
        assert!(matches!(err, Error::UnsupportedSourceUrl { .. }));
    }

    #[test]
    fn rejects_blob_url_missing_segments() {
        let err = normalize_url("https://github.com/owner/repo/blob/main").unwrap_err();
        assert!(matches!(err, Error::UnsupportedSourceUrl { .. }));
    }

    #[test]
    fn rejects_github_tree_urls() {
        let err = normalize_url("https://github.com/owner/repo/tree/main/dir").unwrap_err();
        assert!(matches!(err, Error::UnsupportedSourceUrl { .. }));
    }

    #[test]
    fn suggested_name_strips_extension() {
        let n = suggested_name_from_url(
            "https://raw.githubusercontent.com/o/r/main/path/diagnose.md",
        );
        assert_eq!(n.as_deref(), Some("diagnose"));
    }

    #[test]
    fn suggested_name_keeps_allowed_punctuation() {
        let n = suggested_name_from_url(
            "https://raw.githubusercontent.com/o/r/main/my-skill_v2.md",
        );
        assert_eq!(n.as_deref(), Some("my-skill_v2"));
    }

    #[test]
    fn suggested_name_drops_disallowed_chars() {
        let n = suggested_name_from_url(
            "https://raw.githubusercontent.com/o/r/main/weird%20name@thing.md",
        );
        assert_eq!(n.as_deref(), Some("weird20namething"));
    }

    #[test]
    fn author_from_frontmatter_string() {
        let bytes = b"---\nauthor: Alice\n---\nbody\n";
        assert_eq!(author_from_md(bytes).as_deref(), Some("Alice"));
    }

    #[test]
    fn author_from_frontmatter_missing() {
        let bytes = b"---\nname: x\n---\nbody\n";
        assert_eq!(author_from_md(bytes), None);
    }

    #[test]
    fn author_from_md_handles_non_string() {
        // `author:` as a list — we only accept strings.
        let bytes = b"---\nauthor: [a, b]\n---\nbody\n";
        assert_eq!(author_from_md(bytes), None);
    }

    #[test]
    fn github_owner_from_blob_url() {
        let url = "https://raw.githubusercontent.com/anthropic/skills/main/x.md";
        assert_eq!(github_owner(url).as_deref(), Some("anthropic"));
    }

    #[test]
    fn is_skill_md_url_matches_exact_filename() {
        assert!(is_skill_md_url(
            "https://raw.githubusercontent.com/o/r/main/skills/diagnose/SKILL.md"
        ));
    }

    #[test]
    fn is_skill_md_url_is_case_sensitive() {
        let cases = [
            "https://raw.githubusercontent.com/o/r/main/skill.md",
            "https://raw.githubusercontent.com/o/r/main/Skill.md",
            "https://raw.githubusercontent.com/o/r/main/SKILL.MD",
        ];
        for url in cases {
            assert!(!is_skill_md_url(url), "expected false for {url}");
        }
    }

    #[test]
    fn is_skill_md_url_rejects_near_misses() {
        let cases = [
            "https://raw.githubusercontent.com/o/r/main/XSKILL.md",
            "https://raw.githubusercontent.com/o/r/main/SKILL.mdx",
            "https://raw.githubusercontent.com/o/r/main/SKILL.md.bak",
            "https://raw.githubusercontent.com/o/r/main/notes/SKILL_md",
        ];
        for url in cases {
            assert!(!is_skill_md_url(url), "expected false for {url}");
        }
    }

    #[test]
    fn suggested_name_uses_parent_dir_when_filename_is_skill_md() {
        let n = suggested_name_from_url(
            "https://raw.githubusercontent.com/anthropic/skills/main/skills/diagnose/SKILL.md",
        );
        assert_eq!(n.as_deref(), Some("diagnose"));
    }

    #[test]
    fn bundle_invalid_display_carries_reason() {
        let e = Error::BundleInvalid {
            reason: "Folder has 247 files; the limit is 200".to_string(),
        };
        assert_eq!(
            e.to_string(),
            "folder import bundle is invalid: Folder has 247 files; the limit is 200"
        );
    }

    #[test]
    fn github_rate_limited_has_actionable_message() {
        let e = Error::GitHubRateLimited;
        assert!(e.to_string().contains("GitHub"));
        assert!(e.to_string().contains("60"));
    }

    #[test]
    fn fetched_primitive_default_ref_files_is_empty() {
        let fp = FetchedPrimitive {
            content: "x".to_string(),
            suggested_name: String::new(),
            author: None,
            source_url: String::new(),
            ref_files: Vec::new(),
        };
        assert!(fp.ref_files.is_empty());
    }

    #[test]
    fn ref_file_holds_path_and_bytes() {
        let rf = RefFile {
            rel_path: "references/foo.md".to_string(),
            content: vec![1, 2, 3],
        };
        assert_eq!(rf.rel_path, "references/foo.md");
        assert_eq!(rf.content, vec![1, 2, 3]);
    }

    #[test]
    fn suggested_name_skill_md_with_unusable_parent_falls_back_to_stem() {
        // Parent dir name sanitizes to "." (rejected by sanitize_name);
        // we fall back to the SKILL stem rather than producing nothing.
        let n = suggested_name_from_url(
            "https://raw.githubusercontent.com/o/r/main/./SKILL.md",
        );
        assert_eq!(n.as_deref(), Some("SKILL"));
    }
}
