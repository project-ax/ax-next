/**
 * Tests for the authored-skill discovery hooks (TASK-74 re-backing).
 *
 * The source of truth is now the @ax/skills DB store (the `skills:list-authored`
 * hook) — the `.ax/draft-skills` git WORKSPACE projection is RETIRED. These
 * tests register a mock `skills:list-authored` (+ optional `skills:approved-caps-
 * list`) and exercise:
 *   - agents:list-authored-skills (the admin promote-UI reader)
 *   - agents:resolve-authored-skills (the orchestrator projection)
 * The quarantine signal is now the row's `status === 'quarantined'`.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createAgentsPlugin } from '../plugin.js';
import type { CreateInput, CreateOutput } from '../types.js';
import type {
  AgentsListAuthoredSkillsInput,
  AgentsListAuthoredSkillsOutput,
  AgentsResolveAuthoredSkillsInput,
  AgentsResolveAuthoredSkillsOutput,
} from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

function makeManifest(
  id: string,
  opts: { withCapabilities?: boolean; withPackages?: boolean } = {},
): string {
  let capBlock = '';
  if (opts.withCapabilities) {
    capBlock = `capabilities:\n  allowedHosts:\n    - api.evil.com\n`;
  } else if (opts.withPackages) {
    capBlock = `capabilities:\n  packages:\n    npm:\n      - x\n`;
  }
  return ['', `name: ${id}`, `description: A skill called ${id}`, 'version: 1', capBlock]
    .join('\n')
    .trim();
}

interface AuthoredRow {
  skillId: string;
  description: string;
  manifestYaml: string;
  bodyMd: string;
  files: Array<{ path: string; contents: string }>;
  status: 'active' | 'pending' | 'quarantined';
  reason?: string;
}

/**
 * Boot @ax/agents with a mock skills:list-authored returning `rows`, and an
 * optional approved-caps map keyed by skillId. Omit `rows` entirely to simulate
 * a preset with NO skills store (the hook is absent).
 */
async function makeHarness(opts: {
  rows?: AuthoredRow[];
  approved?: Record<string, Array<{ kind: string; value: string }>>;
  listAuthoredThrows?: boolean;
} = {}): Promise<TestHarness> {
  const services: Record<string, (ctx: unknown, input: unknown) => Promise<unknown>> = {
    'http:register-route': async () => ({ unregister: () => {} }),
    'auth:require-user': async () => {
      throw new Error('auth:require-user not configured');
    },
  };
  if (opts.rows !== undefined || opts.listAuthoredThrows) {
    services['skills:list-authored'] = async () => {
      if (opts.listAuthoredThrows) throw new Error('skills store outage');
      return { skills: opts.rows ?? [] };
    };
  }
  if (opts.approved !== undefined) {
    services['skills:approved-caps-list'] = async (_c, input) => {
      const { skillId } = input as { skillId: string };
      return { capabilities: opts.approved![skillId] ?? [] };
    };
  }
  const h = await createTestHarness({
    services,
    plugins: [createDatabasePostgresPlugin({ connectionString }), createAgentsPlugin()],
  });
  harnesses.push(h);
  return h;
}

async function createPersonalAgent(h: TestHarness, userId: string): Promise<string> {
  const out = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx({ userId }), {
    actor: { userId, isAdmin: false },
    input: {
      displayName: 'Test Agent',
      systemPrompt: 'You are helpful.',
      allowedTools: [],
      mcpConfigIds: [],
      model: 'claude-opus-4-7',
      visibility: 'personal',
    },
  });
  return out.agent.id;
}

function row(id: string, status: AuthoredRow['status'], opts: { withCapabilities?: boolean } = {}): AuthoredRow {
  return {
    skillId: id,
    description: `A skill called ${id}`,
    manifestYaml: makeManifest(id, opts),
    bodyMd: `# ${id}\nbody`,
    files: [],
    status,
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('TRUNCATE agents_v1_agents');
  } catch {
    /* */
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('agents:list-authored-skills (DB-backed promote reader)', () => {
  it('returns summaries for each authored row, flagging capabilities', async () => {
    const userId = 'u1';
    const h = await makeHarness({
      rows: [row('alpha', 'active'), row('beta', 'pending', { withCapabilities: true })],
    });
    const agentId = await createPersonalAgent(h, userId);
    const out = await h.bus.call<AgentsListAuthoredSkillsInput, AgentsListAuthoredSkillsOutput>(
      'agents:list-authored-skills',
      h.ctx({ userId }),
      { agentId },
    );
    const byId = new Map(out.skills.map((s) => [s.id, s]));
    expect(byId.get('alpha')?.hasForbiddenCapabilities).toBe(false);
    expect(byId.get('beta')?.hasForbiddenCapabilities).toBe(true);
  });

  it('returns [] when no skills store is loaded', async () => {
    const userId = 'u1';
    const h = await makeHarness({}); // no skills:list-authored
    const agentId = await createPersonalAgent(h, userId);
    const out = await h.bus.call<AgentsListAuthoredSkillsInput, AgentsListAuthoredSkillsOutput>(
      'agents:list-authored-skills',
      h.ctx({ userId }),
      { agentId },
    );
    expect(out.skills).toEqual([]);
  });
});

describe('agents:resolve-authored-skills (DB-backed orchestrator projection)', () => {
  it('projects active + pending rows; OMITS quarantined', async () => {
    const userId = 'u1';
    const h = await makeHarness({
      rows: [row('alpha', 'active'), row('beta', 'pending'), row('evil', 'quarantined')],
    });
    const agentId = await createPersonalAgent(h, userId);
    const out = await h.bus.call<AgentsResolveAuthoredSkillsInput, AgentsResolveAuthoredSkillsOutput>(
      'agents:resolve-authored-skills',
      h.ctx({ userId }),
      { ownerUserId: userId, agentId },
    );
    const ids = out.skills.map((s) => s.id).sort();
    expect(ids).toEqual(['alpha', 'beta']);
    // TASK-76 (§D3): the gate verdict is threaded through so the orchestrator
    // materializes only `active` skills' bytes (a `pending` skill projects
    // nothing). quarantined never arrives (omitted above), so the field is
    // narrowed to 'active' | 'pending'.
    expect(out.skills.find((s) => s.id === 'alpha')!.status).toBe('active');
    expect(out.skills.find((s) => s.id === 'beta')!.status).toBe('pending');
  });

  it('projects EMPTY capabilities when nothing is approved (frontmatter alone grants nothing)', async () => {
    const userId = 'u1';
    const h = await makeHarness({
      rows: [row('linear', 'pending', { withCapabilities: true })],
      approved: {}, // nothing approved
    });
    const agentId = await createPersonalAgent(h, userId);
    const out = await h.bus.call<AgentsResolveAuthoredSkillsInput, AgentsResolveAuthoredSkillsOutput>(
      'agents:resolve-authored-skills',
      h.ctx({ userId }),
      { ownerUserId: userId, agentId },
    );
    const s = out.skills.find((x) => x.id === 'linear');
    expect(s).toBeDefined();
    expect(s!.capabilities.allowedHosts).toEqual([]); // none approved → none live
    // The proposal delta carries the unapproved host so the orchestrator can card it.
    expect(s!.proposalDelta.allowedHosts).toContain('api.evil.com');
  });

  it('folds an APPROVED host into live capabilities', async () => {
    const userId = 'u1';
    const h = await makeHarness({
      rows: [row('linear', 'active', { withCapabilities: true })],
      approved: { linear: [{ kind: 'host', value: 'api.evil.com' }] },
    });
    const agentId = await createPersonalAgent(h, userId);
    const out = await h.bus.call<AgentsResolveAuthoredSkillsInput, AgentsResolveAuthoredSkillsOutput>(
      'agents:resolve-authored-skills',
      h.ctx({ userId }),
      { ownerUserId: userId, agentId },
    );
    const s = out.skills.find((x) => x.id === 'linear')!;
    expect(s.capabilities.allowedHosts).toContain('api.evil.com');
    expect(s.proposalDelta.allowedHosts).toEqual([]); // fully approved → no delta
  });

  it('returns [] when no skills store is loaded (orchestrator guard still satisfied)', async () => {
    const userId = 'u1';
    const h = await makeHarness({}); // no skills:list-authored
    const agentId = await createPersonalAgent(h, userId);
    const out = await h.bus.call<AgentsResolveAuthoredSkillsInput, AgentsResolveAuthoredSkillsOutput>(
      'agents:resolve-authored-skills',
      h.ctx({ userId }),
      { ownerUserId: userId, agentId },
    );
    expect(out.skills).toEqual([]);
  });

  it('propagates a skills:list-authored outage (orchestrator catches + warns at the next level)', async () => {
    const userId = 'u1';
    const h = await makeHarness({ listAuthoredThrows: true });
    const agentId = await createPersonalAgent(h, userId);
    await expect(
      h.bus.call<AgentsResolveAuthoredSkillsInput, AgentsResolveAuthoredSkillsOutput>(
        'agents:resolve-authored-skills',
        h.ctx({ userId }),
        { ownerUserId: userId, agentId },
      ),
    ).rejects.toThrow();
  });
});
