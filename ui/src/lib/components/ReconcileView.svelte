<script lang="ts">
  // Reconcile view (bootstrap slice — the `forget` home). Lists ORPHANED install
  // records: a `(kind, name)` that still has rows in installs.json but no matching
  // library primitive (the inverse of bootstrap — bootstrap pulls disk→library,
  // reconcile drops dead ledger rows). `forget` was bridge/route/fetcher-complete
  // from the lifecycle slice and only needed this UI home.
  //
  // Orphans are derived by the PARENT (from the driftBatch + primitives reads the
  // Library route already holds) and passed in, so this component is pure-ish and
  // unit-testable with direct orphan input. Forget is a two-phase confirm against
  // a captured SNAPSHOT (D2): the confirm re-issues against the snapshot, so an
  // orphan-list change across the await can't redirect the forget.
  import { Badge, Button, Callout, EmptyState } from "./ui";
  import { forgetPrimitive, LibraryApiError, type LibraryTarget } from "../api";
  import { orphanCue, type OrphanInstall } from "../library";

  let {
    orphans,
    onForgotten,
  }: {
    orphans: OrphanInstall[];
    /** Reload the driftBatch (and thus the orphan derivation) after a forget. */
    onForgotten: () => void;
  } = $props();

  const cue = orphanCue();

  // Captured-intent two-phase confirm (D2).
  let confirm = $state<OrphanInstall | null>(null);
  let busy = $state(false);
  let notice = $state<{ tone: "default" | "amber"; text: string } | null>(null);

  function ask(o: OrphanInstall): void {
    confirm = o;
    notice = null;
  }

  function cancel(): void {
    confirm = null;
  }

  async function doForget(): Promise<void> {
    if (busy || !confirm) return;
    const intent = confirm; // snapshot — the await can't redirect it
    busy = true;
    notice = null;
    try {
      const res = await forgetPrimitive(intent.kind, intent.name);
      confirm = null;
      notice = res.removed
        ? { tone: "default", text: `Forgot ${intent.kind}/${intent.name} — its install records were dropped.` }
        : { tone: "amber", text: `No records matched ${intent.kind}/${intent.name}.` };
      onForgotten();
    } catch (e) {
      const code = e instanceof LibraryApiError ? e.code : "";
      notice = { tone: "amber", text: `Couldn’t forget that install${code ? ` (${code})` : ""}.` };
    } finally {
      busy = false;
    }
  }
</script>

<section class="reconcile" aria-label="Reconcile orphaned installs">
  <p class="reconcile-intro">
    These install records have no matching library primitive — the primitive was deleted or never imported,
    but the ledger still tracks it. <strong>Forget</strong> drops the dead rows; the on-disk files (if any)
    are left untouched.
  </p>

  {#if notice}
    <Callout tone={notice.tone === "amber" ? "warn" : "neutral"} role="status">{notice.text}</Callout>
  {/if}

  {#if !orphans.length}
    <EmptyState
      icon="check"
      title="Nothing to reconcile"
      message="Every install record has a matching library primitive."
    />
  {:else}
    <ul class="orphan-list">
      {#each orphans as o (o.kind + "/" + o.name)}
        <li class="orphan-row">
          <div class="orphan-head">
            <span class="orphan-name">{o.name}</span>
            <Badge>{o.kind}</Badge>
            <small class="cue cyan" title={cue.label}>{cue.glyph} {cue.label}</small>
          </div>
          <div class="orphan-targets">
            installed to:
            {#each o.targets as t (t)}
              <code class="mono">{t}</code>
            {/each}
          </div>
          {#if confirm && confirm.kind === o.kind && confirm.name === o.name}
            <div class="orphan-confirm" role="group" aria-label={`Confirm forget ${o.name}`}>
              <span class="confirm-q">
                Forget all {o.targets.length}
                {o.targets.length === 1 ? "record" : "records"} for <strong>{o.name}</strong>?
              </span>
              <div class="confirm-actions">
                <Button size="sm" disabled={busy} onclick={cancel}>Cancel</Button>
                <Button variant="danger" size="sm" disabled={busy} onclick={doForget}>
                  {busy ? "Forgetting…" : "Forget"}
                </Button>
              </div>
            </div>
          {:else}
            <Button variant="ghost" size="sm" icon="trash" iconSize={13} onclick={() => ask(o)}>
              Forget
            </Button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .reconcile {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .reconcile-intro {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.85rem;
    line-height: 1.45;
  }
  .orphan-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .orphan-row {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  /* The reveal/confirm Buttons sit in a column row — keep them left-aligned
     instead of stretching to full width (replaces .orphan-forget's align-self). */
  .orphan-row > :global(.btn) {
    align-self: flex-start;
  }
  .orphan-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .orphan-name {
    font-weight: 600;
  }
  .orphan-targets {
    font-size: 0.8rem;
    color: var(--text-dim);
    display: flex;
    gap: 0.35rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .cue {
    font-size: 0.75rem;
  }
  .cue.cyan {
    color: var(--cyan);
  }
  .orphan-confirm {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding-top: 0.25rem;
    flex-wrap: wrap;
  }
  .confirm-q {
    font-size: 0.83rem;
  }
  .confirm-actions {
    display: flex;
    gap: 0.4rem;
  }
</style>
