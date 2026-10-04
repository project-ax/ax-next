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
import type { SettingsStore } from './config.js';
import { PLUGIN_NAME } from './shared.js';
import type { BlobGcStore, BlobRowSummary } from './store.js';

// ---------------------------------------------------------------------------
// The blob GC sweep, REPORT MODE (design D4/D5/D8, "The sweep, end to end"
// steps 1, 2 and 4 in docs/plans/2026-10-03-blob-gc-design.md).
//
//   recordStored — `blob:stored`: refresh that sha's `last_put_at`. Fires on
//                  every put, the backends' fast path included. Never throws.
//   sweep        — under the advisory lock:
//                    1. DISCOVER: page `blob:list { state: 'live' }` and insert
//                       every sha the table has never seen, `last_put_at = now`.
//                    2. CANDIDATES: live rows last put before `now - graceMs`,
//                       in batches of at most 1000, each offered to every
//                       holder through `blob:collect-refs`.
//                    4. REPORT: count the candidates nobody holds and their
//                       bytes, log `blob_gc_report`, and keep it for the admin
//                       Storage tab.
//                  Step 3 (purge) and any retiring belong to TASK-778.
//
// THIS FILE DELETES NOTHING. It never calls a backend write or delete hook; the
// only rows it writes are its own (`blob_gc_v1_*`), plus the report and the
// roster.
//
// FAILS CLOSED, exactly as disk-quota's ledger release does (design D2): a
// vetoed fire, a holder answering `ok: false`, an answer that cannot be read,
// or a ROSTER member that did not answer (it threw, or its plugin is no longer
// loaded) aborts the whole sweep with `blob_gc_sweep_aborted`, and no report
// is written for it. The roster is this plugin's own table; every sweep asks
// at least once (with no candidates if none are old enough), so the roster is
// filled long before anything could ever be deleted.
// ---------------------------------------------------------------------------

/** Where the last complete sweep's report is kept, so every replica serves it. */
export const LAST_REPORT_STORAGE_KEY = 'blob-gc:last-report';

/** Most shas asked for per `blob:list` page. */
const LIST_PAGE_LIMIT = 1000;

export interface BlobGcReport {
  /** When the sweep finished (ISO 8601). */
  at: string;
  mode: 'report';
  /** Blobs found by listing that the table had never seen. */
  discovered: number;
  /** Live blobs past the grace window, offered to the holders. */
  candidates: number;
  /** Candidates some holder still references. */
  held: number;
  /** Candidates nobody references: what enforce mode would retire. */
  wouldRetire: number;
  wouldRetireBytes: number;
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

  async function discover(ctx: AgentContext): Promise<number> {
    let discovered = 0;
    let after: string | undefined;
    for (;;) {
      const raw = await bus.call('blob:list', ctx, {
        state: 'live',
        ...(after !== undefined ? { after } : {}),
        limit: LIST_PAGE_LIMIT,
      });
      const page = readListPage(raw, after);
      discovered += await store.discover(page.items, now());
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

  async function runSweep(ctx: AgentContext): Promise<SweepResult> {
    const discovered = await discover(ctx);

    const { graceMs } = await settings.get();
    const cutoff = new Date(now().getTime() - graceMs);
    let candidates = 0;
    let held = 0;
    let wouldRetire = 0;
    let wouldRetireBytes = 0;
    const perHolder = new Map<string, number>();
    let after: string | undefined;
    for (;;) {
      const batch = await store.candidates(cutoff, after, BLOB_COLLECT_REFS_MAX_CANDIDATES);
      // The first ask goes out even with no candidates (see askHolders).
      if (batch.length === 0 && after !== undefined) break;
      const answer = await askHolders(
        ctx,
        batch.map((b) => b.sha256),
      );
      if (answer === undefined) return { outcome: 'aborted' };
      for (const [holder, n] of answer.perHolder) perHolder.set(holder, (perHolder.get(holder) ?? 0) + n);
      candidates += batch.length;
      for (const b of batch) {
        if (answer.held.has(b.sha256)) {
          held++;
        } else {
          // Report mode: counted, never retired.
          wouldRetire++;
          wouldRetireBytes += b.size;
        }
      }
      if (batch.length < BLOB_COLLECT_REFS_MAX_CANDIDATES) break;
      after = batch[batch.length - 1]!.sha256;
    }

    const report: BlobGcReport = {
      at: now().toISOString(),
      mode: 'report',
      discovered,
      candidates,
      held,
      wouldRetire,
      wouldRetireBytes,
      perHolder: Object.fromEntries([...perHolder].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    };
    const { at: _at, ...fields } = report;
    log(ctx, 'info', 'blob_gc_report', fields);
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
