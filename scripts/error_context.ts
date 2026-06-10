// Display parser — a SECOND consumer of each agent's raw session log, distinct
// from scripts/adapters/* (which extract tokens/tools for rollups and never emit
// display text). This module re-reads a session file on demand and flattens it
// into an ordered list of readable messages, with each errored tool call flagged
// and its failing input attached — the data the /errors endpoint windows over.
//
// Why a separate parser (ADR-0005): the adapters drop tool *input* (the DB's
// tool_calls keeps only tool_name + extracted error text), so the failing
// command/edit isn't recoverable from storage — only from the raw line. Both
// consumers read the same three text-JSONL formats; the fixtures in
// error_context.test.ts mirror the adapter test shapes so the two can't drift.
//
// Scope is the three text-format agents (Claude Code, Codex, Pi). Antigravity is
// a protobuf blob with 0 errored sessions → UnsupportedAgentError (the endpoint
// maps it to a "view unavailable for this agent" note + Messages fallback).

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** One readable entry in a session transcript. A `tool` entry collapses a tool
 *  call and its result: `toolInput` is the failing input, `text` is the captured
 *  result/error text, `isError` is set once the matching result comes back. */
export interface DisplayMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  isError: boolean;
  toolName?: string;
  toolInput?: string;
}

/** An errored tool call wrapped in its surrounding readable context. */
export interface ErrorContext {
  toolName: string;
  toolInput: string;
  errorText: string;
  before: DisplayMessage[];
  after: DisplayMessage[];
  /** Position of the errored entry in the full readable sequence. */
  index: number;
}

/** Thrown for an agent with no display parser (today: antigravity). The endpoint
 *  catches this and returns `supported:false` rather than 500ing. */
export class UnsupportedAgentError extends Error {
  constructor(public readonly agent: string) {
    super(`No display parser for agent "${agent}"`);
    this.name = "UnsupportedAgentError";
  }
}

const INPUT_CAP = 2000;
const TEXT_CAP = 1000;

function clip(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}

/** Render a tool input (object or string) verbatim — these are local logs on a
 *  localhost-only app, so no redaction (ADR-0005 Q1) — truncated for display. */
function stringifyInput(input: unknown): string {
  if (input == null) return "";
  const s = typeof input === "string" ? input : safeJson(input);
  return clip(s, INPUT_CAP);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Pull readable text from a content value that may be a string, a {text} block
 *  array (claude/codex/pi all use this shape), or a single {text} object. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b?.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && typeof (content as any).text === "string") {
    return (content as any).text;
  }
  return "";
}

async function* readLines(filePath: string): AsyncIterable<string> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) yield line;
}

/** Agents with a display parser (the three text-JSONL formats). Antigravity
 *  (protobuf, 0 errored sessions) is intentionally absent — ADR-0005. */
export const DISPLAY_PARSER_AGENTS = new Set(["claude_code", "codex", "pi"]);

/** Parse a session log into ordered readable messages. Each per-agent reader
 *  mirrors the exact raw shape documented in scripts/adapters/<agent>.ts. */
export async function parseDisplay(agent: string, filePath: string): Promise<DisplayMessage[]> {
  switch (agent) {
    case "claude_code":
      return parseClaude(filePath);
    case "codex":
      return parseCodex(filePath);
    case "pi":
      return parsePi(filePath);
    default:
      throw new UnsupportedAgentError(agent);
  }
}

/** Locate each errored tool entry and slice a ±N readable-message context window
 *  around it (clamped at the file's start/end). Pure — unit-testable in isolation. */
export function windowErrors(
  messages: DisplayMessage[],
  before = 3,
  after = 2,
): ErrorContext[] {
  const out: ErrorContext[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (!m.isError) continue;
    out.push({
      toolName: m.toolName ?? "unknown",
      toolInput: m.toolInput ?? "",
      errorText: m.text ?? "",
      before: messages.slice(Math.max(0, i - before), i),
      after: messages.slice(i + 1, i + 1 + after),
      index: i,
    });
  }
  return out;
}

// ── Claude Code ──────────────────────────────────────────────────────────────
// assistant lines: message.content[] blocks (text | thinking | tool_use{id,name,
// input}); one logical message is split across lines sharing message.id → collapse
// thinking+text into one assistant turn. user lines: either real prompt text OR
// tool_result{tool_use_id,is_error,content} blocks (synthetic) — the latter fold
// back onto the matching tool entry, never their own message.
async function parseClaude(filePath: string): Promise<DisplayMessage[]> {
  const messages: DisplayMessage[] = [];
  const toolIndexById = new Map<string, number>();
  let curMsgId: string | null = null;
  let curText: string[] = [];

  const flushAsstText = () => {
    const text = curText.join("\n").trim();
    if (text) messages.push({ role: "assistant", text, isError: false });
    curText = [];
  };

  for await (const line of readLines(filePath)) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    if (rec.type === "assistant") {
      const msg = rec.message ?? {};
      const id = typeof msg.id === "string" ? msg.id : null;
      if (id !== curMsgId) {
        flushAsstText();
        curMsgId = id;
      }
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") {
          curText.push(block.text);
        } else if (block?.type === "thinking" && typeof block.thinking === "string") {
          curText.push(block.thinking);
        } else if (block?.type === "tool_use" && typeof block.id === "string") {
          flushAsstText(); // the turn's text precedes its tool call
          const idx =
            messages.push({
              role: "tool",
              text: "",
              isError: false,
              toolName: typeof block.name === "string" ? block.name : "unknown",
              toolInput: stringifyInput(block.input),
            }) - 1;
          toolIndexById.set(block.id, idx);
        }
      }
    } else if (rec.type === "user") {
      const content = Array.isArray(rec.message?.content) ? rec.message.content : null;
      const results = content?.filter((b: any) => b?.type === "tool_result") ?? [];
      if (results.length) {
        for (const block of results) {
          const useId = block.tool_use_id;
          const idx = typeof useId === "string" ? toolIndexById.get(useId) : undefined;
          if (idx == null) continue;
          const m = messages[idx]!;
          m.isError = block.is_error === true;
          m.text = clip(contentText(block.content), TEXT_CAP);
        }
      } else {
        flushAsstText();
        curMsgId = null;
        const text = contentText(rec.message?.content).trim();
        if (text) messages.push({ role: "user", text, isError: false });
      }
    }
    // ai-title / system / api-error carry no readable turn → ignored.
  }
  flushAsstText();
  return messages;
}

// ── Codex ────────────────────────────────────────────────────────────────────
// {type,timestamp,payload} envelope. response_item carries message turns
// (payload.type "message" → role + content[]) and tool calls
// (function_call{call_id,name,arguments} / custom_tool_call{call_id,name,input},
// function_call_output{call_id,output}). event_msg/exec_command_end{call_id,
// exit_code} flags shell failure; a function_call can also carry status:"failed".
async function parseCodex(filePath: string): Promise<DisplayMessage[]> {
  const messages: DisplayMessage[] = [];
  const toolIndexById = new Map<string, number>();

  const ensureTool = (callId: string): DisplayMessage => {
    let idx = toolIndexById.get(callId);
    if (idx == null) {
      idx =
        messages.push({ role: "tool", text: "", isError: false, toolName: "unknown", toolInput: "" }) - 1;
      toolIndexById.set(callId, idx);
    }
    return messages[idx]!;
  };

  for await (const line of readLines(filePath)) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const p = rec.payload ?? {};

    if (rec.type === "response_item") {
      switch (p.type) {
        case "message": {
          const role = p.role === "user" ? "user" : "assistant";
          const text = contentText(p.content).trim();
          if (text) messages.push({ role, text, isError: false });
          break;
        }
        case "function_call":
        case "custom_tool_call": {
          if (typeof p.call_id !== "string") break;
          const m = ensureTool(p.call_id);
          if (typeof p.name === "string") m.toolName = p.name;
          // function_call → JSON `arguments`; custom_tool_call → raw `input` (the patch).
          m.toolInput = stringifyInput(p.arguments ?? p.input);
          if (p.status === "failed") m.isError = true;
          break;
        }
        case "function_call_output":
        case "custom_tool_call_output": {
          if (typeof p.call_id !== "string") break;
          const m = ensureTool(p.call_id);
          const out = typeof p.output === "string" ? p.output : contentText(p.output) || safeJson(p.output);
          m.text = clip(out, TEXT_CAP);
          break;
        }
      }
    } else if (rec.type === "event_msg" && p.type === "exec_command_end") {
      if (typeof p.call_id === "string" && typeof p.exit_code === "number" && p.exit_code !== 0) {
        ensureTool(p.call_id).isError = true;
      }
    }
  }
  return messages;
}

// ── Pi ───────────────────────────────────────────────────────────────────────
// type:"message" with message.role ∈ {user,assistant,toolResult}. assistant
// content[] holds text + toolCall{id,name,input}; toolResult{toolCallId,toolName,
// isError,content} folds back onto the matching toolCall. Tree-structured by
// parentId but real sessions are linear → read in file order (ADR-0005 / pi.ts).
async function parsePi(filePath: string): Promise<DisplayMessage[]> {
  const messages: DisplayMessage[] = [];
  const toolIndexById = new Map<string, number>();

  for await (const line of readLines(filePath)) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== "message") continue;
    const m = rec.message;
    if (!m || typeof m !== "object") continue;

    if (m.role === "user") {
      const text = contentText(m.content).trim();
      if (text) messages.push({ role: "user", text, isError: false });
    } else if (m.role === "assistant") {
      const content = Array.isArray(m.content) ? m.content : [];
      let buf: string[] = [];
      const flush = () => {
        const text = buf.join("\n").trim();
        if (text) messages.push({ role: "assistant", text, isError: false });
        buf = [];
      };
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") {
          buf.push(block.text);
        } else if (block?.type === "toolCall" && typeof block.id === "string") {
          flush(); // the turn's text precedes its tool call
          const idx =
            messages.push({
              role: "tool",
              text: "",
              isError: false,
              toolName: typeof block.name === "string" ? block.name : "unknown",
              toolInput: stringifyInput(block.input),
            }) - 1;
          toolIndexById.set(block.id, idx);
        }
      }
      flush();
    } else if (m.role === "toolResult") {
      const id = typeof m.toolCallId === "string" ? m.toolCallId : undefined;
      const idx = id ? toolIndexById.get(id) : undefined;
      if (idx == null) continue;
      const entry = messages[idx]!;
      entry.isError = m.isError === true;
      if (typeof m.toolName === "string") entry.toolName = m.toolName;
      entry.text = clip(contentText(m.content), TEXT_CAP);
    }
  }
  return messages;
}
