// Typed client for the Command Centre API. Phase 0 only consumes system health;
// every panel's data endpoint arrives in later phases.

export interface SystemHealth {
  ok: boolean;
  uptime_s: number;
  last_otel_event_age_s: number | null;
  last_sync_tick_age_s: number | null;
  last_worker_tick_at: string | null;
  rss_bytes: number;
  tz: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export const getSystemHealth = () => getJson<SystemHealth>("/api/system/health");
