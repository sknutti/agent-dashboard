# Bridge fixtures

Committed, **real** stdout from `prompt-library-bridge` run against a freshly
seeded fixture Library. The dashboard's TypeScript tests
(`scripts/library_bridge.test.ts`) parse these — they never spawn Rust — so the
typed read models in `scripts/library_models.ts` are validated against genuine
serde output, not the UI prototype's imagined shapes (plan C2/M2).

## Regenerate

```bash
bun run scripts/fixtures/bridge/capture.ts
```

That builds the release bridge, seeds a deterministic Library via the
`seed_fixture_library` example (pinned timestamp → byte-stable), runs each read
command, and rewrites the `*.json` here. Absolute temp paths in error `detail`
are normalized to `<LIBRARY_PATH>`.

## Drift guard

`crates/prompt-library-bridge/src/main.rs` has golden tests asserting the live
`kind_info` / `target_info` output still equals `kind_info.json` /
`target_info.json`. A core serde rename therefore fails `cargo test`, pointing
back here — instead of silently desyncing these frozen fixtures from reality.

## Files

| Fixture | Command | Notes |
|---|---|---|
| `kind_info.json` | `kind_info` | per-Kind capability table; `primary_filename` is a tagged union |
| `target_info.json` | `target_info` | library Targets only (claude/pi/codex) |
| `list_primitives.json` | `list_primitives` | all 4 Kinds; one author-bearing, rest null |
| `primitive_detail_skill.json` | `primitive_detail` | md-tagged `working` |
| `primitive_detail_codex_agent.json` | `primitive_detail` | toml-tagged `working` |
| `library_status_valid.json` | `library_status` | valid marker, non-git fixture dir |
| `error_marker_missing.json` | `list_primitives` | application error envelope (`ok:false`) |
