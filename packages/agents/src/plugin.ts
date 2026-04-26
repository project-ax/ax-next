import {
  makeChatContext,
  PluginError,
  type ChatContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
import type { Kysely } from 'kysely';
import { checkAccess } from './acl.js';
import { registerAdminAgentRoutes } from './admin-routes.js';
import { runAgentsMigration, type AgentsDatabase } from './migrations.js';
import {
  createAgentStore,
  resolveAllowedModels,
  validateCreateInput,
  validateUpdatePatch,
  type AgentStore,
} from './store.js';
import type {
  Agent,
  AgentsConfig,
  AgentsResolvedEvent,
  CreateInput,
  CreateOutput,
  DeleteInput,
  DeleteOutput,
  ListForUserInput,
  ListForUserOutput,
  ResolveInput,
  ResolveOutput,
  UpdateInput,
  UpdateOutput,
} from './types.js';

const PLUGIN_NAME = '@ax/agents';

// ---------------------------------------------------------------------------
// @ax/agents plugin
//
// Registers the five `agents:*` service hooks. The ACL gate
// (`checkAccess`) runs on every `agents:resolve`; create/update/delete
// each enforce their own ownership rules inline before persisting.
//
// Manifest decisions:
//   - `calls: ['database:get-instance']` is the ONLY hard dep. We DO NOT
//     declare `teams:is-member` because @ax/core's `verifyCalls` enforces
//     hard presence; declaring it would force every deployment to load
//     @ax/teams. The team branch of `checkAccess` calls the hook via
//     try/catch and degrades to deny when it isn't loaded.
//   - We FIRE `agents:resolved` (subscriber hook). Per the auth/http-server
//     pattern, `subscribes` lists what this plugin LISTENS to — observers
//     subscribe at their end. We listen to nothing.
// ---------------------------------------------------------------------------

export function createAgentsPlugin(config: AgentsConfig = {}): Plugin {
  let db: Kysely<AgentsDatabase> | undefined;
  // store ref is kept for shutdown symmetry only; the actual closure
  // capture is `localStore` inside init(). Prefixed with `_` so lint
  // doesn't flag it; re-init reassigns it via init().
  let _store: AgentStore | undefined;
  const allowedModels = resolveAllowedModels(config.allowedModels);
  const unregisterRoutes: Array<() => void> = [];

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'agents:resolve',
        'agents:list-for-user',
        'agents:create',
        'agents:update',
        'agents:delete',
      ],
      // database:get-instance is hard. http:register-route + auth:require-user
      // are hard NOW because we mount admin routes; the plugin won't boot
      // without @ax/http-server + @ax/auth. teams:is-member stays graceful
      // (handled inside checkAccess via try/catch) and intentionally NOT
      // declared.
      calls: ['database:get-instance', 'http:register-route', 'auth:require-user'],
      subscribes: [],
    },

    async init({ bus }) {
      const initCtx = makeChatContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });

      const { db: shared } = await bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance',
        initCtx,
        {},
      );
      db = shared as Kysely<AgentsDatabase>;
      await runAgentsMigration(db);
      const localStore = createAgentStore(db);
      _store = localStore;

      bus.registerService<ResolveInput, ResolveOutput>(
        'agents:resolve',
        PLUGIN_NAME,
        async (ctx, input) => resolveAgent(localStore, bus, ctx, input),
      );

      bus.registerService<ListForUserInput, ListForUserOutput>(
        'agents:list-for-user',
        PLUGIN_NAME,
        async (_ctx, input) => listForUser(localStore, input),
      );

      bus.registerService<CreateInput, CreateOutput>(
        'agents:create',
        PLUGIN_NAME,
        async (ctx, input) =>
          createAgent(localStore, bus, ctx, input, { allowedModels }),
      );

      bus.registerService<UpdateInput, UpdateOutput>(
        'agents:update',
        PLUGIN_NAME,
        async (ctx, input) =>
          updateAgent(localStore, bus, ctx, input, { allowedModels }),
      );

      bus.registerService<DeleteInput, DeleteOutput>(
        'agents:delete',
        PLUGIN_NAME,
        async (ctx, input) => deleteAgent(localStore, bus, ctx, input),
      );

      // Mount /admin/agents[/:id]. Routes are registered LAST so the bus
      // calls inside their handlers reach our own services, which were
      // registered above. The unregister callbacks are tracked so a
      // re-init in tests doesn't trip duplicate-route on the http-server.
      const unregisters = await registerAdminAgentRoutes(bus, initCtx);
      unregisterRoutes.push(...unregisters);
    },

    async shutdown() {
      // Drop admin routes first so a subsequent re-init can re-register
      // without colliding. unregister is idempotent (http-server's
      // contract); we still wrap in try/catch so a transport error
      // doesn't abort the rest of the shutdown.
      while (unregisterRoutes.length > 0) {
        const fn = unregisterRoutes.pop();
        try {
          fn?.();
        } catch {
          // best-effort
        }
      }
      // The shared db handle is owned by @ax/database-postgres; don't close
      // it here. Just drop our references so a re-init doesn't read a
      // stale store.
      db = undefined;
      _store = undefined;
    },
  };
}

async function resolveAgent(
  store: AgentStore,
  bus: HookBus,
  ctx: ChatContext,
  input: ResolveInput,
): Promise<ResolveOutput> {
  const agent = await store.getById(input.agentId);
  if (agent === null) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName: 'agents:resolve',
      message: `agent '${input.agentId}' not found`,
    });
  }
  const acl = await checkAccess(agent, input.userId, bus, ctx);
  if (!acl.allowed) {
    // Deliberately the SAME error code regardless of whether the agent
    // exists-but-not-yours vs. doesn't exist. We DO surface 'not-found'
    // when getById returned null because the alternative — uniform
    // 'forbidden' — leaks the per-row authz path that callers actually
    // need to handle differently. (Personal-agent existence is not the
    // sensitive bit; team membership is.)
    throw new PluginError({
      code: 'forbidden',
      plugin: PLUGIN_NAME,
      hookName: 'agents:resolve',
      message: `agent '${input.agentId}' not accessible to user '${input.userId}'`,
    });
  }
  // FIRE subscriber event AFTER the access check passes. Payload is
  // generic-only (ids + visibility) — no system_prompt, no tool list.
  // Subscriber failures are isolated by HookBus.fire (logged, not
  // propagated).
  const event: AgentsResolvedEvent = {
    agentId: agent.id,
    userId: input.userId,
    visibility: agent.visibility,
  };
  await bus.fire('agents:resolved', ctx, event);
  return { agent };
}

async function listForUser(
  store: AgentStore,
  input: ListForUserInput,
): Promise<ListForUserOutput> {
  const teamIds = input.teamIds ?? [];
  const agents = await store.listScoped({ userId: input.userId, teamIds });
  return { agents };
}

async function createAgent(
  store: AgentStore,
  bus: HookBus,
  ctx: ChatContext,
  input: CreateInput,
  cfg: { allowedModels: readonly string[] },
): Promise<CreateOutput> {
  const validated = validateCreateInput(input.input, {
    allowedModels: cfg.allowedModels,
  });
  let ownerId: string;
  let ownerType: 'user' | 'team';
  if (validated.visibility === 'personal') {
    ownerId = input.actor.userId;
    ownerType = 'user';
  } else {
    // team — caller must be a member of teamId. Same try/catch posture as
    // the resolve gate: missing teams plugin → forbidden.
    if (validated.teamId === null) {
      // unreachable — validateCreateInput would have thrown — but
      // narrowing for the type checker.
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        message: 'teamId is required for team-visibility agents',
      });
    }
    const member = await isTeamMember(bus, ctx, validated.teamId, input.actor.userId);
    if (!member) {
      throw new PluginError({
        code: 'forbidden',
        plugin: PLUGIN_NAME,
        hookName: 'agents:create',
        message: `user '${input.actor.userId}' is not a member of team '${validated.teamId}'`,
      });
    }
    ownerId = validated.teamId;
    ownerType = 'team';
  }
  const agent = await store.create({ ownerId, ownerType, validated });
  return { agent };
}

async function updateAgent(
  store: AgentStore,
  bus: HookBus,
  ctx: ChatContext,
  input: UpdateInput,
  cfg: { allowedModels: readonly string[] },
): Promise<UpdateOutput> {
  const existing = await store.getById(input.agentId);
  if (existing === null) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName: 'agents:update',
      message: `agent '${input.agentId}' not found`,
    });
  }
  await assertWriteAllowed(existing, bus, ctx, input.actor);
  const validated = validateUpdatePatch(input.patch, {
    allowedModels: cfg.allowedModels,
  });
  const updated = await store.update(input.agentId, validated);
  return { agent: updated };
}

async function deleteAgent(
  store: AgentStore,
  bus: HookBus,
  ctx: ChatContext,
  input: DeleteInput,
): Promise<DeleteOutput> {
  const existing = await store.getById(input.agentId);
  if (existing === null) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName: 'agents:delete',
      message: `agent '${input.agentId}' not found`,
    });
  }
  await assertWriteAllowed(existing, bus, ctx, input.actor);
  await store.deleteById(input.agentId);
}

// ---------------------------------------------------------------------------
// Write-side authz: stricter than read-side. Owner-or-admin for personal;
// any member for team (Task 5 acceptable scope; Task 14 may tighten to
// team admins only once @ax/teams ships role semantics).
// ---------------------------------------------------------------------------

async function assertWriteAllowed(
  agent: Agent,
  bus: HookBus,
  ctx: ChatContext,
  actor: { userId: string; isAdmin: boolean },
): Promise<void> {
  if (actor.isAdmin) return;
  if (agent.visibility === 'personal') {
    if (agent.ownerType === 'user' && agent.ownerId === actor.userId) return;
    throw new PluginError({
      code: 'forbidden',
      plugin: PLUGIN_NAME,
      message: `agent '${agent.id}' is not owned by '${actor.userId}'`,
    });
  }
  // team — any member can write (Task 5 scope).
  if (agent.ownerType !== 'team') {
    throw new PluginError({
      code: 'forbidden',
      plugin: PLUGIN_NAME,
      message: `agent '${agent.id}' has malformed ownership`,
    });
  }
  const member = await isTeamMember(bus, ctx, agent.ownerId, actor.userId);
  if (!member) {
    throw new PluginError({
      code: 'forbidden',
      plugin: PLUGIN_NAME,
      message: `user '${actor.userId}' is not a member of team '${agent.ownerId}'`,
    });
  }
}

async function isTeamMember(
  bus: HookBus,
  ctx: ChatContext,
  teamId: string,
  userId: string,
): Promise<boolean> {
  try {
    const result = await bus.call<
      { teamId: string; userId: string },
      { member: boolean }
    >('teams:is-member', ctx, { teamId, userId });
    return result.member === true;
  } catch (err) {
    // Only "no plugin loaded" gracefully degrades to deny. Anything else
    // (handler threw, validation failed, transient DB outage) MUST
    // propagate so it surfaces as a 5xx instead of being indistinguishable
    // from a legitimate authz denial.
    if (err instanceof PluginError && err.code === 'no-service') {
      return false;
    }
    throw err;
  }
}
