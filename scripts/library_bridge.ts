// Invoke the prompt-library-bridge binary over JSON stdin/stdout and normalize
// its envelope into a typed read model or a dashboard-stable error.
//
// Two-layer error model (the single most important thing this wrapper gets
// right): a *transport* failure (binary missing, killed/timeout, non-zero exit,
// empty/unparseable stdout, protocol mismatch) is distinct from an *application*
// error (a VALID `{ok:false}` envelope the Rust side produced on purpose, e.g.
// `library_marker_missing`). They map to different codes because they need
// different fixes — "binary not built" vs "command timed out" vs "that dir isn't
// a library". stdout is never parsed before the exit/signal is checked: a killed
// process can emit partial JSON.

import { isAbsolute } from "node:path";
import { BridgeShapeError } from "./library_models.ts";

/** Request/response protocol version — must match the bridge's PROTOCOL_VERSION. */
export const PROTOCOL_VERSION = 1;

export interface LibraryError {
  code: string;
  message: string;
  detail: string;
}

export type BridgeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: LibraryError };

/** The completed-process facts `interpretBridgeOutcome` reasons over. */
export interface BridgeOutcome {
  exitCode: number | null;
  signalCode: string | null;
  stdout: string;
  stderr: string;
}

function transportError<T>(code: string, message: string, detail: string): BridgeResult<T> {
  return { ok: false, error: { code, message, detail } };
}

/**
 * Pure interpretation of a finished bridge process into a typed result. Kept
 * separate from spawning so it can be tested against committed real-bridge
 * fixtures with no subprocess. `validate` turns the envelope's `data` into the
 * typed read model (or throws `BridgeShapeError` → `bridge_bad_output`).
 */
export function interpretBridgeOutcome<T>(
  outcome: BridgeOutcome,
  validate: (data: unknown) => T,
): BridgeResult<T> {
  // 1. Killed (timeout / signalled) — exitCode is null, signalCode set.
  if (outcome.signalCode !== null || outcome.exitCode === null) {
    return transportError(
      "bridge_timeout",
      "the library bridge was terminated before it responded",
      `signal=${outcome.signalCode ?? "unknown"} stderr=${outcome.stderr.trim()}`,
    );
  }
  // 2. Crashed / non-zero exit — reserved for genuine failures (the bridge exits
  //    0 even for application errors), so a non-zero exit is a real crash.
  if (outcome.exitCode !== 0) {
    return transportError(
      "bridge_command_failed",
      "the library bridge exited abnormally",
      `exit=${outcome.exitCode} stderr=${outcome.stderr.trim()}`,
    );
  }
  // 3. Parse the envelope. Empty or non-JSON stdout is a transport fault.
  let env: unknown;
  try {
    const trimmed = outcome.stdout.trim();
    if (trimmed === "") throw new Error("empty stdout");
    env = JSON.parse(trimmed);
  } catch (e) {
    return transportError(
      "bridge_bad_output",
      "the library bridge produced unreadable output",
      String(e),
    );
  }
  // 4. Envelope shape + protocol version.
  if (typeof env !== "object" || env === null) {
    return transportError("bridge_bad_output", "the library bridge produced unreadable output", "not an object");
  }
  const e = env as Record<string, unknown>;
  if (e.v !== PROTOCOL_VERSION) {
    return transportError(
      "bridge_bad_output",
      "the library bridge spoke an unsupported protocol version",
      `expected v=${PROTOCOL_VERSION}, got ${JSON.stringify(e.v)}`,
    );
  }
  // 5. Application error — a valid ok:false envelope passes through verbatim.
  if (e.ok === false) {
    const err = e.error;
    if (typeof err !== "object" || err === null) {
      return transportError("bridge_bad_output", "the library bridge produced unreadable output", "missing error body");
    }
    const eo = err as Record<string, unknown>;
    return {
      ok: false,
      error: {
        code: typeof eo.code === "string" ? eo.code : "bridge_command_failed",
        message: typeof eo.message === "string" ? eo.message : "library command failed",
        detail: typeof eo.detail === "string" ? eo.detail : "",
      },
    };
  }
  // 6. Success — validate the data into the typed read model.
  if (e.ok !== true) {
    return transportError("bridge_bad_output", "the library bridge produced unreadable output", "missing ok flag");
  }
  try {
    return { ok: true, data: validate(e.data) };
  } catch (err) {
    if (err instanceof BridgeShapeError) {
      return transportError("bridge_bad_output", "the library bridge returned an unexpected shape", err.message);
    }
    throw err;
  }
}

export interface RunBridgeOptions<T> {
  /** Per-command shape validator; defaults to an unchecked passthrough. */
  validate?: (data: unknown) => T;
  /** Kill the bridge after this many ms (default 10s). */
  timeoutMs?: number;
}

/**
 * Spawn the bridge (argv array — never a shell string, M1), write one JSON
 * request to stdin, drain stdout AND stderr concurrently (so a payload larger
 * than the ~64 KB pipe buffer can't deadlock), then interpret the result.
 */
export async function runBridge<T>(
  bridgePath: string,
  command: string,
  args: Record<string, unknown>,
  opts: RunBridgeOptions<T> = {},
): Promise<BridgeResult<T>> {
  const validate = opts.validate ?? ((d: unknown) => d as T);

  // M1: only ever spawn an absolute path; a relative/escaping path is rejected
  // without spawning (no `sh -c`, no interpolation).
  if (!isAbsolute(bridgePath)) {
    return transportError(
      "bridge_command_failed",
      "the library bridge path is not absolute",
      `refusing to spawn non-absolute path: ${bridgePath}`,
    );
  }

  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([bridgePath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe", // async spawn defaults stderr to "inherit" — pin it so
      // diagnostics land in our error envelope, not the dashboard log.
    });
  } catch (e) {
    // ENOENT / not executable — the binary isn't where config says it is.
    return transportError(
      "bridge_not_found",
      "the library bridge binary could not be launched",
      `${bridgePath}: ${String(e)}`,
    );
  }

  // Explicit watchdog (NOT Bun.spawn's `timeout` option — observed not to fire
  // reliably under concurrent load). A JS timer that kills the process is
  // deterministic: it fires as soon as the loop is free, well before any real
  // hang would matter.
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, opts.timeoutMs ?? 10_000);

  try {
    proc.stdin.write(JSON.stringify({ v: PROTOCOL_VERSION, command, args }));
    proc.stdin.end(); // EOF — flush() alone would hang the bridge's read_to_string
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    if (timedOut) {
      return transportError(
        "bridge_timeout",
        "the library bridge was terminated before it responded",
        `killed after ${opts.timeoutMs ?? 10_000}ms; stderr=${stderr.trim()}`,
      );
    }
    return interpretBridgeOutcome(
      { exitCode: proc.exitCode, signalCode: proc.signalCode, stdout, stderr },
      validate,
    );
  } finally {
    clearTimeout(watchdog);
  }
}
