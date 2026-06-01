import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createSkillsPlugin } from '../plugin.js';
import { blobStoreFakeServices } from './_blob-fake.js';
import type {
  SkillsProposeInput,
  SkillsProposeOutput,
  SkillsListAuthoredInput,
  SkillsListAuthoredOutput,
  SkillsScanInput,
  SkillsScanOutput,
  SkillsProposedEvent,
  SkillsAuthoredActivateInput,
  SkillsAuthoredActivateOutput,
} from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

const httpRegisterRouteStub = async () => ({ unregister: () => {} });
const authRequireUserStub = async () => ({ user: { id: 'admin', isAdmin: true } });

// TASK-100 — a skill manifest carries NO capability block; it references the
// connectors it uses. Every authored skill is therefore zero-reach instruction
// scaffolding, so the gate keys on origin + scan only.
const ZERO_CAP_MANIFEST = `name: commit-style
description: How we write commit messages.
version: 1
`;

const CONNECTOR_MANIFEST = `name: linear
description: How to drive the Linear connector.
version: 1
connectors:
  - linear
`;

// TASK-100 (SECURITY repro): a manifest still carrying a capability block (here,
// caps at the top level, the old capability-loss shape) must now be REJECTED with
// `capability-block-forbidden` — never silently parsed to zero caps and made
// active. Connectors are the one source of truth for reach.
const CAP_BLOCK_MANIFEST = `name: linear
description: Work with Linear issues.
version: 1
allowedHosts:
  - api.linear.app
credentials:
  - slot: LINEAR_API_KEY
    kind: api-key
`;

async function makeHarness(
  services: Record<string, (ctx: unknown, input: unknown) => Promise<unknown>> = {},
): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      ...blobStoreFakeServices(),
      'http:register-route': httpRegisterRouteStub,
      'auth:require-user': authRequireUserStub,
      ...services,
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createSkillsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
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
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_authored');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skills');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_skills');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_attachments');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skill_files');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_catalog_requests');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_quarantine');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_approved_caps');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

// capabilityProposal is a DEPRECATED wire hint — the host ignores it (a skill has
// no caps). Pass empty; the gate reads origin + scan only.
const emptyCaps = { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } };

const baseProposal = (
  manifestYaml: string,
  origin: SkillsProposeInput['origin'] = 'authored',
): SkillsProposeInput => ({
  ownerUserId: 'u1',
  agentId: 'a1',
  manifestYaml,
  bodyMd: '# body\n',
  files: [],
  origin,
  capabilityProposal: emptyCaps,
});

describe('skills:propose — the chokepoint + gate (origin + scan)', () => {
  it('FREE path: an authored skill → active, one authored row, list-authored returns it', async () => {
    const h = await makeHarness();
    const out = await h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
      'skills:propose',
      h.ctx(),
      baseProposal(ZERO_CAP_MANIFEST),
    );
    expect(out).toEqual({ skillId: 'commit-style', status: 'active' });

    const listed = await h.bus.call<SkillsListAuthoredInput, SkillsListAuthoredOutput>(
      'skills:list-authored',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1' },
    );
    expect(listed.skills).toHaveLength(1);
    expect(listed.skills[0]).toMatchObject({ skillId: 'commit-style', status: 'active' });
  });

  it('FREE path: an authored skill REFERENCING a connector is still active (reach comes from the connector, not the skill)', async () => {
    const h = await makeHarness();
    const out = await h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
      'skills:propose',
      h.ctx(),
      baseProposal(CONNECTOR_MANIFEST),
    );
    // A connector reference grants nothing of its own — the connector's caps are
    // gated at connectors:resolve / the connector approval card. The skill itself
    // is instruction-only, so it lands active.
    expect(out).toEqual({ skillId: 'linear', status: 'active' });
  });

  it('GATED path: a non-authored origin (imported) → pending', async () => {
    const h = await makeHarness();
    const out = await h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
      'skills:propose',
      h.ctx(),
      baseProposal(ZERO_CAP_MANIFEST, 'imported'),
    );
    expect(out.skillId).toBe('commit-style');
    expect(out.status).toBe('pending');
  });

  it('SECURITY: a manifest carrying a capability block is REJECTED, never silently active', async () => {
    // TASK-100 — capabilities live only on connectors; a skill that still
    // declares them is a hard parse reject and writes NO row.
    const h = await makeHarness();
    await expect(
      h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
        'skills:propose',
        h.ctx(),
        baseProposal(CAP_BLOCK_MANIFEST),
      ),
    ).rejects.toThrow();

    const listed = await h.bus.call<SkillsListAuthoredInput, SkillsListAuthoredOutput>(
      'skills:list-authored',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1' },
    );
    expect(listed.skills).toHaveLength(0);
  });

  it('QUARANTINE path: a skills:scan hit → quarantined with the reason; omitted from active', async () => {
    const reason = 'contains a credential exfiltration pattern';
    const h = await makeHarness({
      'skills:scan': (async (_ctx, _input) =>
        ({ verdict: 'hit', reason }) satisfies SkillsScanOutput) as never,
    });
    const out = await h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
      'skills:propose',
      h.ctx(),
      baseProposal(ZERO_CAP_MANIFEST),
    );
    expect(out).toEqual({ skillId: 'commit-style', status: 'quarantined', reason });

    const listed = await h.bus.call<SkillsListAuthoredInput, SkillsListAuthoredOutput>(
      'skills:list-authored',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1' },
    );
    expect(listed.skills[0]).toMatchObject({ status: 'quarantined', reason });
  });

  it('skills:scan receives the bundle text', async () => {
    let seen: SkillsScanInput | undefined;
    const h = await makeHarness({
      'skills:scan': (async (_ctx, input) => {
        seen = input as SkillsScanInput;
        return { verdict: 'clean' } satisfies SkillsScanOutput;
      }) as never,
    });
    await h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
      'skills:propose',
      h.ctx(),
      baseProposal(ZERO_CAP_MANIFEST),
    );
    expect(seen?.skillId).toBe('commit-style');
    expect(seen?.manifestYaml).toContain('commit-style');
  });

  it('fires skills:proposed after a successful write', async () => {
    const events: SkillsProposedEvent[] = [];
    const h = await makeHarness();
    h.bus.subscribe<SkillsProposedEvent>('skills:proposed', 'test-sub', async (_ctx, e) => {
      events.push(e);
      return undefined;
    });
    await h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
      'skills:propose',
      h.ctx(),
      baseProposal(ZERO_CAP_MANIFEST),
    );
    expect(events).toEqual([
      { ownerUserId: 'u1', agentId: 'a1', skillId: 'commit-style', status: 'active' },
    ]);
  });

  it('rejects a structurally-invalid manifest (PluginError, no row written)', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
        'skills:propose',
        h.ctx(),
        baseProposal('this is not: [valid yaml frontmatter'),
      ),
    ).rejects.toThrow();

    const listed = await h.bus.call<SkillsListAuthoredInput, SkillsListAuthoredOutput>(
      'skills:list-authored',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1' },
    );
    expect(listed.skills).toHaveLength(0);
  });

  it('re-propose REPLACES the row (last-write-wins per draft)', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
      'skills:propose',
      h.ctx(),
      baseProposal(ZERO_CAP_MANIFEST),
    );
    // Re-propose the same id but now imported → flips to pending.
    const out2 = await h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
      'skills:propose',
      h.ctx(),
      baseProposal(ZERO_CAP_MANIFEST, 'imported'),
    );
    expect(out2.status).toBe('pending');

    const listed = await h.bus.call<SkillsListAuthoredInput, SkillsListAuthoredOutput>(
      'skills:list-authored',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1' },
    );
    expect(listed.skills).toHaveLength(1);
    expect(listed.skills[0]?.status).toBe('pending');
  });
});

describe('skills:authored-activate — pending→active flip on approval (TASK-76, §D3)', () => {
  async function listStatus(
    h: TestHarness,
    skillId: string,
  ): Promise<string | undefined> {
    const listed = await h.bus.call<SkillsListAuthoredInput, SkillsListAuthoredOutput>(
      'skills:list-authored',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1' },
    );
    return listed.skills.find((s) => s.skillId === skillId)?.status;
  }

  it('flips a pending authored skill to active (the core regression)', async () => {
    const h = await makeHarness();
    // A non-authored (imported) origin lands as pending.
    const out = await h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
      'skills:propose',
      h.ctx(),
      baseProposal(CONNECTOR_MANIFEST, 'imported'),
    );
    expect(out.status).toBe('pending');
    expect(await listStatus(h, 'linear')).toBe('pending');

    // Approval grant flips it.
    const flip = await h.bus.call<SkillsAuthoredActivateInput, SkillsAuthoredActivateOutput>(
      'skills:authored-activate',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' },
    );
    expect(flip).toEqual({ activated: true });
    expect(await listStatus(h, 'linear')).toBe('active');
  });

  it('is idempotent — re-activating an already-active row flips nothing', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
      'skills:propose',
      h.ctx(),
      baseProposal(CONNECTOR_MANIFEST, 'imported'),
    );
    const first = await h.bus.call<SkillsAuthoredActivateInput, SkillsAuthoredActivateOutput>(
      'skills:authored-activate',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' },
    );
    expect(first.activated).toBe(true);
    const second = await h.bus.call<SkillsAuthoredActivateInput, SkillsAuthoredActivateOutput>(
      'skills:authored-activate',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' },
    );
    expect(second).toEqual({ activated: false });
    expect(await listStatus(h, 'linear')).toBe('active');
  });

  it('does NOT un-quarantine a flagged skill (approval never un-quarantines)', async () => {
    const reason = 'flagged';
    const h = await makeHarness({
      'skills:scan': (async () => ({ verdict: 'hit', reason }) satisfies SkillsScanOutput) as never,
    });
    await h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
      'skills:propose',
      h.ctx(),
      baseProposal(CONNECTOR_MANIFEST),
    );
    expect(await listStatus(h, 'linear')).toBe('quarantined');

    const flip = await h.bus.call<SkillsAuthoredActivateInput, SkillsAuthoredActivateOutput>(
      'skills:authored-activate',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' },
    );
    expect(flip).toEqual({ activated: false });
    expect(await listStatus(h, 'linear')).toBe('quarantined');
  });

  it('no-ops (activated:false) for a skill that does not exist', async () => {
    const h = await makeHarness();
    const flip = await h.bus.call<SkillsAuthoredActivateInput, SkillsAuthoredActivateOutput>(
      'skills:authored-activate',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1', skillId: 'nope' },
    );
    expect(flip).toEqual({ activated: false });
  });

  it('is scoped to (user, agent, skill) — does not flip a sibling row', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
      'skills:propose',
      h.ctx(),
      baseProposal(CONNECTOR_MANIFEST, 'imported'),
    );
    // Activate a DIFFERENT skill id → the real one stays pending.
    await h.bus.call<SkillsAuthoredActivateInput, SkillsAuthoredActivateOutput>(
      'skills:authored-activate',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1', skillId: 'other' },
    );
    expect(await listStatus(h, 'linear')).toBe('pending');
  });
});
