import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { sql, type Kysely } from 'kysely';
import { createAgentsPlugin } from '../plugin.js';
import type { AgentsDatabase } from '../migrations.js';
import { createSharingStore, type SharingStore } from '../sharing/store.js';
import {
  AGENTS_IDENTITY_GET_HOOK,
  AGENTS_IDENTITY_SET_HOOK,
  type Actor,
  type Agent,
  type AgentAudience,
  type AgentIdentityRecord,
  type AgentInput,
  type AttachConnectorOutput,
  type CreateInput,
  type CreateOutput,
  type DetachConnectorOutput,
  type IdentitySection,
  type IdentitySetOutput,
  type ResolveInput,
  type ResolveOutput,
  type SkillAttachment,
  type UpdateOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// TASK-1246 — who may change a personal agent, through the @ax/agents hooks
// (the plan's "Who may do what" table):
//   - its owners (the creator and co-owners) change its settings: update,
//     skill attachments, connectors (attach, detach, can-manage-connectors);
//   - only its creator deletes it, manages its routines and touches its
//     webhook token. Routines on a personal agent run as the creator
//     (routines/src/services.ts stamps `agent.ownerId`), the token fires them,
//     and a delete can't be undone;
//   - someone it is only shared with uses it and changes nothing;
//   - a workspace admin keeps the existing bypass on update and delete.
// Team agents keep today's rules.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

/** The AX accounts `auth:get-user` knows. Anyone else is null. */
const ACCOUNTS = ['alice', 'bob', 'carol', 'dave'];
/** `teams:is-member` for team-1. Anyone else is no member. */
const TEAM_ROLES: Record<string, { member: true; role: 'admin' | 'member' }> = {
  tadmin: { member: true, role: 'admin' },
  tmember: { member: true, role: 'member' },
};

/** The creator. */
const alice: Actor = { userId: 'alice', isAdmin: false };
/** A co-owner. */
const bob: Actor = { userId: 'bob', isAdmin: false };
/** Only in the audience (`everyone`). */
const carol: Actor = { userId: 'carol', isAdmin: false };
/** An AX account that only a `list` audience names. */
const dave: Actor = { userId: 'dave', isAdmin: false };
/** No AX account at all: not even `everyone` takes them in. */
const ghost: Actor = { userId: 'ghost', isAdmin: false };
/** A workspace admin with no owner row. */
const wsAdmin: Actor = { userId: 'wsadmin', isAdmin: true };
const teamAdmin: Actor = { userId: 'tadmin', isAdmin: false };
const teamMember: Actor = { userId: 'tmember', isAdmin: false };
const outsider: Actor = { userId: 'outsider', isAdmin: false };

const SKILL: SkillAttachment = { skillId: 'sk-notes', credentialBindings: {} };

interface Stack {
  db: Kysely<AgentsDatabase>;
  sharing: SharingStore;
  /** Call `hook` with a ctx whose user is `actor`. */
  call<O>(hook: string, actor: Actor, input: object): Promise<O>;
  /** alice's personal agent; its owners are alice and bob, its audience everyone unless named. */
  seedShared(audience?: AgentAudience): Promise<string>;
  /** A team-1 agent, created by its plain member. */
  seedTeam(): Promise<string>;
  resolve(agentId: string, userId: string): Promise<Agent>;
  webhookToken(agentId: string): Promise<string | null>;
  /** `agents:identity:get` in `userId`'s turn with the agent. */
  identityGet(userId: string, agentId: string): Promise<AgentIdentityRecord>;
  /** `agents:identity:set` at revision 0 in `userId`'s turn, with `author` only when given. */
  identitySet(
    userId: string,
    agentId: string,
    patch: Partial<Record<IdentitySection, string>>,
    author?: 'agent' | 'person',
  ): Promise<IdentitySetOutput>;
}

async function boot(): Promise<Stack> {
  const services: Record<string, (ctx: unknown, input: unknown) => Promise<unknown>> = {
    'http:register-route': async () => ({ unregister: () => {} }),
    'auth:require-user': async () => {
      throw new Error('auth:require-user is not used by owner-powers.test.ts');
    },
    'auth:get-user': async (_ctx, raw) => {
      const { userId } = raw as { userId: string };
      return ACCOUNTS.includes(userId)
        ? { id: userId, email: `${userId}@example.com`, displayName: userId, isAdmin: false }
        : null;
    },
    'teams:is-member': async (_ctx, raw) => {
      const { teamId, userId } = raw as { teamId: string; userId: string };
      return (teamId === 'team-1' ? TEAM_ROLES[userId] : undefined) ?? { member: false };
    },
    // Passes everything, so an identity write the ACL wrongly let through would save.
    'identity:scan': async () => ({ verdict: 'clean' }),
  };
  const h = await createTestHarness({
    services,
    plugins: [createDatabasePostgresPlugin({ connectionString }), createAgentsPlugin()],
  });
  harnesses.push(h);
  const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>('database:get-instance', h.ctx(), {});
  const agentsDb = db as Kysely<AgentsDatabase>;
  const sharing = createSharingStore(agentsDb);
  const call = <O>(hook: string, actor: Actor, input: object): Promise<O> =>
    h.bus.call<object, O>(hook, h.ctx({ userId: actor.userId }), input);
  const create = async (actor: Actor, input: Partial<AgentInput>): Promise<string> => {
    const out = await call<CreateOutput>('agents:create', actor, {
      actor,
      input: {
        displayName: 'Pip',
        allowedTools: ['bash.run'],
        mcpConfigIds: [],
        model: 'anthropic/claude-opus-4-7',
        visibility: 'personal',
        ...input,
      },
    } satisfies CreateInput);
    return out.agent.id;
  };
  return {
    db: agentsDb,
    sharing,
    call,
    async seedShared(audience = { kind: 'everyone' }) {
      const id = await create(alice, {});
      await sharing.setOwners(id, ['alice', 'bob']);
      await sharing.setAudience(id, audience);
      return id;
    },
    async seedTeam() {
      return create(teamMember, { visibility: 'team', teamId: 'team-1' });
    },
    async resolve(agentId, userId) {
      const out = await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', h.ctx({ userId }), {
        agentId,
        userId,
      });
      return out.agent;
    },
    async webhookToken(agentId) {
      const { rows } = await sql<{ webhook_token: string | null }>`
        SELECT webhook_token FROM agents_v1_agents WHERE agent_id = ${agentId}
      `.execute(agentsDb);
      return rows[0]?.webhook_token ?? null;
    },
    identityGet(userId, agentId) {
      return h.bus.call(AGENTS_IDENTITY_GET_HOOK, h.ctx({ userId, agentId, sessionId: 's' }), {
        agentId,
      });
    },
    identitySet(userId, agentId, patch, author) {
      return h.bus.call(AGENTS_IDENTITY_SET_HOOK, h.ctx({ userId, agentId, sessionId: 's' }), {
        agentId,
        patch,
        expectedRevision: 0,
        ...(author !== undefined ? { author } : {}),
      });
    },
  };
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
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
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_identity');
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_owners');
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_audience_members');
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_agents');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const WEBHOOK_HOOKS = ['agents:rotate-webhook-token', 'agents:ensure-webhook-token'];

describe('who may change a personal agent (TASK-1246)', () => {
  it('a co-owner may update, set skill attachments, attach and detach connectors; can-manage-connectors says true for them', async () => {
    const s = await boot();
    const id = await s.seedShared();

    const updated = await s.call<UpdateOutput>('agents:update', bob, {
      actor: bob,
      agentId: id,
      patch: { displayName: 'Pip, by bob' },
    });
    expect(updated.agent.displayName).toBe('Pip, by bob');
    const skills = await s.call<{ agent: Agent }>('agents:set-skill-attachments', bob, {
      actor: bob,
      agentId: id,
      attachments: [SKILL],
    });
    expect(skills.agent.skillAttachments).toEqual([SKILL]);
    const attached = await s.call<AttachConnectorOutput>('agents:attach-connector', bob, {
      actor: bob,
      agentId: id,
      connectorId: 'gmail',
    });
    expect(attached).toMatchObject({ changed: true, agent: { connectorAttachments: ['gmail'] } });
    const detached = await s.call<DetachConnectorOutput>('agents:detach-connector', bob, {
      actor: bob,
      agentId: id,
      connectorId: 'gmail',
      exclude: true,
    });
    expect(detached).toMatchObject({
      changed: true,
      agent: { connectorAttachments: [], connectorExclusions: ['gmail'] },
    });
    expect(await s.call('agents:can-manage-connectors', bob, { actor: bob, agentId: id })).toEqual({
      allowed: true,
    });
  });

  it('a co-owner may not delete (forbidden) or manage routines (can-manage-routines allowed false), and is refused rotate and ensure webhook token', async () => {
    const s = await boot();
    const id = await s.seedShared();

    await expect(s.call('agents:delete', bob, { actor: bob, agentId: id })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await s.call('agents:can-manage-routines', bob, { agentId: id })).toEqual({
      allowed: false,
      stopOthers: false,
    });
    for (const hook of WEBHOOK_HOOKS) {
      await expect(s.call(hook, bob, { actor: bob, agentId: id }), hook).rejects.toMatchObject({
        code: 'forbidden',
      });
    }
    // The agent is still there, and no token was minted for bob.
    expect(await s.resolve(id, 'bob')).toMatchObject({ id, isOwner: true });
    expect(await s.webhookToken(id)).toBeNull();
  });

  it('the creator keeps every power', async () => {
    const s = await boot();
    const id = await s.seedShared();

    const updated = await s.call<UpdateOutput>('agents:update', alice, {
      actor: alice,
      agentId: id,
      patch: { displayName: 'Pip, by alice' },
    });
    expect(updated.agent.displayName).toBe('Pip, by alice');
    const skills = await s.call<{ agent: Agent }>('agents:set-skill-attachments', alice, {
      actor: alice,
      agentId: id,
      attachments: [SKILL],
    });
    expect(skills.agent.skillAttachments).toEqual([SKILL]);
    await s.call('agents:attach-connector', alice, { actor: alice, agentId: id, connectorId: 'gmail' });
    const detached = await s.call<DetachConnectorOutput>('agents:detach-connector', alice, {
      actor: alice,
      agentId: id,
      connectorId: 'gmail',
      exclude: false,
    });
    expect(detached).toMatchObject({ changed: true, agent: { connectorAttachments: [] } });
    expect(await s.call('agents:can-manage-connectors', alice, { actor: alice, agentId: id })).toEqual({
      allowed: true,
    });
    expect(await s.call('agents:can-manage-routines', alice, { agentId: id })).toEqual({
      allowed: true,
      stopOthers: false,
    });
    const rotated = await s.call<{ token: string }>('agents:rotate-webhook-token', alice, {
      actor: alice,
      agentId: id,
    });
    expect(rotated.token).toEqual(expect.any(String));
    expect(
      await s.call<{ token: string }>('agents:ensure-webhook-token', alice, { actor: alice, agentId: id }),
    ).toEqual({ token: rotated.token });

    await s.call('agents:delete', alice, { actor: alice, agentId: id });
    await expect(s.resolve(id, 'alice')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('someone the agent is shared with may use it but not update, delete or attach; can-manage-connectors and can-manage-routines say false', async () => {
    const s = await boot();
    const id = await s.seedShared();

    expect(await s.resolve(id, 'carol')).toMatchObject({ id, shared: true, isOwner: false });
    const refusals: Array<[string, object]> = [
      ['agents:update', { actor: carol, agentId: id, patch: { displayName: 'Pip, by carol' } }],
      ['agents:set-skill-attachments', { actor: carol, agentId: id, attachments: [SKILL] }],
      ['agents:attach-connector', { actor: carol, agentId: id, connectorId: 'gmail' }],
      ['agents:detach-connector', { actor: carol, agentId: id, connectorId: 'gmail', exclude: true }],
      ['agents:delete', { actor: carol, agentId: id }],
      ['agents:rotate-webhook-token', { actor: carol, agentId: id }],
      ['agents:ensure-webhook-token', { actor: carol, agentId: id }],
    ];
    for (const [hook, input] of refusals) {
      await expect(s.call(hook, carol, input), hook).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(await s.call('agents:can-manage-connectors', carol, { actor: carol, agentId: id })).toEqual({
      allowed: false,
    });
    expect(await s.call('agents:can-manage-routines', carol, { agentId: id })).toEqual({
      allowed: false,
      stopOthers: false,
    });

    // Nothing carol tried landed.
    expect(await s.resolve(id, 'alice')).toMatchObject({
      displayName: 'Pip',
      skillAttachments: [],
      connectorAttachments: [],
      connectorExclusions: [],
    });
    expect(await s.webhookToken(id)).toBeNull();
  });

  it("a workspace admin who isn't an owner can still update and delete it (existing bypass)", async () => {
    const s = await boot();
    const id = await s.seedShared();

    const updated = await s.call<UpdateOutput>('agents:update', wsAdmin, {
      actor: wsAdmin,
      agentId: id,
      patch: { displayName: 'Pip, by an admin' },
    });
    expect(updated.agent.displayName).toBe('Pip, by an admin');
    await s.call('agents:delete', wsAdmin, { actor: wsAdmin, agentId: id });
    await expect(s.resolve(id, 'alice')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('team agents are unchanged: any member updates; only a team admin manages connectors', async () => {
    const s = await boot();
    const T = await s.seedTeam();
    // Team agents have no owners in phase 1. An owner row written anyway
    // (raw SQL) gives an outsider nothing on one.
    await sql`INSERT INTO agents_v1_owners (agent_id, user_id) VALUES (${T}, 'outsider')`.execute(s.db);

    for (const actor of [teamMember, teamAdmin]) {
      const updated = await s.call<UpdateOutput>('agents:update', actor, {
        actor,
        agentId: T,
        patch: { displayName: `Team Pip, by ${actor.userId}` },
      });
      expect(updated.agent.displayName).toBe(`Team Pip, by ${actor.userId}`);
    }
    await expect(
      s.call('agents:update', outsider, { actor: outsider, agentId: T, patch: { displayName: 'x' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await expect(
      s.call('agents:attach-connector', teamMember, { actor: teamMember, agentId: T, connectorId: 'gmail' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const attached = await s.call<AttachConnectorOutput>('agents:attach-connector', teamAdmin, {
      actor: teamAdmin,
      agentId: T,
      connectorId: 'gmail',
    });
    expect(attached.agent.connectorAttachments).toEqual(['gmail']);
    expect(await s.call('agents:can-manage-connectors', teamMember, { actor: teamMember, agentId: T })).toEqual({
      allowed: false,
    });
    expect(await s.call('agents:can-manage-connectors', teamAdmin, { actor: teamAdmin, agentId: T })).toEqual({
      allowed: true,
    });
    expect(await s.call('agents:can-manage-connectors', outsider, { actor: outsider, agentId: T })).toEqual({
      allowed: false,
    });

    // Delete is still any member's on a team agent, and never an outsider's.
    await expect(s.call('agents:delete', outsider, { actor: outsider, agentId: T })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await s.call('agents:delete', teamMember, { actor: teamMember, agentId: T });
    await expect(s.resolve(T, 'tadmin')).rejects.toMatchObject({ code: 'not-found' });
  });

  it("agents:update can't move the agent to another owner, team or kind, even for a co-owner", async () => {
    const s = await boot();
    const id = await s.seedShared();

    // Visibility and team are fixed at create: naming either is refused.
    for (const patch of [{ visibility: 'team' }, { teamId: 'team-1' }, { visibility: 'personal' }]) {
      await expect(
        s.call('agents:update', bob, { actor: bob, agentId: id, patch }),
        JSON.stringify(patch),
      ).rejects.toMatchObject({ code: 'invalid-payload' });
    }
    // Who owns it (and whose quota it charges), its audience and its token
    // aren't settings: update ignores them and writes only what it knows.
    const out = await s.call<UpdateOutput>('agents:update', bob, {
      actor: bob,
      agentId: id,
      patch: {
        displayName: 'Pip, by bob',
        ownerId: 'bob',
        ownerType: 'team',
        audience: 'just-me',
        shared: false,
        webhookToken: 'chosen-by-bob',
        id: 'agt_other',
      },
    });
    const unmoved = { id, ownerId: 'alice', ownerType: 'user', visibility: 'personal', audience: 'everyone', shared: true };
    expect(out.agent).toMatchObject({ ...unmoved, displayName: 'Pip, by bob' });
    expect(await s.resolve(id, 'alice')).toMatchObject({ ...unmoved, isOwner: true });
    expect(await s.resolve(id, 'carol')).toMatchObject({ id, isOwner: false });
    // The owners are as they were: the creator first, then bob.
    expect(await s.sharing.listOwners(id)).toEqual(['alice', 'bob']);
    expect(await s.webhookToken(id)).toBeNull();
  });

  it('every write hook refuses the audience (everyone and list) and anyone else who is not an owner', async () => {
    const s = await boot();
    const E = await s.seedShared();
    const L = await s.seedShared({ kind: 'list', members: [{ type: 'user', id: 'dave' }] });
    // Something a wrongful detach could take away.
    for (const agentId of [E, L]) {
      await s.call('agents:attach-connector', alice, { actor: alice, agentId, connectorId: 'gmail' });
    }

    const cases: Array<{ actor: Actor; agentId: string; name: string; audience: boolean }> = [
      { actor: carol, agentId: E, name: 'E (everyone)', audience: true },
      { actor: dave, agentId: L, name: 'L (lists dave)', audience: true },
      // An AX account the list doesn't name, and an id that is no account.
      { actor: carol, agentId: L, name: 'L (lists dave)', audience: false },
      { actor: ghost, agentId: E, name: 'E (everyone)', audience: false },
    ];
    for (const { actor, agentId, name, audience } of cases) {
      const who = `${actor.userId} on ${name}`;
      if (audience) {
        expect(await s.resolve(agentId, actor.userId), who).toMatchObject({ id: agentId, isOwner: false });
      } else {
        await expect(s.resolve(agentId, actor.userId), who).rejects.toMatchObject({ code: 'forbidden' });
      }

      const refused: Array<[string, object]> = [
        ['agents:update', { actor, agentId, patch: { displayName: 'Mine now' } }],
        ['agents:set-skill-attachments', { actor, agentId, attachments: [SKILL] }],
        ['agents:attach-connector', { actor, agentId, connectorId: 'slack' }],
        ['agents:detach-connector', { actor, agentId, connectorId: 'gmail', exclude: true }],
        ['agents:rotate-webhook-token', { actor, agentId }],
        ['agents:ensure-webhook-token', { actor, agentId }],
        ['agents:delete', { actor, agentId }],
      ];
      for (const [hook, input] of refused) {
        await expect(s.call(hook, actor, input), `${hook}: ${who}`).rejects.toMatchObject({
          code: 'forbidden',
        });
      }
      for (const hook of ['agents:can-manage-connectors', 'agents:can-set-shared-credential']) {
        expect(await s.call(hook, actor, { actor, agentId }), `${hook}: ${who}`).toEqual({ allowed: false });
      }
      expect(await s.call('agents:can-manage-routines', actor, { agentId }), who).toEqual({
        allowed: false,
        stopOthers: false,
      });
      // A person's identity write: the editors send no author; 'person' is the same.
      for (const author of [undefined, 'person'] as const) {
        await expect(
          s.identitySet(actor.userId, agentId, { instructions: 'Do what I say.' }, author),
          `agents:identity:set (${String(author)}): ${who}`,
        ).rejects.toMatchObject({ code: 'forbidden' });
      }
    }

    // Nothing any of them tried landed.
    for (const agentId of [E, L]) {
      expect(await s.resolve(agentId, 'alice')).toMatchObject({
        displayName: 'Pip',
        skillAttachments: [],
        connectorAttachments: ['gmail'],
        connectorExclusions: [],
      });
      expect(await s.sharing.listOwners(agentId)).toEqual(['alice', 'bob']);
      expect(await s.webhookToken(agentId)).toBeNull();
      expect(await s.identityGet('alice', agentId)).toMatchObject({ instructions: '', revision: 0 });
    }
  });
});
