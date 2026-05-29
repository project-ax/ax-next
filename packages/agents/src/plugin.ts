import {
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
import { sql, type Kysely } from 'kysely';
import { buildSkillManifestYaml } from '@ax/skills-parser';
import { checkAccess } from './acl.js';
import {
  describeNearbyAuthoredSkills,
  listAuthoredSkills,
  readAuthoredBundle,
} from './authored-skills.js';
import { registerAdminAgentRoutes } from './admin-routes.js';
import { runAgentsMigration, type AgentsDatabase } from './migrations.js';
import {
  createAgentStore,
  resolveAllowedModels,
  validateCreateInput,
  validateUpdatePatch,
  type AgentStore,
} from './store.js';
import { randomBytes } from 'node:crypto';
import { AgentsInstallAuthoredSkillOutputSchema, ResolveOutputSchema } from './types.js';
import type {
  Actor,
  Agent,
  AgentsConfig,
  AgentsCreatedEvent,
  AgentsInstallAuthoredSkillInput,
  AgentsInstallAuthoredSkillOutput,
  AgentsListAuthoredSkillsInput,
  AgentsListAuthoredSkillsOutput,
  AgentsResolvedEvent,
  AgentsWebhookTokenRotatedEvent,
  CreateInput,
  CreateOutput,
  DeleteInput,
  DeleteOutput,
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

export function createAgentsPlugin(config: AgentsConfig = {}): Plugin {
  let db: Kysely<AgentsDatabase> | undefined;
  // store ref is kept for shutdown symmetry only; the actual closure
  // capture is `localStore` inside init(). Prefixed with `_` so lint
  // doesn't flag it; re-init reassigns it via init().
  let _store: AgentStore | undefined;
  let busRef: HookBus | undefined;
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
        'agents:resolve-by-webhook-token',
        'agents:rotate-webhook-token',
        'agents:ensure-webhook-token',
        'agents:any-attached-to-skill',
        'agents:set-skill-attachments',
        'agents:list-ids',
        'agents:list-personal-owners',
        'agents:list-authored-skills',
        'agents:install-authored-skill',
      ],
      // database:get-instance is hard. http:register-route + auth:require-user
      // are hard NOW because we mount admin routes; the plugin won't boot
      // without @ax/http-server + @ax/auth. teams:is-member stays graceful
      // (handled inside checkAccess via try/catch) and intentionally NOT
      // declared.
      calls: ['database:get-instance', 'http:register-route', 'auth:require-user'],
      // Soft deps used via hasService by agents:install-authored-skill (TASK-39)
      // and agents:list-authored-skills: presets that strip the skills/workspace
      // plugins degrade gracefully rather than failing to boot.
      optionalCalls: [
        {
          hook: 'skills:upsert',
          degradation:
            'open-mode authoring (agents:install-authored-skill) cannot persist a skill; agent-authored installs are unavailable',
        },
        {
          hook: 'workspace:list',
          degradation: 'authored-skill discovery + retire are skipped (no workspace backend)',
        },
        {
          hook: 'workspace:read',
          degradation: 'authored-skill bodies cannot be read (no workspace backend)',
        },
        {
          hook: 'workspace:apply',
          degradation:
            'the .ax/draft-skills/<id>/ draft is not retired after install (leaves a duplicate-id risk if the same id is later attached)',
        },
        {
          hook: 'skills:quarantine-get',
          degradation:
            'a quarantined authored draft is NOT refused promotion (no skills store) — the Phase-3 projection gate still applies',
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
        async (ctx, input) => resolveAgent(localStore, bus, ctx, input),
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

      // Read-side hook for the "promote authored skill" Phase E flow.
      // Scans the agent's workspace for .ax/draft-skills/*/SKILL.md files and
      // returns parsed summaries. Personal agents only: team agents have no
      // single-owner workspace (per-user shards; deferred). workspace:list
      // and workspace:read are soft deps (hasService guards) so this hook is
      // safe to register in presets that strip the workspace plugin.
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

      // Open-mode authoring (TASK-39, flow C): the in-chat, user-approved
      // analog of the admin promoteAuthoredSkill flow. Reads the agent-authored
      // draft (.ax/draft-skills/<id>/, capability-free — the validator strips caps at
      // write time), upserts a USER-scoped skill carrying the user-REQUESTED
      // capabilities (the tool args, surfaced on the approval card) WITH the
      // bundle's helper files[], then retires the draft. Called host-side by
      // @ax/skill-broker's gated install_authored_skill tool ONLY when open mode
      // is on. skills:upsert + workspace:* are SOFT deps (hasService-guarded).
      bus.registerService<AgentsInstallAuthoredSkillInput, AgentsInstallAuthoredSkillOutput>(
        'agents:install-authored-skill',
        PLUGIN_NAME,
        async (ctx, input) => {
          // Personal agents only — same restriction as agents:list-authored-
          // skills (team agents have no single-owner workspace to route the
          // read/retire through).
          const agent = await localStore.getById(input.agentId);
          if (agent === null || agent.ownerType !== 'user') {
            throw new PluginError({
              code: 'authored-skill-unsupported',
              plugin: PLUGIN_NAME,
              message: 'authoring is supported only for personal agents',
            });
          }
          const ownerUserId = agent.ownerId;

          // 1. Read the writable draft bundle (body + helper files). The
          //    workspace-authored SKILL.md is capability-free (the validator
          //    strips caps at the .ax/draft-skills boundary — I-P1-2, unchanged).
          //    readAuthoredBundle accepts both the directory form
          //    `.ax/draft-skills/<id>/SKILL.md` and the flat form `.ax/draft-skills/<id>.md`.
          const bundle = await readAuthoredBundle(bus, ownerUserId, input.agentId, input.skillId);
          if (bundle === null) {
            // Neither shape exists. Sharpen the message: state BOTH accepted
            // paths and name any nearby files (a wrong-case dir, a typo'd id)
            // so the agent fixes the path instead of re-deriving blind — the
            // old bare "no authored skill" dead-ended the agent (it had
            // authored the skill, just not where the installer looks).
            const hint = await describeNearbyAuthoredSkills(
              bus,
              ownerUserId,
              input.agentId,
              input.skillId,
            );
            throw new PluginError({
              code: 'authored-skill-not-found',
              plugin: PLUGIN_NAME,
              message:
                `no authored skill '${input.skillId}' in the workspace — write it to ` +
                `.ax/draft-skills/${input.skillId}/SKILL.md (a directory containing SKILL.md) or ` +
                `.ax/draft-skills/${input.skillId}.md, then call install_authored_skill again.${hint}`,
            });
          }

          // Phase 2: refuse to promote a quarantined draft. The validator commit
          // scan sets the flag; install_authored_skill flushes the workspace
          // FIRST (so a fresh scan ran on the current SKILL.md), then reaches
          // here. The agent reads the reason, revises the body in place (the file
          // is preserved — non-destructive), re-commits (a clean re-scan clears
          // the flag) and re-runs install. Soft dep: a preset without the skills
          // store skips this (the Phase-3 projection gate still applies).
          if (bus.hasService('skills:quarantine-get')) {
            const q = await bus.call<
              { ownerUserId: string; agentId: string; skillId: string },
              { quarantined: boolean; reason?: string }
            >('skills:quarantine-get', ctx, {
              ownerUserId,
              agentId: input.agentId,
              skillId: input.skillId,
            });
            if (q.quarantined) {
              throw new PluginError({
                code: 'skill-quarantined',
                plugin: PLUGIN_NAME,
                message:
                  `the skill '${input.skillId}' is quarantined: ${q.reason ?? 'flagged by the content safety scan'} ` +
                  `— revise the SKILL.md body to remove the flagged content, then call install_authored_skill again.`,
              });
            }
          }

          // 2. Build the manifest from the user-REQUESTED capabilities (the
          //    card surfaces these). Like admin promoteAuthoredSkill, the
          //    authored file's OWN caps are NOT used (they were stripped at
          //    write time). skills:upsert's parseSkillManifest is the single
          //    authority that validates host/slot SHAPES (invalid-host/-slot).
          const slots = input.slots.map((s) => ({ slot: s, kind: 'api-key' as const }));
          const reqPackages = {
            npm: input.packages?.npm ?? [],
            pypi: input.packages?.pypi ?? [],
          };
          const manifestYaml = buildSkillManifestYaml({
            id: bundle.id,
            description: bundle.description,
            version: bundle.version,
            capabilities: {
              allowedHosts: input.hosts,
              credentials: slots,
              mcpServers: [],
              packages: reqPackages,
            },
          });

          // 3. Upsert to the USER skill store WITH the bundle's helper files —
          //    the first production caller of TASK-32's files[] write path
          //    (CLOSES the half-wired window). skills:upsert validates the
          //    manifest (invalid-host/-slot) and the files (validateBundleFiles:
          //    traversal / .mcp.json / .claude / caps); those PluginErrors
          //    propagate to the broker tool unchanged.
          if (!bus.hasService('skills:upsert')) {
            throw new PluginError({
              code: 'skills-plugin-not-loaded',
              plugin: PLUGIN_NAME,
              message: 'skills:upsert is required to install an authored skill',
            });
          }
          await bus.call<
            {
              manifestYaml: string;
              bodyMd: string;
              files: Array<{ path: string; contents: string }>;
              scope: 'user';
              ownerUserId: string;
            },
            { skillId: string; created: boolean }
          >('skills:upsert', ctx, {
            manifestYaml,
            bodyMd: bundle.bodyMd,
            files: bundle.files,
            scope: 'user',
            ownerUserId,
          });

          // 4. Retire the writable draft (the §6D cross-domain move): the
          //    canonical copy is now the user store. Prevents the project/user
          //    duplicate-id collision after re-spawn AND stops the agent editing
          //    the skill between request and approval (integrity). We delete
          //    exactly `bundle.draftPaths` — the whole `.ax/draft-skills/<id>/`
          //    directory (SKILL.md + helpers) OR the single flat
          //    `.ax/draft-skills/<id>.md`, whichever readAuthoredBundle promoted — so
          //    the retire matches the installed shape. Best-effort; on a
          //    workspace-less preset readAuthoredBundle would have returned null
          //    above, so reaching here means the workspace exists. The upsert
          //    wrote to the SKILL STORE, not the workspace, so the workspace is
          //    unchanged since the read — we pass `bundle.bundleVersion` as
          //    `parent` to satisfy the backend's optimistic-concurrency CAS.
          if (bus.hasService('workspace:apply') && bundle.draftPaths.length > 0) {
            const wsCtx = makeAgentContext({
              userId: ownerUserId,
              agentId: input.agentId,
              sessionId: 'authored-bundle-retire',
            });
            await bus.call<
              {
                changes: Array<{ path: string; kind: 'delete' }>;
                parent: string | null;
              },
              unknown
            >('workspace:apply', wsCtx, {
              changes: bundle.draftPaths.map((p) => ({ path: p, kind: 'delete' as const })),
              parent: bundle.bundleVersion,
            });
          }

          return { description: bundle.description, hosts: input.hosts, slots, packages: reqPackages };
        },
        { returns: AgentsInstallAuthoredSkillOutputSchema },
      );

      // Mount /admin/agents[/:id]. Routes are registered LAST so the bus
      // calls inside their handlers reach our own services, which were
      // registered above. The unregister callbacks are tracked so a
      // re-init in tests doesn't trip duplicate-route on the http-server.
      const unregisters = await registerAdminAgentRoutes(bus, initCtx);
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
  ctx: AgentContext,
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
  ctx: AgentContext,
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
}

// ---------------------------------------------------------------------------
// Write-side authz: stricter than read-side. Owner-or-admin for personal;
// any member for team (Task 5 acceptable scope; Task 14 may tighten to
// team admins only once @ax/teams ships role semantics).
// ---------------------------------------------------------------------------

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
