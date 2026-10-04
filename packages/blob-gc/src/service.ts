import {
  BLOB_COLLECT_REFS_HOOK,
  BLOB_COLLECT_REFS_MAX_CANDIDATES,
  isBlobSha256,
  makeAgentContext,
  readBlobCollectRefsAnswers,
  type AgentContext,
  type HookBus,
  type Logger,
} from '@ax/core';
import type { BlobGcMode, SettingsStore } from './config.js';
import { PLUGIN_NAME } from './shared.js';
import type { BlobGcStore, BlobRowSummary } from './store.js';

// ---------------------------------------------------------------------------
// The blob GC sweep (design D2/D3/D4/D5/D8, "The sweep, end to end" in
// docs/plans/2026-10-03-blob-gc-design.md).
//
// THIS FILE CAN DELETE USER DATA, in enforce mode only. Report mode (the
// default, and what a missing or corrupt setting reads as) never calls
// `blob:retire`, `blob:purge` or `blob:stat`.
//
//   recordStored — `blob:stored`: refresh that sha's `last_put_at`. Fires on
//                  every put, the backends' fast path included. Never throws.
//   sweep        — under the advisory lock, with the settings read ONCE:
//                    1. DISCOVER: page `blob:list { state: 'live' }` and insert
//                       every sha the table has never seen as live,
//                       `last_put_at = now`; then `{ state: 'retired' }`, and
//                       insert unseen ones as retired, `retired_at = now`.
//                    2. RETIRE PASS: live rows last put before `now - graceMs`,
//                       in batches of at most 1000, each offered to every
//                       holder through `blob:collect-refs`. Each one nobody
//                       holds is counted (`wouldRetire`). Enforce only: its
//                       row flips to retired ONLY IF it is still live and still
//                       older than the cutoff (a re-put after the ask refreshed
//                       it: skip), and then `blob:retire` moves the bytes
//                       aside. A retire that throws reverts the row and fails
//                       the sweep. Retired bytes are still recoverable: any
//                       `blob:get` / `blob:stat` restores them (D3).
//                    3. PURGE PASS, enforce only: rows retired before
//                       `now - retentionMs`, asked about AGAIN under the same
//                       abort rules. Held now -> `blob:stat` (which restores)
//                       and the row goes live. Still unheld -> `blob:purge`
//                       (the RETIRED copy only; a live copy is never touched)
//                       and the row is dropped if it is still retired.
//                    4. REPORT: log `blob_gc_report` and `blob_gc_sweep`, and
//                       keep the report for the admin Storage tab.
//
// The only rows it writes are its own (`blob_gc_v1_*`), plus the report and the
// roster.
//
// FAILS CLOSED, exactly as disk-quota's ledger release does (design D2): a
// vetoed fire, a holder answering `ok: false`, an answer that cannot be read,
// or a ROSTER member that did not answer (it threw, or its plugin is no longer
// loaded) aborts the whole sweep with `blob_gc_sweep_aborted`: nothing further
// is retired or purged, and no report is written for it. In enforce mode an
// ask about real candidates that NO holder answered aborts too (an empty
// roster must never read as "nobody holds anything"). The roster is this
// plugin's own table; every sweep asks at least once (with no candidates if
// none are old enough), so the roster fills during report mode, long before
// enforce is switched on.
// ---------------------------------------------------------------------------

/** Where the last complete sweep's report is kept, so every replica serves it. */
export const LAST_REPORT_STORAGE_KEY = 'blob-gc:last-report';

/** Most shas asked for per `blob:list` page. */
const LIST_PAGE_LIMIT = 1000;

export interface BlobGcReport {
  /** When the sweep finished (ISO 8601). */
  at: string;
  /** The mode this sweep ran in (read once, at its start). */
  mode: BlobGcMode;
  /** Blobs found by listing (live or retired) that the table had never seen. */
  discovered: number;
  /** Live blobs past the grace window, offered to the holders. */
  candidates: number;
  /** Candidates some holder still references. */
  held: number;
  /**
   * Candidates nobody references, counted in BOTH modes. In enforce mode this
   * can exceed `retired` (a re-put refreshed one between the ask and the retire).
   */
  wouldRetire: number;
  wouldRetireBytes: number;
  /** Blobs this sweep moved aside (enforce only; always 0 in report mode). */
  retired: number;
  /** Retired blobs a holder referenced again, moved back (enforce only). */
  restored: number;
  /** Retired blobs gone for good, and their bytes (enforce only). */
  purged: number;
  bytesPurged: number;
  /** Holder name -> how many candidates it said it holds. */
  perHolder: Record<string, number>;
}

export type SweepResult =
  | { outcome: 'reported'; report: BlobGcReport }
  | { outcome: 'aborted' }
  | { outcome: 'failed' }
  | { outcome: 'skipped' };

export interface BlobGcService {
  recordStored(ctx: AgentContext, payload: unknown): Promise<void>;
  /** One sweep. Never throws. */
  sweep(): Promise<SweepResult>;
  /** The last complete sweep's report, or null if none has finished yet. */
  lastReport(): Promise<BlobGcReport | null>;
  /** Drop a holder from the roster (operator action). Resolves whether it was there. */
  forgetHolder(holder: string): Promise<boolean>;
}

function log(
  ctx: AgentContext,
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  bindings?: Record<string, unknown>,
): void {
  try {
    ctx.logger[level](msg, bindings);
  } catch {
    /* a broken logger must not break a sweep or a put */
  }
}

/** A size we can store: a finite whole number of bytes, not negative. */
function isSize(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * The page a backend returned, or a thrown Error naming what was wrong with it.
 * The backends are first-party, but a listing that went backwards, or a
 * malformed item, would make discovery loop or store junk: refuse it instead.
 */
function readListPage(raw: unknown, after: string | undefined): { items: BlobRowSummary[]; next?: string } {
  const page = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  if (page === undefined || !Array.isArray(page.items)) throw new Error('blob:list returned no items list');
  const items: BlobRowSummary[] = [];
  let last = after;
  for (const it of page.items as unknown[]) {
    const item = it !== null && typeof it === 'object' ? (it as Record<string, unknown>) : undefined;
    if (item === undefined || !isBlobSha256(item.sha256) || !isSize(item.size)) {
      throw new Error('blob:list returned a malformed item');
    }
    if (last !== undefined && item.sha256 <= last) throw new Error('blob:list went out of order');
    last = item.sha256;
    items.push({ sha256: item.sha256, size: item.size });
  }
  if (page.next === undefined) return { items };
  if (!isBlobSha256(page.next) || (after !== undefined && page.next <= after)) {
    throw new Error('blob:list returned a cursor that does not move forward');
  }
  return { items, next: page.next };
}

export function createBlobGcService(deps: {
  bus: HookBus;
  store: BlobGcStore;
  settings: SettingsStore;
  now: () => Date;
  /** Where the sweep's lines go. Default: the context's own logger. */
  logger?: Logger;
}): BlobGcService {
  const { bus, store, settings, now, logger } = deps;

  function sweepContext(): AgentContext {
    return makeAgentContext({
      sessionId: 'blob-gc-sweep',
      agentId: PLUGIN_NAME,
      userId: 'system',
      ...(logger !== undefined ? { logger } : {}),
    });
  }

  /** Page one backend namespace and insert the shas the table has never seen. */
  async function discover(ctx: AgentContext, state: 'live' | 'retired'): Promise<number> {
    let discovered = 0;
    let after: string | undefined;
    for (;;) {
      const raw = await bus.call('blob:list', ctx, {
        state,
        ...(after !== undefined ? { after } : {}),
        limit: LIST_PAGE_LIMIT,
      });
      const page = readListPage(raw, after);
      discovered +=
        state === 'live'
          ? await store.discover(page.items, now())
          : await store.discoverRetired(page.items, now());
      if (page.next === undefined) return discovered;
      after = page.next;
    }
  }

  /**
   * Ask every holder about one batch (possibly empty). Resolves who holds what
   * plus a per-holder count, or undefined after logging why the answers cannot
   * be trusted. Every holder that answered at all joins the roster first.
   */
  async function askHolders(
    ctx: AgentContext,
    candidates: readonly string[],
    opts: { requireAnswer: boolean },
  ): Promise<{ held: Set<string>; perHolder: Map<string, number> } | undefined> {
    const roster = await store.listRoster();
    const fired = await bus.fire(BLOB_COLLECT_REFS_HOOK, ctx, {
      candidates: [...candidates],
      answers: [],
    });
    if (fired.rejected) {
      log(ctx, 'error', 'blob_gc_sweep_aborted', {
        candidates: candidates.length,
        rejected: true,
        source: fired.source,
        missing: [],
        failed: [],
        malformed: 0,
      });
      return undefined;
    }
    // Judged against OUR candidate list, never the (rewritable) payload's.
    const outcome = readBlobCollectRefsAnswers(fired.payload, candidates);
    if (outcome.answered.size > 0) await store.touchRoster([...outcome.answered]);
    const missing = roster.filter((h) => !outcome.answered.has(h)).sort();
    if (missing.length > 0 || outcome.failed.length > 0 || outcome.malformed > 0) {
      // An error, not a warn: a missing holder stays missing until an operator
      // acts, and until then no report is produced.
      log(ctx, 'error', 'blob_gc_sweep_aborted', {
        candidates: candidates.length,
        rejected: false,
        missing,
        failed: outcome.failed,
        malformed: outcome.malformed,
      });
      return undefined;
    }

    if (opts.requireAnswer && outcome.answered.size === 0) {
      // Enforce mode: an empty roster plus no answers would read as "nobody
      // holds anything". That is never evidence enough to move a byte.
      log(ctx, 'error', 'blob_gc_sweep_aborted', {
        candidates: candidates.length,
        rejected: false,
        missing: [],
        failed: [],
        malformed: 0,
        noHolders: true,
      });
      return undefined;
    }

    // Every answer is readable here (none failed, none malformed), so a
    // per-holder count can be taken straight from the payload.
    const wanted = new Set(candidates);
    const perHolder = new Map<string, number>();
    const answers = (fired.payload as { answers: Array<{ holder: string; refs: Array<{ sha256: string }> }> })
      .answers;
    for (const a of answers) {
      const shas = new Set(a.refs.map((r) => r.sha256).filter((s) => wanted.has(s)));
      perHolder.set(a.holder, (perHolder.get(a.holder) ?? 0) + shas.size);
    }
    return { held: new Set(outcome.held.keys()), perHolder };
  }

  interface Counts {
    discovered: number;
    candidates: number;
    held: number;
    wouldRetire: number;
    wouldRetireBytes: number;
    retired: number;
    restored: number;
    purged: number;
    bytesPurged: number;
  }

  function sweepLine(mode: BlobGcMode, c: Counts): Record<string, unknown> {
    return {
      mode,
      discovered: c.discovered,
      candidates: c.candidates,
      held: c.held,
      retired: c.retired,
      restored: c.restored,
      purged: c.purged,
      bytesPurged: c.bytesPurged,
    };
  }

  /**
   * Enforce: retire one candidate nobody held. The row flips FIRST, and only
   * if it is still live and still older than `cutoff`; a re-put that landed
   * after the ask refreshed `last_put_at`, so it is skipped and its bytes are
   * never moved. Resolves whether the blob was retired.
   */
  async function retireOne(ctx: AgentContext, sha256: string, cutoff: Date): Promise<boolean> {
    const at = now();
    if (!(await store.markRetired(sha256, cutoff, at))) return false;
    try {
      await bus.call('blob:retire', ctx, { sha256 });
    } catch (err) {
      try {
        await store.unmarkRetired(sha256, at);
      } catch (undoErr) {
        // The row stays retired while the bytes may still be live. Harmless:
        // purge only ever deletes the retired copy.
        log(ctx, 'error', 'blob_gc_unretire_failed', { sha256, err: undoErr });
      }
      throw err;
    }
    return true;
  }

  async function runSweep(ctx: AgentContext): Promise<SweepResult> {
    // Read ONCE: an admin flipping the mode mid-sweep takes effect next sweep.
    const { mode, graceMs, retentionMs } = await settings.get();
    const enforce = mode === 'enforce';
    const start = now().getTime();
    const c: Counts = {
      discovered: 0,
      candidates: 0,
      held: 0,
      wouldRetire: 0,
      wouldRetireBytes: 0,
      retired: 0,
      restored: 0,
      purged: 0,
      bytesPurged: 0,
    };
    const abort = (): SweepResult => {
      log(ctx, 'info', 'blob_gc_sweep', { ...sweepLine(mode, c), aborted: true });
      return { outcome: 'aborted' };
    };

    // 1. DISCOVER.
    c.discovered += await discover(ctx, 'live');
    c.discovered += await discover(ctx, 'retired');

    // 2. RETIRE PASS.
    const cutoff = new Date(start - graceMs);
    const perHolder = new Map<string, number>();
    let after: string | undefined;
    for (;;) {
      const batch = await store.candidates(cutoff, after, BLOB_COLLECT_REFS_MAX_CANDIDATES);
      // The first ask goes out even with no candidates (see askHolders).
      if (batch.length === 0 && after !== undefined) break;
      const answer = await askHolders(
        ctx,
        batch.map((b) => b.sha256),
        { requireAnswer: enforce && batch.length > 0 },
      );
      if (answer === undefined) return abort();
      for (const [holder, n] of answer.perHolder) perHolder.set(holder, (perHolder.get(holder) ?? 0) + n);
      c.candidates += batch.length;
      for (const b of batch) {
        if (answer.held.has(b.sha256)) {
          c.held++;
          continue;
        }
        c.wouldRetire++;
        c.wouldRetireBytes += b.size;
        if (enforce && (await retireOne(ctx, b.sha256, cutoff))) c.retired++;
      }
      if (batch.length < BLOB_COLLECT_REFS_MAX_CANDIDATES) break;
      after = batch[batch.length - 1]!.sha256;
    }

    // 3. PURGE PASS (enforce only). Report mode never reaches a byte here,
    // not even one retired by an earlier enforce sweep.
    if (enforce) {
      const purgeCutoff = new Date(start - retentionMs);
      let purgeAfter: string | undefined;
      for (;;) {
        const batch = await store.purgeDue(purgeCutoff, purgeAfter, BLOB_COLLECT_REFS_MAX_CANDIDATES);
        if (batch.length === 0) break;
        // Asked AGAIN: a holder may have started referencing it since retire.
        const answer = await askHolders(
          ctx,
          batch.map((b) => b.sha256),
          { requireAnswer: true },
        );
        if (answer === undefined) return abort();
        for (const b of batch) {
          if (answer.held.has(b.sha256)) {
            // `blob:stat` restores a retired blob on a live miss (D3). Asked
            // for explicitly, so a change of the backends' default cannot
            // silently turn this into a probe.
            const stat = await bus.call<{ sha256: string; restore: boolean }, unknown>('blob:stat', ctx, {
              sha256: b.sha256,
              restore: true,
            });
            if (stat !== null && typeof stat === 'object' && (stat as Record<string, unknown>).found === false) {
              // Someone references bytes that are gone. Nothing the GC can
              // bring back; say so loudly, and stop treating it as retired.
              log(ctx, 'error', 'blob_gc_held_blob_missing', { sha256: b.sha256 });
            }
            await store.markRestored(b.sha256, now());
            c.restored++;
          } else {
            // Deletes the RETIRED copy only. A live copy (a re-put, or a read
            // that restored it) survives, and then so does its row.
            await bus.call('blob:purge', ctx, { sha256: b.sha256 });
            if (await store.deletePurged(b.sha256, purgeCutoff)) {
              c.purged++;
              c.bytesPurged += b.size;
            }
          }
        }
        if (batch.length < BLOB_COLLECT_REFS_MAX_CANDIDATES) break;
        purgeAfter = batch[batch.length - 1]!.sha256;
      }
    }

    // 4. REPORT.
    const report: BlobGcReport = {
      at: now().toISOString(),
      mode,
      discovered: c.discovered,
      candidates: c.candidates,
      held: c.held,
      wouldRetire: c.wouldRetire,
      wouldRetireBytes: c.wouldRetireBytes,
      retired: c.retired,
      restored: c.restored,
      purged: c.purged,
      bytesPurged: c.bytesPurged,
      perHolder: Object.fromEntries([...perHolder].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    };
    const { at: _at, ...fields } = report;
    log(ctx, 'info', 'blob_gc_report', fields);
    log(ctx, 'info', 'blob_gc_sweep', sweepLine(mode, c));
    await bus.call('storage:set', ctx, {
      key: LAST_REPORT_STORAGE_KEY,
      value: new TextEncoder().encode(JSON.stringify(report)),
    });
    return { outcome: 'reported', report };
  }

  return {
    async recordStored(ctx, payload) {
      const p = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
      if (!isBlobSha256(p.sha256) || !isSize(p.size)) {
        log(ctx, 'warn', 'blob_gc_stored_ignored', { reason: 'malformed-payload' });
        return;
      }
      try {
        await store.recordPut(p.sha256, p.size, now());
      } catch (err) {
        // Observe-only: a lost record is repaired by discovery (the row then
        // gets `last_put_at = now()` when the sweep first sees it).
        log(ctx, 'warn', 'blob_gc_record_failed', { sha256: p.sha256, err });
      }
    },

    async sweep() {
      const ctx = sweepContext();
      try {
        const res = await store.withSweepLock(() => runSweep(ctx));
        if (!res.locked) {
          log(ctx, 'debug', 'blob_gc_sweep_skipped', { reason: 'another sweep holds the lock' });
          return { outcome: 'skipped' };
        }
        return res.value;
      } catch (err) {
        log(ctx, 'error', 'blob_gc_sweep_failed', { err });
        return { outcome: 'failed' };
      }
    },

    forgetHolder(holder) {
      return store.forgetHolder(holder);
    },

    async lastReport() {
      const ctx = sweepContext();
      const res = await bus.call<{ key: string }, { value: Uint8Array | undefined }>('storage:get', ctx, {
        key: LAST_REPORT_STORAGE_KEY,
      });
      if (res.value === undefined) return null;
      try {
        return JSON.parse(new TextDecoder().decode(res.value)) as BlobGcReport;
      } catch {
        log(ctx, 'warn', 'blob_gc_report_corrupt', { key: LAST_REPORT_STORAGE_KEY });
        return null;
      }
    },
  };
}
