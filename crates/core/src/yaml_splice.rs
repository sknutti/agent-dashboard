//! Byte-range YAML splicing for known-safe edits.
//!
//! Parses the source with `marked-yaml` to capture spans, then performs
//! byte-range swaps so unrelated formatting (comments, blank lines, key
//! ordering, quoting style) is preserved verbatim.
//!
//! Supported operations:
//! - [`set_scalar`] — swap a scalar value at a known top-level key.
//! - [`seq_add_string`] — append a string item to a top-level sequence
//!   (flow `[a, b]` or block `- a\n- b` style).
//! - [`seq_remove_string`] — remove a string item from a top-level sequence.
//!
//! Anything outside that scope (adding new keys, removing keys, multi-line
//! block scalars, type changes) returns `SpliceError::Unsupported` so the
//! caller can fall back to a full re-emit.

use marked_yaml::parse_yaml;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SpliceError {
    #[error("YAML parse error: {0}")]
    Parse(String),
    #[error("key `{0}` not found at the top-level mapping")]
    KeyNotFound(String),
    #[error("item not present in sequence")]
    ItemNotFound,
    #[error("splice not supported: {0}")]
    Unsupported(&'static str),
}

/// Replace the scalar value of a top-level key, preserving the rest of the
/// document byte-exact.
///
/// Bails (`Unsupported`) on block scalars (`|`, `>`) or any value that spans
/// multiple lines. The replacement is always emitted as a double-quoted
/// scalar — the old quoting style is overwritten on purpose so escapes are
/// always handled correctly.
pub fn set_scalar(src: &str, key: &str, new_value: &str) -> Result<String, SpliceError> {
    let node = parse_yaml(0, src).map_err(|e| SpliceError::Parse(e.to_string()))?;
    let map = node
        .as_mapping()
        .ok_or(SpliceError::Unsupported("top-level node is not a mapping"))?;
    let value = map
        .get(key)
        .ok_or_else(|| SpliceError::KeyNotFound(key.into()))?;
    let scalar = value
        .as_scalar()
        .ok_or(SpliceError::Unsupported("value is not a scalar"))?;
    let start = span_start(scalar.span())?;

    let prefix = preceding_separator(src, key, start)?;
    if prefix.contains('\n') || starts_with_block_indicator(prefix) {
        return Err(SpliceError::Unsupported(
            "block scalar / multi-line value — falling back to re-emit",
        ));
    }

    let end = scan_scalar_end(src.as_bytes(), start)?;
    let mut out = String::with_capacity(src.len() + new_value.len());
    out.push_str(&src[..start]);
    out.push_str(&yaml_double_quote(new_value));
    out.push_str(&src[end..]);
    Ok(out)
}

/// Add a string item to a top-level sequence keyed by `key`. Detects flow
/// (`[a, b]`) vs block (`- a`) style from the source bytes and matches the
/// document's existing convention.
pub fn seq_add_string(src: &str, key: &str, item: &str) -> Result<String, SpliceError> {
    let node = parse_yaml(0, src).map_err(|e| SpliceError::Parse(e.to_string()))?;
    let map = node
        .as_mapping()
        .ok_or(SpliceError::Unsupported("top-level node is not a mapping"))?;
    let value = map
        .get(key)
        .ok_or_else(|| SpliceError::KeyNotFound(key.into()))?;
    let seq = value
        .as_sequence()
        .ok_or(SpliceError::Unsupported("value is not a sequence"))?;

    let seq_start = span_start(seq.span())?;
    let bytes = src.as_bytes();
    let style = detect_seq_style(bytes, key, seq_start)?;

    match style {
        SeqStyle::Flow => splice_flow_add(src, seq_start, seq.len(), item),
        SeqStyle::Block => {
            // Use the indentation of the first existing item; if empty,
            // bail (block-empty is rare and ambiguous).
            if seq.is_empty() {
                return Err(SpliceError::Unsupported("cannot add to empty block sequence"));
            }
            let first_item_start = span_start(seq.iter().next().unwrap().span())?;
            splice_block_add(src, seq, first_item_start, item)
        }
    }
}

/// Remove a string item matching `item` from a top-level sequence. Errors
/// with `ItemNotFound` if no item matches.
pub fn seq_remove_string(src: &str, key: &str, item: &str) -> Result<String, SpliceError> {
    let node = parse_yaml(0, src).map_err(|e| SpliceError::Parse(e.to_string()))?;
    let map = node
        .as_mapping()
        .ok_or(SpliceError::Unsupported("top-level node is not a mapping"))?;
    let value = map
        .get(key)
        .ok_or_else(|| SpliceError::KeyNotFound(key.into()))?;
    let seq = value
        .as_sequence()
        .ok_or(SpliceError::Unsupported("value is not a sequence"))?;

    let mut idx = None;
    for (i, n) in seq.iter().enumerate() {
        if n.as_scalar().map(|s| s.as_str()) == Some(item) {
            idx = Some(i);
            break;
        }
    }
    let idx = idx.ok_or(SpliceError::ItemNotFound)?;

    let seq_start = span_start(seq.span())?;
    let bytes = src.as_bytes();
    let style = detect_seq_style(bytes, key, seq_start)?;

    match style {
        SeqStyle::Flow => splice_flow_remove(src, seq, idx),
        SeqStyle::Block => splice_block_remove(src, seq, idx),
    }
}

// --- helpers --------------------------------------------------------------

fn span_start(span: &marked_yaml::Span) -> Result<usize, SpliceError> {
    span.start()
        .map(|m| m.character())
        .ok_or(SpliceError::Unsupported("missing span start marker"))
}

/// Slice between the key's start and the value's start. Used to detect block
/// scalar indicators (`|`, `>`) and multi-line plain scalars.
fn preceding_separator<'a>(
    src: &'a str,
    key: &str,
    value_start: usize,
) -> Result<&'a str, SpliceError> {
    // Find the key text just before its colon. We don't have a reliable end
    // marker for scalar keys, so scan forward from a `:` heuristic.
    let key_pos = src.find(key).ok_or(SpliceError::Unsupported(
        "key text not present (escaped key?)",
    ))?;
    let after_key = key_pos + key.len();
    if value_start < after_key {
        return Err(SpliceError::Unsupported("value precedes key span"));
    }
    Ok(&src[after_key..value_start])
}

fn starts_with_block_indicator(sep: &str) -> bool {
    let trimmed = sep.trim_start_matches([':', ' ', '\t']);
    matches!(trimmed.chars().next(), Some('|') | Some('>'))
}

fn scan_scalar_end(bytes: &[u8], start: usize) -> Result<usize, SpliceError> {
    let first = *bytes
        .get(start)
        .ok_or(SpliceError::Unsupported("scalar start past EOF"))?;
    let end = match first {
        b'"' => scan_double_quoted_end(bytes, start)?,
        b'\'' => scan_single_quoted_end(bytes, start)?,
        _ => scan_plain_end(bytes, start),
    };
    Ok(end)
}

/// Flow-context item end: stops at the first unquoted `,`, `]`, `}`, or `\n`.
/// Quoted scalars are skipped over so commas inside strings don't confuse it.
fn scan_flow_item_end(bytes: &[u8], start: usize) -> Result<usize, SpliceError> {
    let first = *bytes
        .get(start)
        .ok_or(SpliceError::Unsupported("scalar start past EOF"))?;
    let mut end = match first {
        b'"' => scan_double_quoted_end(bytes, start)?,
        b'\'' => scan_single_quoted_end(bytes, start)?,
        _ => {
            let mut i = start;
            while i < bytes.len() {
                match bytes[i] {
                    b',' | b']' | b'}' | b'\n' => break,
                    _ => i += 1,
                }
            }
            i
        }
    };
    while end > start && matches!(bytes[end - 1], b' ' | b'\t') {
        end -= 1;
    }
    Ok(end)
}

fn scan_plain_end(bytes: &[u8], start: usize) -> usize {
    let mut i = start;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\n' {
            break;
        }
        // strip trailing ` #comment` (whitespace + #) — we don't want to clobber it.
        if b == b'#' && i > start && (bytes[i - 1] == b' ' || bytes[i - 1] == b'\t') {
            break;
        }
        i += 1;
    }
    // Trim trailing whitespace from value end (stay before any comment / newline).
    while i > start && matches!(bytes[i - 1], b' ' | b'\t') {
        i -= 1;
    }
    i
}

fn scan_double_quoted_end(bytes: &[u8], start: usize) -> Result<usize, SpliceError> {
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return Ok(i + 1),
            b'\n' => {
                return Err(SpliceError::Unsupported(
                    "multi-line double-quoted scalar",
                ))
            }
            _ => i += 1,
        }
    }
    Err(SpliceError::Unsupported("unterminated double-quoted scalar"))
}

fn scan_single_quoted_end(bytes: &[u8], start: usize) -> Result<usize, SpliceError> {
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' if bytes.get(i + 1) == Some(&b'\'') => i += 2,
            b'\'' => return Ok(i + 1),
            b'\n' => {
                return Err(SpliceError::Unsupported(
                    "multi-line single-quoted scalar",
                ))
            }
            _ => i += 1,
        }
    }
    Err(SpliceError::Unsupported("unterminated single-quoted scalar"))
}

/// Always emit values as YAML double-quoted strings — covers every input
/// safely (no need to detect when plain would have worked).
fn yaml_double_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                use std::fmt::Write;
                let _ = write!(out, "\\x{:02x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
enum SeqStyle {
    Flow,
    Block,
}

fn detect_seq_style(
    bytes: &[u8],
    key: &str,
    seq_start: usize,
) -> Result<SeqStyle, SpliceError> {
    // Walk from `key` end forward to seq_start to look for a flow-open `[`.
    let key_pos = std::str::from_utf8(bytes)
        .ok()
        .and_then(|s| s.find(key))
        .ok_or(SpliceError::Unsupported("key text not present"))?;
    let scan_start = key_pos + key.len();
    for &b in &bytes[scan_start..seq_start.min(bytes.len())] {
        match b {
            b'[' => return Ok(SeqStyle::Flow),
            b'-' => return Ok(SeqStyle::Block),
            _ => continue,
        }
    }
    // seq_start itself: marked-yaml's flow-seq value_span starts AT `[`,
    // and block-seq value_span starts AT `-` (or at item start).
    match bytes.get(seq_start) {
        Some(b'[') => Ok(SeqStyle::Flow),
        Some(b'-') => Ok(SeqStyle::Block),
        // Item-start (block) — span pointed at the first scalar item.
        _ => Ok(SeqStyle::Block),
    }
}

fn splice_flow_add(
    src: &str,
    seq_start: usize,
    existing_len: usize,
    item: &str,
) -> Result<String, SpliceError> {
    let bytes = src.as_bytes();
    let close = find_flow_close(bytes, seq_start)?;
    let formatted = yaml_double_quote(item);
    let mut out = String::with_capacity(src.len() + formatted.len() + 2);
    out.push_str(&src[..close]);
    if existing_len == 0 {
        out.push_str(&formatted);
    } else {
        out.push_str(", ");
        out.push_str(&formatted);
    }
    out.push_str(&src[close..]);
    Ok(out)
}

fn find_flow_close(bytes: &[u8], seq_start: usize) -> Result<usize, SpliceError> {
    let mut depth = 0i32;
    let mut i = seq_start;
    while i < bytes.len() {
        match bytes[i] {
            b'[' => depth += 1,
            b']' if depth == 1 => return Ok(i),
            b']' => depth -= 1,
            b'"' => i = scan_double_quoted_end(bytes, i)?.saturating_sub(1),
            b'\'' => i = scan_single_quoted_end(bytes, i)?.saturating_sub(1),
            _ => {}
        }
        i += 1;
    }
    Err(SpliceError::Unsupported("unterminated flow sequence"))
}

fn splice_flow_remove(
    src: &str,
    seq: &marked_yaml::types::MarkedSequenceNode,
    idx: usize,
) -> Result<String, SpliceError> {
    let item_node = seq.get(idx).unwrap();
    let item_start = span_start(item_node.span())?;
    let bytes = src.as_bytes();
    let item_end = scan_flow_item_end(bytes, item_start)?;

    // Decide which separator to absorb:
    //  - if not last: remove the trailing `, `
    //  - if last + not first: remove the leading `, `
    //  - if only item: remove just the item, leaving `[]`
    let (cut_start, cut_end) = if idx + 1 < seq.len() {
        // Absorb trailing ", " (or "," + whitespace)
        let mut j = item_end;
        while j < bytes.len() && matches!(bytes[j], b' ' | b'\t') {
            j += 1;
        }
        if bytes.get(j) == Some(&b',') {
            j += 1;
            while j < bytes.len() && matches!(bytes[j], b' ' | b'\t') {
                j += 1;
            }
        }
        (item_start, j)
    } else if idx > 0 {
        // Absorb leading ", "
        let mut j = item_start;
        while j > 0 && matches!(bytes[j - 1], b' ' | b'\t') {
            j -= 1;
        }
        if j > 0 && bytes[j - 1] == b',' {
            j -= 1;
            while j > 0 && matches!(bytes[j - 1], b' ' | b'\t') {
                j -= 1;
            }
        }
        (j, item_end)
    } else {
        (item_start, item_end)
    };

    let mut out = String::with_capacity(src.len());
    out.push_str(&src[..cut_start]);
    out.push_str(&src[cut_end..]);
    Ok(out)
}

fn splice_block_add(
    src: &str,
    seq: &marked_yaml::types::MarkedSequenceNode,
    first_item_start: usize,
    item: &str,
) -> Result<String, SpliceError> {
    let bytes = src.as_bytes();
    // Indentation of the first item's line: walk back from first_item_start
    // to the start of its line, then forward through whitespace to the `-`.
    let line_start = bytes[..first_item_start]
        .iter()
        .rposition(|&b| b == b'\n')
        .map(|p| p + 1)
        .unwrap_or(0);
    let mut dash = line_start;
    while dash < bytes.len() && matches!(bytes[dash], b' ' | b'\t') {
        dash += 1;
    }
    if bytes.get(dash) != Some(&b'-') {
        return Err(SpliceError::Unsupported(
            "first block-sequence item does not begin with a dash",
        ));
    }
    let indent = &src[line_start..dash];

    // Locate end of last item's line (newline after it).
    let last_item_node = seq.iter().last().unwrap();
    let last_item_start = span_start(last_item_node.span())?;
    let last_end = scan_scalar_end(bytes, last_item_start)?;
    let line_end = bytes[last_end..]
        .iter()
        .position(|&b| b == b'\n')
        .map(|p| last_end + p)
        .unwrap_or(bytes.len());

    let formatted = yaml_double_quote(item);
    let mut insert = String::with_capacity(formatted.len() + indent.len() + 4);
    insert.push('\n');
    insert.push_str(indent);
    insert.push_str("- ");
    insert.push_str(&formatted);

    let mut out = String::with_capacity(src.len() + insert.len());
    out.push_str(&src[..line_end]);
    out.push_str(&insert);
    out.push_str(&src[line_end..]);
    Ok(out)
}

fn splice_block_remove(
    src: &str,
    seq: &marked_yaml::types::MarkedSequenceNode,
    idx: usize,
) -> Result<String, SpliceError> {
    let item_node = seq.get(idx).unwrap();
    let item_start = span_start(item_node.span())?;
    let bytes = src.as_bytes();
    let line_start = bytes[..item_start]
        .iter()
        .rposition(|&b| b == b'\n')
        .map(|p| p + 1)
        .unwrap_or(0);
    let item_end = scan_scalar_end(bytes, item_start)?;
    let after_newline = bytes[item_end..]
        .iter()
        .position(|&b| b == b'\n')
        .map(|p| item_end + p + 1)
        .unwrap_or(bytes.len());

    let mut out = String::with_capacity(src.len());
    out.push_str(&src[..line_start]);
    out.push_str(&src[after_newline..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- set_scalar ---------------------------------------------------------

    #[test]
    fn set_scalar_replaces_plain_value() {
        let src = "description: hello\nfoo: bar\n";
        let out = set_scalar(src, "description", "world").unwrap();
        assert_eq!(out, "description: \"world\"\nfoo: bar\n");
    }

    #[test]
    fn set_scalar_preserves_unrelated_keys_and_comments() {
        let src = "# top comment\nfoo: 1     # trailing\ndescription: old   # keep\nbar: 2\n";
        let out = set_scalar(src, "description", "new").unwrap();
        assert_eq!(
            out,
            "# top comment\nfoo: 1     # trailing\ndescription: \"new\"   # keep\nbar: 2\n"
        );
    }

    #[test]
    fn set_scalar_replaces_double_quoted_value() {
        let src = "description: \"hello world\"\n";
        let out = set_scalar(src, "description", "next").unwrap();
        assert_eq!(out, "description: \"next\"\n");
    }

    #[test]
    fn set_scalar_replaces_single_quoted_value() {
        let src = "description: 'hello'\nx: y\n";
        let out = set_scalar(src, "description", "world").unwrap();
        assert_eq!(out, "description: \"world\"\nx: y\n");
    }

    #[test]
    fn set_scalar_escapes_special_chars() {
        let src = "description: hi\n";
        let out = set_scalar(src, "description", "line\nwith\"quote").unwrap();
        assert_eq!(out, "description: \"line\\nwith\\\"quote\"\n");
    }

    #[test]
    fn set_scalar_block_scalar_falls_back() {
        let src = "description: |\n  multi\n  line\n";
        let err = set_scalar(src, "description", "x").unwrap_err();
        assert!(matches!(err, SpliceError::Unsupported(_)));
    }

    #[test]
    fn set_scalar_missing_key() {
        let src = "foo: 1\n";
        let err = set_scalar(src, "description", "x").unwrap_err();
        assert!(matches!(err, SpliceError::KeyNotFound(k) if k == "description"));
    }

    // --- seq_add_string -----------------------------------------------------

    #[test]
    fn seq_add_flow_appends_with_separator() {
        let src = "foo: 1\nallowed_targets: [a, b, c]\n";
        let out = seq_add_string(src, "allowed_targets", "d").unwrap();
        assert_eq!(out, "foo: 1\nallowed_targets: [a, b, c, \"d\"]\n");
    }

    #[test]
    fn seq_add_flow_into_empty() {
        let src = "allowed_targets: []\n";
        let out = seq_add_string(src, "allowed_targets", "d").unwrap();
        assert_eq!(out, "allowed_targets: [\"d\"]\n");
    }

    #[test]
    fn seq_add_block_matches_indentation() {
        let src = "allowed_targets:\n  - a\n  - b\nfoo: bar\n";
        let out = seq_add_string(src, "allowed_targets", "c").unwrap();
        assert_eq!(out, "allowed_targets:\n  - a\n  - b\n  - \"c\"\nfoo: bar\n");
    }

    #[test]
    fn seq_add_block_preserves_inter_item_comments() {
        let src = "allowed_targets:\n  - a\n  # mid\n  - b\nfoo: bar\n";
        let out = seq_add_string(src, "allowed_targets", "c").unwrap();
        assert_eq!(
            out,
            "allowed_targets:\n  - a\n  # mid\n  - b\n  - \"c\"\nfoo: bar\n"
        );
    }

    // --- seq_remove_string --------------------------------------------------

    #[test]
    fn seq_remove_flow_middle() {
        let src = "allowed_targets: [a, b, c]\nfoo: bar\n";
        let out = seq_remove_string(src, "allowed_targets", "b").unwrap();
        assert_eq!(out, "allowed_targets: [a, c]\nfoo: bar\n");
    }

    #[test]
    fn seq_remove_flow_first() {
        let src = "allowed_targets: [a, b, c]\n";
        let out = seq_remove_string(src, "allowed_targets", "a").unwrap();
        assert_eq!(out, "allowed_targets: [b, c]\n");
    }

    #[test]
    fn seq_remove_flow_last() {
        let src = "allowed_targets: [a, b, c]\n";
        let out = seq_remove_string(src, "allowed_targets", "c").unwrap();
        assert_eq!(out, "allowed_targets: [a, b]\n");
    }

    #[test]
    fn seq_remove_block() {
        let src = "allowed_targets:\n  - a\n  - b\n  - c\nfoo: bar\n";
        let out = seq_remove_string(src, "allowed_targets", "b").unwrap();
        assert_eq!(out, "allowed_targets:\n  - a\n  - c\nfoo: bar\n");
    }

    #[test]
    fn seq_remove_block_first_preserves_subsequent_comments() {
        let src = "allowed_targets:\n  - a\n  # keep\n  - b\nfoo: bar\n";
        let out = seq_remove_string(src, "allowed_targets", "a").unwrap();
        assert_eq!(
            out,
            "allowed_targets:\n  # keep\n  - b\nfoo: bar\n"
        );
    }

    #[test]
    fn seq_remove_missing_item() {
        let src = "allowed_targets: [a, b]\n";
        let err = seq_remove_string(src, "allowed_targets", "z").unwrap_err();
        assert_eq!(err, SpliceError::ItemNotFound);
    }
}
