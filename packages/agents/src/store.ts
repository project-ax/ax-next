import { randomBytes } from 'node:crypto';
import { PluginError } from '@ax/core';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { AgentsDatabase, AgentsRow } from './migrations.js';
import { scopedAgents, type AgentScope } from './scope.js';
import type { Agent, AgentInput, SkillAttachment } from './types.js';

const PLUGIN_NAME = '@ax/agents';

// ---------------------------------------------------------------------------
// Validation
//
// All caller-supplied strings are bounded BEFORE INSERT. The DB has CHECKs
// for owner_type / visibility / pairing; everything else is enforced here
// because length limits and regex tests don't translate cleanly to SQL.
//
// `system_prompt` is intentionally not pattern-matched — it's free-form
// text by design (it's the prompt). We cap its length and store it
// verbatim. It flows untrusted to the LLM via the chat path; that's the
// expected shape. The Week 9.5 plan §Invariant I8 calls this out.
// ---------------------------------------------------------------------------

const DISPLAY_NAME_MIN = 1;
const DISPLAY_NAME_MAX = 128;
const SYSTEM_PROMPT_MAX = 32 * 1024; // 32 KiB
const ALLOWED_TOOLS_MAX = 100;
const MCP_CONFIG_IDS_MAX = 50;
const WORKSPACE_REF_MAX = 256;
// allowedTools is a union of MCP tool names (lowercase, namespaced by
// @ax/mcp-client's stricter TOOL_NAME_RE) AND Claude Agent SDK built-ins
// (`Bash`, `Read`, `WebFetch`, `Skill`, …, PascalCase). The agent layer
// relaxes the leading-letter case so SDK built-ins parse without an
// out-of-band case-mapping table. Keep this in sync with admin-routes.ts's
// schema regex (the two are belt-and-braces).
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
// Mirrors @ax/mcp-client/config.ts ID_RE. Same rationale.
const MCP_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const WORKSPACE_REF_RE = /^[A-Za-z0-9_./-]+$/;

const DEFAULT_ALLOWED_MODELS: readonly string[] = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

function loadAllowedModelsFromEnv(): readonly string[] | null {
  const raw = process.env.AX_AGENT_MODELS_ALLOWED;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length === 0 ? null : parts;
}

export function resolveAllowedModels(
  configured: readonly string[] | undefined,
): readonly string[] {
  if (configured !== undefined && configured.length > 0) return configured;
  const fromEnv = loadAllowedModelsFromEnv();
  if (fromEnv !== null) return fromEnv;
  return DEFAULT_ALLOWED_MODELS;
}

interface ValidationContext {
  allowedModels: readonly string[];
}

function invalid(message: string): PluginError {
  return new PluginError({
    code: 'invalid-payload',
    plugin: PLUGIN_NAME,
    message,
  });
}

function validateDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalid('displayName must be a string');
  }
  if (value.length < DISPLAY_NAME_MIN || value.length > DISPLAY_NAME_MAX) {
    throw invalid(
      `displayName must be ${DISPLAY_NAME_MIN}-${DISPLAY_NAME_MAX} chars`,
    );
  }
  if (value !== value.trim()) {
    throw invalid('displayName must not have leading or trailing whitespace');
  }
  return value;
}

function validateSystemPrompt(value: unknown): string {
  // TASK-140: an ABSENT systemPrompt is now legal — a BARE agent (the
  // conversational-first-run path) has no identity string; its identity lives
  // in `.ax/` files. undefined/null → '' so `agents:create` can mint a bare
  // agent. A PRESENT non-string is still a hard reject (that's a malformed
  // payload, not an intentional omission). The column itself dies in Phase 4.
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw invalid('systemPrompt must be a string');
  }
  if (value.length > SYSTEM_PROMPT_MAX) {
    throw invalid(`systemPrompt must be at most ${SYSTEM_PROMPT_MAX} chars`);
  }
  return value;
}

function validateAllowedTools(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw invalid('allowedTools must be an array');
  }
  if (value.length > ALLOWED_TOOLS_MAX) {
    throw invalid(`allowedTools must have at most ${ALLOWED_TOOLS_MAX} entries`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw invalid('allowedTools entries must be strings');
    }
    if (!TOOL_NAME_RE.test(entry)) {
      throw invalid(
        `allowedTools entry '${entry}' must match ${TOOL_NAME_RE.source}`,
      );
    }
    if (seen.has(entry)) {
      throw invalid(`allowedTools entry '${entry}' duplicated`);
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

function validateMcpConfigIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw invalid('mcpConfigIds must be an array');
  }
  if (value.length > MCP_CONFIG_IDS_MAX) {
    throw invalid(`mcpConfigIds must have at most ${MCP_CONFIG_IDS_MAX} entries`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw invalid('mcpConfigIds entries must be strings');
    }
    if (!MCP_ID_RE.test(entry)) {
      throw invalid(
        `mcpConfigIds entry '${entry}' must match ${MCP_ID_RE.source}`,
      );
    }
    if (seen.has(entry)) {
      throw invalid(`mcpConfigIds entry '${entry}' duplicated`);
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

// TASK-107 — connector-id grammar, re-declared per I2 (no @ax/connectors import).
// MUST stay in lockstep with @ax/connectors store.ts `ID_RE` / `ID_MAX`; the
// attach store only references a connector id, never interprets it. A bad shape
// is a LOUD reject at the write boundary (a dangling-but-well-formed id is fine
// — it simply never resolves at session open).
const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const CONNECTOR_ID_MAX = 128;
const CONNECTOR_ATTACHMENTS_MAX = 50;

/**
 * Validate a per-agent connector-attachment id list: bounded count, each a
 * well-formed connector-id slug, deduped. Returns the deduped, validated list.
 * Used by the admin route before calling agents:set-connector-attachments.
 */
export function validateConnectorAttachmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw invalid('connectorAttachments must be an array');
  }
  if (value.length > CONNECTOR_ATTACHMENTS_MAX) {
    throw invalid(
      `connectorAttachments must have at most ${CONNECTOR_ATTACHMENTS_MAX} entries`,
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw invalid('connectorAttachments entries must be strings');
    }
    if (entry.length === 0 || entry.length > CONNECTOR_ID_MAX) {
      throw invalid(`connectorAttachments entry must be 1-${CONNECTOR_ID_MAX} chars`);
    }
    if (!CONNECTOR_ID_RE.test(entry)) {
      throw invalid(
        `connectorAttachments entry '${entry}' must match ${CONNECTOR_ID_RE.source}`,
      );
    }
    if (seen.has(entry)) {
      throw invalid(`connectorAttachments entry '${entry}' duplicated`);
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

function validateModel(value: unknown, allowed: readonly string[]): string {
  if (typeof value !== 'string') {
    throw invalid('model must be a string');
  }
  if (!allowed.includes(value)) {
    throw invalid(`model '${value}' is not in the allow-list`);
  }
  return value;
}

function validateVisibility(value: unknown): 'personal' | 'team' {
  if (value !== 'personal' && value !== 'team') {
    throw invalid("visibility must be 'personal' or 'team'");
  }
  return value;
}

function validateWorkspaceRef(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw invalid('workspaceRef must be a string or null');
  }
  if (value.length === 0 || value.length > WORKSPACE_REF_MAX) {
    throw invalid(
      `workspaceRef must be 1-${WORKSPACE_REF_MAX} chars`,
    );
  }
  if (!WORKSPACE_REF_RE.test(value)) {
    throw invalid(`workspaceRef must match ${WORKSPACE_REF_RE.source}`);
  }
  return value;
}

function validateTeamId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw invalid('teamId must be a 1-128 char string');
  }
  return value;
}

interface ValidatedAgentInput {
  displayName: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
  workspaceRef: string | null;
  visibility: 'personal' | 'team';
  teamId: string | null;
}

export function validateCreateInput(
  input: AgentInput,
  vctx: ValidationContext,
): ValidatedAgentInput {
  const visibility = validateVisibility(input.visibility);
  const teamId = visibility === 'team' ? validateTeamId(input.teamId) : null;
  if (visibility === 'personal' && input.teamId !== undefined) {
    throw invalid('teamId must not be set for personal agents');
  }
  return {
    displayName: validateDisplayName(input.displayName),
    systemPrompt: validateSystemPrompt(input.systemPrompt),
    allowedTools: validateAllowedTools(input.allowedTools),
    mcpConfigIds: validateMcpConfigIds(input.mcpConfigIds),
    model: validateModel(input.model, vctx.allowedModels),
    workspaceRef: validateWorkspaceRef(input.workspaceRef ?? null),
    visibility,
    teamId,
  };
}

/**
 * Partial-update validator. Only the keys the caller actually supplied
 * are validated — `undefined` means "leave alone". Visibility / teamId
 * cannot be changed via update (Invariant I10-adjacent: changing
 * ownership type forces a new agent so workspace + ACL invariants stay
 * crisp). Callers should `agents:delete` + `agents:create` instead.
 */
export function validateUpdatePatch(
  patch: Partial<AgentInput>,
  vctx: ValidationContext,
): Partial<ValidatedAgentInput> {
  if (patch.visibility !== undefined) {
    throw invalid('visibility cannot be changed via update — recreate the agent');
  }
  if (patch.teamId !== undefined) {
    throw invalid('teamId cannot be changed via update — recreate the agent');
  }
  const out: Partial<ValidatedAgentInput> = {};
  if (patch.displayName !== undefined) {
    out.displayName = validateDisplayName(patch.displayName);
  }
  if (patch.systemPrompt !== undefined) {
    out.systemPrompt = validateSystemPrompt(patch.systemPrompt);
  }
  if (patch.allowedTools !== undefined) {
    out.allowedTools = validateAllowedTools(patch.allowedTools);
  }
  if (patch.mcpConfigIds !== undefined) {
    out.mcpConfigIds = validateMcpConfigIds(patch.mcpConfigIds);
  }
  if (patch.model !== undefined) {
    out.model = validateModel(patch.model, vctx.allowedModels);
  }
  if (patch.workspaceRef !== undefined) {
    out.workspaceRef = validateWorkspaceRef(patch.workspaceRef);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistence
//
// We use crypto.randomBytes-derived ids prefixed `agt_` rather than pulling
// a `ulid` dep. 16 bytes of randomness (128 bits) is collision-free for
// our scale and matches the auth plugin's `usr_` minting. The DB stores
// the id verbatim — no regex constraint at the row level (over-
// constraining; future schema migrations may want different shapes).
// ---------------------------------------------------------------------------

export function mintAgentId(): string {
  return `agt_${randomBytes(16).toString('base64url')}`;
}

// Validate that every value in a record is a non-empty string. Used to
// narrow JSONB-decoded `credentialBindings` shapes before trusting them
// in attachment-resolution. Array values must NOT pass (Array.isArray
// short-circuits) — `typeof [] === 'object'` is true and we don't want
// `{SLOT: ['a', 'b']}` slipping through.
function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  for (const v of Object.values(value)) {
    if (typeof v !== 'string' || v.length === 0) return false;
  }
  return true;
}

function rowToAgent(row: AgentsRow): Agent {
  // JSONB columns return parsed JS values from `pg`'s default casts —
  // narrow them defensively. A row that fails this cast is corrupt.
  const allowedTools = row.allowed_tools;
  const mcpConfigIds = row.mcp_config_ids;
  if (
    !Array.isArray(allowedTools) ||
    !allowedTools.every((s) => typeof s === 'string')
  ) {
    throw new PluginError({
      code: 'corrupt-row',
      plugin: PLUGIN_NAME,
      message: `agents_v1_agents.${row.agent_id} has invalid allowed_tools JSONB`,
    });
  }
  if (
    !Array.isArray(mcpConfigIds) ||
    !mcpConfigIds.every((s) => typeof s === 'string')
  ) {
    throw new PluginError({
      code: 'corrupt-row',
      plugin: PLUGIN_NAME,
      message: `agents_v1_agents.${row.agent_id} has invalid mcp_config_ids JSONB`,
    });
  }
  if (row.owner_type !== 'user' && row.owner_type !== 'team') {
    throw new PluginError({
      code: 'corrupt-row',
      plugin: PLUGIN_NAME,
      message: `agents_v1_agents.${row.agent_id} has invalid owner_type`,
    });
  }
  if (row.visibility !== 'personal' && row.visibility !== 'team') {
    throw new PluginError({
      code: 'corrupt-row',
      plugin: PLUGIN_NAME,
      message: `agents_v1_agents.${row.agent_id} has invalid visibility`,
    });
  }
  const skillAttachmentsRaw = row.skill_attachments;
  if (
    !Array.isArray(skillAttachmentsRaw) ||
    !skillAttachmentsRaw.every(
      (e) =>
        e !== null &&
        typeof e === 'object' &&
        !Array.isArray(e) &&
        typeof (e as Record<string, unknown>)['skillId'] === 'string' &&
        isStringRecord((e as Record<string, unknown>)['credentialBindings']),
    )
  ) {
    throw new PluginError({
      code: 'corrupt-row',
      plugin: PLUGIN_NAME,
      message: `agents_v1_agents.${row.agent_id} has invalid skill_attachments JSONB`,
    });
  }
  const skillAttachments = skillAttachmentsRaw as SkillAttachment[];
  // TASK-107 — connector attachments are a plain string[] of connector ids.
  // A row predating the column is impossible (NOT NULL DEFAULT '[]'), but a
  // corrupt JSONB (non-array / non-string entries) is a LOUD reject, mirroring
  // the skill_attachments / mcp_config_ids guards above.
  const connectorAttachmentsRaw = row.connector_attachments;
  if (
    !Array.isArray(connectorAttachmentsRaw) ||
    !connectorAttachmentsRaw.every((s) => typeof s === 'string')
  ) {
    throw new PluginError({
      code: 'corrupt-row',
      plugin: PLUGIN_NAME,
      message: `agents_v1_agents.${row.agent_id} has invalid connector_attachments JSONB`,
    });
  }
  const connectorAttachments = connectorAttachmentsRaw as string[];
  return {
    id: row.agent_id,
    ownerId: row.owner_id,
    ownerType: row.owner_type,
    visibility: row.visibility,
    displayName: row.display_name,
    systemPrompt: row.system_prompt,
    allowedTools,
    mcpConfigIds,
    model: row.model,
    workspaceRef: row.workspace_ref,
    skillAttachments,
    connectorAttachments,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface AgentStoreCreateArgs {
  ownerId: string;
  ownerType: 'user' | 'team';
  validated: ValidatedAgentInput;
  tx?: Transaction<unknown>;
}

export interface AgentStore {
  getById(agentId: string): Promise<Agent | null>;
  listScoped(scope: AgentScope): Promise<Agent[]>;
  create(args: AgentStoreCreateArgs): Promise<Agent>;
  /**
   * Apply a validated patch. Returns the updated row. Caller MUST have
   * already verified ACL on the existing row.
   */
  update(agentId: string, patch: Partial<ValidatedAgentInput>): Promise<Agent>;
  /** Idempotent — no row → returns false. */
  deleteById(agentId: string): Promise<boolean>;
  /**
   * Lookup by opaque webhook token. Returns null on miss (no oracle —
   * the caller maps null to 404).
   */
  getByWebhookToken(token: string): Promise<Agent | null>;
  /**
   * Returns the raw `webhook_token` column value for an agent. Returns
   * null when no token has been set yet. Used internally by the plugin
   * to implement `agents:ensure-webhook-token` without surfacing the
   * token on the public `Agent` DTO.
   */
  getWebhookToken(agentId: string): Promise<string | null>;
  /**
   * Atomic write of `webhook_token`. Throws `PluginError` with code
   * `not-found` when no row matched. The UNIQUE partial index prevents
   * collisions across agents — concurrent rotations onto the same
   * token surface as a constraint error from the driver.
   */
  setWebhookToken(agentId: string, token: string): Promise<void>;
  /**
   * Returns true if at least one agent row has an entry in
   * skill_attachments[] whose skillId matches the given skillId.
   * Used by the skill-delete-guard in @ax/skills to prevent removing
   * a skill that an agent is currently relying on.
   */
  anyAttachedToSkill(skillId: string): Promise<boolean>;
  /**
   * Replace the skill_attachments array wholesale for an agent. The caller
   * (agents:set-skill-attachments) is responsible for pre-validating the
   * attachments with validateNewAttachments before calling this method.
   * Throws PluginError(not-found) when the agent row doesn't exist.
   */
  setSkillAttachments(agentId: string, attachments: SkillAttachment[]): Promise<Agent>;
  /**
   * TASK-107 — replace the connector_attachments id list wholesale for an
   * agent. The caller (agents:set-connector-attachments) pre-validates the ids
   * with validateConnectorAttachmentIds before calling. Throws
   * PluginError(not-found) when the agent row doesn't exist. Mirrors
   * setSkillAttachments.
   */
  setConnectorAttachments(agentId: string, connectorIds: string[]): Promise<Agent>;
  /**
   * Read-only enumeration of every agent id. Used by callers that need to
   * iterate the agent set without paying for full row hydration — e.g.,
   * the @ax/routines tick loop's lazy materialization of default rows. No
   * ACL filtering: the caller is a trusted background loop, not a user
   * request. Visibility / ownership filtering belongs in listScoped.
   */
  listAllIds(): Promise<string[]>;
  /**
   * Full hydration of EVERY agent row. Used by the TASK-140 identity backfill,
   * which needs each agent's displayName + system_prompt + owner to write its
   * `.ax/` identity files. Same trust posture as listAllIds (background, no
   * ACL — the caller is the boot-time migration, not a user request).
   */
  listAll(): Promise<Agent[]>;
  /**
   * Personal-agent (owner_type='user') ids paired with their owner user
   * ids. Backs `agents:list-personal-owners` — same trust posture as
   * listAllIds (background-loop caller, no ACL). Excludes team agents.
   */
  listPersonalAgentOwners(): Promise<Array<{ agentId: string; ownerUserId: string }>>;
}

export function createAgentStore(db: Kysely<AgentsDatabase>): AgentStore {
  return {
    async getById(agentId) {
      const row = await db
        .selectFrom('agents_v1_agents')
        .selectAll('agents_v1_agents')
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      return row === undefined ? null : rowToAgent(row);
    },

    async listScoped(scope) {
      const rows = await scopedAgents(db, scope)
        .orderBy('created_at', 'desc')
        .execute();
      return rows.map(rowToAgent);
    },

    async create({ ownerId, ownerType, validated, tx }) {
      const id = mintAgentId();
      const now = new Date();
      const exec = (tx ?? db) as Kysely<AgentsDatabase>;
      const row = await exec
        .insertInto('agents_v1_agents')
        .values({
          agent_id: id,
          owner_id: ownerId,
          owner_type: ownerType,
          visibility: validated.visibility,
          display_name: validated.displayName,
          system_prompt: validated.systemPrompt,
          // Kysely's pg dialect serializes JSONB on the way down; pass the
          // arrays directly. (Verified vs. session-postgres patterns.)
          allowed_tools: JSON.stringify(validated.allowedTools) as unknown,
          mcp_config_ids: JSON.stringify(validated.mcpConfigIds) as unknown,
          model: validated.model,
          workspace_ref: validated.workspaceRef,
          skill_attachments: JSON.stringify([]) as unknown,
          connector_attachments: JSON.stringify([]) as unknown,
          created_at: now,
          updated_at: now,
        } as never)
        .returning([
          'agent_id',
          'owner_id',
          'owner_type',
          'visibility',
          'display_name',
          'system_prompt',
          'allowed_tools',
          'mcp_config_ids',
          'model',
          'workspace_ref',
          'webhook_token',
          'skill_attachments',
          'connector_attachments',
          'created_at',
          'updated_at',
        ])
        .executeTakeFirstOrThrow();
      return rowToAgent(row as AgentsRow);
    },

    async update(agentId, patch) {
      const now = new Date();
      const setClause: Record<string, unknown> = { updated_at: now };
      if (patch.displayName !== undefined) setClause.display_name = patch.displayName;
      if (patch.systemPrompt !== undefined) setClause.system_prompt = patch.systemPrompt;
      if (patch.allowedTools !== undefined) {
        setClause.allowed_tools = JSON.stringify(patch.allowedTools);
      }
      if (patch.mcpConfigIds !== undefined) {
        setClause.mcp_config_ids = JSON.stringify(patch.mcpConfigIds);
      }
      if (patch.model !== undefined) setClause.model = patch.model;
      if (patch.workspaceRef !== undefined) setClause.workspace_ref = patch.workspaceRef;

      const row = await db
        .updateTable('agents_v1_agents')
        .set(setClause as never)
        .where('agent_id', '=', agentId)
        .returning([
          'agent_id',
          'owner_id',
          'owner_type',
          'visibility',
          'display_name',
          'system_prompt',
          'allowed_tools',
          'mcp_config_ids',
          'model',
          'workspace_ref',
          'webhook_token',
          'skill_attachments',
          'connector_attachments',
          'created_at',
          'updated_at',
        ])
        .executeTakeFirst();
      if (row === undefined) {
        throw new PluginError({
          code: 'not-found',
          plugin: PLUGIN_NAME,
          message: `agent '${agentId}' not found`,
        });
      }
      return rowToAgent(row as AgentsRow);
    },

    async deleteById(agentId) {
      const result = await db
        .deleteFrom('agents_v1_agents')
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      // postgres returns BigInt for numAffectedRows; coerce to number for the
      // boolean check.
      return Number(result.numDeletedRows ?? 0n) > 0;
    },

    async getByWebhookToken(token) {
      const row = await db
        .selectFrom('agents_v1_agents')
        .selectAll('agents_v1_agents')
        .where('webhook_token', '=', token)
        .executeTakeFirst();
      return row === undefined ? null : rowToAgent(row);
    },

    async getWebhookToken(agentId) {
      const row = await db
        .selectFrom('agents_v1_agents')
        .select(['webhook_token'])
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      return row === undefined ? null : (row.webhook_token ?? null);
    },

    async setWebhookToken(agentId, token) {
      const result = await db
        .updateTable('agents_v1_agents')
        .set({ webhook_token: token, updated_at: new Date() } as never)
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      const affected = Number(result.numUpdatedRows ?? 0n);
      if (affected === 0) {
        throw new PluginError({
          code: 'not-found',
          plugin: PLUGIN_NAME,
          message: `agent '${agentId}' not found`,
        });
      }
    },

    async anyAttachedToSkill(skillId) {
      // JSONB containment: skill_attachments array contains an object with
      // the given skillId. Returns on the first match (LIMIT 1).
      const row = await db
        .selectFrom('agents_v1_agents')
        .select(sql<number>`1`.as('one'))
        .where(sql<boolean>`skill_attachments @> ${JSON.stringify([{ skillId }])}::jsonb`)
        .limit(1)
        .executeTakeFirst();
      return Boolean(row);
    },

    async listAllIds() {
      const rows = await db
        .selectFrom('agents_v1_agents')
        .select(['agent_id'])
        .orderBy('agent_id')
        .execute();
      return rows.map((r) => r.agent_id);
    },

    async listAll() {
      const rows = await db
        .selectFrom('agents_v1_agents')
        .selectAll('agents_v1_agents')
        .orderBy('agent_id')
        .execute();
      return rows.map(rowToAgent);
    },

    async listPersonalAgentOwners() {
      const rows = await db
        .selectFrom('agents_v1_agents')
        .select(['agent_id', 'owner_id'])
        .where('owner_type', '=', 'user')
        .orderBy('agent_id')
        .execute();
      return rows.map((r) => ({ agentId: r.agent_id, ownerUserId: r.owner_id }));
    },

    async setSkillAttachments(agentId, attachments) {
      const row = await db
        .updateTable('agents_v1_agents')
        .set({
          skill_attachments: JSON.stringify(attachments) as unknown,
          updated_at: new Date(),
        } as never)
        .where('agent_id', '=', agentId)
        .returning([
          'agent_id',
          'owner_id',
          'owner_type',
          'visibility',
          'display_name',
          'system_prompt',
          'allowed_tools',
          'mcp_config_ids',
          'model',
          'workspace_ref',
          'webhook_token',
          'skill_attachments',
          'connector_attachments',
          'created_at',
          'updated_at',
        ])
        .executeTakeFirst();
      if (row === undefined) {
        throw new PluginError({
          code: 'not-found',
          plugin: PLUGIN_NAME,
          message: `agent '${agentId}' not found`,
        });
      }
      return rowToAgent(row as AgentsRow);
    },

    async setConnectorAttachments(agentId, connectorIds) {
      const row = await db
        .updateTable('agents_v1_agents')
        .set({
          connector_attachments: JSON.stringify(connectorIds) as unknown,
          updated_at: new Date(),
        } as never)
        .where('agent_id', '=', agentId)
        .returning([
          'agent_id',
          'owner_id',
          'owner_type',
          'visibility',
          'display_name',
          'system_prompt',
          'allowed_tools',
          'mcp_config_ids',
          'model',
          'workspace_ref',
          'webhook_token',
          'skill_attachments',
          'connector_attachments',
          'created_at',
          'updated_at',
        ])
        .executeTakeFirst();
      if (row === undefined) {
        throw new PluginError({
          code: 'not-found',
          plugin: PLUGIN_NAME,
          message: `agent '${agentId}' not found`,
        });
      }
      return rowToAgent(row as AgentsRow);
    },
  };
}
