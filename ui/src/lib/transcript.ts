// Transcript display helpers shared by the Messages (whole) and Errors (windowed)
// views. `groupTurns` is the ADR-0006 layout-C fold; `readableInput` pretty-prints
// a tool call's failing input (lifted here from SessionErrors so both views share
// one source of truth).

import type { DisplayMessage } from "./api";

/** One conversational turn: a user prompt and the agent Messages that follow it.
 *  A leading run of non-user Messages (before the first prompt) has prompt:null. */
export interface Turn {
  prompt: DisplayMessage | null;
  entries: DisplayMessage[];
}

/** Fold the flat ordered DisplayMessage[] into grouped turns. A new turn starts at
 *  each `user` Message; thinking/assistant/tool accrue into the current turn. Pure. */
export function groupTurns(messages: DisplayMessage[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const msg of messages) {
    if (msg.role === "user") {
      cur = { prompt: msg, entries: [] };
      turns.push(cur);
    } else {
      if (!cur) {
        cur = { prompt: null, entries: [] };
        turns.push(cur);
      }
      cur.entries.push(msg);
    }
  }
  return turns;
}

/** The failing input arrives as a verbatim JSON string. Render it as readable
 *  text: a command-bearing tool (Bash `command`, codex exec `cmd`/`command[]`)
 *  shows the command itself — the thing you'd re-run — with real newlines; any
 *  other tool gets indented JSON instead of a crushed one-liner. Unparseable
 *  (e.g. truncated) input falls through to the raw string. */
export function readableInput(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (typeof parsed === "string") return parsed;
  if (!parsed || typeof parsed !== "object") return raw;
  const o = parsed as Record<string, unknown>;
  const cmd = o.command ?? o.cmd;
  if (cmd != null) return Array.isArray(cmd) ? cmd.map(String).join(" ") : String(cmd);
  return JSON.stringify(parsed, null, 2);
}
