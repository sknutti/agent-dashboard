// OTLP/HTTP JSON ingest (master §15, §12).
//
// Three entry points — ingestLogs / ingestMetrics / ingestTraces — each walks the
// nested OTLP envelope (resource* -> scope* -> records) and persists rows.
//
// Contract (load-bearing, master §15):
//   • PER-ROW try/catch — one malformed record never drops the batch.
//   • The caller ALWAYS returns HTTP 200 (Claude Code does not retry on 200 and
//     silently drops telemetry on any failure).
//   • event.name is accepted both bare ("tool_result") and claude_code.-namespaced
//     ("claude_code.tool_result"); we store it verbatim and let queries coalesce.
//   • intValue arrives as a STRING in OTLP/JSON — coerced here.
//
// Phase 0 maps the high-value documented attributes to columns and keeps the full
// flattened attribute set as JSON, so Phase 1 enrichment never needs a migration.

import type { Database } from "bun:sqlite";
import { loadAgentsConfig } from "./agents_config.ts";

type AnyValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
  bytesValue?: string;
};
type KeyValue = { key?: string; value?: AnyValue };

export interface IngestResult {
  received: number;
  dropped: number;
}

function anyValueToJs(v?: AnyValue): unknown {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) {
    return typeof v.intValue === "string" ? Number(v.intValue) : v.intValue;
  }
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(anyValueToJs);
  if (v.kvlistValue) return flattenAttrs(v.kvlistValue.values);
  if (v.bytesValue !== undefined) return v.bytesValue;
  return null;
}

function flattenAttrs(attrs?: KeyValue[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs ?? []) {
    if (a && typeof a.key === "string") out[a.key] = anyValueToJs(a.value);
  }
  return out;
}

/** OTLP times are unix nanoseconds (as a string). -> ISO 8601, or null. */
function nanoToIso(nano?: string | number): string | null {
  if (nano === undefined || nano === null) return null;
  const ms = Number(nano) / 1e6;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function pick(attrs: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = attrs[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}
function asNum(x: unknown): number | null {
  if (x === undefined || x === null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function asStr(x: unknown): string | null {
  return x === undefined || x === null ? null : String(x);
}
function asBoolInt(x: unknown): number | null {
  if (x === undefined || x === null) return null;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (x === "true" || x === 1 || x === "1") return 1;
  if (x === "false" || x === 0 || x === "0") return 0;
  return null;
}

// OTLP resource service.name (or an explicit agent attr) → our agent id. Claude
// Code sets service.name="claude-code"; other emitters (pi-otel, codex) carry
// their own. Hardcoding "claude_code" here misattributes every non-Claude event
// with NO error — Pi's cost/usage would silently land under Claude. The mapping is
// built from agents.yaml `otel_service:` (review #17), so a new agent's telemetry
// is attributed by adding one config line. Defaults to claude_code (the primary
// emitter) when nothing matches, so unlabeled Claude data is unaffected.
const serviceToAgent = (() => {
  const map: Record<string, string> = {};
  for (const m of loadAgentsConfig()) {
    map[m.id] = m.id; // an explicit agent attr may carry the id itself
    if (m.otelService) map[m.otelService] = m.id;
  }
  return map;
})();
function agentOf(attrs: Record<string, unknown>): string {
  const explicit = asStr(pick(attrs, "agent", "agent.id", "agent_id"));
  if (explicit && serviceToAgent[explicit]) return serviceToAgent[explicit];
  const svc = asStr(pick(attrs, "service.name", "service_name"));
  if (svc && serviceToAgent[svc]) return serviceToAgent[svc];
  return "claude_code";
}

export function ingestLogs(db: Database, body: any): IngestResult {
  const insert = db.prepare(/* sql */ `
    INSERT INTO otel_events (
      event_name, agent, session_id, prompt_id, timestamp, model,
      tool_name, tool_success, tool_duration_ms, tool_error,
      cost_usd, api_duration_ms, input_tokens, output_tokens,
      cache_read_tokens, cache_create_tokens, speed, error_message,
      status_code, attempt_count, skill_name, skill_source, prompt_length,
      decision, decision_source, request_id, tool_result_size_bytes,
      mcp_server_scope, plugin_name, plugin_version, marketplace_name,
      install_trigger, mcp_server_name, mcp_tool_name, attributes, received_at
    ) VALUES (
      $event_name, $agent, $session_id, $prompt_id, $timestamp, $model,
      $tool_name, $tool_success, $tool_duration_ms, $tool_error,
      $cost_usd, $api_duration_ms, $input_tokens, $output_tokens,
      $cache_read_tokens, $cache_create_tokens, $speed, $error_message,
      $status_code, $attempt_count, $skill_name, $skill_source, $prompt_length,
      $decision, $decision_source, $request_id, $tool_result_size_bytes,
      $mcp_server_scope, $plugin_name, $plugin_version, $marketplace_name,
      $install_trigger, $mcp_server_name, $mcp_tool_name, $attributes, $received_at
    )`);

  const now = new Date().toISOString();
  let received = 0;
  let dropped = 0;

  // One transaction per batch: a 500-record batch was 500 fsync commits, since
  // each insert.run auto-commits outside a txn. Per-row try/catch stays inside so
  // a single bad record still only drops itself (its run() threw before writing).
  const runBatch = db.transaction(() => {
  for (const rl of body?.resourceLogs ?? []) {
    const resAttrs = flattenAttrs(rl?.resource?.attributes);
    for (const sl of rl?.scopeLogs ?? []) {
      for (const lr of sl?.logRecords ?? []) {
        try {
          const a = { ...resAttrs, ...flattenAttrs(lr?.attributes) };
          const eventName = asStr(lr?.eventName ?? pick(a, "event.name", "event_name"));
          const durationMs = asNum(pick(a, "duration_ms", "tool.duration_ms", "duration"));
          const isApi = (eventName ?? "").includes("api");

          insert.run({
            $event_name: eventName,
            $agent: agentOf(a),
            $session_id: asStr(pick(a, "session.id", "session_id")),
            $prompt_id: asStr(pick(a, "prompt_id", "prompt.id")),
            $timestamp:
              nanoToIso(lr?.timeUnixNano ?? lr?.observedTimeUnixNano) ??
              asStr(pick(a, "event.timestamp", "timestamp")) ??
              now,
            $model: asStr(pick(a, "model")),
            $tool_name: asStr(pick(a, "tool_name", "name", "tool.name")),
            $tool_success: asBoolInt(pick(a, "success", "tool.success")),
            $tool_duration_ms: isApi ? null : durationMs,
            $tool_error: asStr(pick(a, "tool_error")),
            $cost_usd: asNum(pick(a, "cost_usd", "cost")),
            $api_duration_ms: isApi ? durationMs : null,
            $input_tokens: asNum(pick(a, "input_tokens", "input")),
            $output_tokens: asNum(pick(a, "output_tokens", "output")),
            $cache_read_tokens: asNum(pick(a, "cache_read_tokens", "cacheRead")),
            $cache_create_tokens: asNum(pick(a, "cache_creation_tokens", "cache_create_tokens", "cacheCreation")),
            $speed: asNum(pick(a, "speed", "tokens_per_second")),
            $error_message: asStr(pick(a, "error", "error.message", "error_message", "message")),
            $status_code: asNum(pick(a, "status_code", "http.status_code")),
            $attempt_count: asNum(pick(a, "attempt", "attempt_count")),
            $skill_name: asStr(pick(a, "skill.name", "skill_name")),
            $skill_source: asStr(pick(a, "skill.source", "skill_source")),
            $prompt_length: asNum(pick(a, "prompt_length", "prompt.length")),
            $decision: asStr(pick(a, "decision")),
            $decision_source: asStr(pick(a, "source", "decision_source")),
            $request_id: asStr(pick(a, "request_id", "request.id")),
            $tool_result_size_bytes: asNum(pick(a, "tool_result_size_bytes")),
            $mcp_server_scope: asStr(pick(a, "mcp_server.scope", "mcp_server_scope")),
            $plugin_name: asStr(pick(a, "plugin.name", "plugin_name")),
            $plugin_version: asStr(pick(a, "plugin.version", "plugin_version")),
            $marketplace_name: asStr(pick(a, "marketplace.name", "marketplace_name")),
            $install_trigger: asStr(pick(a, "install_trigger")),
            $mcp_server_name: asStr(pick(a, "mcp_server.name", "mcp_server_name")),
            $mcp_tool_name: asStr(pick(a, "mcp_tool.name", "mcp_tool_name")),
            $attributes: JSON.stringify(a),
            $received_at: now,
          });
          received += 1;
        } catch (err) {
          dropped += 1;
          console.error("[otel/logs] dropped record:", err);
        }
      }
    }
  }
  });
  runBatch();
  return { received, dropped };
}

export function ingestMetrics(db: Database, body: any): IngestResult {
  const insert = db.prepare(/* sql */ `
    INSERT INTO otel_metrics
      (metric_name, metric_type, value, agent, session_id, model, attributes, timestamp, received_at)
    VALUES ($metric_name, $metric_type, $value, $agent, $session_id, $model, $attributes, $timestamp, $received_at)`);

  const now = new Date().toISOString();
  let received = 0;
  let dropped = 0;

  const runBatch = db.transaction(() => {
  for (const rm of body?.resourceMetrics ?? []) {
    const resAttrs = flattenAttrs(rm?.resource?.attributes);
    for (const sm of rm?.scopeMetrics ?? []) {
      for (const m of sm?.metrics ?? []) {
        // A metric carries exactly one of sum/gauge/histogram.
        const kind = m?.sum
          ? { type: "counter", points: m.sum.dataPoints }
          : m?.gauge
            ? { type: "gauge", points: m.gauge.dataPoints }
            : m?.histogram
              ? { type: "histogram", points: m.histogram.dataPoints }
              : { type: "unknown", points: [] as any[] };

        for (const dp of kind.points ?? []) {
          try {
            const a = { ...resAttrs, ...flattenAttrs(dp?.attributes) };
            const value =
              dp?.asInt !== undefined
                ? Number(dp.asInt)
                : dp?.asDouble !== undefined
                  ? Number(dp.asDouble)
                  : dp?.sum !== undefined
                    ? Number(dp.sum) // histogram
                    : null;
            insert.run({
              $metric_name: asStr(m?.name),
              $metric_type: kind.type,
              $value: value,
              $agent: agentOf(a),
              $session_id: asStr(pick(a, "session.id", "session_id")),
              $model: asStr(pick(a, "model")),
              $attributes: JSON.stringify(a),
              $timestamp: nanoToIso(dp?.timeUnixNano ?? dp?.startTimeUnixNano) ?? now,
              $received_at: now,
            });
            received += 1;
          } catch (err) {
            dropped += 1;
            console.error("[otel/metrics] dropped point:", err);
          }
        }
      }
    }
  }
  });
  runBatch();
  return { received, dropped };
}

export function ingestTraces(db: Database, body: any): IngestResult {
  const insert = db.prepare(/* sql */ `
    INSERT INTO otel_spans
      (span_id, trace_id, parent_span_id, name, agent, session_id,
       start_time, end_time, duration_ms, attributes, received_at)
    VALUES ($span_id, $trace_id, $parent_span_id, $name, $agent, $session_id,
       $start_time, $end_time, $duration_ms, $attributes, $received_at)`);

  const now = new Date().toISOString();
  let received = 0;
  let dropped = 0;

  const runBatch = db.transaction(() => {
  for (const rs of body?.resourceSpans ?? []) {
    const resAttrs = flattenAttrs(rs?.resource?.attributes);
    for (const ss of rs?.scopeSpans ?? []) {
      for (const sp of ss?.spans ?? []) {
        try {
          const a = { ...resAttrs, ...flattenAttrs(sp?.attributes) };
          const start = Number(sp?.startTimeUnixNano);
          const end = Number(sp?.endTimeUnixNano);
          const durationMs =
            Number.isFinite(start) && Number.isFinite(end) && end >= start
              ? (end - start) / 1e6
              : null;
          insert.run({
            $span_id: asStr(sp?.spanId),
            $trace_id: asStr(sp?.traceId),
            $parent_span_id: asStr(sp?.parentSpanId),
            $name: asStr(sp?.name),
            $agent: agentOf(a),
            $session_id: asStr(pick(a, "session.id", "session_id")),
            $start_time: nanoToIso(sp?.startTimeUnixNano),
            $end_time: nanoToIso(sp?.endTimeUnixNano),
            $duration_ms: durationMs,
            $attributes: JSON.stringify(a),
            $received_at: now,
          });
          received += 1;
        } catch (err) {
          dropped += 1;
          console.error("[otel/traces] dropped span:", err);
        }
      }
    }
  }
  });
  runBatch();
  return { received, dropped };
}
