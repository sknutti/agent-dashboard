#!/usr/bin/env bun
/**
 * Design-system enforcement gate.
 *
 * Fails (exit 1) when UI code bypasses the component library:
 *   1. Raw hex colors inside a Svelte component's <style> block. All colors must
 *      flow through the semantic tokens defined in ui/src/app.css. (app.css itself
 *      is a .css file — it is the token source and is NOT scanned. Hex in <script>,
 *      e.g. data-driven chart ramps, is also NOT scanned — only <style> blocks.)
 *   2. Bare native <button>/<input>/<select>/<textarea> in any .svelte OUTSIDE the
 *      library dir (ui/src/lib/components/ui/). These must use a primitive
 *      (Button, IconButton, Input, Textarea, Select, Checkbox, Field).
 *      Escape hatch: a flagged element is suppressed if its line — or the line
 *      immediately above — contains `ds-allow-native:` followed by a reason. Use
 *      for genuinely-structural interactive elements (e.g. a <button> wrapping a
 *      whole clickable row) that do not map to a form-control primitive.
 *
 * Usage: bun run ui/scripts/check-design-system.ts   (run from repo root or ui/)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Resolve ui/src regardless of CWD (repo root or ui/).
const here = new URL(".", import.meta.url).pathname; // .../ui/scripts/
const UI_SRC = join(here, "..", "src");
const REPO_ROOT = join(here, "..", "..");
const LIB_DIR = join(UI_SRC, "lib", "components", "ui"); // the library — exempt from rule 2

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/;
const NATIVE = /<(button|input|select|textarea)(?=[\s/>])/g;
const SUGGEST: Record<string, string> = {
  button: "<Button> or <IconButton> (or <!-- ds-allow-native: reason --> if a structural row)",
  input: "<Input> / <Checkbox>",
  select: "<Select>",
  textarea: "<Textarea>",
};

type Violation = { file: string; line: number; rule: string; detail: string };
const violations: Violation[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (entry.endsWith(".svelte")) out.push(p);
  }
  return out;
}

/** Classify each line as inside <style>, inside <script>, or template markup.
 *  Svelte SFCs keep style/script as top-level blocks; a line-state toggle is
 *  sufficient and robust for this codebase. */
function classify(lines: string[]): ("style" | "script" | "markup")[] {
  const kinds: ("style" | "script" | "markup")[] = [];
  let mode: "style" | "script" | "markup" = "markup";
  for (const raw of lines) {
    const line = raw;
    const opensStyle = /<style[\s>]/.test(line);
    const opensScript = /<script[\s>]/.test(line);
    const closesStyle = /<\/style>/.test(line);
    const closesScript = /<\/script>/.test(line);
    if (mode === "markup" && opensStyle && !closesStyle) { kinds.push("style"); mode = "style"; continue; }
    if (mode === "markup" && opensScript && !closesScript) { kinds.push("script"); mode = "script"; continue; }
    if (mode === "style") { kinds.push("style"); if (closesStyle) mode = "markup"; continue; }
    if (mode === "script") { kinds.push("script"); if (closesScript) mode = "markup"; continue; }
    // single-line <style>…</style> or <script>…</script> or plain markup
    kinds.push(opensStyle || opensScript ? "markup" : "markup");
  }
  return kinds;
}

for (const file of walk(UI_SRC)) {
  if (file.endsWith(".test.ts") || file.endsWith(".test.svelte")) continue;
  const rel = relative(REPO_ROOT, file);
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  const kind = classify(lines);
  const inLib = file.startsWith(LIB_DIR + "/") || file.startsWith(LIB_DIR);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Rule 1: raw hex in <style> (every file, incl. library).
    if (kind[i] === "style") {
      const m = line.match(HEX);
      if (m) violations.push({ file: rel, line: i + 1, rule: "raw-hex-in-style", detail: `${m[0]} — use a semantic token (var(--…)) from app.css` });
    }

    // Rule 2: bare native control in markup, outside the library dir.
    if (!inLib && kind[i] === "markup") {
      NATIVE.lastIndex = 0;
      let nm: RegExpExecArray | null;
      while ((nm = NATIVE.exec(line)) !== null) {
        const tag = nm[1];
        const thisLine = line;
        const prevLine = i > 0 ? lines[i - 1] : "";
        const suppressed = /ds-allow-native:/.test(thisLine) || /ds-allow-native:/.test(prevLine);
        if (!suppressed) {
          violations.push({ file: rel, line: i + 1, rule: "bare-native-control", detail: `<${tag}> → use ${SUGGEST[tag]}` });
        }
      }
    }
  }
}

if (violations.length === 0) {
  console.log("✓ design-system gate: no bypasses (raw hex in <style>, bare native controls outside ui/)");
  process.exit(0);
}

console.error(`✗ design-system gate: ${violations.length} violation(s)\n`);
const byRule = new Map<string, Violation[]>();
for (const v of violations) (byRule.get(v.rule) ?? byRule.set(v.rule, []).get(v.rule)!).push(v);
for (const [rule, vs] of byRule) {
  console.error(`  [${rule}] ${vs.length}`);
  for (const v of vs) console.error(`    ${v.file}:${v.line}  ${v.detail}`);
  console.error("");
}
process.exit(1);
