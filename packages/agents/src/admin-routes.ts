import {
  isRejection,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { buildSkillManifestYaml } from '@ax/skills-parser';
import { z } from 'zod';
import {
  validateNewAttachments,
  type NewAttachmentInput,
} from './skill-attachments-validation.js';
import { validateConnectorAttachmentIds } from './store.js';
import type {
  Actor,
  Agent,
  AgentInput,
  AgentsListAuthoredSkillsInput,
  AgentsListAuthoredSkillsOutput,
  CreateInput,
  CreateOutput,
  DeleteInput,
  ListForUserInput,
  ListForUserOutput,
  ResolveInput,
  ResolveOutput,
  SetConnectorAttachmentsInput,
  SetConnectorAttachmentsOutput,
  SkillAttachment,
  UpdateInput,
  UpdateOutput,
} from './types.js';

// ---------------------------------------------------------------------------
// HTTP route handlers for /admin/agents[/:id].
//
// Routes are registered on @ax/http-server via http:register-route in
// plugin.init. Handlers here duck-type the request/response surface
// (Invariant I2 — no @ax/http-server import) so a future non-HTTP transport
// could provide it.
//
// ALL endpoints:
//   - require a valid signed session cookie (auth:require-user) — 401 if not
//   - cap the request body at 64 KiB BEFORE zod-parsing — 413 if over
//   - validate the body via zod and collapse error paths into a single
//     user-friendly message — raw zod paths are NEVER echoed to the client
//   - delegate to the existing agents:* service hooks for ACL + persistence
//
// Wildcard tool scope (allowedTools=[] AND mcpConfigIds=[] together) is
// REJECTED here, NOT in store.ts. The store still allows the wildcard
// shape so dev-agents-stub can register pass-through filters at boot.
// Production agents created via THIS API path must not be able to
// silently bypass the per-agent tool catalog filter.
// ---------------------------------------------------------------------------

/** Locked at handler entry — wider than the store's 32 KiB system_prompt cap
 *  to leave room for the JSON envelope, headers, and a generous margin for
 *  the longest possible allowedTools / mcpConfigIds + display_name combo.
 *  Smaller than http-server's 1 MiB so the admin API doesn't accept blobs
 *  the storage layer can't hold. */
export const ADMIN_BODY_MAX_BYTES = 64 * 1024;

const PLUGIN_NAME = '@ax/agents';

// --- duck-typed request/response (mirrors @ax/http-server's HttpRequest /
// HttpResponse minus the import) -------------------------------------------

export interface RouteRequest {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  /** Pattern-route capture for `/admin/agents/:id`. Empty for collection routes. */
  readonly params: Record<string, string>;
  signedCookie(name: string): string | null;
}

export interface RouteResponse {
  status(n: number): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  end(): void;
}

// --- zod schemas -----------------------------------------------------------

// These mirror the store.ts validators (one-source-of-truth lives in the
// store; this layer's job is to reject malformed JSON shape and the
// wildcard-bypass case before the bus call). Keeping the regex / length
// caps in lockstep is a manual maintenance task — if store.ts loosens, this
// layer stays strict. Drift in the OTHER direction (this layer accepts
// what the store rejects) gets caught by the hook impl and surfaces as
// invalid-payload at runtime.
// allowedTools is a union of MCP tool names (`mcp__<server>__<tool>`, all
// lowercase) AND Claude Agent SDK built-ins (`Bash`, `Read`, `WebFetch`,
// `Skill`, …, PascalCase). The MCP catalog's own regex stays strict-lower
// in @ax/mcp-client; the agent layer relaxes the leading-letter case so
// SDK built-ins parse without an out-of-band case-mapping table.
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MCP_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const WORKSPACE_REF_RE = /^[A-Za-z0-9_./-]+$/;

const displayNameSchema = z
  .string()
  .min(1, 'displayName must be 1-128 chars')
  .max(128, 'displayName must be 1-128 chars')
  .refine(
    (s) => s === s.trim(),
    'displayName must not have leading or trailing whitespace',
  );

const systemPromptSchema = z
  .string()
  .max(32 * 1024, 'systemPrompt must be at most 32 KiB');

const allowedToolsSchema = z
  .array(z.string().regex(TOOL_NAME_RE, 'allowedTools entry has invalid shape'))
  .max(100, 'allowedTools must have at most 100 entries');

const mcpConfigIdsSchema = z
  .array(z.string().regex(MCP_ID_RE, 'mcpConfigIds entry has invalid shape'))
  .max(50, 'mcpConfigIds must have at most 50 entries');

const modelSchema = z.string().min(1, 'model must be a non-empty string');

const visibilitySchema = z.enum(['personal', 'team']);

const teamIdSchema = z.string().min(1).max(128);

const workspaceRefSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(WORKSPACE_REF_RE, 'workspaceRef has invalid shape')
  .nullable();

/**
 * Body schema for `POST /admin/agents`. Matches AgentInput exactly so the
 * shape passes through `agents:create` without further translation.
 *
 * `visibility:'team'` requires teamId — checked via .superRefine because
 * the field is conditionally required.
 */
const createBodySchema = z
  .object({
    displayName: displayNameSchema,
    systemPrompt: systemPromptSchema,
    allowedTools: allowedToolsSchema,
    mcpConfigIds: mcpConfigIdsSchema,
    model: modelSchema,
    visibility: visibilitySchema,
    teamId: teamIdSchema.optional(),
    workspaceRef: workspaceRefSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.visibility === 'team' && value.teamId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "teamId is required when visibility='team'",
        path: ['teamId'],
      });
    }
    if (value.visibility === 'personal' && value.teamId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "teamId must not be set when visibility='personal'",
        path: ['teamId'],
      });
    }
  });

/**
 * Body schema for `PATCH /admin/agents/:id`. Same field shapes as create
 * but every field is optional. visibility/teamId cannot be patched (the
 * store rejects them anyway — checked here too so the error message is
 * crisp).
 */
const updateBodySchema = z
  .object({
    displayName: displayNameSchema.optional(),
    systemPrompt: systemPromptSchema.optional(),
    allowedTools: allowedToolsSchema.optional(),
    mcpConfigIds: mcpConfigIdsSchema.optional(),
    model: modelSchema.optional(),
    workspaceRef: workspaceRefSchema.optional(),
  })
  .strict();

// Slot identifiers: UPPER_SNAKE_CASE, 1-64 chars.
const SLOT_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
// Skill identifiers: lower-kebab-case, 1-64 chars.
const SKILL_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

const skillAttachmentSchema = z
  .object({
    skillId: z.string().regex(SKILL_ID_RE, 'skillId has invalid shape'),
    credentialBindings: z.record(
      z.string().regex(SLOT_RE, 'slot has invalid shape'),
      z.string().min(1).max(256),
    ),
  })
  .strict();

/**
 * Body schema for `PATCH /admin/agents/:id/skill-attachments`. Replaces the
 * entire skill_attachments array. An empty array detaches all skills.
 */
const patchAttachmentsBodySchema = z
  .object({
    skillAttachments: z.array(skillAttachmentSchema).max(20),
  })
  .strict();

/**
 * Body schema for `PATCH /admin/agents/:id/connector-attachments` (TASK-107).
 * Replaces the entire connector_attachments id list. An empty array detaches
 * all connectors. The wire is a plain list of connector-id strings; the full
 * slug/dedup/count validation lives in `validateConnectorAttachmentIds` (the
 * single source of truth, shared with the store), called by the handler.
 */
const patchConnectorAttachmentsBodySchema = z
  .object({
    connectorAttachments: z.array(z.string()),
  })
  .strict();

/**
 * Body schema for `POST /admin/agents/:id/authored-skills/promote`.
 *
 * TASK-100 — a promoted skill carries NO capability block; its reach is the
 * connectors it references. The legacy admin-supplied `grants` (hosts /
 * credentials / mcpServers baked into the skill) are DEPRECATED and IGNORED: a
 * skill can no longer hold capabilities, so there is nothing for an admin grant
 * to replace. The field is kept OPTIONAL on the wire so the existing review
 * dialog keeps compiling; the promoted manifest is built body + connectors only.
 */
const promoteAuthoredSkillBodySchema = z
  .object({
    skillId: z.string().min(1),
    targetScope: z.enum(['global', 'user']),
    // @deprecated TASK-100 — ignored (a skill declares no capabilities).
    grants: z
      .object({
        allowedHosts: z.array(z.string()),
        credentials: z.array(
          z.object({
            slot: z.string(),
            kind: z.literal('api-key'),
          }),
        ),
        mcpServers: z.array(z.unknown()),
      })
      .optional(),
  })
  .strict();

// --- helpers ---------------------------------------------------------------

/**
 * Try to authenticate. Returns the user on success, null on failure (we
 * already wrote the 401). Mirrors @ax/auth's admin-routes pattern: the
 * check is inline, not a wrapper, so each handler has explicit control
 * over its response shape.
 */
async function requireUser(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<{ id: string; isAdmin: boolean } | null> {
  try {
    const result = await bus.call<
      { req: RouteRequest },
      { user: { id: string; isAdmin: boolean } }
    >('auth:require-user', ctx, { req });
    return { id: result.user.id, isAdmin: result.user.isAdmin };
  } catch (err) {
    // PluginError 'unauthenticated' is the documented rejection; any
    // other failure (e.g. auth plugin not loaded) returns 401 too —
    // an admin endpoint that can't authenticate is closed by default.
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
}

function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return {};
  return JSON.parse(body.toString('utf8'));
}

interface ParsedBody<T> {
  ok: true;
  value: T;
}
interface ParseError {
  ok: false;
  status: 400 | 413;
  message: string;
}

/**
 * Body parsing pipeline. Returns either a parsed value or an error
 * descriptor whose `status`/`message` the caller writes verbatim. Order:
 *   1. 413 on body > ADMIN_BODY_MAX_BYTES (the http-server's own 1 MiB
 *      cap is wider; we tighten here for the admin surface).
 *   2. 400 on JSON.parse failure.
 *   3. 400 on zod validation failure (collapsed to one message; raw zod
 *      issue paths are NOT echoed — they can leak internal field names
 *      and confuse callers).
 *   4. 400 on the wildcard-bypass case (allowedTools=[] AND mcpConfigIds=[]).
 */
function parseAndValidate<T extends z.ZodTypeAny>(
  body: Buffer,
  schema: T,
): ParsedBody<z.infer<T>> | ParseError {
  if (body.length > ADMIN_BODY_MAX_BYTES) {
    return { ok: false, status: 413, message: 'body-too-large' };
  }
  let raw: unknown;
  try {
    raw = parseJsonBody(body);
  } catch {
    return { ok: false, status: 400, message: 'invalid-json' };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    // first message wins; never expose `path` (some are internal-shape
    // names that leak which Zod refinement triggered).
    return {
      ok: false,
      status: 400,
      message:
        first?.message !== undefined && first.message.length > 0
          ? first.message
          : 'invalid-payload',
    };
  }
  return { ok: true, value: result.data };
}

function rejectsWildcardScope(input: {
  allowedTools?: string[] | undefined;
  mcpConfigIds?: string[] | undefined;
}): boolean {
  // Both arrays must be PRESENT and EMPTY to trigger. This matches the
  // dev-agents-stub bypass shape (Task 7) — that path is allowed at the
  // store layer but forbidden via this admin API. A PATCH that omits
  // both fields stays unaffected; a PATCH that sets both to [] hits this.
  return (
    input.allowedTools !== undefined &&
    input.allowedTools.length === 0 &&
    input.mcpConfigIds !== undefined &&
    input.mcpConfigIds.length === 0
  );
}

const WILDCARD_REJECT_MESSAGE =
  'agent must list at least one tool or one MCP config; empty arrays are reserved for dev-mode bypass';

function serializeAgent(a: Agent): Record<string, unknown> {
  // Date → ISO 8601 strings. The HTTP wire is JSON; Date doesn't serialize
  // cleanly through res.json otherwise (becomes "" via JSON.stringify of
  // Date prototype-mangled paths in some test environments). Be explicit.
  return {
    id: a.id,
    ownerId: a.ownerId,
    ownerType: a.ownerType,
    visibility: a.visibility,
    displayName: a.displayName,
    systemPrompt: a.systemPrompt,
    allowedTools: a.allowedTools,
    mcpConfigIds: a.mcpConfigIds,
    model: a.model,
    workspaceRef: a.workspaceRef,
    skillAttachments: a.skillAttachments,
    connectorAttachments: a.connectorAttachments,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

/**
 * Translate a service-hook PluginError into an HTTP status. `forbidden`
 * → 403, `not-found` → 404, `invalid-payload` → 400, anything else →
 * 500 (logged at the http-server's catch-all).
 */
function writeServiceError(res: RouteResponse, err: unknown): boolean {
  if (err instanceof PluginError) {
    if (err.code === 'forbidden') {
      res.status(403).json({ error: 'forbidden' });
      return true;
    }
    if (err.code === 'not-found') {
      res.status(404).json({ error: 'not-found' });
      return true;
    }
    if (err.code === 'invalid-payload') {
      res.status(400).json({ error: err.message });
      return true;
    }
  }
  return false;
}

// --- non-admin attachment guard -------------------------------------------

/**
 * SECURITY (non-admin owner-scoped attachment). Agent CRUD + attachments are
 * owner-scoped (the agent-ownership ACL lives in the hooks' `assertWriteAllowed`),
 * so a non-admin may manage their OWN agents. The one escalation an attachment
 * could enable is making the agent spend a GLOBAL (company) credential — and that
 * only ever comes from a `keyMode:'workspace'` connector. So a non-admin's set is
 * rejected iff ANY of the given connector ids resolves — OWNER-SCOPED to the actor
 * — to keyMode 'workspace'. A personal connector is the user's own per-user key
 * (their own reach → no escalation); a connector the actor doesn't own never
 * resolves and is a runtime no-op (tolerated, like a dangling id). Admins bypass
 * this entirely (admin curation is unchanged).
 *
 * Fail-closed: if `connectors:resolve` is unavailable we can't verify keyMode, so
 * a non-empty connector set from a non-admin is refused (attaching stays
 * admin-only in a connectors-less preset).
 *
 * Returns an error message to 403 with, or null when the set is allowed.
 */
async function workspaceConnectorGrantViolation(
  bus: HookBus,
  ctx: AgentContext,
  userId: string,
  connectorIds: readonly string[],
): Promise<string | null> {
  if (connectorIds.length === 0) return null;
  if (!bus.hasService('connectors:resolve')) {
    return 'cannot verify connector reach — attaching connectors is admin-only here';
  }
  for (const connectorId of connectorIds) {
    let keyMode: string | undefined;
    try {
      const resolved = await bus.call<
        { userId: string; connectorId: string },
        { keyMode: string }
      >('connectors:resolve', ctx, { userId, connectorId });
      keyMode = resolved.keyMode;
    } catch {
      // not-found / not owned by this user → never resolves at runtime → no-op.
      continue;
    }
    if (keyMode === 'workspace') {
      return `forbidden: '${connectorId}' is a workspace (shared) connector — only an admin can attach it`;
    }
  }
  return null;
}

// --- handler factory -------------------------------------------------------

export interface AdminRouteDeps {
  bus: HookBus;
}

export function createAdminAgentRouteHandlers(deps: AdminRouteDeps) {
  // A per-handler ctx is acceptable for MVP (Task 9 spec). A subscriber
  // observing audit events sees `userId: 'admin'` in the ctx — the actual
  // acting-user id is in the agents:resolved subscriber payload, which is
  // what audit consumers should key off. Documented in the plan.
  const ctx = makeAgentContext({
    sessionId: 'agents-admin',
    agentId: PLUGIN_NAME,
    userId: 'admin',
  });

  return {
    /** POST /admin/agents */
    async create(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;

      const parsed = parseAndValidate(req.body, createBodySchema);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      if (rejectsWildcardScope(parsed.value)) {
        res.status(400).json({ error: WILDCARD_REJECT_MESSAGE });
        return;
      }
      // The zod schema guarantees the AgentInput shape; cast through unknown
      // because exactOptionalPropertyTypes treats omitted-vs-explicit-undefined
      // differently between the schema's inferred shape and AgentInput's
      // declared optional fields. Runtime payload is identical.
      const input = parsed.value as unknown as AgentInput;
      try {
        const out = await deps.bus.call<CreateInput, CreateOutput>(
          'agents:create',
          ctx,
          {
            actor: { userId: actor.id, isAdmin: actor.isAdmin } satisfies Actor,
            input,
          },
        );
        res.status(201).json({ agent: serializeAgent(out.agent) });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** GET /admin/agents */
    async list(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      // TODO Task 14: pass teamIds: await listTeamsForUser(actor.id) so
      // team agents the user belongs to surface here. Until @ax/teams
      // ships, this list returns personal agents only (the store's
      // scope filter accepts an empty teamIds list and only matches
      // owner_type='user' rows).
      const out = await deps.bus.call<ListForUserInput, ListForUserOutput>(
        'agents:list-for-user',
        ctx,
        { userId: actor.id },
      );
      res.status(200).json({ agents: out.agents.map(serializeAgent) });
    },

    /** GET /admin/agents/:id */
    async show(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const agentId = req.params.id;
      if (typeof agentId !== 'string' || agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      try {
        const out = await deps.bus.call<ResolveInput, ResolveOutput>(
          'agents:resolve',
          ctx,
          { agentId, userId: actor.id },
        );
        res.status(200).json({ agent: serializeAgent(out.agent) });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** PATCH /admin/agents/:id */
    async update(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const agentId = req.params.id;
      if (typeof agentId !== 'string' || agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const parsed = parseAndValidate(req.body, updateBodySchema);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      if (rejectsWildcardScope(parsed.value)) {
        res.status(400).json({ error: WILDCARD_REJECT_MESSAGE });
        return;
      }
      try {
        const out = await deps.bus.call<UpdateInput, UpdateOutput>(
          'agents:update',
          ctx,
          {
            actor: { userId: actor.id, isAdmin: actor.isAdmin } satisfies Actor,
            agentId,
            patch: parsed.value as Partial<AgentInput>,
          },
        );
        res.status(200).json({ agent: serializeAgent(out.agent) });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** DELETE /admin/agents/:id */
    async destroy(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const agentId = req.params.id;
      if (typeof agentId !== 'string' || agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      try {
        await deps.bus.call<DeleteInput, void>('agents:delete', ctx, {
          actor: { userId: actor.id, isAdmin: actor.isAdmin } satisfies Actor,
          agentId,
        });
        res.status(204).end();
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** PATCH /admin/agents/:id/skill-attachments */
    async setSkillAttachments(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      // Owner-scoped (agent ownership enforced by the hook's assertWriteAllowed).
      // The validator below rejects any credential binding, and the non-admin
      // workspace-connector guard (after skill resolution) rejects granting a
      // shared/global-keyed connector via a referenced skill — see the post-
      // resolution check. Admins bypass that guard.
      const agentId = req.params.id;
      if (typeof agentId !== 'string' || agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const parsed = parseAndValidate(req.body, patchAttachmentsBodySchema);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      const attachments = parsed.value.skillAttachments as NewAttachmentInput[];
      // Collect unique skill ids to resolve in one call.
      const uniqueSkillIds = [...new Set(attachments.map((a) => a.skillId))];
      // Resolve referenced skills via the bus. A missing skills plugin surfaces
      // as 'no-service'; treat it the same as zero skills found.
      // TASK-100 — a skill declares no capabilities; skills:resolve returns id +
      // body + manifest + connector references only. The attachment validator
      // confirms the skill exists and rejects any credential binding.
      let resolvedSkills: Array<{
        id: string;
        connectors?: string[];
        bodyMd: string;
        manifestYaml: string;
      }> = [];
      if (uniqueSkillIds.length > 0) {
        try {
          // Resolve against the ACTOR'S scope: skills:resolve unions the global
          // catalog with the caller's USER-SCOPED skills only when ownerUserId is
          // passed (user-wins on id collision). A non-admin attaches their OWN
          // user-scoped skills (from /settings/skills), so we must pass it or
          // those ids resolve to nothing → spurious skill-not-found. Passing it
          // for admins too is a superset (global catalog + their own), and it
          // lets the workspace-connector guard below see a user-scoped skill's
          // referenced connectors. Mirrors the orchestrator's runtime resolve.
          const result = await deps.bus.call<
            { skillIds: string[]; ownerUserId: string },
            { skills: typeof resolvedSkills }
          >('skills:resolve', ctx, {
            skillIds: uniqueSkillIds,
            ownerUserId: actor.id,
          });
          resolvedSkills = result.skills;
        } catch (err) {
          if (err instanceof PluginError && err.code === 'no-service') {
            // @ax/skills not loaded — any attachment reference is not-found.
            resolvedSkills = [];
          } else {
            throw err;
          }
        }
      }
      // TODO(orchestrator-grows-requiredCredentials): pass agent.requiredCredentials
      // keys here once Phase 1.5 plumbs that field through the agent shape. For
      // Phase 1.4 the only seed is the attachments themselves.
      const reservedAgentSlots: readonly string[] = [];
      const validation = validateNewAttachments(attachments, resolvedSkills, reservedAgentSlots);
      if (!validation.ok) {
        res.status(400).json({ error: validation.message, code: validation.code });
        return;
      }
      // Non-admin owner-scoped guard: a referenced skill must not pull in a
      // workspace (shared/global-keyed) connector — that would let the agent
      // spend a company credential. Admins may attach any skill.
      if (!actor.isAdmin) {
        const referencedConnectors = [
          ...new Set(resolvedSkills.flatMap((s) => s.connectors ?? [])),
        ];
        const violation = await workspaceConnectorGrantViolation(
          deps.bus,
          ctx,
          actor.id,
          referencedConnectors,
        );
        if (violation !== null) {
          res.status(403).json({ error: violation });
          return;
        }
      }
      try {
        const out = await deps.bus.call<
          { actor: Actor; agentId: string; attachments: SkillAttachment[] },
          { agent: Agent }
        >('agents:set-skill-attachments', ctx, {
          actor: { userId: actor.id, isAdmin: actor.isAdmin } satisfies Actor,
          agentId,
          attachments: validation.validated as SkillAttachment[],
        });
        res.status(200).json({ agent: serializeAgent(out.agent) });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** PATCH /admin/agents/:id/connector-attachments (TASK-107) */
    async setConnectorAttachments(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      // Owner-scoped (agent ownership enforced by the hook's assertWriteAllowed).
      // A non-admin may attach their OWN PERSONAL connectors (their own reach);
      // the workspace-connector guard after id validation rejects attaching a
      // shared/global-keyed connector (that would grant the company key). Admins
      // bypass that guard.
      const agentId = req.params.id;
      if (typeof agentId !== 'string' || agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const parsed = parseAndValidate(req.body, patchConnectorAttachmentsBodySchema);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      // Slug/dedup/count validation (the single source of truth, shared with
      // the store). Connector EXISTENCE is intentionally NOT checked: a dangling
      // id is tolerated and simply never resolves at session open (the
      // orchestrator's NON-FATAL union) — mirroring skill_attachments' orphan
      // tolerance and keeping this route decoupled from @ax/connectors.
      let connectorIds: string[];
      try {
        connectorIds = validateConnectorAttachmentIds(parsed.value.connectorAttachments);
      } catch (err) {
        if (err instanceof PluginError && err.code === 'invalid-payload') {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      // Non-admin owner-scoped guard: reject attaching a workspace (shared/
      // global-keyed) connector. Personal connectors (own per-user key) are fine.
      if (!actor.isAdmin) {
        const violation = await workspaceConnectorGrantViolation(
          deps.bus,
          ctx,
          actor.id,
          connectorIds,
        );
        if (violation !== null) {
          res.status(403).json({ error: violation });
          return;
        }
      }
      try {
        const out = await deps.bus.call<
          SetConnectorAttachmentsInput,
          SetConnectorAttachmentsOutput
        >('agents:set-connector-attachments', ctx, {
          actor: { userId: actor.id, isAdmin: actor.isAdmin } satisfies Actor,
          agentId,
          connectorIds,
        });
        res.status(200).json({ agent: serializeAgent(out.agent) });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** GET /admin/agents/:id/authored-skills */
    async listAuthoredSkills(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      if (!actor.isAdmin) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const agentId = req.params.id;
      if (typeof agentId !== 'string' || agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const out = await deps.bus.call<AgentsListAuthoredSkillsInput, AgentsListAuthoredSkillsOutput>(
        'agents:list-authored-skills',
        ctx,
        { agentId },
      );
      res.status(200).json(out);
    },

    /** POST /admin/agents/:id/authored-skills/promote */
    async promoteAuthoredSkill(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      if (!actor.isAdmin) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const agentId = req.params.id;
      if (typeof agentId !== 'string' || agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }

      // Check that skills:upsert is available — soft dep, do not add to manifest.
      if (!deps.bus.hasService('skills:upsert')) {
        res.status(503).json({ error: 'skills-plugin-not-loaded' });
        return;
      }

      const parsed = parseAndValidate(req.body, promoteAuthoredSkillBodySchema);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      const body = parsed.value;

      // For user-scope promotion, resolve the agent owner BEFORE checking
      // authored skills so we give a clear "team-agent-user-scope-unsupported"
      // response rather than a confusing "authored-skill-not-found" (team agents
      // have no single-owner workspace so list-authored-skills returns []).
      let userScopeOwnerId: string | undefined;
      if (body.targetScope === 'user') {
        const { agents: personalOwners } = await deps.bus.call<
          Record<string, never>,
          { agents: Array<{ agentId: string; ownerUserId: string }> }
        >('agents:list-personal-owners', ctx, {});
        const ownerEntry = personalOwners.find((a) => a.agentId === agentId);
        if (ownerEntry === undefined) {
          // Agent not found in personal owners: it's a team agent or nonexistent.
          res.status(400).json({ error: 'team-agent-user-scope-unsupported' });
          return;
        }
        userScopeOwnerId = ownerEntry.ownerUserId;
      }

      // Load the agent's authored skills and find the target.
      const { skills } = await deps.bus.call<AgentsListAuthoredSkillsInput, AgentsListAuthoredSkillsOutput>(
        'agents:list-authored-skills',
        ctx,
        { agentId },
      );
      const target = skills.find((s) => s.id === body.skillId);
      if (target === undefined) {
        res.status(404).json({ error: 'authored-skill-not-found' });
        return;
      }

      // TASK-100 — a promoted skill carries NO capability block; its reach is the
      // connectors it references (preserved from the authored draft). The legacy
      // admin `grants` are ignored (a skill can't hold capabilities). A connector's
      // reach is gated by the connector approval wall, not baked into the skill.
      const manifestYaml = buildSkillManifestYaml({
        id: target.id,
        description: target.description,
        version: target.version,
        connectors: target.connectors,
      });

      try {
        if (body.targetScope === 'global') {
          await deps.bus.call<
            { manifestYaml: string; bodyMd: string; scope: 'global' },
            { skillId: string; created: boolean }
          >('skills:upsert', ctx, {
            manifestYaml,
            bodyMd: target.bodyMd,
            scope: 'global',
          });
        } else {
          // userScopeOwnerId is guaranteed non-undefined here: we checked above
          // and returned early if it was missing.
          await deps.bus.call<
            { manifestYaml: string; bodyMd: string; scope: 'user'; ownerUserId: string },
            { skillId: string; created: boolean }
          >('skills:upsert', ctx, {
            manifestYaml,
            bodyMd: target.bodyMd,
            scope: 'user',
            ownerUserId: userScopeOwnerId!,
          });
        }
      } catch (err) {
        if (writeServiceError(res, err)) return;
        // skills:upsert manifest-validation errors (invalid-host, invalid-slot,
        // invalid-mcp-command, etc.) are PluginErrors not mapped by writeServiceError.
        // Return them as 400 so callers get actionable feedback.
        if (err instanceof PluginError) {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }

      res.status(200).json({
        promoted: true,
        skillId: target.id,
        targetScope: body.targetScope,
      });
    },

    /** DELETE /admin/agents/:id/authored-skills/:skillId
     *
     * Hard-delete an agent-authored draft (the Delete affordance on the admin
     * AuthoredSkillsSection). Admin-only. Authored drafts are keyed by the
     * agent's single owner, so we resolve it the same way promote does
     * (`agents:list-personal-owners`) and hand the owner to @ax/skills'
     * `skills:delete-authored` hook — @ax/agents never touches the skills store
     * directly (I4). A team/nonexistent agent has no personal authored namespace
     * → 404. Idempotent: deleting an already-gone draft still returns 204. */
    async deleteAuthoredSkill(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      if (!actor.isAdmin) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const agentId = req.params.id;
      const skillId = req.params.skillId;
      if (typeof agentId !== 'string' || agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      if (typeof skillId !== 'string' || skillId.length === 0) {
        res.status(400).json({ error: 'missing-skill-id' });
        return;
      }

      // Soft dep — the skills plugin owns the authored store. Mirror promote's
      // skills:upsert guard (503, not added to the manifest).
      if (!deps.bus.hasService('skills:delete-authored')) {
        res.status(503).json({ error: 'skills-plugin-not-loaded' });
        return;
      }

      // Resolve the agent's owner (authored drafts are per-(owner, agent)). A
      // team/nonexistent agent isn't a personal owner → no such authored draft.
      const { agents: personalOwners } = await deps.bus.call<
        Record<string, never>,
        { agents: Array<{ agentId: string; ownerUserId: string }> }
      >('agents:list-personal-owners', ctx, {});
      const ownerEntry = personalOwners.find((a) => a.agentId === agentId);
      if (ownerEntry === undefined) {
        res.status(404).json({ error: 'authored-skill-not-found' });
        return;
      }

      try {
        await deps.bus.call<
          { ownerUserId: string; agentId: string; skillId: string },
          { deleted: boolean }
        >('skills:delete-authored', ctx, {
          ownerUserId: ownerEntry.ownerUserId,
          agentId,
          skillId,
        });
        res.status(204).end();
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },
  };
}

/**
 * Register the admin agent routes against @ax/http-server. Returned
 * unregister callbacks should be tracked by the plugin and called in
 * shutdown so a re-init in tests doesn't trip duplicate-route.
 */
export async function registerAdminAgentRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createAdminAgentRouteHandlers({ bus });
  const routes: Array<{
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'POST', path: '/admin/agents', handler: handlers.create },
    { method: 'GET', path: '/admin/agents', handler: handlers.list },
    { method: 'GET', path: '/admin/agents/:id', handler: handlers.show },
    { method: 'PATCH', path: '/admin/agents/:id', handler: handlers.update },
    { method: 'DELETE', path: '/admin/agents/:id', handler: handlers.destroy },
    {
      method: 'PATCH',
      path: '/admin/agents/:id/skill-attachments',
      handler: handlers.setSkillAttachments,
    },
    {
      method: 'PATCH',
      path: '/admin/agents/:id/connector-attachments',
      handler: handlers.setConnectorAttachments,
    },
    {
      method: 'GET',
      path: '/admin/agents/:id/authored-skills',
      handler: handlers.listAuthoredSkills,
    },
    // DELETE /admin/agents/:id/authored-skills/:skillId — a 5-segment DELETE
    // pattern. Patterns are segregated by method, so it never collides with the
    // 5-segment POST .../promote, nor with the 3-segment DELETE /admin/agents/:id.
    {
      method: 'DELETE',
      path: '/admin/agents/:id/authored-skills/:skillId',
      handler: handlers.deleteAuthoredSkill,
    },
    {
      method: 'POST',
      path: '/admin/agents/:id/authored-skills/promote',
      handler: handlers.promoteAuthoredSkill,
    },
  ];
  const unregisters: Array<() => void> = [];
  for (const route of routes) {
    const result = await bus.call<unknown, { unregister: () => void }>(
      'http:register-route',
      initCtx,
      route,
    );
    unregisters.push(result.unregister);
  }
  return unregisters;
}
