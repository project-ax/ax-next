import { applyPolicy, builtinPolicy, loadPolicy, type ModelPolicy } from './model-policy.js';
import {
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
import { sql, type Kysely } from 'kysely';
import { checkAccess } from './acl.js';
import { snapshotNewlyAttachedConnectors } from './connector-snapshot.js';
import { listAuthoredSkills } from './authored-skills.js';
import { projectAuthoredBundle } from './authored-caps.js';
import { registerAdminAgentRoutes } from './admin-routes.js';
import { runAgentsMigration, type AgentsDatabase } from './migrations.js';
import {
  createAgentStore,
  resolveAllowedModels,
  validateCreateInput,
  validateConnectorId,
  validateUpdatePatch,
  type AgentStore,
} from './store.js';
import { assertConnectorGrantAllowed } from './connector-guard.js';
import { randomBytes } from 'node:crypto';
import {
  AgentsResolveAuthoredSkillsOutputSchema,
  ResolveOutputSchema,
} from './types.js';
import type {
  Actor,
  Agent,
  AgentsConfig,
  AgentsCreatedEvent,
  AgentsDeletedEvent,
  AgentsListAuthoredSkillsInput,
  AgentsListAuthoredSkillsOutput,
  AgentsResolveAuthoredSkillsInput,
  AgentsResolveAuthoredSkillsOutput,
  AgentsResolvedEvent,
  AgentsWebhookTokenRotatedEvent,
  AttachConnectorInput,
  AttachConnectorOutput,
  AuthoredResolvedSkill,
  CanManageConnectorsInput,
  CanManageConnectorsOutput,
  CreateInput,
  CreateOutput,
  DeleteInput,
  DeleteOutput,
  DetachConnectorInput,
  DetachConnectorOutput,
  EnsureWebhookTokenInput,
  EnsureWebhookTokenOutput,
  ListForUserInput,
  ListForUserOutput,
  ListPersonalOwnersInput,
  ListPersonalOwnersOutput,
  ResolveByWebhookTokenInput,
  ResolveByWebhookTokenOutput,
  ResolveInput,
  ResolveOutput,
  RotateWebhookTokenInput,
  RotateWebhookTokenOutput,
  SkillAttachment,
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

const RESET_CLEANUP_KEY = `${PLUGIN_NAME}/bootstrap-reset-cleanup`;

/**
 * How long `agents:delete` waits on one `agents:deleted` subscriber before it
 * moves on to the next. The slowest legitimate one is the Filestore reclaim pod
 * (`activeDeadlineSeconds` 120 in @ax/sandbox-k8s, plus create and poll), so this
 * sits just above that: a healthy delete is never cut short, a wedged one is
 * bounded.
 */
export const AGENTS_DELETED_SUBSCRIBER_TIMEOUT_MS = 150_000;

export function createAgentsPlugin(config: AgentsConfig = {}): Plugin {
  let db: Kysely<AgentsDatabase> | undefined;
  // store ref is kept for shutdown symmetry only; the actual closure
  // capture is `localStore` inside init(). Prefixed with `_` so lint
  // doesn't flag it; re-init reassigns it via init().
  let _store: AgentStore | undefined;
  let busRef: HookBus | undefined;
  const allowedModels = resolveAllowedModels(config.allowedModels);
  const bootPolicy = builtinPolicy(allowedModels);
  const deletedSubscriberTimeoutMs =
    config.deletedSubscriberTimeoutMs ?? AGENTS_DELETED_SUBSCRIBER_TIMEOUT_MS;
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
        'agents:resolve-by-webhook-token',
        'agents:rotate-webhook-token',
        'agents:ensure-webhook-token',
        'agents:any-attached-to-skill',
        'agents:set-skill-attachments',
        'agents:attach-connector',
        'agents:detach-connector',
        'agents:can-manage-connectors',
        'agents:list-ids',
        'agents:list-personal-owners',
        'agents:list-authored-skills',
        'agents:resolve-authored-skills',
      ],
      // database:get-instance is hard. http:register-route + auth:require-user
      // are hard NOW because we mount admin routes; the plugin won't boot
      // without @ax/http-server + @ax/auth. teams:is-member stays graceful
      // (handled inside checkAccess via try/catch) and intentionally NOT
      // declared.
      calls: ['database:get-instance', 'http:register-route', 'auth:require-user'],
      // Soft deps used via hasService by the authored-skill discovery hooks
      // (agents:list-authored-skills + agents:resolve-authored-skills). TASK-74:
      // these read the @ax/skills DB store (skills:list-authored) — the
      // .ax/draft-skills workspace scan is RETIRED, so workspace:list/read are
      // no longer deps. A preset that strips @ax/skills degrades to no authored
      // skills (the safe default).
      optionalCalls: [
        {
          // GET /admin/agents surfaces team agents the user belongs to by
          // resolving the user's teamIds here. teams:list-for-user is
          // k8s-preset-only; a preset without @ax/teams degrades the list to
          // the user's personal agents (owner_type='user' rows only).
          hook: 'teams:list-for-user',
          degradation:
            'team agents the user belongs to are omitted from GET /admin/agents (personal agents only)',
        },
        {
          hook: 'skills:list-authored',
          degradation: 'authored-skill discovery is skipped (no skills store)',
        },
        {
          hook: 'connectors:resolve',
          degradation:
            "the non-admin attachment guard can't verify a connector's keyMode, so attaching connectors/skills falls back to admin-only (fail-closed) — admins are unaffected; a newly attached connector also cannot copy its per-tool defaults",
        },
        {
          hook: 'tool-policy:snapshot-connector-for-agent',
          degradation:
            "a newly attached connector does not copy its per-tool defaults; the agent follows the connector's live defaults instead (a later loosening by the connector's editor then applies to it too)",
        },
        {
          hook: 'models:get-policy',
          degradation:
            "the model allow-list, the Default model and the runner rule fall back to the built-in list (today's behaviour)",
        },
      ],
      subscribes: ['bootstrap:reset-cleanup'],
    },

    async init({ bus }) {
      busRef = bus;
      const initCtx = makeAgentContext({
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
        async (ctx, input) => resolveAgent(localStore, bus, ctx, input, bootPolicy),
        { returns: ResolveOutputSchema },
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
          createAgent(localStore, bus, ctx, input, { policy: await loadPolicy(bus, ctx, bootPolicy) }),
      );

      bus.registerService<UpdateInput, UpdateOutput>(
        'agents:update',
        PLUGIN_NAME,
        async (ctx, input) =>
          updateAgent(localStore, bus, ctx, input, { policy: await loadPolicy(bus, ctx, bootPolicy) }),
      );

      bus.registerService<DeleteInput, DeleteOutput>(
        'agents:delete',
        PLUGIN_NAME,
        async (ctx, input) =>
          deleteAgent(localStore, bus, ctx, input, { deletedSubscriberTimeoutMs }),
      );

      bus.registerService<ResolveByWebhookTokenInput, ResolveByWebhookTokenOutput>(
        'agents:resolve-by-webhook-token',
        PLUGIN_NAME,
        async (_ctx, input) => {
          if (typeof input.token !== 'string' || input.token.length === 0) {
            return null;
          }
          const agent = await localStore.getByWebhookToken(input.token);
          if (agent === null) return null;
          return { agent };
        },
      );

      bus.registerService<RotateWebhookTokenInput, RotateWebhookTokenOutput>(
        'agents:rotate-webhook-token',
        PLUGIN_NAME,
        async (ctx, input) => {
          const existing = await localStore.getById(input.agentId);
          if (existing === null) {
            throw new PluginError({
              code: 'not-found',
              plugin: PLUGIN_NAME,
              hookName: 'agents:rotate-webhook-token',
              message: `agent '${input.agentId}' not found`,
            });
          }
          // ACL: owner OR admin (mirrors agents:update access path).
          const isOwner = existing.ownerType === 'user'
            && existing.ownerId === input.actor.userId;
          if (!isOwner && !input.actor.isAdmin) {
            throw new PluginError({
              code: 'forbidden',
              plugin: PLUGIN_NAME,
              hookName: 'agents:rotate-webhook-token',
              message: `forbidden: actor '${input.actor.userId}' cannot rotate webhook token for agent '${input.agentId}'`,
            });
          }
          const token = randomBytes(32).toString('base64url');
          await localStore.setWebhookToken(input.agentId, token);
          // Fire subscriber event so that callers (e.g., @ax/routines) can
          // re-bind webhook routes for this agent. Payload is opaque —
          // agentId only, never the token itself. Subscriber failures are
          // isolated by HookBus.fire (logged, not propagated).
          const rotatedEvent: AgentsWebhookTokenRotatedEvent = { agentId: input.agentId };
          await bus.fire('agents:webhook-token-rotated', ctx, rotatedEvent);
          return { token };
        },
      );

      bus.registerService<EnsureWebhookTokenInput, EnsureWebhookTokenOutput>(
        'agents:ensure-webhook-token',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const existing = await localStore.getById(input.agentId);
          if (existing === null) {
            throw new PluginError({
              code: 'not-found',
              plugin: PLUGIN_NAME,
              hookName: 'agents:ensure-webhook-token',
              message: `agent '${input.agentId}' not found`,
            });
          }
          // ACL: owner OR admin (mirrors agents:rotate-webhook-token access path).
          const isOwner = existing.ownerType === 'user'
            && existing.ownerId === input.actor.userId;
          if (!isOwner && !input.actor.isAdmin) {
            throw new PluginError({
              code: 'forbidden',
              plugin: PLUGIN_NAME,
              hookName: 'agents:ensure-webhook-token',
              message: `forbidden: actor '${input.actor.userId}' cannot access webhook token for agent '${input.agentId}'`,
            });
          }
          // Return existing token if present; generate a new one if null.
          const currentToken = await localStore.getWebhookToken(input.agentId);
          if (typeof currentToken === 'string' && currentToken.length > 0) {
            return { token: currentToken };
          }
          const token = randomBytes(32).toString('base64url');
          await localStore.setWebhookToken(input.agentId, token);
          return { token };
        },
      );

      bus.registerService<{ skillId: string }, { attached: boolean }>(
        'agents:any-attached-to-skill',
        PLUGIN_NAME,
        async (_ctx, input) => ({
          attached: await localStore.anyAttachedToSkill(input.skillId),
        }),
      );

      // Read-only enumeration of agent ids. The @ax/routines tick loop
      // calls this to drive lazy materialization of default-sourced
      // per-agent rows. Background-loop caller, not user-facing — no ACL
      // filtering. See I-R10 + I-R11 in the defaults-routines-half plan.
      bus.registerService<Record<string, never>, { agentIds: string[] }>(
        'agents:list-ids',
        PLUGIN_NAME,
        async () => ({ agentIds: await localStore.listAllIds() }),
      );

      // Personal-agent enumeration with owners. Backs the
      // @ax/routines tick loop's defaults-materialize step — it must
      // stamp each materialized routine with the agent owner's user id
      // so that `agents:resolve` (called from fire.ts) finds a real
      // user. Team agents are deliberately excluded; routing a default
      // fire under a team is a policy question, not a lookup.
      bus.registerService<ListPersonalOwnersInput, ListPersonalOwnersOutput>(
        'agents:list-personal-owners',
        PLUGIN_NAME,
        async () => ({ agents: await localStore.listPersonalAgentOwners() }),
      );

      bus.registerService<
        { actor: Actor; agentId: string; attachments: SkillAttachment[] },
        { agent: Agent }
      >(
        'agents:set-skill-attachments',
        PLUGIN_NAME,
        async (ctx, input) => {
          const existing = await localStore.getById(input.agentId);
          if (existing === null) {
            throw new PluginError({
              code: 'not-found',
              plugin: PLUGIN_NAME,
              message: `agent '${input.agentId}' not found`,
            });
          }
          // ACL: same as agents:update — owner or admin.
          await assertWriteAllowed(existing, bus, ctx, input.actor);
          const updated = await localStore.setSkillAttachments(
            input.agentId,
            input.attachments,
          );
          return { agent: updated };
        },
      );

      // TASK-739 — attach ONE connector. Order: id shape → agent exists →
      // ownership ACL → owner-or-admin (TASK-798) → workspace-connector guard
      // (non-admin) → one row-locked read-modify-write (append if absent, drop
      // from exclusions).
      bus.registerService<AttachConnectorInput, AttachConnectorOutput>(
        'agents:attach-connector',
        PLUGIN_NAME,
        async (ctx, input) => {
          const connectorId = validateConnectorId(input.connectorId);
          const existing = await getForConnectorEdit(
            localStore,
            input.agentId,
            'agents:attach-connector',
          );
          await assertWriteAllowed(existing, bus, ctx, input.actor);
          // TASK-798 — on a team agent whatever is attached reaches every
          // member's runs, so only its owner (a team admin) or a workspace admin
          // may attach. This one check also covers TASK-765's "a member must not
          // undo the owner's removal of a default": attaching drops the id from
          // `connectorExclusions`, and only someone who may exclude gets here.
          await assertConnectorsManageAllowed(
            existing,
            bus,
            ctx,
            input.actor,
            'agents:attach-connector',
          );
          await assertConnectorGrantAllowed(
            bus,
            ctx,
            input.actor,
            [connectorId],
            'agents:attach-connector',
          );
          const out = await localStore.attachConnector(input.agentId, connectorId);
          // TASK-737's snapshot-on-attach, on THIS path too: a newly attached
          // connector copies its per-tool defaults. Only when the id is new to
          // the attachment list — re-copying an existing attachment would
          // overwrite the attach-time copy with today's (maybe looser) default.
          await snapshotNewlyAttachedConnectors(bus, ctx, {
            agentId: input.agentId,
            before: existing.connectorAttachments,
            after: out.agent.connectorAttachments,
            resolveAs: existing.ownerType === 'user' ? existing.ownerId : input.actor.userId,
            actorId: input.actor.userId,
          });
          return out;
        },
      );

      // TASK-739 — detach ONE connector; `exclude` also hides it from the
      // agent's other sources (a default). On a team agent either one changes
      // what every member's runs reach, so both are the owner's (a team
      // admin's) or a workspace admin's call — TASK-765 for an exclusion,
      // widened to every detach by TASK-798. One check, below.
      bus.registerService<DetachConnectorInput, DetachConnectorOutput>(
        'agents:detach-connector',
        PLUGIN_NAME,
        async (ctx, input) => {
          const connectorId = validateConnectorId(input.connectorId);
          const existing = await getForConnectorEdit(
            localStore,
            input.agentId,
            'agents:detach-connector',
          );
          await assertWriteAllowed(existing, bus, ctx, input.actor);
          await assertConnectorsManageAllowed(
            existing,
            bus,
            ctx,
            input.actor,
            'agents:detach-connector',
          );
          return localStore.detachConnector(
            input.agentId,
            connectorId,
            input.exclude === true,
          );
        },
      );

      // TASK-765 / TASK-798 — may this actor change this agent's connectors
      // (attach, detach, exclude, and — asked by @ax/mcp-oauth — sign in ON
      // the agent)? The predicate the hooks above enforce, exposed so a caller
      // shows the affordance only to someone it will work for. An actor who
      // can't reach the agent at all gets `false`, not an error; a missing
      // agent is `not-found`. (TASK-803: renamed from its TASK-765 name,
      // which was about exclusions only, now the question is wider.)
      bus.registerService<CanManageConnectorsInput, CanManageConnectorsOutput>(
        'agents:can-manage-connectors',
        PLUGIN_NAME,
        async (ctx, input) => {
          const existing = await getForConnectorEdit(
            localStore,
            input.agentId,
            'agents:can-manage-connectors',
          );
          try {
            await assertWriteAllowed(existing, bus, ctx, input.actor);
          } catch (err) {
            if (err instanceof PluginError && err.code === 'forbidden') {
              return { allowed: false };
            }
            throw err;
          }
          return { allowed: await connectorsManageAllowed(existing, bus, ctx, input.actor) };
        },
      );

      // Read-side hook for the "promote authored skill" Phase E flow. Reads the
      // agent's self-authored skill drafts from the @ax/skills DB store
      // (skills:list-authored, a hasService-guarded soft dep). Personal agents
      // only: team agents have no single-owner workspace (per-user shards;
      // deferred). A preset without @ax/skills degrades to no authored skills.
      bus.registerService<AgentsListAuthoredSkillsInput, AgentsListAuthoredSkillsOutput>(
        'agents:list-authored-skills',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const agent = await localStore.getById(input.agentId);
          // Personal agents only: team-owned agents have per-user workspace
          // shards and no single canonical owner userId to route the
          // workspace:list/read ctx through. Return [] until that policy lands.
          if (agent === null || agent.ownerType !== 'user') {
            return { skills: [] };
          }
          return {
            skills: await listAuthoredSkills(bus, agent.ownerId, input.agentId),
          };
        },
      );

      // Authored-skill discovery projection (TASK-74 re-backing). The source is
      // the @ax/skills DB store (skills:list-authored). The shape returned feeds
      // the orchestrator union.
      //
      // TASK-100 — a skill manifest carries NO capability block; its only
      // declared reach is the `connectors` it references (resolved into sandbox
      // caps by the orchestrator's skill→connector bridge, gated by the connector
      // approval wall). So there is no per-skill capability proposal to intersect
      // with an approved set, no proposalDelta, and no per-skill capability
      // approval card — we project the skill's connector references verbatim.
      //
      // QUARANTINE is the row's `status === 'quarantined'` (set by the
      // skills:propose gate when skills:scan flagged it) — a quarantined skill is
      // OMITTED so the model never sees its name/description. `pending` / `active`
      // both project; a `pending` skill's bytes are withheld by the orchestrator
      // until it flips to `active`. skills:list-authored is a soft dep
      // (hasService-guarded): a preset without the skills store yields no authored
      // skills — the safe default.
      bus.registerService<AgentsResolveAuthoredSkillsInput, AgentsResolveAuthoredSkillsOutput>(
        'agents:resolve-authored-skills',
        PLUGIN_NAME,
        async (_ctx, input) => {
          if (!bus.hasService('skills:list-authored')) {
            return { skills: [] };
          }
          // Structural mirror of @ax/skills' SkillsListAuthoredOutput (I2 — no
          // @ax/skills import).
          interface AuthoredRow {
            skillId: string;
            description: string;
            manifestYaml: string;
            bodyMd: string;
            files: Array<{ path: string; contents: string }>;
            status: 'active' | 'pending' | 'quarantined';
            reason?: string;
          }
          const { skills: rows } = await bus.call<
            { ownerUserId: string; agentId: string },
            { skills: AuthoredRow[] }
          >('skills:list-authored', _ctx, {
            ownerUserId: input.ownerUserId,
            agentId: input.agentId,
          });

          const skills: AuthoredResolvedSkill[] = [];
          for (const b of rows) {
            if (b.status === 'quarantined') continue; // omit — model never sees it

            const proj = projectAuthoredBundle(b.manifestYaml);
            if (proj === null) continue; // unparseable — skip (defensive)

            skills.push({
              id: b.skillId,
              description: proj.description,
              connectors: proj.connectors,
              bodyMd: b.bodyMd,
              manifestYaml: proj.manifestYaml,
              files: b.files,
              // TASK-76 (§D3): forward the gate verdict so the orchestrator
              // materializes only `active` skills' bytes into the spawn; a
              // `pending` skill projects nothing until a human approves. The row
              // is `active` | `pending` here (quarantined was `continue`d above).
              status: b.status === 'active' ? 'active' : 'pending',
            });
          }
          return { skills };
        },
        { returns: AgentsResolveAuthoredSkillsOutputSchema },
      );

      // Mount /admin/agents[/:id]. Routes are registered LAST so the bus
      // calls inside their handlers reach our own services, which were
      // registered above. The unregister callbacks are tracked so a
      // re-init in tests doesn't trip duplicate-route on the http-server.
      const unregisters = await registerAdminAgentRoutes(bus, initCtx, bootPolicy, localStore);
      unregisterRoutes.push(...unregisters);

      // Bootstrap-reset cleanup: when an operator runs `ax admin
      // reset-bootstrap --force`, drop every agent row so the wizard's
      // model step can re-create the default chat agent without
      // tripping any uniqueness constraints. The reset is a deliberate
      // "redo from scratch" — operator paid the I6 escape hatch.
      const localDb = db;
      bus.subscribe(
        'bootstrap:reset-cleanup',
        RESET_CLEANUP_KEY,
        async () => {
          await sql`TRUNCATE agents_v1_agents`.execute(localDb);
          return undefined;
        },
      );
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
      busRef?.unsubscribe('bootstrap:reset-cleanup', RESET_CLEANUP_KEY);
      busRef = undefined;
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
  ctx: AgentContext,
  input: ResolveInput,
  boot: ModelPolicy,
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
  // The swap lives only in what chats see. `agent` (the stored row) is never written back.
  const policy = await loadPolicy(bus, ctx, boot);
  return { agent: applyPolicy(agent, policy) };
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
  ctx: AgentContext,
  input: CreateInput,
  cfg: { policy: ModelPolicy },
): Promise<CreateOutput> {
  const validated = validateCreateInput(input.input, {
    allowedModels: cfg.policy.allowed,
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
  const createArgs: Parameters<AgentStore['create']>[0] = { ownerId, ownerType, validated };
  if (input.tx !== undefined) createArgs.tx = input.tx;
  const agent = await store.create(createArgs);
  // Fire subscriber event so callers (e.g., @ax/routines) can seed
  // per-agent workspace state (e.g., heartbeat.md). Payload is intentionally
  // minimal and storage-agnostic (L4) — subscribers needing richer data
  // re-resolve via `agents:resolve`. Subscriber failures are isolated by
  // HookBus.fire (logged, not propagated), so agent creation succeeds even
  // if every subscriber throws (L6).
  //
  // CONTRACT: when `input.tx` is supplied, the caller owns the commit
  // boundary. Firing here would surface `agents:created` to subscribers
  // BEFORE the outer transaction commits — if the caller rolls back, the
  // heartbeat seed and any other subscriber-driven state would orphan
  // against a non-existent agent row. Callers that pass `tx` MUST fire
  // `agents:created` themselves AFTER their commit succeeds. See
  // @ax/onboarding completion-tx for the canonical pattern.
  if (input.tx === undefined) {
    const createdEvent: AgentsCreatedEvent = {
      agentId: agent.id,
      ownerId: agent.ownerId,
      ownerType: agent.ownerType,
    };
    await bus.fire('agents:created', ctx, createdEvent);
  }
  return { agent };
}

async function updateAgent(
  store: AgentStore,
  bus: HookBus,
  ctx: AgentContext,
  input: UpdateInput,
  cfg: { policy: ModelPolicy },
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
    allowedModels: cfg.policy.allowed,
    currentModel: existing.model,
  });
  const updated = await store.update(input.agentId, validated);
  return { agent: updated };
}

async function deleteAgent(
  store: AgentStore,
  bus: HookBus,
  ctx: AgentContext,
  input: DeleteInput,
  cfg: { deletedSubscriberTimeoutMs: number },
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

  // Credential purge is best-effort: failures are logged and we continue to
  // store.deleteById regardless. The purge runs first so that on success the
  // agent's creds are gone before the agent row is removed — if the purge
  // fails the agent row stays and the operator can retry (preserving the
  // ability to clean up the orphaned credential rows). If we deleted the
  // agent row first and the purge then failed, the credential rows would be
  // orphaned with no way to reclaim them.
  if (bus.hasService('credentials:purge-by-owner')) {
    try {
      await bus.call('credentials:purge-by-owner', ctx, {
        scope: 'agent',
        ownerId: input.agentId,
      });
    } catch (err) {
      ctx.logger.warn('agents_delete_credential_purge_failed', {
        agentId: input.agentId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await store.deleteById(input.agentId);

  // Fire `agents:deleted` AFTER the row is gone so subscribers reclaim per-agent
  // state owned in other tiers. Each plugin that keeps rows keyed on an agent id
  // deletes ITS OWN (there is no FK to this table, on purpose, and no plugin may
  // reach into another's tables): the sandbox provider `rm -rf`s the durable
  // `/workspace` subtree (filestore-user-files design §11); @ax/routines drops the
  // routines so the heartbeat stops (TASK-680); and, since TASK-718, conversations
  // (which then announce `conversations:purged` for attachments), sessions,
  // skills, connectors, host grants, decisions, MCP handshakes and remembered
  // facts, plus the orchestrator killing the agent's warm sandboxes.
  // scripts/__tests__/agent-keyed-tables-are-cleaned.test.js fails when a new
  // agent-keyed table appears with no owner cleaning it up.
  //
  // Payload is minimal + storage-agnostic (L4) — `agentId` is the subtree key;
  // `ownerId`/`ownerType` come from the row we already loaded (re-resolving would
  // 404 now). Subscriber failures are isolated by HookBus.fire and never affect
  // the (already-committed) delete (L6). Fired after the credential purge above
  // so a single delete cascades both reclaims.
  const deletedEvent: AgentsDeletedEvent = {
    agentId: input.agentId,
    ownerId: existing.ownerId,
    ownerType: existing.ownerType,
  };
  //
  // Bounded (TASK-718): the subscribers run one after another, and they now
  // include a Filestore reclaim pod that waits on the apiserver. Without a bound
  // one that never settles holds this request open and keeps every later
  // subscriber from ever running.
  await bus.fire('agents:deleted', ctx, deletedEvent, {
    subscriberTimeoutMs: cfg.deletedSubscriberTimeoutMs,
  });
}

// ---------------------------------------------------------------------------
// Write-side authz: stricter than read-side. Owner-or-admin for personal;
// any member for team (Task 5 acceptable scope; Task 14 may tighten to
// team admins only once @ax/teams ships role semantics).
// ---------------------------------------------------------------------------

async function getForConnectorEdit(
  store: AgentStore,
  agentId: string,
  hookName: string,
): Promise<Agent> {
  const existing = await store.getById(agentId);
  if (existing === null) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName,
      message: `agent '${agentId}' not found`,
    });
  }
  return existing;
}

async function assertWriteAllowed(
  agent: Agent,
  bus: HookBus,
  ctx: AgentContext,
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
  ctx: AgentContext,
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

/**
 * TASK-765 / TASK-798 — may `actor` change which connectors `agent` reaches
 * (attach, detach, exclude a default, sign in ON the agent)? On a team agent
 * that changes what every member's runs reach — and a sign-in on it decides
 * whose account they all act as — so it is a decision about the whole team,
 * not about the actor's own use of the agent:
 *
 *   - a workspace admin: always;
 *   - a personal agent: its owner;
 *   - a team agent: a member whose team role is `admin` (the agent's "owner":
 *     a team agent has no single owning person).
 *
 * Deliberately NOT part of `assertWriteAllowed`, whose "any team member may
 * write" semantics stay as they were for the agent's other fields — this is a
 * narrower question asked on top of it. Anything we can't prove is a refusal:
 * a missing teams plugin (`no-service`) and malformed ownership are `false`;
 * every OTHER lookup failure propagates so it surfaces as a 5xx rather than a
 * quiet denial.
 */
async function connectorsManageAllowed(
  agent: Agent,
  bus: HookBus,
  ctx: AgentContext,
  actor: Actor,
): Promise<boolean> {
  if (actor.isAdmin) return true;
  if (agent.visibility === 'personal') {
    return agent.ownerType === 'user' && agent.ownerId === actor.userId;
  }
  if (agent.ownerType !== 'team') return false;
  try {
    const result = await bus.call<
      { teamId: string; userId: string },
      { member: boolean; role?: 'admin' | 'member' }
    >('teams:is-member', ctx, { teamId: agent.ownerId, userId: actor.userId });
    return result.member === true && result.role === 'admin';
  } catch (err) {
    if (err instanceof PluginError && err.code === 'no-service') return false;
    throw err;
  }
}

/** {@link connectorsManageAllowed} as a `forbidden` refusal, for the write hooks. */
async function assertConnectorsManageAllowed(
  agent: Agent,
  bus: HookBus,
  ctx: AgentContext,
  actor: Actor,
  hookName: string,
): Promise<void> {
  if (await connectorsManageAllowed(agent, bus, ctx, actor)) return;
  throw new PluginError({
    code: 'forbidden',
    plugin: PLUGIN_NAME,
    hookName,
    message: "only the agent's owner or an admin can change its connectors",
  });
}
