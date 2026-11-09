/**
 * One sync: copy the registry's latest listings into the mirror, page by page.
 *
 * The recipe is the registry's own aggregator guide (decisions shard,
 * `.claude/memory/decisions/2026-11-09-TASK-1100.md`): the first sync, or the
 * first after a source change, asks for the full list; later ones ask for
 * what changed since the last checkpoint minus WATERMARK_OVERLAP_MS, with the
 * SAME `updated_since` on every page, and save a new checkpoint only after the
 * last page applied. The checkpoint is our clock's start time for the run,
 * never a timestamp from the registry: response data must not be able to move
 * it (a far-future `updatedAt` would freeze every later sync).
 *
 * Only a list asked for with `updated_since` names deleted servers; the full
 * list just leaves them out. So a full crawl starts from an empty mirror and
 * a never-synced state (`store.reset`), as a source change does: a row kept
 * from before it could never be removed.
 *
 * Bounded: at most `maxPages` pages, a cursor seen before ends the run, and
 * the store skips new names past `maxRows`. A failure keeps the copy and the
 * checkpoint, records the attempt, and is logged as a fixed short code: never
 * a URL, a header or a byte of the registry's answer. A shutdown abort is not
 * a failure and records nothing.
 */
import { faultLogFields, type Logger } from '@ax/core';
import { MAX_PAGES_PER_SYNC, MAX_ROWS, WATERMARK_OVERLAP_MS } from './limits.js';
import { planEntry, type DirectoryRow } from './normalize.js';
import {
  RegistryError,
  type PageQuery,
  type RegistryFailure,
  type RegistryPage,
} from './registry-client.js';
import type { DirectoryStore } from './store.js';

export type SyncFailure = RegistryFailure | 'too-many-pages' | 'cursor-loop' | 'store';

export type SyncResult =
  | {
      outcome: 'ok';
      /** True when the run asked for the whole list (no checkpoint to ask from). */
      full: boolean;
      pages: number;
      upserted: number;
      deleted: number;
      /** Entries with no usable name, or not the latest version: they touch nothing. */
      skipped: number;
      /** New names left out because the mirror was full. */
      capped: number;
    }
  | { outcome: 'failed'; reason: SyncFailure }
  | { outcome: 'disabled' };

export interface SyncDeps {
  store: DirectoryStore;
  /** The registry the pages come from; a change clears the mirror first. */
  source: string;
  fetchPage(q: PageQuery): Promise<RegistryPage>;
  now(): Date;
  logger: Logger;
  /** Default MAX_ROWS. */
  maxRows?: number;
  /** Default MAX_PAGES_PER_SYNC. */
  maxPages?: number;
}

/** A failure the crawl itself decides on. */
class CrawlStopped extends Error {
  constructor(readonly reason: 'too-many-pages' | 'cursor-loop') {
    super(`connector directory sync stopped: ${reason}`);
    this.name = 'CrawlStopped';
  }
}

type Totals = Omit<Extract<SyncResult, { outcome: 'ok' }>, 'outcome' | 'full'>;

/** A log line is never worth failing (or un-failing) a sync over. */
function log(
  logger: Logger,
  level: 'info' | 'warn',
  msg: string,
  fields?: Record<string, unknown>,
): void {
  try {
    logger[level](msg, fields);
  } catch {
    // Nothing better to do with a logger that throws.
  }
}

/**
 * Where an incremental sync asks from. No checkpoint: the full list. A
 * checkpoint AFTER this run's start means our clock went back since it was
 * written; asking from it would miss every change until the clock caught up,
 * so the run starts over and crawls in full instead.
 */
function sinceFor(watermark: Date | null, startedAt: Date): Date | undefined {
  if (watermark === null || watermark.getTime() > startedAt.getTime()) return undefined;
  return new Date(watermark.getTime() - WATERMARK_OVERLAP_MS);
}

/** Plan a page's entries; when one name appears twice, the later entry wins. */
function planPage(servers: readonly unknown[]): {
  upserts: DirectoryRow[];
  deletes: string[];
  skipped: number;
} {
  const byId = new Map<string, DirectoryRow | null>();
  let skipped = 0;
  for (const raw of servers) {
    const plan = planEntry(raw);
    if (plan.kind === 'skip') skipped += 1;
    else if (plan.kind === 'upsert') byId.set(plan.row.id, plan.row);
    else byId.set(plan.id, null);
  }
  const upserts: DirectoryRow[] = [];
  const deletes: string[] = [];
  for (const [id, row] of byId) {
    if (row === null) deletes.push(id);
    else upserts.push(row);
  }
  return { upserts, deletes, skipped };
}

async function crawl(deps: SyncDeps): Promise<SyncResult> {
  const maxRows = deps.maxRows ?? MAX_ROWS;
  const maxPages = deps.maxPages ?? MAX_PAGES_PER_SYNC;
  const startedAt = deps.now();

  if (await deps.store.useSource(deps.source)) {
    log(deps.logger, 'info', 'connector_directory_source_changed');
  }
  const state = await deps.store.readState();
  const since = sinceFor(state?.watermark ?? null, startedAt);
  // The full list leaves deleted servers out, so a row kept from before this
  // crawl (a first crawl that failed part way, or a checkpoint our clock has
  // gone back past) would be served forever once the registry deleted it.
  // Nothing correct is lost: a failed first crawl's rows were never served,
  // and every server still listed comes back in this crawl.
  if (since === undefined) await deps.store.reset();

  const totals: Totals = { pages: 0, upserted: 0, deleted: 0, skipped: 0, capped: 0 };
  const followed = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    if (totals.pages >= maxPages) throw new CrawlStopped('too-many-pages');
    const page = await deps.fetchPage({
      ...(since === undefined ? {} : { since }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    totals.pages += 1;

    const { upserts, deletes, skipped } = planPage(page.servers);
    totals.skipped += skipped;
    const applied = await deps.store.applyPage({ upserts, deletes }, maxRows);
    totals.upserted += applied.upserted;
    totals.deleted += applied.deleted;
    totals.capped += applied.capped;

    if (page.nextCursor === undefined) break;
    if (followed.has(page.nextCursor)) throw new CrawlStopped('cursor-loop');
    followed.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  await deps.store.recordSuccess({ watermark: startedAt, syncedAt: deps.now() });
  const full = since === undefined;
  if (totals.capped > 0) {
    log(deps.logger, 'warn', 'connector_directory_row_cap_reached', {
      cap: maxRows,
      skipped: totals.capped,
    });
  }
  log(deps.logger, 'info', 'connector_directory_sync_ok', { full, ...totals });
  return { outcome: 'ok', full, ...totals };
}

/**
 * Run one sync. Never throws: every failure resolves `{ outcome: 'failed' }`
 * with a short code (a RegistryError's reason, the crawl's own, or `store` for
 * anything else), after recording the attempt (a failure to record it is
 * swallowed: the warn line still reports the run). Except `aborted`: the
 * caller stopped the run (shutdown), which is not a failed attempt. Nothing is
 * recorded, so a deploy that lands mid-sync does not leave the copy reading
 * as stale, and the run is logged at info.
 */
export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  try {
    return await crawl(deps);
  } catch (err) {
    const reason: SyncFailure =
      err instanceof RegistryError || err instanceof CrawlStopped ? err.reason : 'store';
    if (reason === 'aborted') {
      log(deps.logger, 'info', 'connector_directory_sync_aborted');
      return { outcome: 'failed', reason };
    }
    try {
      await deps.store.recordFailure(deps.now());
    } catch {
      // Already failing; the line below says so.
    }
    // A database error's message can quote the row it refused: codes only.
    log(
      deps.logger,
      'warn',
      'connector_directory_sync_failed',
      reason === 'store' ? { reason, ...faultLogFields(err) } : { reason },
    );
    return { outcome: 'failed', reason };
  }
}
