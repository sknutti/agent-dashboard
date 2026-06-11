// Turn-grouping fold (ADR-0006 layout C). Pure over the flat ordered
// DisplayMessage[] the /messages endpoint returns — a new turn starts at each
// `user` Message; thinking/assistant/tool nest under the current turn. Messages
// before the first user prompt form a leading turn with prompt:null.

import { describe, test, expect } from "vitest";
import { groupTurns, readableInput } from "./transcript";
import type { DisplayMessage } from "./api";

const m = (role: DisplayMessage["role"], text: string, extra: Partial<DisplayMessage> = {}): DisplayMessage => ({
  role, text, isError: false, ts: "", ...extra,
});

describe("groupTurns", () => {
  test("two user prompts → two turns, each carrying its following entries", () => {
    const turns = groupTurns([
      m("user", "first"),
      m("thinking", "hmm"),
      m("assistant", "doing it"),
      m("tool", "", { toolName: "Bash", toolInput: "ls" }),
      m("user", "second"),
      m("assistant", "done"),
    ]);
    expect(turns.length).toBe(2);
    expect(turns[0]!.prompt!.text).toBe("first");
    expect(turns[0]!.entries.map((e) => e.role)).toEqual(["thinking", "assistant", "tool"]);
    expect(turns[1]!.prompt!.text).toBe("second");
    expect(turns[1]!.entries.map((e) => e.role)).toEqual(["assistant"]);
  });

  test("leading non-user messages form a prompt:null turn", () => {
    const turns = groupTurns([
      m("assistant", "greeting before any prompt"),
      m("user", "hi"),
      m("assistant", "hello"),
    ]);
    expect(turns.length).toBe(2);
    expect(turns[0]!.prompt).toBeNull();
    expect(turns[0]!.entries.map((e) => e.role)).toEqual(["assistant"]);
    expect(turns[1]!.prompt!.text).toBe("hi");
  });

  test("empty input → []", () => {
    expect(groupTurns([])).toEqual([]);
  });

  test("a lone user prompt with no following entries → one empty-entries turn", () => {
    const turns = groupTurns([m("user", "solo")]);
    expect(turns.length).toBe(1);
    expect(turns[0]!.entries).toEqual([]);
  });
});

describe("readableInput", () => {
  test("a command-bearing tool input renders the command as plain text", () => {
    expect(readableInput(JSON.stringify({ command: "git status", description: "x" }))).toBe("git status");
  });

  test("an array command joins with spaces", () => {
    expect(readableInput(JSON.stringify({ cmd: ["bash", "-lc", "npm test"] }))).toBe("bash -lc npm test");
  });

  test("a non-command tool input renders as indented JSON", () => {
    const out = readableInput(JSON.stringify({ file_path: "foo.ts", old_string: "a" }));
    expect(out).toContain('"file_path": "foo.ts"');
    expect(out).toContain("\n"); // pretty-printed, not crushed
  });

  test("unparseable input falls through to the raw string", () => {
    expect(readableInput("not json {")).toBe("not json {");
  });
});
