//! Integration tests for folder import via the Contents API.
//!
//! Each test stands up an httpmock server that impersonates
//! `api.github.com` (for the listing endpoint) and the per-file download
//! URLs returned in the listing. The test pokes
//! `prompt_library_core::url_import::walk_skill_folder` (re-exposed via a
//! tiny test-only re-export below) with the mock server's base URL.

use httpmock::prelude::*;
use prompt_library_core::test_only::{fetch_from_url_for_tests, walk_skill_folder_for_tests};
use prompt_library_core::Error;
use serde_json::json;

fn raw_url_for(server: &MockServer, dir: &str, filename: &str) -> String {
    // Production raw URLs live at raw.githubusercontent.com; the production
    // walk derives the API base separately, so the raw URL's host is
    // immaterial for the walk's behaviour. We point it at the mock server
    // for symmetry — what matters is the path shape `{owner}/{repo}/{ref}/{path}`.
    format!(
        "{}/owner/repo/main/{}/{}",
        server.base_url().replace("http://", "https://raw.githubusercontent.com/").replacen(
            "https://raw.githubusercontent.com/",
            "https://raw.githubusercontent.com/",
            1,
        ),
        dir,
        filename,
    )
}

/// Build a normalized raw URL pointing at `<dir>/SKILL.md`. The host is
/// `raw.githubusercontent.com` (what `parse_repo_slug` expects); the API
/// base passed to the walk is independently the httpmock server.
fn skill_md_url(dir: &str) -> String {
    let _ = dir;
    if dir.is_empty() {
        "https://raw.githubusercontent.com/owner/repo/main/SKILL.md".to_string()
    } else {
        format!("https://raw.githubusercontent.com/owner/repo/main/{dir}/SKILL.md")
    }
}

fn entry(entry_type: &str, path: &str, size: u64, download_url: Option<String>) -> serde_json::Value {
    json!({
        "type": entry_type,
        "path": path,
        "name": path.rsplit('/').next().unwrap_or(path),
        "size": size,
        "download_url": download_url,
    })
}

#[tokio::test]
async fn happy_path_pulls_skill_md_siblings_and_subdir_files() {
    let server = MockServer::start_async().await;
    let api_base = server.base_url();

    // Mock the directory listing for skills/diagnose.
    let download_grep = format!("{}/dl/grep.md", server.base_url());
    let download_repro = format!("{}/dl/repro.sh", server.base_url());
    let download_logo = format!("{}/dl/logo.bin", server.base_url());
    server.mock_async(|when, then| {
        when.method(GET)
            .path("/repos/owner/repo/contents/skills/diagnose")
            .query_param("ref", "main");
        then.status(200).header("content-type", "application/json").json_body(json!([
            entry("file", "skills/diagnose/SKILL.md", 123, Some(format!("{}/dl/SKILL.md", server.base_url()))),
            entry("file", "skills/diagnose/grep.md", 14, Some(download_grep.clone())),
            entry("dir", "skills/diagnose/scripts", 0, None),
            entry("dir", "skills/diagnose/assets", 0, None),
        ]));
    }).await;
    server.mock_async(|when, then| {
        when.method(GET)
            .path("/repos/owner/repo/contents/skills/diagnose/scripts")
            .query_param("ref", "main");
        then.status(200).json_body(json!([
            entry("file", "skills/diagnose/scripts/repro.sh", 9, Some(download_repro.clone())),
        ]));
    }).await;
    server.mock_async(|when, then| {
        when.method(GET)
            .path("/repos/owner/repo/contents/skills/diagnose/assets")
            .query_param("ref", "main");
        then.status(200).json_body(json!([
            entry("file", "skills/diagnose/assets/logo.bin", 3, Some(download_logo.clone())),
        ]));
    }).await;

    // Mock the file downloads.
    server.mock_async(|when, then| {
        when.method(GET).path("/dl/grep.md");
        then.status(200).body("# grep recipes");
    }).await;
    server.mock_async(|when, then| {
        when.method(GET).path("/dl/repro.sh");
        then.status(200).body("#!/bin/sh\n");
    }).await;
    server.mock_async(|when, then| {
        when.method(GET).path("/dl/logo.bin");
        then.status(200).body(vec![0xFFu8, 0xD8, 0xFF]);
    }).await;

    let client = reqwest::Client::new();
    let result = walk_skill_folder_for_tests(
        &client,
        &api_base,
        &skill_md_url("skills/diagnose"),
    )
    .await
    .expect("walk should succeed");

    let paths: Vec<&str> = result.iter().map(|r| r.rel_path.as_str()).collect();
    assert_eq!(paths, vec!["assets/logo.bin", "grep.md", "scripts/repro.sh"]);
    assert_eq!(result[0].content, vec![0xFFu8, 0xD8, 0xFF]);
    assert_eq!(result[1].content, b"# grep recipes");
    assert_eq!(result[2].content, b"#!/bin/sh\n");
}

#[tokio::test]
async fn folder_with_only_skill_md_returns_empty_ref_files() {
    let server = MockServer::start_async().await;
    server.mock_async(|when, then| {
        when.method(GET).path("/repos/owner/repo/contents/skills/diagnose");
        then.status(200).json_body(json!([
            entry(
                "file",
                "skills/diagnose/SKILL.md",
                42,
                Some(format!("{}/dl/SKILL.md", server.base_url())),
            ),
        ]));
    }).await;

    let client = reqwest::Client::new();
    let result = walk_skill_folder_for_tests(
        &client,
        &server.base_url(),
        &skill_md_url("skills/diagnose"),
    )
    .await
    .expect("walk should succeed");
    assert!(result.is_empty());
}

#[tokio::test]
async fn over_count_limit_errors_before_fetching_bytes() {
    let server = MockServer::start_async().await;

    // Build a listing of 201 files; downloads are not mocked so any byte
    // fetch would error and surface differently. We assert the count check
    // fires first (a `BundleInvalid` whose message names `200`).
    let mut listing = vec![entry(
        "file",
        "skills/diagnose/SKILL.md",
        1,
        Some(format!("{}/dl/SKILL.md", server.base_url())),
    )];
    for i in 0..201 {
        listing.push(entry(
            "file",
            &format!("skills/diagnose/f{i:03}.md"),
            1,
            Some(format!("{}/dl/{i}", server.base_url())),
        ));
    }
    server.mock_async(|when, then| {
        when.method(GET).path("/repos/owner/repo/contents/skills/diagnose");
        then.status(200).json_body(json!(listing));
    }).await;

    let client = reqwest::Client::new();
    let err = walk_skill_folder_for_tests(
        &client,
        &server.base_url(),
        &skill_md_url("skills/diagnose"),
    )
    .await
    .expect_err("should reject over-count bundle");
    match err {
        Error::BundleInvalid { reason } => {
            assert!(reason.contains("202"), "reason should name count: {reason}");
            assert!(reason.contains("200"), "reason should name limit: {reason}");
        }
        other => panic!("expected BundleInvalid, got {other:?}"),
    }
}

#[tokio::test]
async fn over_size_limit_errors_before_fetching_bytes() {
    let server = MockServer::start_async().await;
    // 5 MiB file → exceeds 4 MiB total cap. Listing-stage rejection.
    let big_size: u64 = 5 * 1024 * 1024;
    server.mock_async(|when, then| {
        when.method(GET).path("/repos/owner/repo/contents/skills/diagnose");
        then.status(200).json_body(json!([
            entry("file", "skills/diagnose/SKILL.md", 1, Some(format!("{}/dl/SKILL.md", server.base_url()))),
            entry("file", "skills/diagnose/big.bin", big_size, Some(format!("{}/dl/big.bin", server.base_url()))),
        ]));
    }).await;

    let client = reqwest::Client::new();
    let err = walk_skill_folder_for_tests(
        &client,
        &server.base_url(),
        &skill_md_url("skills/diagnose"),
    )
    .await
    .expect_err("should reject over-size bundle");
    match err {
        Error::BundleInvalid { reason } => {
            assert!(reason.contains("bytes"), "reason should reference bytes: {reason}");
        }
        other => panic!("expected BundleInvalid, got {other:?}"),
    }
}

#[tokio::test]
async fn rate_limit_response_returns_dedicated_error() {
    let server = MockServer::start_async().await;
    server.mock_async(|when, then| {
        when.method(GET).path("/repos/owner/repo/contents/skills/diagnose");
        then.status(403)
            .header("X-RateLimit-Remaining", "0")
            .body("{}");
    }).await;

    let client = reqwest::Client::new();
    let err = walk_skill_folder_for_tests(
        &client,
        &server.base_url(),
        &skill_md_url("skills/diagnose"),
    )
    .await
    .expect_err("should map 403/remaining=0 to GitHubRateLimited");
    assert!(matches!(err, Error::GitHubRateLimited));
}

#[tokio::test]
async fn ignored_leaves_are_dropped_from_listing() {
    let server = MockServer::start_async().await;
    // .DS_Store should be dropped silently — `is_ignored` covers it.
    let download_grep = format!("{}/dl/grep.md", server.base_url());
    server.mock_async(|when, then| {
        when.method(GET).path("/repos/owner/repo/contents/skills/diagnose");
        then.status(200).json_body(json!([
            entry("file", "skills/diagnose/SKILL.md", 1, Some(format!("{}/dl/SKILL.md", server.base_url()))),
            entry("file", "skills/diagnose/grep.md", 14, Some(download_grep.clone())),
            entry("file", "skills/diagnose/.DS_Store", 6148, Some(format!("{}/dl/dsstore", server.base_url()))),
        ]));
    }).await;
    server.mock_async(|when, then| {
        when.method(GET).path("/dl/grep.md");
        then.status(200).body("# grep recipes");
    }).await;

    let client = reqwest::Client::new();
    let result = walk_skill_folder_for_tests(
        &client,
        &server.base_url(),
        &skill_md_url("skills/diagnose"),
    )
    .await
    .expect("walk should succeed");
    let paths: Vec<&str> = result.iter().map(|r| r.rel_path.as_str()).collect();
    assert_eq!(paths, vec!["grep.md"], "DS_Store should be dropped");
}

#[tokio::test]
async fn per_file_byte_overflow_surfaces_as_bundle_invalid() {
    // Listing claims a small size, but the download serves 1 MiB+1 bytes.
    // The per-file MAX_BYTES check at download time should fire.
    let server = MockServer::start_async().await;
    let huge_url = format!("{}/dl/huge.bin", server.base_url());
    server.mock_async(|when, then| {
        when.method(GET).path("/repos/owner/repo/contents/skills/diagnose");
        then.status(200).json_body(json!([
            entry("file", "skills/diagnose/SKILL.md", 1, Some(format!("{}/dl/SKILL.md", server.base_url()))),
            entry("file", "skills/diagnose/huge.bin", 10, Some(huge_url.clone())),
        ]));
    }).await;
    server.mock_async(|when, then| {
        when.method(GET).path("/dl/huge.bin");
        then.status(200).body(vec![0u8; (1 << 20) + 1]);
    }).await;

    let client = reqwest::Client::new();
    let err = walk_skill_folder_for_tests(
        &client,
        &server.base_url(),
        &skill_md_url("skills/diagnose"),
    )
    .await
    .expect_err("over-cap download should error");
    assert!(matches!(err, Error::BundleInvalid { .. }));
}

#[tokio::test]
async fn used_helpers_keep_unused_warnings_off() {
    // No-op test that touches the unused helper from this file so cargo
    // doesn't whine about it during single-test runs. (Not in production
    // shape; just stops a friction warning during dev.)
    let _ = raw_url_for;
}

// End-to-end fetch_from_url integration is awkward to mock because
// `normalize_url` only accepts `raw.githubusercontent.com` and `github.com`
// hosts. Splitting the raw-fetch host out into its own injectable seam is
// out of Phase 0's scope. The wiring inside `fetch_from_url` is a
// single-line gate (`if is_skill_md_url(&normalized) { walk_skill_folder(...).await? }`);
// the walk itself is covered by the cases above, and the classifier is
// covered by url_import's unit tests. Leaving `fetch_from_url_for_tests`
// reachable here preserves the seam for a future test that mocks both
// hosts.
#[tokio::test]
async fn fetch_from_url_for_tests_seam_is_reachable() {
    let _ = fetch_from_url_for_tests;
}
