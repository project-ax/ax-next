import {
  isOwnerlessId,
  makeAgentContext,
  type AgentContext,
  type HookBus,
  type Logger,
} from '@ax/core';
import { limitBytesOf, type LimitsStore } from './config.js';
import { blobFullMessage, STORAGE_UNAVAILABLE_MESSAGE, workspaceFullMessage } from './messages.js';
import { mapBounded, PLUGIN_NAME } from './shared.js';
import type { DiskQuotaStore } from './store.js';

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
//   reconcile           — the periodic sweep over every personal agent.
//
// Error posture is deliberately lopsided (the same as @ax/usage-limits):
//   - The GATES fail CLOSED. HookBus.fire isolates a throwing subscriber and
//     carries on, which on a disk guard would mean "database down = no
//     limit". So a gate never throws; any failure becomes a refusal.
//   - The METERS never throw. A metering hiccup is one log line, never a
//     failed commit or a failed upload.
// ---------------------------------------------------------------------------

/**
 * A refusal of a WRITE carries prose (see messages.ts), shown verbatim. A refusal
 * of a TURN carries `STORAGE_FULL_REASON`, a code, because the orchestrator
 * surfaces it as `chat:start:<code>` and channel-web owns the sentence.
 */
export type AdmitDecision = { ok: true } | { ok: false; reason: string };

/** The `chat:start` veto reason for a person whose storage is full. */
export const STORAGE_FULL_REASON = 'storage-full';

export interface ReconcileResult {
  /** Workspaces measured and recorded. */
  measured: number;
  /** Agents the sweep tried but could not measure. */
  failed: number;
}

export interface DiskQuotaService {
  admitWorkspaceWrite(ctx: AgentContext, sizeBytes: number): Promise<AdmitDecision>;
  admitBlobWrite(ctx: AgentContext, sizeBytes: number): Promise<AdmitDecision>;
  /** `chat:start`: turn a full person's next message away with a clear code. Fails OPEN. */
  admitTurn(ctx: AgentContext): Promise<AdmitDecision>;
  recordBlobStored(ctx: AgentContext, payload: unknown): Promise<void>;
  /** Fire-and-track: never awaited by the caller, never throws. */
  scheduleWorkspaceMeasure(ctx: AgentContext): void;
  /** Sweep every personal agent. Skips (measured: 0) when a hook it needs is absent. Never throws. */
  reconcile(): Promise<ReconcileResult>;
  /** Resolves once every background measurement has settled. */
  drain(): Promise<void>;
  /** Who a write in this context is charged to; undefined when nobody. */
  ownerOf(ctx: AgentContext): Promise<string | undefined>;
}

/** Answers cached per agent; cleared wholesale past this many entries. */
export const OWNER_CACHE_MAX = 5000;
/** The sweep measures this many agents at once. */
export const SWEEP_CONCURRENCY = 2;

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
}): DiskQuotaService {
  const { bus, store, limits } = deps;
  const sweepLogger: { logger?: Logger } = deps.logger === undefined ? {} : { logger: deps.logger };

  // ---- who pays ------------------------------------------------------------

  const ownerCache = new Map<string, string>();

  async function ownerOf(ctx: AgentContext): Promise<string | undefined> {
    const agentId = ctx.agentId;
    if (usableAgentId(agentId) && bus.hasService('agents:resolve')) {
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
          if (ownerCache.size >= OWNER_CACHE_MAX) ownerCache.clear();
          ownerCache.set(agentId, owner);
          return owner;
        }
        log(ctx, 'debug', 'disk_quota_owner_unusable', { agentId });
      } catch (err) {
        // Not resolvable (no such agent, no access, resolver down): the acting
        // user pays instead. A wrong-but-real owner beats an unmetered write.
        log(ctx, 'debug', 'disk_quota_owner_fallback', { agentId, err });
      }
    }
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
      return { ok: false, reason: refusal(usedBytes, limitBytes) };
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

  // The FRONT DOOR: once a person's storage is full, their next turn is turned
  // away at `chat:start` with a plain sentence. The write gates above are the
  // hard guard, but the runner's end-of-turn save happens after the reply is
  // shown and its refusal reason is only surfaced on the mid-turn flush path,
  // so on its own a full person would lose files with nobody telling them.
  //
  // It fails OPEN, the opposite of the write gates, on purpose: this gate exists
  // to give a clear message, not to guard the disk (the write gates do that and
  // fail closed), and a storage hiccup must not stop people chatting.
  async function admitTurn(ctx: AgentContext): Promise<AdmitDecision> {
    try {
      const owner = await ownerOf(ctx);
      if (owner === undefined) return OK;
      const [current, usage] = await Promise.all([limits.get(), store.usageFor(owner)]);
      const { limitBytes } = limitBytesOf(current);
      if (usage.workspaceBytes + usage.fileBytes >= limitBytes) {
        return { ok: false, reason: STORAGE_FULL_REASON };
      }
      return OK;
    } catch (err) {
      log(ctx, 'warn', 'disk_quota_turn_check_failed', { err });
      return OK;
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
  const measuring = new Map<string, { again: boolean; ctx: AgentContext }>();
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
    const state = { again: false, ctx };
    measuring.set(agentId, state);
    track(
      (async () => {
        try {
          do {
            state.again = false;
            await measureOnce(state.ctx);
          } while (state.again);
        } finally {
          measuring.delete(agentId);
        }
      })(),
      ctx,
    );
  }

  async function reconcile(): Promise<ReconcileResult> {
    const sweepCtx = makeAgentContext({
      sessionId: 'disk-quota-sweep',
      agentId: PLUGIN_NAME,
      userId: 'system',
      ...sweepLogger,
    });
    try {
      if (!bus.hasService('agents:list-personal-owners') || !bus.hasService('workspace:usage')) {
        log(sweepCtx, 'debug', 'disk_quota_sweep_skipped');
        return { measured: 0, failed: 0 };
      }
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
      let measured = 0;
      let failed = 0;
      await mapBounded(listed, SWEEP_CONCURRENCY, async (a) => {
        const agentCtx = makeAgentContext({
          sessionId: 'disk-quota-sweep',
          agentId: a.agentId,
          userId: a.ownerUserId,
          ...sweepLogger,
        });
        if (await measureOnce(agentCtx, a.ownerUserId)) measured++;
        else failed++;
      });
      log(sweepCtx, 'info', 'disk_quota_sweep_done', { measured, failed });
      return { measured, failed };
    } catch (err) {
      log(sweepCtx, 'warn', 'disk_quota_sweep_failed', { err });
      return { measured: 0, failed: 0 };
    }
  }

  return {
    admitWorkspaceWrite,
    admitBlobWrite,
    admitTurn,
    recordBlobStored,
    scheduleWorkspaceMeasure,
    reconcile,
    ownerOf,
    async drain() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
