//! Phase 0 security spike (Slice 8 — git remote sync).
//!
//! Answers the one blocking unknown the slice plan flagged as a
//! STOP-and-ask-Scott checkpoint: under the dashboard's
//! process-per-request bridge, can a *fresh* process of the same
//! unchanged binary read the PAT from the login keychain WITHOUT
//! re-prompting, after a single "Always Allow"?
//!
//! `keychain.rs` documents that the consent prompt is bound to the
//! binary hash (re-prompts after `cargo build`, not per-process), but
//! that claim is untested and load-bearing for the one-shot bridge.
//! This probe verifies it by hand — Claude can't grant keychain
//! consent or observe the prompt.
//!
//! ## How to run (Scott)
//!
//! Build ONCE so the binary hash is stable, then run the staged
//! invocations as SEPARATE processes against that one build:
//!
//! ```sh
//! cargo build --example keychain_probe -p prompt-library-secrets
//! BIN=target/debug/examples/keychain_probe
//!
//! $BIN set      # writes a fixture PAT — click "Always Allow" once
//! $BIN get      # fresh process: should read it back, NO new prompt
//! $BIN get      # run a few more times — confirm none re-prompt
//! $BIN get
//! $BIN delete   # cleanup — removes the fixture PAT
//! ```
//!
//! ## What to report back
//!
//! - Did `set` prompt? (expected: yes, once.)
//! - Did the FIRST `get` prompt, or read silently? (the key question.)
//! - Did REPEATED `get`s ever re-prompt? (expected: no — if yes, D2
//!   needs rework: the one-shot bridge can't use the keychain cleanly.)
//! - Re-run `cargo build --example keychain_probe ...` then `$BIN get`
//!   — does the rebuild re-prompt? (expected: yes, per the doc.)
//!
//! The fixture token below is FAKE and never touches the network.

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("keychain_probe is macOS-only (KeychainStore is cfg(target_os = \"macos\")).");
    std::process::exit(2);
}

#[cfg(target_os = "macos")]
fn main() {
    use prompt_library_secrets::{redact_pat, KeychainStore, SecretStore};

    // A clearly-fake fixture. Never a real credential; never sent anywhere.
    const FIXTURE_PAT: &str = "ghp_PHASE0PROBE000000000000000000000000";

    let stage = std::env::args().nth(1).unwrap_or_default();
    let store = KeychainStore::new();

    match stage.as_str() {
        "set" => match store.set_pat(FIXTURE_PAT) {
            Ok(()) => {
                println!("[set] wrote fixture PAT ({})", redact_pat(FIXTURE_PAT));
                println!("[set] if macOS prompted, you clicked \"Always Allow\" — good.");
            }
            Err(e) => {
                eprintln!("[set] FAILED: {e}");
                std::process::exit(1);
            }
        },
        "get" => match store.get_pat() {
            Ok(Some(pat)) => {
                let ok = pat == FIXTURE_PAT;
                println!("[get] read PAT ({}) — matches fixture: {ok}", redact_pat(&pat));
                println!("[get] >>> Did macOS RE-PROMPT for keychain access just now? <<<");
                println!("[get]     expected: NO (silent read after the one Always Allow).");
            }
            Ok(None) => {
                eprintln!("[get] no PAT stored — run `set` first.");
                std::process::exit(1);
            }
            Err(e) => {
                eprintln!("[get] FAILED: {e}");
                std::process::exit(1);
            }
        },
        "delete" => match store.delete_pat() {
            Ok(()) => println!("[delete] fixture PAT removed (idempotent)."),
            Err(e) => {
                eprintln!("[delete] FAILED: {e}");
                std::process::exit(1);
            }
        },
        other => {
            eprintln!("unknown stage {other:?}; expected one of: set | get | delete");
            eprintln!("see the module doc comment for the full run sequence.");
            std::process::exit(2);
        }
    }
}
