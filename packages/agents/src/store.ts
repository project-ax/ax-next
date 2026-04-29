import { randomBytes } from 'node:crypto';
import { PluginError } from '@ax/core';
import type { Kysely } from 'kysely';
import type { AgentsDatabase, AgentsRow } from './migrations.js';
import { scopedAgents, type AgentScope } from './scope.js';
import type { Agent, AgentInput } from './types.js';

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
// Mirrors the tool-dispatcher plugin's TOOL_NAME_RE (now in @ax/mcp-client) —
// keep in sync if the dispatcher relaxes it. Tightening here would exclude
// dispatcher-valid tool names from agent allow-lists, which is wrong.
const TOOL_NAME_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface AgentStoreCreateArgs {
  ownerId: string;
  ownerType: 'user' | 'team';
  validated: ValidatedAgentInput;
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

    async create({ ownerId, ownerType, validated }) {
      const id = mintAgentId();
      const now = new Date();
      const row = await db
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
  };
}
