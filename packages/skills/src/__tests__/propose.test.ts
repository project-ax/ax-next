import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
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

const ZERO_CAP_MANIFEST = `name: commit-style
description: How we write commit messages.
version: 1
`;

const HOST_MANIFEST = `name: linear
description: Work with Linear issues.
version: 1
capabilities:
  allowedHosts:
    - api.linear.app
  credentials:
    - slot: LINEAR_API_KEY
      kind: api-key
`;

// TASK-79 (SECURITY repro): the capability-LOSS shape. The model followed the
// OLD skill_propose docs and put the caps at the TOP LEVEL (and would have used
// `id`) instead of under `capabilities:`. Before the parser fix this parsed to
// ZERO caps → the gate classified it `active` (a cap-bearing Linear skill went
// live with no approval card). It must now be REJECTED as malformed, never
// silently active.
const TOP_LEVEL_CAPS_MANIFEST = `name: linear
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
  if (container) await container.stop();
});

const baseProposal = (manifestYaml: string): Omit<SkillsProposeInput, 'capabilityProposal'> => ({
  ownerUserId: 'u1',
  agentId: 'a1',
  manifestYaml,
  bodyMd: '# body\n',
  files: [],
  origin: 'authored',
});

// capabilityProposal is a redundant wire hint — the host re-parses the manifest.
// Pass empty; the gate reads the parsed frontmatter, not this field.
const emptyCaps = { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } };

describe('skills:propose — the chokepoint + hybrid gate (TASK-74)', () => {
  it('FREE path: zero-cap authored skill → active, one authored row, list-authored returns it', async () => {
    const h = await makeHarness();
    const out = await h.bus.call<SkillsProposeInput, SkillsProposeOutput>('skills:propose', h.ctx(), {
      ...baseProposal(ZERO_CAP_MANIFEST),
      capabilityProposal: emptyCaps,
    });
    expect(out).toEqual({ skillId: 'commit-style', status: 'active' });

    const listed = await h.bus.call<SkillsListAuthoredInput, SkillsListAuthoredOutput>(
      'skills:list-authored',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1' },
    );
    expect(listed.skills).toHaveLength(1);
    expect(listed.skills[0]).toMatchObject({ skillId: 'commit-style', status: 'active' });
  });

  it('GATED path: a skill declaring hosts + a credential → pending', async () => {
    const h = await makeHarness();
    const out = await h.bus.call<SkillsProposeInput, SkillsProposeOutput>('skills:propose', h.ctx(), {
      ...baseProposal(HOST_MANIFEST),
      capabilityProposal: emptyCaps,
    });
    expect(out.skillId).toBe('linear');
    expect(out.status).toBe('pending');
  });

  it('SECURITY: a cap-bearing manifest with caps at the TOP LEVEL is REJECTED, never silently active', async () => {
    // The capability-loss bypass (TASK-79): caps declared outside `capabilities:`
    // used to be silently dropped → zero caps → gate said `active`. The propose
    // chokepoint must now reject the malformed manifest and write NO row.
    const h = await makeHarness();
    await expect(
      h.bus.call<SkillsProposeInput, SkillsProposeOutput>('skills:propose', h.ctx(), {
        ...baseProposal(TOP_LEVEL_CAPS_MANIFEST),
        capabilityProposal: emptyCaps,
      }),
    ).rejects.toThrow();

    // Crucially: nothing was written — there is NO active (or any) row for it.
    const listed = await h.bus.call<SkillsListAuthoredInput, SkillsListAuthoredOutput>(
      'skills:list-authored',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1' },
    );
    expect(listed.skills).toHaveLength(0);
  });

  it('SECURITY: the SAME skill authored correctly (caps under capabilities:) lands pending, not active', async () => {
    // Proves the cap-bearing skill's only safe landing is `pending` (approval
    // card), never `active` — closing the loop on the capability-loss bug.
    const h = await makeHarness();
    const out = await h.bus.call<SkillsProposeInput, SkillsProposeOutput>('skills:propose', h.ctx(), {
      ...baseProposal(HOST_MANIFEST),
      capabilityProposal: emptyCaps,
    });
    expect(out.status).toBe('pending');
    expect(out.status).not.toBe('active');
  });

  it('QUARANTINE path: a skills:scan hit → quarantined with the reason; omitted from active', async () => {
    const reason = 'contains a credential exfiltration pattern';
    const h = await makeHarness({
      'skills:scan': (async (_ctx, _input) =>
        ({ verdict: 'hit', reason }) satisfies SkillsScanOutput) as never,
    });
    const out = await h.bus.call<SkillsProposeInput, SkillsProposeOutput>('skills:propose', h.ctx(), {
      ...baseProposal(ZERO_CAP_MANIFEST),
      capabilityProposal: emptyCaps,
    });
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
    await h.bus.call<SkillsProposeInput, SkillsProposeOutput>('skills:propose', h.ctx(), {
      ...baseProposal(ZERO_CAP_MANIFEST),
      capabilityProposal: emptyCaps,
    });
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
    await h.bus.call<SkillsProposeInput, SkillsProposeOutput>('skills:propose', h.ctx(), {
      ...baseProposal(ZERO_CAP_MANIFEST),
      capabilityProposal: emptyCaps,
    });
    expect(events).toEqual([
      { ownerUserId: 'u1', agentId: 'a1', skillId: 'commit-style', status: 'active' },
    ]);
  });

  it('rejects a structurally-invalid manifest (PluginError, no row written)', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call<SkillsProposeInput, SkillsProposeOutput>('skills:propose', h.ctx(), {
        ...baseProposal('this is not: [valid yaml frontmatter'),
        capabilityProposal: emptyCaps,
      }),
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
    await h.bus.call<SkillsProposeInput, SkillsProposeOutput>('skills:propose', h.ctx(), {
      ...baseProposal(ZERO_CAP_MANIFEST),
      capabilityProposal: emptyCaps,
    });
    // Re-propose the same id but now with caps → flips to pending.
    const out2 = await h.bus.call<SkillsProposeInput, SkillsProposeOutput>('skills:propose', h.ctx(), {
      ...baseProposal(HOST_MANIFEST.replace('name: linear', 'name: commit-style')),
      capabilityProposal: emptyCaps,
    });
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
    // A gated (host+credential) skill lands as pending.
    const out = await h.bus.call<SkillsProposeInput, SkillsProposeOutput>('skills:propose', h.ctx(), {
      ...baseProposal(HOST_MANIFEST),
      capabilityProposal: emptyCaps,
    });
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
    await h.bus.call<SkillsProposeInput, SkillsProposeOutput>('skills:propose', h.ctx(), {
      ...baseProposal(HOST_MANIFEST),
      capabilityProposal: emptyCaps,
    });
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
    await h.bus.call<SkillsProposeInput, SkillsProposeOutput>('skills:propose', h.ctx(), {
      ...baseProposal(HOST_MANIFEST),
      capabilityProposal: emptyCaps,
    });
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
    await h.bus.call<SkillsProposeInput, SkillsProposeOutput>('skills:propose', h.ctx(), {
      ...baseProposal(HOST_MANIFEST),
      capabilityProposal: emptyCaps,
    });
    // Activate a DIFFERENT skill id → the real one stays pending.
    await h.bus.call<SkillsAuthoredActivateInput, SkillsAuthoredActivateOutput>(
      'skills:authored-activate',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1', skillId: 'other' },
    );
    expect(await listStatus(h, 'linear')).toBe('pending');
  });
});
