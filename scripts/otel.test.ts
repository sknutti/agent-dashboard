import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "./db.ts";
import { ingestLogs, ingestMetrics } from "./otel.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  initSchema(db);
  return db;
}

/** Minimal OTLP/JSON log envelope with one record. */
function logBody(resAttrs: Record<string, string>, recAttrs: Record<string, string> = {}) {
  const kv = (o: Record<string, string>) =>
    Object.entries(o).map(([key, v]) => ({ key, value: { stringValue: v } }));
  return {
    resourceLogs: [
      {
        resource: { attributes: kv(resAttrs) },
        scopeLogs: [{ logRecords: [{ eventName: "tool_result", attributes: kv(recAttrs), timeUnixNano: "1700000000000000000" }] }],
      },
    ],
  };
}

describe("otel agent attribution (#18)", () => {
  test("defaults to claude_code when no service.name is present", () => {
    const db = freshDb();
    ingestLogs(db, logBody({}));
    const r = db.query("SELECT agent FROM otel_events").get() as { agent: string };
    expect(r.agent).toBe("claude_code");
  });

  test("claude-code service.name maps to claude_code", () => {
    const db = freshDb();
    ingestLogs(db, logBody({ "service.name": "claude-code" }));
    const r = db.query("SELECT agent FROM otel_events").get() as { agent: string };
    expect(r.agent).toBe("claude_code");
  });

  test("pi-otel service.name lands under pi, NOT claude_code (the misattribution bug)", () => {
    const db = freshDb();
    ingestLogs(db, logBody({ "service.name": "pi-otel" }));
    const r = db.query("SELECT agent FROM otel_events").get() as { agent: string };
    expect(r.agent).toBe("pi");
  });

  test("an explicit per-record agent attribute wins over service.name", () => {
    const db = freshDb();
    ingestLogs(db, logBody({ "service.name": "claude-code" }, { agent: "codex" }));
    const r = db.query("SELECT agent FROM otel_events").get() as { agent: string };
    expect(r.agent).toBe("codex");
  });

  test("an unknown service.name falls back to claude_code (never invents an agent)", () => {
    const db = freshDb();
    ingestLogs(db, logBody({ "service.name": "some-random-emitter" }));
    const r = db.query("SELECT agent FROM otel_events").get() as { agent: string };
    expect(r.agent).toBe("claude_code");
  });

  test("metrics carry the same attribution (pi cost.usage stays under pi)", () => {
    const db = freshDb();
    const body = {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "pi-otel" } }] },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.cost.usage",
                  sum: { dataPoints: [{ asDouble: 0.5, timeUnixNano: "1700000000000000000", attributes: [] }] },
                },
              ],
            },
          ],
        },
      ],
    };
    const res = ingestMetrics(db, body);
    expect(res.received).toBe(1);
    const r = db.query("SELECT agent, value FROM otel_metrics").get() as { agent: string; value: number };
    expect(r.agent).toBe("pi");
    expect(r.value).toBe(0.5);
  });
});

describe("otel batch ingest (#14)", () => {
  test("every record in a multi-record batch is persisted (one transaction)", () => {
    const db = freshDb();
    const rec = (i: number) => ({
      eventName: "tool_result",
      attributes: [{ key: "session.id", value: { stringValue: `s${i}` } }],
      timeUnixNano: "1700000000000000000",
    });
    const body = {
      resourceLogs: [
        { resource: { attributes: [] }, scopeLogs: [{ logRecords: [rec(1), rec(2), rec(3)] }] },
      ],
    };
    const res = ingestLogs(db, body);
    expect(res.received).toBe(3);
    expect(res.dropped).toBe(0);
    expect((db.query("SELECT COUNT(*) n FROM otel_events").get() as { n: number }).n).toBe(3);
  });
});
