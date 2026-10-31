import {
  BLOB_COLLECT_REFS_HOOK,
  BLOB_COLLECT_REFS_MAX_CANDIDATES,
  isOwnerlessId,
  makeAgentContext,
  readBlobCollectRefsAnswers,
  type AgentContext,
  type BlobHolding,
  type HookBus,
  type Logger,
} from '@ax/core';
import { limitBytesOf, type LimitsStore } from './config.js';
import { blobFullMessage, STORAGE_UNAVAILABLE_MESSAGE, workspaceFullMessage } from './messages.js';
import { createLimiter, mapBounded, PLUGIN_NAME } from './shared.js';
import { agentFilesSource, type BlobRow, type DiskQuotaStore } from './store.js';

// ---------------------------------------------------------------------------
// The gates and the meters, kept apart from the plugin wiring so they can be
// tested with a fake store, a fixed clock and a capturing logger.
//
//   admitWorkspaceWrite — `workspace:pre-apply`: refuse a commit that would
//                         push its owner past the limit.
//   admitBlobWrite      — `blob:pre-put`: the same for an upload or a file.
//   recordBlobStored    — `blob:stored`: charge the bytes to the writer.
//   scheduleWorkspaceMeasure — `workspace:applied`: re-measure that agent's
//                         repo off the write's critical path.
//   releaseWorkspace    — `workspace:deleted`: the agent's repo is gone, so
//                         drop its row and give the owner the room back.
//   scheduleAgentFilesMeasure — `chat:turn-end` (the assistant one): measure
//                         that agent's `/files` through
//                         `sandbox:user-files-usage`, off the turn's path, and
//                         charge it to the agent's OWNER (TASK-993).
//   releaseAgentFiles   — `agents:deleted`: tombstone the agent, wait out a
//                         measurement in flight, drop its agent-files row.
//   reconcile           — the periodic sweep: every personal agent's
//                         workspace, then every personal agent's `/files`,
//                         then the BLOB PASS (releaseBlobs).
//   releaseBlobs        — drop an (owner, blob:<sha>) charge once it is past
//                         the grace window and no holder says that owner
//                         still holds the sha (design D6), but never so that
//                         bytes that still exist end up charged to nobody: a
//                         sha held by others goes only while one of them is
//                         charged for it, a sha held by nobody only once
//                         `blob:stat` says its bytes are gone. Fails CLOSED.
//
// Error posture is deliberately lopsided (the same as @ax/usage-limits):
//   - The GATES fail CLOSED. HookBus.fire isolates a throwing subscriber and
//     carries on, which on a disk guard would mean "database down = no
//     limit". So a gate never throws; any failure becomes a refusal.
//   - The METERS never throw. A metering hiccup is one log line, never a
//     failed commit or a failed upload.
// ---------------------------------------------------------------------------

/**
 * A refusal of a WRITE carries prose (see messages.ts), shown verbatim, and, when
 * the refusal is because the person's storage is full, ALSO `code:
 * STORAGE_FULL_REASON`, so a caller that must treat "full" differently (an HTTP
 * status, a banner) keys on the code instead of matching the sentence. The
 * fail-closed "could not check your storage" refusal has NO code: it is not the
 * same thing, and a caller keyed on `storage-full` must not see it. Only WRITES
 * are ever refused: a full person's turn is never turned away (TASK-993).
 */
export type AdmitDecision = { ok: true } | { ok: false; reason: string; code?: string };

/**
 * The stable code for "this person's storage is full": the `code` on a write
 * refused for that cause. (It is no longer a `chat:start` veto reason, TASK-993;
 * channel-web keeps its `chat:start:storage-full` label for replayed history.)
 */
export const STORAGE_FULL_REASON = 'storage-full';

export interface ReconcileResult {
  /**
   * Measurements recorded: workspaces AND agent files (one per agent per
   * pass that ran, TASK-993).
   */
  measured: number;
  /**
   * Measurements the sweep tried but could not record, of either kind (a
   * deleted agent still listed counts here too).
   */
  failed: number;
  /** Blob ledger rows (one owner's charge for one sha) the blob pass released. */
  blobsReleased: number;
  /**
   * The blob pass stopped early: a holder failed or went missing, an answer
   * could not be read, the fire was vetoed, or the pass itself broke. Rows
   * released by batches BEFORE the abort stand (see releaseBlobs).
   */
  blobReleaseAborted: boolean;
}

export interface BlobReleaseResult {
  released: number;
  aborted: boolean;
}

export interface DiskQuotaService {
  admitWorkspaceWrite(ctx: AgentContext, sizeBytes: number): Promise<AdmitDecision>;
  admitBlobWrite(ctx: AgentContext, sizeBytes: number): Promise<AdmitDecision>;
  recordBlobStored(ctx: AgentContext, payload: unknown): Promise<void>;
  /** Fire-and-track: never awaited by the caller, never throws. */
  scheduleWorkspaceMeasure(ctx: AgentContext): void;
  /**
   * `workspace:deleted`: the agent's repo is gone, so drop its ledger row (for
   * every owner) and free that room. Takes the raw payload field, because the
   * subscriber must not trust it: anything that is not a non-empty string
   * deletes nothing. Never throws.
   */
  releaseWorkspace(agentId: unknown): Promise<void>;
  /**
   * `chat:turn-end`: measure this context's agent's `/files` in the
   * background (coalesced per agent, at most FILES_MEASURE_CONCURRENCY walks
   * at once) and charge it to the agent's owner. Fire-and-track: never awaited
   * by the caller, never throws.
   */
  scheduleAgentFilesMeasure(ctx: AgentContext): void;
  /**
   * `agents:deleted`: the agent is gone for good. Tombstone it (nothing
   * measures it again in this process), wait out a measurement in flight, and
   * drop its agent-files row for every owner. Takes the raw payload field:
   * anything that is not a non-empty string does nothing. Never throws.
   */
  releaseAgentFiles(agentId: unknown): Promise<void>;
  /**
   * Sweep every personal agent's workspace, then every personal agent's
   * `/files` (each pass skipped, adding 0, when a hook it needs is absent),
   * then run the blob pass, which needs none of those hooks. Never throws.
   */
  reconcile(): Promise<ReconcileResult>;
  /** The blob pass on its own (reconcile runs it). Never throws. */
  releaseBlobs(): Promise<BlobReleaseResult>;
  /** Resolves once every background measurement has settled. */
  drain(): Promise<void>;
  /** Who a write in this context is charged to; undefined when nobody. */
  ownerOf(ctx: AgentContext): Promise<string | undefined>;
}

/** Answers cached per agent; cleared wholesale past this many entries. */
export const OWNER_CACHE_MAX = 5000;
/** The sweep measures this many agents at once. */
export const SWEEP_CONCURRENCY = 2;
/** The blob pass asks `blob:stat` about this many unheld shas at once. */
export const BLOB_STAT_CONCURRENCY = 8;

/**
 * The provider hook that measures one agent's `/files` (TASK-993): input
 * `{ agentId }`, answer `{ bytes }` (allocated bytes). Host-internal, registered
 * by the sandbox provider. Called by name and its answer read as `unknown`:
 * this plugin imports nothing from the provider's package.
 */
export const AGENT_FILES_USAGE_HOOK = 'sandbox:user-files-usage';
/**
 * At most this many agent-files measurements run at once in this process,
 * turn ends and the sweep together. Each is a directory walk of a tree an
 * agent controls, so a burst of turn ends must not become a burst of walks.
 */
export const FILES_MEASURE_CONCURRENCY = 2;
/**
 * The provider's error code for "this deployment cannot measure agent files at
 * all" (k8s without the read-only host mount). A fact about the deployment, not
 * a failed measurement: after the first one this process stops asking, and logs
 * it once at info instead of a warn on every turn end.
 */
export const FILES_USAGE_UNAVAILABLE_CODE = 'user-files-usage-unavailable';

/**
 * A user id that names a person the ledger can be charged to. The empty id and
 * the two system principals are not people; an owner-less stand-in is not
 * anybody either.
 */
export function isAttributableUser(userId: unknown): userId is string {
  return (
    typeof userId === 'string' &&
    userId.length > 0 &&
    userId !== 'system' &&
    userId !== 'init' &&
    !isOwnerlessId(userId)
  );
}

/** A size the gate can add: a finite number >= 0, else 0. */
export function cleanSize(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * The unit a stored blob is charged in. The fs blob backend keeps ONE FILE PER
 * BLOB, so however small the blob, it occupies at least a filesystem block and
 * an inode. Charging logical bytes let a looping agent make millions of tiny
 * artifacts "inside" its quota and exhaust the shared volume; whole units make
 * a blob cost roughly what it costs the volume (the same currency the workspace
 * meter uses: allocated bytes). The S3 backend has no such overhead, so there
 * this over-counts by up to one unit per blob, which errs on the safe side.
 */
export const BLOB_ALLOCATION_UNIT = 4096;

/** What one blob of `size` logical bytes is charged: whole units, at least one. */
export function blobCharge(size: unknown): number {
  return Math.max(1, Math.ceil(cleanSize(size) / BLOB_ALLOCATION_UNIT)) * BLOB_ALLOCATION_UNIT;
}

function usableAgentId(agentId: unknown): agentId is string {
  return typeof agentId === 'string' && agentId.length > 0 && !isOwnerlessId(agentId);
}

/** Log without ever letting a broken logger change the outcome. */
function log(
  ctx: AgentContext,
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  bindings?: Record<string, unknown>,
): void {
  try {
    ctx.logger[level](msg, bindings);
  } catch {
    /* a broken logger must not turn a refusal into a pass, or a meter into a failure */
  }
}

export function createDiskQuotaService(deps: {
  bus: HookBus;
  store: DiskQuotaStore;
  limits: LimitsStore;
  /** For the sweep's own contexts (no request to borrow a logger from). */
  logger?: Logger;
  /** Injected clock: the blob pass's grace cutoff is measured from it. */
  now?: () => Date;
}): DiskQuotaService {
  const { bus, store, limits } = deps;
  const now = deps.now ?? (() => new Date());
  const sweepLogger: { logger?: Logger } = deps.logger === undefined ? {} : { logger: deps.logger };

  // ---- who pays ------------------------------------------------------------

  const ownerCache = new Map<string, string>();
  /**
   * Agents `agents:deleted` has announced. Never cleared (agent ids are never
   * reused; the TASK-719 precedent), so a warm runner's late turn end or a
   * sweep that listed the agent just before the delete measures nothing.
   */
  const deletedAgents = new Set<string>();

  /**
   * The agent's own owner per `agents:resolve` (`team:<id>` for a team agent),
   * cached; undefined when there is no usable agent, no resolver, or no usable
   * answer. No fallback to the acting user: see ownerOf for that.
   */
  async function resolveAgentOwner(ctx: AgentContext): Promise<string | undefined> {
    const agentId = ctx.agentId;
    if (!usableAgentId(agentId) || !bus.hasService('agents:resolve')) return undefined;
    const cached = ownerCache.get(agentId);
    if (cached !== undefined) return cached;
    try {
      const out = await bus.call<
        { agentId: string; userId: string },
        { agent?: { ownerId?: unknown; ownerType?: unknown } } | null
      >('agents:resolve', ctx, { agentId, userId: ctx.userId });
      const agent = out?.agent;
      if (typeof agent?.ownerId === 'string' && agent.ownerId.length > 0) {
        const owner = agent.ownerType === 'team' ? `team:${agent.ownerId}` : agent.ownerId;
        // A resolve that was in flight across the delete must not re-cache it.
        if (!deletedAgents.has(agentId)) {
          if (ownerCache.size >= OWNER_CACHE_MAX) ownerCache.clear();
          ownerCache.set(agentId, owner);
        }
        return owner;
      }
      log(ctx, 'debug', 'disk_quota_owner_unusable', { agentId });
    } catch (err) {
      log(ctx, 'debug', 'disk_quota_owner_unresolved', { agentId, err });
    }
    return undefined;
  }

  /**
   * Who a WRITE in this context is charged to: the agent's owner, else (not
   * resolvable: no such agent, no access, resolver down) the acting user. A
   * wrong-but-real owner beats an unmetered write. The agent-files meter does
   * NOT use this: it charges resolveAgentOwner or nobody.
   */
  async function ownerOf(ctx: AgentContext): Promise<string | undefined> {
    const owner = await resolveAgentOwner(ctx);
    if (owner !== undefined) return owner;
    return isAttributableUser(ctx.userId) ? ctx.userId : undefined;
  }

  // ---- the gates -----------------------------------------------------------

  async function admit(
    owner: string,
    sizeBytes: number,
    refusal: (usedBytes: number, limitBytes: number) => string,
  ): Promise<AdmitDecision> {
    const [current, usage] = await Promise.all([limits.get(), store.usageFor(owner)]);
    const { limitBytes } = limitBytesOf(current);
    const usedBytes = usage.workspaceBytes + usage.fileBytes;
    // A write may land EXACTLY on the limit; one byte past it is refused.
    if (usedBytes + cleanSize(sizeBytes) > limitBytes) {
      return { ok: false, reason: refusal(usedBytes, limitBytes), code: STORAGE_FULL_REASON };
    }
    return { ok: true };
  }

  const OK: AdmitDecision = { ok: true };

  async function admitWorkspaceWrite(ctx: AgentContext, sizeBytes: number): Promise<AdmitDecision> {
    try {
      const owner = await ownerOf(ctx);
      if (owner === undefined) {
        // Nobody to charge: a system write. Say so rather than pass silently.
        log(ctx, 'warn', 'disk_quota_workspace_write_unattributed', { agentId: ctx.agentId });
        return OK;
      }
      return await admit(owner, sizeBytes, workspaceFullMessage);
    } catch (err) {
      log(ctx, 'error', 'disk_quota_admit_failed', { kind: 'workspace', err });
      return { ok: false, reason: STORAGE_UNAVAILABLE_MESSAGE };
    }
  }

  async function admitBlobWrite(ctx: AgentContext, sizeBytes: number): Promise<AdmitDecision> {
    try {
      // The branding logo and the skill paths with no owner write as `system`.
      // They are not a person's storage, and refusing them would break admin
      // work over someone else's usage.
      if (!isAttributableUser(ctx.userId)) return OK;
      return await admit(ctx.userId, blobCharge(sizeBytes), blobFullMessage);
    } catch (err) {
      log(ctx, 'error', 'disk_quota_admit_failed', { kind: 'blob', err });
      return { ok: false, reason: STORAGE_UNAVAILABLE_MESSAGE };
    }
  }

  // ---- the meters ----------------------------------------------------------

  async function recordBlobStored(ctx: AgentContext, payload: unknown): Promise<void> {
    try {
      if (!isAttributableUser(ctx.userId)) return;
      const p = (payload ?? {}) as { sha256?: unknown; size?: unknown };
      const size = p.size;
      if (
        typeof p.sha256 !== 'string' ||
        p.sha256.length === 0 ||
        p.sha256.length > 128 ||
        typeof size !== 'number' ||
        !Number.isFinite(size) ||
        size < 0
      ) {
        log(ctx, 'warn', 'disk_quota_blob_stored_invalid');
        return;
      }
      await store.upsertUsage(ctx.userId, `blob:${p.sha256}`, 'blob', blobCharge(size));
    } catch (err) {
      log(ctx, 'error', 'disk_quota_record_failed', { err });
    }
  }

  /**
   * Measure one agent's workspace and record it. Resolves true when a figure
   * was recorded. NEVER throws.
   */
  async function measureOnce(ctx: AgentContext, ownerOverride?: string): Promise<boolean> {
    try {
      if (!bus.hasService('workspace:usage')) return false;
      if (!usableAgentId(ctx.agentId)) return false;
      const owner = ownerOverride ?? (await ownerOf(ctx));
      if (owner === undefined) {
        log(ctx, 'debug', 'disk_quota_measure_unattributed', { agentId: ctx.agentId });
        return false;
      }
      const out = await bus.call<Record<string, never>, { bytes?: unknown } | null>(
        'workspace:usage',
        ctx,
        {},
      );
      const bytes = out?.bytes;
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
        log(ctx, 'warn', 'disk_quota_usage_invalid', { agentId: ctx.agentId });
        return false;
      }
      await store.upsertUsage(owner, `workspace:${ctx.agentId}`, 'workspace', bytes);
      return true;
    } catch (err) {
      log(ctx, 'warn', 'disk_quota_measure_failed', { agentId: ctx.agentId, err });
      return false;
    }
  }

  // One measurement per agent at a time. A write that lands while one is
  // running asks for a fresh measurement afterwards, so a slow, stale reading
  // can never be the LAST one written.
  // `done` settles when that agent's whole measuring loop has, so a release can
  // wait for it (see releaseWorkspace).
  const measuring = new Map<string, { again: boolean; ctx: AgentContext; done?: Promise<void> }>();
  const inflight = new Set<Promise<void>>();

  function track(p: Promise<unknown>, ctx: AgentContext): void {
    const wrapped: Promise<void> = p
      .then(
        () => undefined,
        (err: unknown) => log(ctx, 'warn', 'disk_quota_background_failed', { err }),
      )
      .finally(() => {
        inflight.delete(wrapped);
      });
    inflight.add(wrapped);
  }

  function scheduleWorkspaceMeasure(ctx: AgentContext): void {
    const agentId = ctx.agentId;
    if (!usableAgentId(agentId)) return;
    const running = measuring.get(agentId);
    if (running !== undefined) {
      running.again = true;
      running.ctx = ctx;
      return;
    }
    const state: { again: boolean; ctx: AgentContext; done?: Promise<void> } = { again: false, ctx };
    measuring.set(agentId, state);
    const run = (async () => {
      try {
        do {
          state.again = false;
          await measureOnce(state.ctx);
        } while (state.again);
      } finally {
        measuring.delete(agentId);
      }
    })();
    state.done = run;
    track(run, ctx);
  }

  async function releaseWorkspace(agentId: unknown): Promise<void> {
    // No request to borrow a logger from: the notice carries an id and nothing else.
    const ctx = makeAgentContext({
      sessionId: 'disk-quota-release',
      agentId: PLUGIN_NAME,
      userId: 'system',
      ...sweepLogger,
    });
    try {
      if (typeof agentId !== 'string' || agentId.length === 0) {
        log(ctx, 'warn', 'disk_quota_workspace_deleted_invalid');
        return;
      }
      // A measurement already walking this repo would upsert its (now stale)
      // figure AFTER the delete below and re-create the row, and nothing ever
      // repairs that: the sweep only upserts, and the agent is no longer listed.
      // Let it land first, then delete. It never rejects today (see
      // scheduleWorkspaceMeasure), but the `.catch` makes that a guarantee: a
      // future rejection must not be able to skip the delete.
      //
      // KNOWN RESIDUAL: this only covers the write-triggered measurements. The
      // periodic sweep (`reconcile`) calls `measureOnce` directly and bypasses
      // the `measuring` map, so a sweep measurement already mid-walk when the
      // agent is deleted can still upsert a stale figure afterwards. The window
      // is narrow (one sweep per 6 h, two agents at a time). A measurement (or a
      // write) that STARTS after the delete is not the problem: workspace-git
      // refuses it with `agent-deleted` (TASK-719), so `measureOnce` records a
      // failure and writes nothing. Deliberately not fixed here: the sweep is
      // unchanged.
      await measuring.get(agentId)?.done?.catch(() => undefined);
      const removed = await store.deleteWorkspaceUsage(agentId);
      log(ctx, 'debug', 'disk_quota_workspace_released', { agentId, removed });
    } catch (err) {
      // An error, not a warn: a row left behind keeps charging the owner for
      // bytes that are gone, and nothing else takes it out. So it names the agent
      // (this context's own agentId is the plugin's): it is the line an operator
      // acts on. `agentId` is a validated string on every path that reaches here.
      log(ctx, 'error', 'disk_quota_release_failed', { agentId, err });
    }
  }

  // ---- agent files (TASK-993) ---------------------------------------------

  /** Every agent-files walk in this process runs through this. */
  const filesLimiter = createLimiter(FILES_MEASURE_CONCURRENCY);
  /** Set once the provider says this deployment cannot measure agent files. */
  let filesUsageUnavailable = false;
  const filesMeasurable = (): boolean =>
    !filesUsageUnavailable && bus.hasService(AGENT_FILES_USAGE_HOOK);
  const DELETED_WHILE_QUEUED = Symbol('deleted-while-queued');

  /**
   * Measure one agent's `/files` and record it for its owner (`ownerOverride`,
   * the sweep's listed owner, else resolveAgentOwner: never the acting user).
   * Resolves true only when a row was written. NEVER throws: a failure keeps
   * the previous figure and is one warn.
   */
  async function measureAgentFilesOnce(ctx: AgentContext, ownerOverride?: string): Promise<boolean> {
    const agentId = ctx.agentId;
    try {
      if (!filesMeasurable()) return false;
      if (!usableAgentId(agentId) || deletedAgents.has(agentId)) return false;
      const owner = ownerOverride ?? (await resolveAgentOwner(ctx));
      if (owner === undefined) {
        // Nobody to charge. Charging the acting user instead would leave a
        // second row for the same files once the owner resolves again.
        log(ctx, 'debug', 'disk_quota_files_unattributed', { agentId });
        return false;
      }
      // Deleted while it queued for a slot: do not walk a tree that is being
      // removed (and do not make the release wait for that walk).
      const out = await filesLimiter.run(async () =>
        deletedAgents.has(agentId)
          ? DELETED_WHILE_QUEUED
          : bus.call<{ agentId: string }, unknown>(AGENT_FILES_USAGE_HOOK, ctx, { agentId }),
      );
      if (out === DELETED_WHILE_QUEUED) return false;
      const bytes =
        out !== null && typeof out === 'object' ? (out as { bytes?: unknown }).bytes : undefined;
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
        log(ctx, 'warn', 'disk_quota_files_usage_invalid', { agentId });
        return false;
      }
      // Deleted while we walked: write nothing. This check and the start of
      // the upsert are in the same tick, and a release that tombstoned the
      // agent before this point waits for this whole measurement
      // (measuringFiles) before it deletes, so the row cannot outlive it.
      if (deletedAgents.has(agentId)) return false;
      await store.upsertUsage(owner, agentFilesSource(agentId), 'agent-files', bytes);
      return true;
    } catch (err) {
      if (
        err !== null &&
        typeof err === 'object' &&
        (err as { code?: unknown }).code === FILES_USAGE_UNAVAILABLE_CODE
      ) {
        if (!filesUsageUnavailable) {
          filesUsageUnavailable = true;
          log(ctx, 'info', 'disk_quota_files_usage_unavailable', { agentId });
        }
        return false;
      }
      log(ctx, 'warn', 'disk_quota_files_measure_failed', { agentId, err });
      return false;
    }
  }

  interface FilesMeasuring {
    again: boolean;
    ctx: AgentContext;
    owner: string | undefined;
    done: Promise<boolean>;
  }
  // One agent-files measurement per agent at a time, turn ends AND the sweep,
  // so a release can wait for whatever is in flight. A request that lands while
  // one runs asks for one fresh measurement afterwards (with its own ctx and
  // owner), so a slow, stale reading is never the last one written.
  const measuringFiles = new Map<string, FilesMeasuring>();

  /** Resolves true when the LAST measurement of the loop recorded a row. Never rejects. */
  function measureAgentFiles(ctx: AgentContext, ownerOverride?: string): Promise<boolean> {
    const agentId = ctx.agentId;
    const running = measuringFiles.get(agentId);
    if (running !== undefined) {
      running.again = true;
      running.ctx = ctx;
      running.owner = ownerOverride;
      return running.done;
    }
    const state = { again: false, ctx, owner: ownerOverride } as FilesMeasuring;
    measuringFiles.set(agentId, state);
    state.done = (async () => {
      let ok = false;
      try {
        do {
          state.again = false;
          ok = await measureAgentFilesOnce(state.ctx, state.owner);
        } while (state.again);
      } finally {
        measuringFiles.delete(agentId);
      }
      return ok;
    })();
    return state.done;
  }

  function scheduleAgentFilesMeasure(ctx: AgentContext): void {
    const agentId = ctx.agentId;
    if (!usableAgentId(agentId) || deletedAgents.has(agentId)) return;
    if (!filesMeasurable()) return;
    track(measureAgentFiles(ctx), ctx);
  }

  async function releaseAgentFiles(agentId: unknown): Promise<void> {
    const ctx = makeAgentContext({
      sessionId: 'disk-quota-release',
      agentId: PLUGIN_NAME,
      userId: 'system',
      ...sweepLogger,
    });
    try {
      if (typeof agentId !== 'string' || agentId.length === 0) {
        log(ctx, 'warn', 'disk_quota_agents_deleted_invalid');
        return;
      }
      // Before any await: from here on nothing starts measuring this agent,
      // and nothing in flight writes past its pre-upsert check.
      deletedAgents.add(agentId);
      ownerCache.delete(agentId);
      // A measurement already past that check is inside this loop; let it land,
      // then delete. `done` never rejects; the `.catch` makes that a guarantee.
      await measuringFiles.get(agentId)?.done.catch(() => false);
      const removed = await store.deleteAgentFilesUsage(agentId);
      log(ctx, 'debug', 'disk_quota_agent_files_released', { agentId, removed });
    } catch (err) {
      // An error, not a warn: a row left behind keeps charging the owner for
      // files that are gone. `agentId` is a validated string on every path here.
      log(ctx, 'error', 'disk_quota_release_failed', { agentId, err });
    }
  }

  function sweepContext(): AgentContext {
    return makeAgentContext({
      sessionId: 'disk-quota-sweep',
      agentId: PLUGIN_NAME,
      userId: 'system',
      ...sweepLogger,
    });
  }

  async function sweepWorkspaces(): Promise<{ measured: number; failed: number }> {
    const sweepCtx = sweepContext();
    try {
      if (!bus.hasService('agents:list-personal-owners') || !bus.hasService('workspace:usage')) {
        log(sweepCtx, 'debug', 'disk_quota_sweep_skipped');
        return { measured: 0, failed: 0 };
      }
      const listed = await listPersonalAgents(sweepCtx);
      let measured = 0;
      let failed = 0;
      await mapBounded(listed, SWEEP_CONCURRENCY, async (a) => {
        if (await measureOnce(agentSweepContext(a), a.ownerUserId)) measured++;
        else failed++;
      });
      log(sweepCtx, 'info', 'disk_quota_sweep_done', { measured, failed });
      return { measured, failed };
    } catch (err) {
      log(sweepCtx, 'warn', 'disk_quota_sweep_failed', { err });
      return { measured: 0, failed: 0 };
    }
  }

  /**
   * Every personal agent's `/files`, charged to its listed owner, through the
   * same per-agent coalescing as the turn-end meter (so a release waits for a
   * sweep walk too). Needs the listing AND the provider; skipped otherwise.
   */
  async function sweepAgentFiles(): Promise<{ measured: number; failed: number }> {
    const sweepCtx = sweepContext();
    try {
      if (
        !bus.hasService('agents:list-personal-owners') ||
        !filesMeasurable()
      ) {
        log(sweepCtx, 'debug', 'disk_quota_files_sweep_skipped');
        return { measured: 0, failed: 0 };
      }
      const listed = await listPersonalAgents(sweepCtx);
      let measured = 0;
      let failed = 0;
      await mapBounded(listed, SWEEP_CONCURRENCY, async (a) => {
        if (await measureAgentFiles(agentSweepContext(a), a.ownerUserId)) measured++;
        else failed++;
      });
      log(sweepCtx, 'info', 'disk_quota_files_sweep_done', { measured, failed });
      return { measured, failed };
    } catch (err) {
      log(sweepCtx, 'warn', 'disk_quota_files_sweep_failed', { err });
      return { measured: 0, failed: 0 };
    }
  }

  /** Personal agents with a usable id and a person as owner; malformed entries dropped. */
  async function listPersonalAgents(
    sweepCtx: AgentContext,
  ): Promise<Array<{ agentId: string; ownerUserId: string }>> {
    const out = await bus.call<Record<string, never>, { agents?: unknown }>(
      'agents:list-personal-owners',
      sweepCtx,
      {},
    );
    const listed: Array<{ agentId: string; ownerUserId: string }> = [];
    if (Array.isArray(out?.agents)) {
      for (const a of out.agents as Array<{ agentId?: unknown; ownerUserId?: unknown }>) {
        if (usableAgentId(a?.agentId) && isAttributableUser(a?.ownerUserId)) {
          listed.push({ agentId: a.agentId, ownerUserId: a.ownerUserId });
        }
      }
    }
    return listed;
  }

  /** One agent's own sweep context: measured AS its owner, in a sweep session. */
  function agentSweepContext(a: { agentId: string; ownerUserId: string }): AgentContext {
    return makeAgentContext({
      sessionId: 'disk-quota-sweep',
      agentId: a.agentId,
      userId: a.ownerUserId,
      ...sweepLogger,
    });
  }

  /**
   * Ask every holder about one batch of candidate shas (possibly none: an
   * empty ask still records who answers, so the roster is filled long before
   * anything is stale, design D2). Resolves the reading when the answers can
   * be trusted, or undefined after logging why not. Every holder that
   * answered at all joins the roster first, ok or not.
   */
  async function askHolders(
    ctx: AgentContext,
    candidates: string[],
  ): Promise<ReturnType<typeof readBlobCollectRefsAnswers> | undefined> {
    const roster = await store.listRefHolders();
    const fired = await bus.fire(BLOB_COLLECT_REFS_HOOK, ctx, {
      candidates: [...candidates],
      answers: [],
    });
    if (fired.rejected) {
      log(ctx, 'error', 'disk_quota_blob_release_aborted', {
        candidates: candidates.length,
        rejected: true,
        source: fired.source,
        missing: [],
        failed: [],
        malformed: 0,
      });
      return undefined;
    }
    // Judged against OUR candidate list, not the (rewritable) payload's.
    const outcome = readBlobCollectRefsAnswers(fired.payload, candidates);
    if (outcome.answered.size > 0) await store.touchRefHolders([...outcome.answered]);
    const missing = roster.filter((h) => !outcome.answered.has(h)).sort();
    if (missing.length > 0 || outcome.failed.length > 0 || outcome.malformed > 0) {
      // An error, not a warn: a missing holder that is really gone stays
      // missing until an admin forgets it, and until then nobody gets a
      // released charge back. This is the line an operator acts on.
      log(ctx, 'error', 'disk_quota_blob_release_aborted', {
        candidates: candidates.length,
        rejected: false,
        missing,
        failed: outcome.failed,
        malformed: outcome.malformed,
      });
      return undefined;
    }
    return outcome;
  }

  /**
   * Of the shas nobody holds, the ones whose bytes the blob store says are
   * GONE (`blob:stat` answered exactly `{ found: false }`). Anything else (a
   * size, an odd answer, a throw, no `blob:stat` at all) means "maybe still
   * there", and that sha keeps its charge. Never throws.
   *
   * Asks with `restore: false` (TASK-778). The byte GC retires exactly the
   * shas this pass probes, and a plain `blob:stat` moves a retired blob back
   * to live. Probing with a restoring stat would revive every retired blob on
   * each reconcile, so its bytes would never be purged and its charge never
   * released. A retired blob still answers `{ size }`: its bytes exist until
   * the GC's purge, and until then someone keeps paying for them.
   */
  async function bytesGone(ctx: AgentContext, shas: readonly string[]): Promise<Set<string>> {
    const gone = new Set<string>();
    if (shas.length === 0) return gone;
    if (!bus.hasService('blob:stat')) {
      log(ctx, 'info', 'disk_quota_blob_release_unverifiable', { shas: shas.length });
      return gone;
    }
    let failed = 0;
    await mapBounded(shas, BLOB_STAT_CONCURRENCY, async (sha256) => {
      try {
        const out = await bus.call<{ sha256: string; restore: false }, unknown>('blob:stat', ctx, {
          sha256,
          restore: false,
        });
        if (
          out !== null &&
          typeof out === 'object' &&
          (out as Record<string, unknown>).found === false &&
          !('size' in out)
        ) {
          gone.add(sha256);
        }
      } catch (err) {
        failed++;
        log(ctx, 'debug', 'disk_quota_blob_stat_failed', { sha256, err });
      }
    });
    if (failed > 0) log(ctx, 'warn', 'disk_quota_blob_stat_failed', { failed, of: shas.length });
    return gone;
  }

  /**
   * Which of these stale rows may go. Per sha:
   *   1. held for nobody in particular (some ref with `userIds: []`): none;
   *   2. held by named people U: the row of an owner outside U goes ONLY IF
   *      someone in U is still charged for that sha (a row of any age);
   *      otherwise every row stays, because the bytes exist and someone has to
   *      keep paying for them;
   *   3. held by nobody: the rows go ONLY IF the bytes are confirmed gone
   *      (`blob:stat` says `{ found: false }`; see bytesGone).
   *
   * The invariant: this pass never leaves bytes that still exist charged to
   * nobody. A charge for unreferenced bytes is given back only once the bytes
   * are gone (the later byte GC's purge), and one owner's share of shared bytes
   * is released only while someone listed is still charged for them. Without
   * this, upload to the limit, drop every reference, wait out the grace window
   * and repeat would grow the shared volume without bound.
   */
  async function releasableRows(
    ctx: AgentContext,
    rows: readonly BlobRow[],
    held: ReadonlyMap<string, BlobHolding>,
  ): Promise<BlobRow[]> {
    const shas = [...new Set(rows.map((r) => r.sha256))];
    const unheld = shas.filter((s) => !held.has(s));
    const shared = shas.filter((s) => {
      const h = held.get(s);
      if (h === undefined || h.unattributed) return false;
      return rows.some((r) => r.sha256 === s && !h.userIds.has(r.ownerId));
    });
    const payers = new Map<string, Set<string>>();
    for (const r of await store.chargedOwners(shared)) {
      let set = payers.get(r.sha256);
      if (set === undefined) payers.set(r.sha256, (set = new Set()));
      set.add(r.ownerId);
    }
    const gone = await bytesGone(ctx, unheld);
    return rows.filter((r) => {
      const h = held.get(r.sha256);
      if (h === undefined) return gone.has(r.sha256);
      if (h.unattributed || h.userIds.has(r.ownerId)) return false;
      const charged = payers.get(r.sha256);
      return charged !== undefined && [...h.userIds].some((u) => charged.has(u));
    });
  }

  /**
   * The blob pass (design D6). Takes this plugin's own `blob:<sha>` rows last
   * written before `now - graceMs`, in batches of at most
   * BLOB_COLLECT_REFS_MAX_CANDIDATES shas, asks every holder about each batch
   * through `blob:collect-refs`, and drops the (owner, sha) rows the release
   * rule allows (releasableRows): an owner no holder lists loses their charge
   * while a listed holder is still charged for the same bytes; a sha held for
   * nobody in particular (`userIds: []`) releases nothing at all; a sha held
   * by nobody is released only once `blob:stat` confirms its bytes are gone.
   * The pass never leaves bytes that still exist charged to nobody.
   *
   * FAILS CLOSED: a vetoed fire, a holder answering `ok: false`, an answer that
   * cannot be read, or a roster member that did not answer (it threw, or its
   * plugin is no longer loaded) releases NOTHING for that batch and stops the
   * pass. Batches already done stay done: each was decided on a complete set
   * of answers for its own shas, so an abort later says nothing about them.
   *
   * The DELETE re-checks the row's age, so a re-put landing between the ask
   * and the delete (it refreshes `updated_at`) keeps its row. Never throws.
   */
  async function releaseBlobs(): Promise<BlobReleaseResult> {
    const ctx = sweepContext();
    let released = 0;
    let candidatesSeen = 0;
    try {
      const { graceMs } = await limits.get();
      const cutoff = new Date(now().getTime() - graceMs);
      let after: string | undefined;
      for (;;) {
        const shas = await store.staleBlobShas(cutoff, after, BLOB_COLLECT_REFS_MAX_CANDIDATES);
        // The first ask goes out even with no candidates (see askHolders).
        if (shas.length === 0 && after !== undefined) break;
        candidatesSeen += shas.length;
        const outcome = await askHolders(ctx, shas);
        if (outcome === undefined) return { released, aborted: true };
        if (shas.length === 0) break;

        const rows = await store.staleBlobRows(shas, cutoff);
        const release = await releasableRows(ctx, rows, outcome.held);
        if (release.length > 0) released += await store.releaseBlobRows(release, cutoff);
        if (shas.length < BLOB_COLLECT_REFS_MAX_CANDIDATES) break;
        after = shas[shas.length - 1];
      }
      log(ctx, 'info', 'disk_quota_blob_release_done', { candidates: candidatesSeen, released });
      return { released, aborted: false };
    } catch (err) {
      log(ctx, 'error', 'disk_quota_blob_release_failed', { released, err });
      return { released, aborted: true };
    }
  }

  async function reconcile(): Promise<ReconcileResult> {
    const workspaces = await sweepWorkspaces();
    const files = await sweepAgentFiles();
    const blobs = await releaseBlobs();
    return {
      measured: workspaces.measured + files.measured,
      failed: workspaces.failed + files.failed,
      blobsReleased: blobs.released,
      blobReleaseAborted: blobs.aborted,
    };
  }

  return {
    admitWorkspaceWrite,
    admitBlobWrite,
    recordBlobStored,
    scheduleWorkspaceMeasure,
    releaseWorkspace,
    scheduleAgentFilesMeasure,
    releaseAgentFiles,
    reconcile,
    releaseBlobs,
    ownerOf,
    async drain() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
