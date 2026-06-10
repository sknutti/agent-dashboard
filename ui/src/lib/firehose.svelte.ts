// Live OTEL firehose — synchronizes with the server's SSE stream (an external
// system, the one legitimate $effect use), wrapped in a descriptive hook.
// Call once at component init; the EventSource is closed on teardown.

import type { OtelEvent } from "./api";

export interface Firehose {
  events: OtelEvent[];
  connected: boolean;
}

export function createFirehose(max = 200): Firehose {
  const state = $state<Firehose>({ events: [], connected: false });

  $effect(() => {
    // Dedupe by id: on reconnect the server replays its recent backlog, so the
    // same events re-arrive — without this they'd duplicate {#each} keys.
    const seen = new Set<number>();
    const es = new EventSource("/api/firehose");
    es.addEventListener("otel", (e) => {
      try {
        const ev = JSON.parse((e as MessageEvent).data) as OtelEvent;
        if (seen.has(ev.id)) return;
        seen.add(ev.id);
        state.events = [...state.events, ev].slice(-max);
      } catch {
        /* ignore malformed frame */
      }
    });
    es.onopen = () => { state.connected = true; };
    es.onerror = () => { state.connected = false; };
    return () => es.close();
  });

  return state;
}
