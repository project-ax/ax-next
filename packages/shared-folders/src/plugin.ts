import { randomBytes } from 'node:crypto';
import {
  isOwnerlessId,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
import { isValidSharedFolderId } from '@ax/sandbox-protocol';
import type {
  AuthorizeMountsInput,
  AuthorizeMountsOutput,
  DeleteSharedFolderInput,
  DeleteSharedFolderOutput,
} from '@ax/sandbox-mount-protocol';
import type { Kysely } from 'kysely';
import type { ZodType } from 'zod';
import { runSharedFoldersMigration, type SharedFoldersDatabase } from './migrations.js';
import { createSharedFoldersStore, type SharedFoldersStore } from './store.js';
import {
  AuthorizeMountsInputSchema,
  AuthorizeMountsOutputSchema,
  CreateInputSchema,
  CreateOutputSchema,
  DeleteInputSchema,
  DeleteOutputSchema,
  GrantInputSchema,
  GrantOutputSchema,
  ListInputSchema,
  ListOutputSchema,
  RevokeInputSchema,
  RevokeOutputSchema,
  type SharedFoldersAccessReducedEvent,
  type SharedFoldersCreateOutput,
  type SharedFoldersDeleteOutput,
  type SharedFoldersGrantOutput,
  type SharedFoldersListOutput,
  type SharedFoldersRevokeOutput,
} from './types.js';

const PLUGIN_NAME = '@ax/shared-folders';

export const ACCESS_REDUCED_HOOK = 'shared-folders:access-reduced';
// See the comment at the call site for why this is NOT in the manifest.
const DELETE_PROVIDER_HOOK = 'sandbox:delete-shared-folder';

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const SWEEP_BATCH = 50;

export interface SharedFoldersPluginOptions {
  /**
   * How often the tombstone sweep retries folders whose bytes could not be
   * removed yet. Default 5 minutes; 0 disables the timer (tests drive
   * `sweep()` directly).
   */
  sweepIntervalMs?: number;
}

export interface SharedFoldersPlugin extends Plugin {
  /** Run one sweep pass now. Resolves with how many tombstones it retried / removed. */
  sweep(now?: Date): Promise<{ attempted: number; removed: number }>;
}

/** The slice of `agents:resolve`'s output this plugin reads (declared locally — no cross-plugin import). */
interface ResolvedAgent {
  agent: { id: string; ownerId: string; ownerType: 'user' | 'team' };
}

function mintFolderId(): string {
  return `sf_${randomBytes(16).toString('base64url')}`;
}

function parseInput<T>(schema: ZodType<T>, hookName: string, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `${hookName}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    });
  }
  return parsed.data;
}

/** A refused call: audited as a structured warning, then thrown as `forbidden`. Writes nothing. */
function refuse(
  ctx: AgentContext,
  hookName: string,
  reason: string,
  fields: { folderId?: string; agentId?: string } = {},
): never {
  ctx.logger.warn('shared_folders_refused', {
    hook: hookName,
    reason,
    actor: ctx.userId,
    ...fields,
  });
  throw new PluginError({
    code: 'forbidden',
    plugin: PLUGIN_NAME,
    hookName,
    // One message for every reason: a refused caller learns nothing about
    // which check failed (e.g. whether a folder exists). The log has it.
    message: `${hookName}: not allowed`,
  });
}

/**
 * The actor is the authenticated person on the context, never a payload
 * field. A call with no real person — empty, the `system` stand-in, or an
 * owner-less session id — is refused: there is no synthetic actor (§3.2).
 */
function requireActor(ctx: AgentContext, hookName: string): string {
  const userId = ctx.userId;
  if (typeof userId !== 'string' || userId.length === 0 || userId === 'system' || isOwnerlessId(userId)) {
    refuse(ctx, hookName, 'no-actor');
  }
  return userId;
}

/** A forbidden/not-found from `@ax/agents` is a refusal; anything else is a real failure. */
function isDenial(err: unknown): boolean {
  return err instanceof PluginError && (err.code === 'forbidden' || err.code === 'not-found');
}

export function createSharedFoldersPlugin(opts: SharedFoldersPluginOptions = {}): SharedFoldersPlugin {
  const sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  let store: SharedFoldersStore | undefined;
  let bus: HookBus | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let sweepInFlight: Promise<{ attempted: number; removed: number }> | undefined;
  let stopped = false;
  /** Fire-and-forget cleanups kicked from the `agents:deleted` subscriber; joined on shutdown. */
  const detached = new Set<Promise<void>>();

  const systemCtx = (): AgentContext =>
    makeAgentContext({ sessionId: 'shared-folders-sweep', agentId: PLUGIN_NAME, userId: 'system' });

  async function canManage(ctx: AgentContext, agentId: string): Promise<boolean> {
    try {
      const out = await bus!.call<{ agentId: string }, { allowed: boolean }>(
        'agents:can-manage-sharing',
        ctx,
        { agentId },
      );
      return out.allowed === true;
    } catch (err) {
      if (isDenial(err)) return false;
      throw err;
    }
  }

  /** `agents:resolve` as the actor: null when the actor may not use the agent (or it doesn't exist). */
  async function resolveAgent(ctx: AgentContext, agentId: string): Promise<ResolvedAgent['agent'] | null> {
    try {
      const out = await bus!.call<{ agentId: string; userId: string }, ResolvedAgent>(
        'agents:resolve',
        ctx,
        { agentId, userId: ctx.userId },
      );
      return out.agent;
    } catch (err) {
      if (isDenial(err)) return null;
      throw err;
    }
  }

  async function fireAccessReduced(ctx: AgentContext, folderId: string, agentIds: string[]): Promise<void> {
    if (agentIds.length === 0) return;
    const payload: SharedFoldersAccessReducedEvent = { folderId, agentIds: [...new Set(agentIds)] };
    await bus!.fire(ACCESS_REDUCED_HOOK, ctx, payload);
  }

  /**
   * Remove a tombstoned folder's bytes, then its row. Never throws: by the
   * time this runs the tombstone is committed, so a failure here only means
   * "retry later" (the sweep picks it up after the backoff).
   */
  async function cleanup(ctx: AgentContext, folderId: string): Promise<boolean> {
    const s = store!;
    try {
      // `sandbox:delete-shared-folder` is deliberately NOT declared in the
      // manifest (neither `calls` nor `optionalCalls`): the provider locates
      // the folder via the resolver's `sandbox:locate-shared-folder`, and the
      // resolver calls `shared-folders:authorize-mounts` — so a declared edge
      // would close the call-graph cycle shared-folders → provider → resolver
      // → shared-folders, which bootstrap rejects. hasService-guarded instead
      // (TASK-809 precedent in @ax/agents); with no provider the tombstone
      // stays and the sweep keeps retrying.
      if (!bus!.hasService(DELETE_PROVIDER_HOOK)) {
        await s.recordCleanupFailure(folderId, new Date());
        ctx.logger.warn('shared_folders_cleanup_failed', { folderId, reason: 'no-provider' });
        return false;
      }
      await bus!.call<DeleteSharedFolderInput, DeleteSharedFolderOutput>(DELETE_PROVIDER_HOOK, ctx, {
        folderId,
      });
      await s.removeTombstone(folderId);
      ctx.logger.info('shared_folders_cleaned_up', { folderId });
      return true;
    } catch (err) {
      ctx.logger.warn('shared_folders_cleanup_failed', {
        folderId,
        reason: 'provider-error',
        err: err instanceof Error ? err : new Error(String(err)),
      });
      try {
        await s.recordCleanupFailure(folderId, new Date());
      } catch (recordErr) {
        ctx.logger.error('shared_folders_cleanup_record_failed', {
          folderId,
          err: recordErr instanceof Error ? recordErr : new Error(String(recordErr)),
        });
      }
      return false;
    }
  }

  async function runSweep(now: Date): Promise<{ attempted: number; removed: number }> {
    const ctx = systemCtx();
    const due = await store!.dueTombstones(now, SWEEP_BATCH);
    let removed = 0;
    for (const folderId of due) {
      if (await cleanup(ctx, folderId)) removed++;
    }
    return { attempted: due.length, removed };
  }

  /** One pass at a time: a pass still running when the next is asked for is joined, not doubled. */
  function sweep(now: Date = new Date()): Promise<{ attempted: number; removed: number }> {
    if (store === undefined) return Promise.resolve({ attempted: 0, removed: 0 });
    if (sweepInFlight !== undefined) return sweepInFlight;
    const p = runSweep(now).finally(() => {
      sweepInFlight = undefined;
    });
    sweepInFlight = p;
    return p;
  }

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'shared-folders:create',
        'shared-folders:grant',
        'shared-folders:revoke',
        'shared-folders:delete',
        'shared-folders:list',
        'shared-folders:authorize-mounts',
      ],
      calls: ['database:get-instance', 'agents:can-manage-sharing', 'agents:resolve'],
      subscribes: ['agents:deleted'],
    },

    async init({ bus: b }) {
      bus = b;
      const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
      const { db } = await b.call<unknown, { db: Kysely<unknown> }>('database:get-instance', initCtx, {});
      const typed = db as Kysely<SharedFoldersDatabase>;
      await runSharedFoldersMigration(typed);
      const s = createSharedFoldersStore(typed);
      store = s;

      // ---- create -------------------------------------------------------
      b.registerService<unknown, SharedFoldersCreateOutput>(
        'shared-folders:create',
        PLUGIN_NAME,
        async (ctx, raw) => {
          const hook = 'shared-folders:create';
          const input = parseInput(CreateInputSchema, hook, raw);
          const actor = requireActor(ctx, hook);
          if (!(await canManage(ctx, input.ownerAgentId))) {
            refuse(ctx, hook, 'cannot-manage-owner-agent', { agentId: input.ownerAgentId });
          }
          const folderId = mintFolderId();
          await s.createFolder({ folderId, ownerAgentId: input.ownerAgentId, userId: actor });
          ctx.logger.info('shared_folders_created', { folderId, ownerAgentId: input.ownerAgentId, actor });
          return { folderId };
        },
        { returns: CreateOutputSchema },
      );

      // ---- grant --------------------------------------------------------
      // Authority: the actor manages the folder (= its owner agent) AND the
      // target agent. "Same owner" compares the two agents' (ownerType,
      // ownerId) read via `agents:resolve` as the actor — managing an agent
      // implies being able to resolve it (its owner, or an admin of its team,
      // who is a team member), so a resolve failure here is just a refusal.
      b.registerService<unknown, SharedFoldersGrantOutput>(
        'shared-folders:grant',
        PLUGIN_NAME,
        async (ctx, raw) => {
          const hook = 'shared-folders:grant';
          const input = parseInput(GrantInputSchema, hook, raw);
          const actor = requireActor(ctx, hook);
          const ids = { folderId: input.folderId, agentId: input.agentId };
          const folder = await s.getFolder(input.folderId);
          if (folder === null || folder.deleted || folder.ownerAgentId === null) {
            refuse(ctx, hook, 'folder-unavailable', ids);
          }
          const ownerAgentId = folder.ownerAgentId;
          if (!(await canManage(ctx, ownerAgentId))) refuse(ctx, hook, 'cannot-manage-folder', ids);
          if (!(await canManage(ctx, input.agentId))) refuse(ctx, hook, 'cannot-manage-target', ids);
          if (input.agentId === ownerAgentId) refuse(ctx, hook, 'target-is-owner', ids);
          const [ownerAgent, targetAgent] = await Promise.all([
            resolveAgent(ctx, ownerAgentId),
            resolveAgent(ctx, input.agentId),
          ]);
          if (ownerAgent === null || targetAgent === null) refuse(ctx, hook, 'cannot-resolve-agent', ids);
          if (ownerAgent.ownerType !== targetAgent.ownerType || ownerAgent.ownerId !== targetAgent.ownerId) {
            refuse(ctx, hook, 'different-owner', ids);
          }
          const res = await s.upsertGrant({ ...ids, role: input.role, userId: actor });
          if (res.status === 'unavailable') refuse(ctx, hook, 'folder-unavailable', ids);
          if (res.status === 'target-is-owner') refuse(ctx, hook, 'target-is-owner', ids);
          if (res.changed) {
            ctx.logger.info('shared_folders_granted', { ...ids, role: input.role, previousRole: res.previousRole, actor });
          }
          // Only a narrowing fires: editor → viewer. A new grant or an upgrade
          // is picked up by the next session.
          if (res.previousRole === 'editor' && input.role === 'viewer') {
            await fireAccessReduced(ctx, input.folderId, [input.agentId]);
          }
          return { changed: res.changed };
        },
        { returns: GrantOutputSchema },
      );

      // ---- revoke -------------------------------------------------------
      // The folder's manager OR the target agent's manager may revoke — an
      // agent's manager can always take it out of a folder.
      b.registerService<unknown, SharedFoldersRevokeOutput>(
        'shared-folders:revoke',
        PLUGIN_NAME,
        async (ctx, raw) => {
          const hook = 'shared-folders:revoke';
          const input = parseInput(RevokeInputSchema, hook, raw);
          requireActor(ctx, hook);
          const ids = { folderId: input.folderId, agentId: input.agentId };
          const folder = await s.getFolder(input.folderId);
          if (folder === null || folder.deleted || folder.ownerAgentId === null) {
            refuse(ctx, hook, 'folder-unavailable', ids);
          }
          const allowed =
            (await canManage(ctx, folder.ownerAgentId)) || (await canManage(ctx, input.agentId));
          if (!allowed) refuse(ctx, hook, 'cannot-manage-folder-or-target', ids);
          if (input.agentId === folder.ownerAgentId) refuse(ctx, hook, 'target-is-owner', ids);
          const res = await s.revokeGrant(ids);
          if (res.status === 'unavailable') refuse(ctx, hook, 'folder-unavailable', ids);
          if (res.status === 'target-is-owner') refuse(ctx, hook, 'target-is-owner', ids);
          if (res.revoked) {
            ctx.logger.info('shared_folders_revoked', { ...ids, actor: ctx.userId });
            await fireAccessReduced(ctx, input.folderId, [input.agentId]);
          }
          return { revoked: res.revoked };
        },
        { returns: RevokeOutputSchema },
      );

      // ---- delete -------------------------------------------------------
      b.registerService<unknown, SharedFoldersDeleteOutput>(
        'shared-folders:delete',
        PLUGIN_NAME,
        async (ctx, raw) => {
          const hook = 'shared-folders:delete';
          const input = parseInput(DeleteInputSchema, hook, raw);
          requireActor(ctx, hook);
          const ids = { folderId: input.folderId };
          const folder = await s.getFolder(input.folderId);
          if (folder === null || folder.deleted || folder.ownerAgentId === null) {
            refuse(ctx, hook, 'folder-unavailable', ids);
          }
          if (!(await canManage(ctx, folder.ownerAgentId))) refuse(ctx, hook, 'cannot-manage-folder', ids);
          const res = await s.tombstone(input.folderId);
          // Lost a race with another delete: it is already tombstoned, which
          // is the outcome the caller asked for.
          if (res === null) return { deleted: true };
          ctx.logger.info('shared_folders_deleted', { ...ids, actor: ctx.userId });
          await fireAccessReduced(ctx, input.folderId, res.formerGrantees);
          // The tombstone is committed; cleanup failure only defers byte
          // removal to the sweep, so it never fails the delete.
          await cleanup(ctx, input.folderId);
          return { deleted: true };
        },
        { returns: DeleteOutputSchema },
      );

      // ---- list ---------------------------------------------------------
      b.registerService<unknown, SharedFoldersListOutput>(
        'shared-folders:list',
        PLUGIN_NAME,
        async (ctx, raw) => {
          const hook = 'shared-folders:list';
          const input = parseInput(ListInputSchema, hook, raw);
          requireActor(ctx, hook);
          if ((await resolveAgent(ctx, input.agentId)) === null) {
            refuse(ctx, hook, 'cannot-use-agent', { agentId: input.agentId });
          }
          return { folders: await s.listForAgent(input.agentId) };
        },
        { returns: ListOutputSchema },
      );

      // ---- authorize-mounts --------------------------------------------
      // Host-internal, person-less (called by mount resolvers at session
      // open), so there is NO actor check: it can only NARROW a host-chosen
      // list to the agent's live grants. Malformed ids are dropped, never an
      // error, and the answer never says why a folder is absent.
      b.registerService<AuthorizeMountsInput, AuthorizeMountsOutput>(
        'shared-folders:authorize-mounts',
        PLUGIN_NAME,
        async (ctx, raw) => {
          const hook = 'shared-folders:authorize-mounts';
          const input = parseInput(AuthorizeMountsInputSchema, hook, raw);
          const valid = [...new Set(input.folderIds.filter((id) => isValidSharedFolderId(id)))];
          if (valid.length !== input.folderIds.length) {
            ctx.logger.warn('shared_folders_authorize_dropped_ids', {
              agentId: input.agentId,
              dropped: input.folderIds.length - valid.length,
            });
          }
          return { folders: await s.authorize(input.agentId, valid) };
        },
        { returns: AuthorizeMountsOutputSchema },
      );

      // ---- agents:deleted ----------------------------------------------
      // Payload declared locally (no cross-plugin import): `{ agentId,
      // ownerId, ownerType }`; only `agentId` matters. Subscribers run
      // serially, so the byte cleanup for newly tombstoned folders is kicked
      // off WITHOUT being awaited. A subscriber never throws (K10).
      b.subscribe<unknown>('agents:deleted', PLUGIN_NAME, async (ctx, payload) => {
        const agentId = (payload as { agentId?: unknown } | null | undefined)?.agentId;
        if (typeof agentId !== 'string' || agentId.length === 0) {
          ctx.logger.warn('shared_folders_agent_deleted_skipped', {
            reason: 'agents:deleted payload has no non-empty string agentId',
          });
          return undefined;
        }
        try {
          const res = await s.deleteAllForAgent(agentId);
          ctx.logger.info('shared_folders_purged_for_deleted_agent', {
            agentId,
            folders: res.reduced.length,
            transferred: res.transferred.length,
            tombstoned: res.tombstoned.length,
          });
          for (const r of res.reduced) await fireAccessReduced(ctx, r.folderId, r.agentIds);
          if (!stopped) {
            const sys = systemCtx();
            for (const folderId of res.tombstoned) {
              const p: Promise<void> = cleanup(sys, folderId).then(
                () => undefined,
                () => undefined,
              );
              detached.add(p);
              void p.finally(() => detached.delete(p));
            }
          }
        } catch (err) {
          ctx.logger.error('shared_folders_purge_for_deleted_agent_failed', {
            agentId,
            err: err instanceof Error ? err : new Error(String(err)),
          });
        }
        return undefined;
      });

      // ---- the sweep ----------------------------------------------------
      if (sweepIntervalMs > 0) {
        sweepTimer = setInterval(() => {
          void sweep().catch((err: unknown) => {
            systemCtx().logger.error('shared_folders_sweep_failed', {
              err: err instanceof Error ? err : new Error(String(err)),
            });
          });
        }, sweepIntervalMs);
        sweepTimer.unref?.();
      }
    },

    sweep,

    async shutdown() {
      stopped = true;
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      if (sweepInFlight !== undefined) await sweepInFlight.catch(() => undefined);
      while (detached.size > 0) await Promise.allSettled([...detached]);
    },
  };
}
