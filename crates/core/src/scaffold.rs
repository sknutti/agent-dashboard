use camino::Utf8PathBuf;

use crate::fs_helpers::atomic_write;
use crate::{Error, LibraryLayout, PrimitiveKind, PrimitiveMetadata, PrimitiveName};

/// Optional content + attribution to seed a fresh primitive with — used by
/// the "import from URL" flow so the new primitive starts populated rather
/// than empty.
pub struct ScaffoldSource<'a> {
    /// Bytes written to the primary file in place of the default empty
    /// content.
    pub content: &'a [u8],
    /// URL the bytes were fetched from. Persisted to `metadata.yaml` so the
    /// origin survives across versions.
    pub source_url: &'a str,
    /// Optional author attribution, derived from frontmatter or the
    /// repo owner depending on the URL.
    pub author: Option<&'a str>,
    /// Supporting files for Skill folder imports — written into
    /// `working/base/<rel_path>` verbatim. Empty for single-file imports.
    /// Bytes are arbitrary (not UTF-8-validated), matching the disk-import
    /// path's tolerance for binaries.
    pub ref_files: &'a [(Utf8PathBuf, Vec<u8>)],
}

/// Skeleton for a brand-new Skill primitive.
///
/// Thin wrapper over `scaffold_primitive` for backward compatibility — new
/// code should call `scaffold_primitive(layout, kind, ...)` directly.
pub fn scaffold_skill(
    layout: LibraryLayout<'_>,
    name: &PrimitiveName,
    now_rfc3339: &str,
) -> Result<(), Error> {
    scaffold_primitive(layout, PrimitiveKind::Skill, name, now_rfc3339, None)
}

/// Write each `(rel, bytes)` pair into `working/base/<rel>`, creating
/// parent directories as needed. The caller is responsible for having
/// validated each `rel` against `working_files::validate_ref_path` before
/// reaching here — this function performs no path validation of its own.
fn write_ref_files(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
    ref_files: &[(Utf8PathBuf, Vec<u8>)],
) -> Result<(), Error> {
    let base = layout.working_base(kind, name);
    for (rel, bytes) in ref_files {
        let dest = base.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent.as_std_path()).map_err(|source| Error::Io {
                path: parent.to_string(),
                source,
            })?;
        }
        atomic_write(&dest, bytes)?;
    }
    Ok(())
}

/// Skeleton for a brand-new primitive of any kind.
///
/// Writes `metadata.yaml` and the primary file inside `working/base/`. If
/// `source` is `None`, the primary file gets kind-appropriate empty content
/// (MD kinds get `---\n---\n`; CodexAgent gets `""`) and metadata starts
/// empty. If `source` is `Some(_)`, the primary file gets `source.content`
/// verbatim and `metadata.source_url` + `metadata.author` capture the
/// import provenance. Errors if the primitive directory already exists.
pub fn scaffold_primitive(
    layout: LibraryLayout<'_>,
    kind: PrimitiveKind,
    name: &PrimitiveName,
    now_rfc3339: &str,
    source: Option<ScaffoldSource<'_>>,
) -> Result<(), Error> {
    let dir = layout.primitive_dir(kind, name);
    if dir.exists() {
        return Err(Error::PrimitiveAlreadyExists {
            kind,
            name: name.as_str().to_string(),
        });
    }

    let metadata = PrimitiveMetadata {
        allowed_targets: vec![],
        created_at: now_rfc3339.to_string(),
        display_name: None,
        author: source.as_ref().and_then(|s| s.author.map(|a| a.to_string())),
        source_url: source.as_ref().map(|s| s.source_url.to_string()),
    };
    let yaml = metadata.to_yaml()?;
    atomic_write(&layout.primitive_metadata(kind, name), yaml.as_bytes())?;

    let primary = layout
        .working_base(kind, name)
        .join(kind.primary_filename(name));
    let initial: &[u8] = match &source {
        Some(s) => s.content,
        None if kind.is_md_kind() => b"---\n---\n",
        None => b"",
    };
    atomic_write(&primary, initial)?;

    if let Some(s) = source.as_ref() {
        write_ref_files(layout, kind, name, s.ref_files)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use camino::Utf8PathBuf;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Utf8PathBuf, PrimitiveName) {
        let tmp = TempDir::new().unwrap();
        let root = Utf8PathBuf::from_path_buf(tmp.path().to_path_buf()).unwrap();
        let name = PrimitiveName::try_new("diagnose").unwrap();
        (tmp, root, name)
    }

    #[test]
    fn scaffold_creates_metadata_and_skill_md() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        assert!(root.join("skills/diagnose/metadata.yaml").exists());
        assert!(root.join("skills/diagnose/working/base/SKILL.md").exists());
    }

    #[test]
    fn scaffold_errors_if_primitive_dir_already_exists() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        let err = scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap_err();
        assert!(
            matches!(
                err,
                Error::PrimitiveAlreadyExists { kind: PrimitiveKind::Skill, ref name }
                    if name == "diagnose"
            ),
            "expected PrimitiveAlreadyExists, got: {err:?}"
        );
    }

    #[test]
    fn metadata_yaml_has_empty_allowed_targets_and_omits_display_name() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_skill(layout, &name, "2026-05-04T12:34:56Z").unwrap();
        let yaml = std::fs::read_to_string(root.join("skills/diagnose/metadata.yaml")).unwrap();
        let parsed = PrimitiveMetadata::from_yaml(&yaml).unwrap();
        assert_eq!(parsed.allowed_targets, Vec::new());
        assert_eq!(parsed.created_at, "2026-05-04T12:34:56Z");
        assert_eq!(parsed.display_name, None);
        assert!(!yaml.contains("display_name"), "None should be omitted");
    }

    #[test]
    fn skill_md_has_empty_frontmatter_and_body() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_skill(layout, &name, "2026-05-04T00:00:00Z").unwrap();
        let body = std::fs::read(root.join("skills/diagnose/working/base/SKILL.md")).unwrap();
        assert_eq!(body, b"---\n---\n");
    }

    #[test]
    fn scaffold_agent_writes_lowercase_agent_md() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_primitive(layout, PrimitiveKind::Agent, &name, "2026-05-04T00:00:00Z", None)
            .unwrap();
        let path = root.join("agents/diagnose/working/base/agent.md");
        assert!(path.exists(), "expected {} to exist", path);
        assert_eq!(std::fs::read(path).unwrap(), b"---\n---\n");
    }

    #[test]
    fn scaffold_command_writes_named_md_file() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_primitive(layout, PrimitiveKind::Command, &name, "2026-05-04T00:00:00Z", None)
            .unwrap();
        let path = root.join("commands/diagnose/working/base/diagnose.md");
        assert!(path.exists(), "expected {} to exist", path);
        assert_eq!(std::fs::read(path).unwrap(), b"---\n---\n");
    }

    #[test]
    fn scaffold_codex_agent_writes_named_toml_file_with_empty_content() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_primitive(
            layout,
            PrimitiveKind::CodexAgent,
            &name,
            "2026-05-04T00:00:00Z",
            None,
        )
        .unwrap();
        let path = root.join("codex_agents/diagnose/working/base/diagnose.toml");
        assert!(path.exists(), "expected {} to exist", path);
        assert_eq!(std::fs::read(path).unwrap(), b"");
    }

    #[test]
    fn scaffold_writes_ref_files_alongside_primary() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        let source = ScaffoldSource {
            content: b"---\n---\nbody\n",
            source_url: "https://raw.githubusercontent.com/o/r/main/skills/diagnose/SKILL.md",
            author: Some("anthropic"),
            ref_files: &[
                (Utf8PathBuf::from("references/grep.md"), b"# grep recipes\n".to_vec()),
                (Utf8PathBuf::from("scripts/repro.sh"), b"#!/bin/sh\n".to_vec()),
                (Utf8PathBuf::from("assets/logo.bin"), vec![0xFFu8, 0xD8, 0xFF]),
            ],
        };
        scaffold_primitive(
            layout,
            PrimitiveKind::Skill,
            &name,
            "2026-05-04T00:00:00Z",
            Some(source),
        )
        .unwrap();

        let base = root.join("skills/diagnose/working/base");
        assert_eq!(std::fs::read(base.join("SKILL.md")).unwrap(), b"---\n---\nbody\n");
        assert_eq!(
            std::fs::read(base.join("references/grep.md")).unwrap(),
            b"# grep recipes\n"
        );
        assert_eq!(
            std::fs::read(base.join("scripts/repro.sh")).unwrap(),
            b"#!/bin/sh\n"
        );
        assert_eq!(
            std::fs::read(base.join("assets/logo.bin")).unwrap(),
            vec![0xFFu8, 0xD8, 0xFF]
        );
    }

    #[test]
    fn scaffold_with_no_ref_files_writes_only_primary() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        let source = ScaffoldSource {
            content: b"---\n---\nbody\n",
            source_url: "https://raw.githubusercontent.com/o/r/main/SKILL.md",
            author: None,
            ref_files: &[],
        };
        scaffold_primitive(
            layout,
            PrimitiveKind::Skill,
            &name,
            "2026-05-04T00:00:00Z",
            Some(source),
        )
        .unwrap();
        let base = root.join("skills/diagnose/working/base");
        assert!(base.join("SKILL.md").exists());
        let entries: Vec<_> = std::fs::read_dir(base.as_std_path())
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(entries.len(), 1, "only the primary file should exist");
    }

    #[test]
    fn scaffold_primitive_errors_if_dir_exists_for_any_kind() {
        let (_tmp, root, name) = setup();
        let layout = LibraryLayout::new(&root);
        scaffold_primitive(layout, PrimitiveKind::Agent, &name, "2026-05-04T00:00:00Z", None)
            .unwrap();
        let err =
            scaffold_primitive(layout, PrimitiveKind::Agent, &name, "2026-05-04T00:00:00Z", None)
                .unwrap_err();
        assert!(
            matches!(
                err,
                Error::PrimitiveAlreadyExists { kind: PrimitiveKind::Agent, ref name }
                    if name == "diagnose"
            ),
            "expected PrimitiveAlreadyExists for Agent, got: {err:?}"
        );
    }
}
