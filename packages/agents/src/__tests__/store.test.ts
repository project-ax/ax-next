import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { stopPostgresContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { runAgentsMigration, type AgentsDatabase } from '../migrations.js';
import {
  createAgentStore,
  resolveAllowedModels,
  validateCreateInput,
  validateUpdatePatch,
  validateConnectorAttachmentIds,
} from '../store.js';
import { scopedAgents } from '../scope.js';
import type { AgentInput } from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<AgentsDatabase>[] = [];

function makeKysely(): Kysely<AgentsDatabase> {
  const k = new Kysely<AgentsDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 2 }),
    }),
  });
  opened.push(k);
  return k;
}

const ALLOWED = ['claude-opus-4-7', 'claude-sonnet-4-6'];

function makeInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    displayName: 'My Agent',
    allowedTools: ['bash.run', 'fs.read'],
    mcpConfigIds: [],
    model: 'claude-opus-4-7',
    visibility: 'personal',
    ...overrides,
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('agents_v1_agents').ifExists().execute();
    } catch {
      /* drained pool */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('validation', () => {
  const vctx = { allowedModels: ALLOWED };

  it('rejects displayName > 128', () => {
    expect(() =>
      validateCreateInput(makeInput({ displayName: 'x'.repeat(129) }), vctx),
    ).toThrow(/displayName must be 1-128 chars/);
  });

  it('rejects displayName with leading whitespace', () => {
    expect(() =>
      validateCreateInput(makeInput({ displayName: ' X' }), vctx),
    ).toThrow(/leading or trailing whitespace/);
  });

  // TASK-142: the `system_prompt` column + validator are gone — an agent's
  // identity lives in its `.ax/` files. `agents:create` no longer accepts a
  // `systemPrompt` field (its zod schema `.strip()`s/rejects it; the store
  // never reads it).

  it('rejects model not in allow-list', () => {
    expect(() =>
      validateCreateInput(makeInput({ model: 'gpt-4' }), vctx),
    ).toThrow(/not in the allow-list/);
  });

  it('rejects allowedTools > 100 entries', () => {
    const tools = Array.from({ length: 101 }, (_, i) => `tool${i}`);
    expect(() =>
      validateCreateInput(makeInput({ allowedTools: tools }), vctx),
    ).toThrow(/at most 100 entries/);
  });

  it('rejects allowedTools entry that fails the regex', () => {
    // Whitespace breaks the regex regardless of case. Other shapes that
    // remain invalid: leading digit, leading punctuation. PascalCase
    // names like 'Bash' / 'Read' are accepted (SDK built-ins).
    expect(() =>
      validateCreateInput(makeInput({ allowedTools: ['Bad Name'] }), vctx),
    ).toThrow(/must match/);
  });

  it('accepts PascalCase SDK built-in tool names (Bash, Read, WebFetch, Skill)', () => {
    // Phase 1 skill-install canary: the model needs SDK built-ins by their
    // canonical PascalCase names. The prior strict-lowercase regex rejected
    // them, forcing operators to either fall back to lowercase aliases (which
    // didn't actually map to anything) or hand-edit the DB. Widened to a case-
    // insensitive leading letter — see TOOL_NAME_RE comment.
    expect(() =>
      validateCreateInput(
        makeInput({ allowedTools: ['Bash', 'Read', 'WebFetch', 'Skill'] }),
        vctx,
      ),
    ).not.toThrow();
  });

  it('rejects mcpConfigIds entry that fails the regex', () => {
    expect(() =>
      validateCreateInput(
        makeInput({ mcpConfigIds: ['BAD ID'] }),
        vctx,
      ),
    ).toThrow(/must match/);
  });

  it('rejects mcpConfigIds > 50 entries', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `mcp${i}`);
    expect(() =>
      validateCreateInput(makeInput({ mcpConfigIds: ids }), vctx),
    ).toThrow(/at most 50 entries/);
  });

  it('rejects bad workspaceRef chars', () => {
    expect(() =>
      validateCreateInput(makeInput({ workspaceRef: 'has spaces' }), vctx),
    ).toThrow(/workspaceRef/);
  });

  it('requires teamId for team visibility', () => {
    expect(() =>
      validateCreateInput(makeInput({ visibility: 'team' }), vctx),
    ).toThrow(/teamId/);
  });

  it('rejects teamId on personal visibility', () => {
    expect(() =>
      validateCreateInput(
        makeInput({ visibility: 'personal', teamId: 't1' }),
        vctx,
      ),
    ).toThrow(/teamId must not be set/);
  });

  it('accepts a valid input', () => {
    const v = validateCreateInput(makeInput(), vctx);
    expect(v.displayName).toBe('My Agent');
    expect(v.allowedTools).toEqual(['bash.run', 'fs.read']);
    expect(v.workspaceRef).toBeNull();
  });

  it('rejects duplicate allowedTools', () => {
    expect(() =>
      validateCreateInput(
        makeInput({ allowedTools: ['bash.run', 'bash.run'] }),
        vctx,
      ),
    ).toThrow(/duplicated/);
  });

  it('update patch refuses to change visibility', () => {
    expect(() =>
      validateUpdatePatch({ visibility: 'team' }, vctx),
    ).toThrow(/visibility cannot be changed/);
  });

  it('update patch validates only provided keys', () => {
    const out = validateUpdatePatch({ displayName: 'New Name' }, vctx);
    expect(out).toEqual({ displayName: 'New Name' });
  });
});

describe('resolveAllowedModels', () => {
  it('uses configured list when non-empty', () => {
    expect(resolveAllowedModels(['x'])).toEqual(['x']);
  });

  it('falls back to env var when configured is empty/undefined', () => {
    process.env.AX_AGENT_MODELS_ALLOWED = 'a, b , c';
    try {
      expect(resolveAllowedModels(undefined)).toEqual(['a', 'b', 'c']);
    } finally {
      delete process.env.AX_AGENT_MODELS_ALLOWED;
    }
  });

  it('falls back to defaults when nothing configured', () => {
    delete process.env.AX_AGENT_MODELS_ALLOWED;
    const out = resolveAllowedModels(undefined);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('claude-opus-4-7');
  });
});

describe('store + scopedAgents', () => {
  it('round-trips a created agent', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    const store = createAgentStore(db);
    const validated = validateCreateInput(makeInput(), {
      allowedModels: ALLOWED,
    });
    const created = await store.create({
      ownerId: 'u1',
      ownerType: 'user',
      validated,
    });
    expect(created.id).toMatch(/^agt_/);
    expect(created.ownerId).toBe('u1');
    expect(created.allowedTools).toEqual(['bash.run', 'fs.read']);

    const round = await store.getById(created.id);
    expect(round).not.toBeNull();
    expect(round!.displayName).toBe('My Agent');
  });

  it('scopedAgents returns only agents the user can reach', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    const store = createAgentStore(db);
    const personal = (uid: string, name: string) =>
      validateCreateInput(makeInput({ displayName: name }), {
        allowedModels: ALLOWED,
      });
    const team = (name: string) =>
      validateCreateInput(
        makeInput({ displayName: name, visibility: 'team', teamId: 't1' }),
        { allowedModels: ALLOWED },
      );

    // u1 owns 1 personal, t1 owns 1 team, t2 owns 1 team, u2 owns 1 personal.
    await store.create({ ownerId: 'u1', ownerType: 'user', validated: personal('u1', 'A') });
    await store.create({ ownerId: 'u2', ownerType: 'user', validated: personal('u2', 'B') });
    await store.create({ ownerId: 't1', ownerType: 'team', validated: team('T1') });
    await store.create({ ownerId: 't2', ownerType: 'team', validated: team('T2') });

    // u1 with no teams sees only A.
    const noTeams = await store.listScoped({ userId: 'u1', teamIds: [] });
    expect(noTeams.map((a) => a.displayName).sort()).toEqual(['A']);

    // u1 in team t1 sees A + T1.
    const oneTeam = await store.listScoped({ userId: 'u1', teamIds: ['t1'] });
    expect(oneTeam.map((a) => a.displayName).sort()).toEqual(['A', 'T1']);

    // u1 in t1 and t2 sees A + T1 + T2.
    const twoTeams = await store.listScoped({
      userId: 'u1',
      teamIds: ['t1', 't2'],
    });
    expect(twoTeams.map((a) => a.displayName).sort()).toEqual(['A', 'T1', 'T2']);

    // u2 in t1 sees B + T1 (not A).
    const u2 = await store.listScoped({ userId: 'u2', teamIds: ['t1'] });
    expect(u2.map((a) => a.displayName).sort()).toEqual(['B', 'T1']);
  });

  it('scopedAgents query helper filters at the SQL layer', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    const store = createAgentStore(db);
    const validated = validateCreateInput(makeInput(), {
      allowedModels: ALLOWED,
    });
    await store.create({ ownerId: 'u1', ownerType: 'user', validated });
    await store.create({ ownerId: 'u2', ownerType: 'user', validated });

    // Direct use of the helper (mirrors how list-for-user uses it).
    const rows = await scopedAgents(db, { userId: 'u1', teamIds: [] }).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner_id).toBe('u1');
  });

  it('update only modifies provided fields', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    const store = createAgentStore(db);
    const validated = validateCreateInput(makeInput(), {
      allowedModels: ALLOWED,
    });
    const created = await store.create({
      ownerId: 'u1',
      ownerType: 'user',
      validated,
    });
    const updatedPatch = validateUpdatePatch(
      { displayName: 'Renamed' },
      { allowedModels: ALLOWED },
    );
    const updated = await store.update(created.id, updatedPatch);
    expect(updated.displayName).toBe('Renamed');
    // unchanged fields preserved
    expect(updated.model).toBe(created.model);
  });

  it('deleteById is idempotent', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    const store = createAgentStore(db);
    const validated = validateCreateInput(makeInput(), {
      allowedModels: ALLOWED,
    });
    const created = await store.create({
      ownerId: 'u1',
      ownerType: 'user',
      validated,
    });
    expect(await store.deleteById(created.id)).toBe(true);
    expect(await store.deleteById(created.id)).toBe(false);
    expect(await store.getById(created.id)).toBeNull();
  });
});

// TASK-107 — per-agent connector-attachment store.
describe('validateConnectorAttachmentIds', () => {
  it('accepts a deduped list of well-formed connector-id slugs', () => {
    expect(validateConnectorAttachmentIds(['salesforce', 'my-drive', 'gh_2'])).toEqual([
      'salesforce',
      'my-drive',
      'gh_2',
    ]);
  });

  it('accepts an empty list', () => {
    expect(validateConnectorAttachmentIds([])).toEqual([]);
  });

  it('rejects a non-array', () => {
    expect(() => validateConnectorAttachmentIds('nope')).toThrow(/must be an array/);
  });

  it('rejects a non-string entry', () => {
    expect(() => validateConnectorAttachmentIds([1])).toThrow(/entries must be strings/);
  });

  it('rejects a malformed slug', () => {
    expect(() => validateConnectorAttachmentIds(['Bad Id'])).toThrow(/must match/);
    expect(() => validateConnectorAttachmentIds(['-leading'])).toThrow(/must match/);
  });

  it('rejects a duplicate', () => {
    expect(() => validateConnectorAttachmentIds(['gh', 'gh'])).toThrow(/duplicated/);
  });

  it('rejects more than 50 entries', () => {
    const many = Array.from({ length: 51 }, (_, i) => `c${i}`);
    expect(() => validateConnectorAttachmentIds(many)).toThrow(/at most 50/);
  });
});

describe('store connector attachments', () => {
  it('defaults a freshly created agent to an empty connectorAttachments list', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    const store = createAgentStore(db);
    const created = await store.create({
      ownerId: 'u1',
      ownerType: 'user',
      validated: validateCreateInput(makeInput(), { allowedModels: ALLOWED }),
    });
    expect(created.connectorAttachments).toEqual([]);
    const round = await store.getById(created.id);
    expect(round!.connectorAttachments).toEqual([]);
  });

  it('setConnectorAttachments replaces the list wholesale and round-trips', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    const store = createAgentStore(db);
    const created = await store.create({
      ownerId: 'u1',
      ownerType: 'user',
      validated: validateCreateInput(makeInput(), { allowedModels: ALLOWED }),
    });
    const updated = await store.setConnectorAttachments(created.id, ['salesforce', 'gh']);
    expect(updated.connectorAttachments).toEqual(['salesforce', 'gh']);
    // Wholesale replace — a second call with a different set overwrites, not appends.
    const replaced = await store.setConnectorAttachments(created.id, ['gh']);
    expect(replaced.connectorAttachments).toEqual(['gh']);
    const round = await store.getById(created.id);
    expect(round!.connectorAttachments).toEqual(['gh']);
  });

  it('setConnectorAttachments throws not-found for a missing agent', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    const store = createAgentStore(db);
    await expect(store.setConnectorAttachments('agt_missing', ['gh'])).rejects.toThrow(
      /not found/,
    );
  });

  it('does not touch mcpConfigIds (mcpConfigIds reverts to MCP-only)', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    const store = createAgentStore(db);
    const created = await store.create({
      ownerId: 'u1',
      ownerType: 'user',
      validated: validateCreateInput(makeInput({ mcpConfigIds: ['real-mcp'] }), {
        allowedModels: ALLOWED,
      }),
    });
    const updated = await store.setConnectorAttachments(created.id, ['gh']);
    // The connector attach store is orthogonal to the MCP binding.
    expect(updated.mcpConfigIds).toEqual(['real-mcp']);
    expect(updated.connectorAttachments).toEqual(['gh']);
  });
});
