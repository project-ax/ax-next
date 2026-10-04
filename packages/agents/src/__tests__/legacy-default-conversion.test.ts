import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  createTestHarness,
  stopPostgresContainer,
  startTestContainer,
  type TestHarness,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import type { AgentContext } from '@ax/core';
import { createAgentsPlugin } from '../plugin.js';
import type { Actor, CreateInput, CreateOutput, ResolveInput, ResolveOutput } from '../types.js';

/**
 * TASK-808 — the connector "Set default" flag is gone; @ax/agents converts
 * every legacy default into explicit attachments at the end of init.
 *
 * Real @ax/agents on Postgres. The connectors / tool-policy / teams sides are
 * stubbed on the bus (their real impls are tested in their own packages); the
 * stubs keep the legacy flag in an in-memory list so a "reboot" (a second
 * harness on the same database) sees what the first boot cleared.
 */

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

interface LegacyRow {
  ownerUserId: string;
  connectorId: string;
}

interface World {
  legacy: LegacyRow[];
  /** `${teamId}/${userId}` → role. Absent = not a member. */
  teamRoles: Record<string, 'admin' | 'member'>;
  listHook: 'present' | 'absent' | 'throws';
  /** How many upcoming clear calls throw before one succeeds. */
  clearThrows: number;
  /** How many upcoming snapshot calls throw before one succeeds. */
  snapshotThrows: number;
  snapshotCalls: Array<{ userId: string; input: Record<string, unknown> }>;
  clearCalls: LegacyRow[];
  resolveCalls: Array<{ ctxUserId: string; userId: string; connectorId: string }>;
}

let world: World;

function freshWorld(): World {
  return {
    legacy: [],
    teamRoles: {},
    listHook: 'present',
    clearThrows: 0,
    snapshotThrows: 0,
    snapshotCalls: [],
    clearCalls: [],
    resolveCalls: [],
  };
}

async function boot(): Promise<TestHarness> {
  const services: Record<string, (ctx: AgentContext, input: unknown) => Promise<unknown>> = {
    'http:register-route': async () => ({ unregister: () => {} }),
    'auth:require-user': async () => {
      throw new Error('not used');
    },
    'teams:is-member': async (_ctx, input) => {
      const { teamId, userId } = input as { teamId: string; userId: string };
      const role = world.teamRoles[`${teamId}/${userId}`];
      return role === undefined ? { member: false } : { member: true, role };
    },
    'connectors:resolve': async (ctx, input) => {
      const { userId, connectorId } = input as { userId: string; connectorId: string };
      world.resolveCalls.push({ ctxUserId: ctx.userId, userId, connectorId });
      return {
        keyMode: 'personal',
        toolNamespaces: [{ server: connectorId, toolNamespace: `ns_${connectorId}` }],
      };
    },
    'tool-policy:snapshot-connector-for-agent': async (ctx, input) => {
      world.snapshotCalls.push({ userId: ctx.userId, input: input as Record<string, unknown> });
      if (world.snapshotThrows > 0) {
        world.snapshotThrows -= 1;
        throw new Error('tool-policy store unavailable');
      }
      return { copied: 0 };
    },
    'connectors:clear-legacy-default': async (_ctx, input) => {
      const row = input as LegacyRow;
      world.clearCalls.push(row);
      if (world.clearThrows > 0) {
        world.clearThrows -= 1;
        throw new Error('connectors store unavailable');
      }
      const before = world.legacy.length;
      world.legacy = world.legacy.filter(
        (r) => !(r.ownerUserId === row.ownerUserId && r.connectorId === row.connectorId),
      );
      return { cleared: world.legacy.length < before };
    },
  };
  if (world.listHook !== 'absent') {
    services['connectors:list-legacy-defaults'] = async () => {
      if (world.listHook === 'throws') throw new Error('connectors table locked');
      return { connectors: world.legacy.map((r) => ({ ...r })) };
    };
  }
  const h = await createTestHarness({
    services: services as never,
    plugins: [createDatabasePostgresPlugin({ connectionString }), createAgentsPlugin()],
  });
  harnesses.push(h);
  return h;
}

/** A second boot on the same database (what a host restart looks like). */
async function reboot(): Promise<TestHarness> {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  return boot();
}

async function newAgent(
  h: TestHarness,
  owner: string,
  opts: { teamId?: string; name?: string } = {},
): Promise<string> {
  const actor: Actor = { userId: owner, isAdmin: false };
  const out = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx({ userId: owner }), {
    actor,
    input: {
      displayName: opts.name ?? 'Quill',
      allowedTools: [],
      mcpConfigIds: [],
      model: 'anthropic/claude-opus-4-7',
      visibility: opts.teamId === undefined ? 'personal' : 'team',
      ...(opts.teamId === undefined ? {} : { teamId: opts.teamId }),
    },
  });
  return out.agent.id;
}

async function withPg<T>(fn: (c: import('pg').Client) => Promise<T>): Promise<T> {
  const c = new (await import('pg')).default.Client({ connectionString });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

async function row(
  agentId: string,
): Promise<{ attachments: string[]; exclusions: string[]; updatedAt: Date }> {
  return withPg(async (c) => {
    const r = await c.query(
      'SELECT connector_attachments, connector_exclusions, updated_at FROM agents_v1_agents WHERE agent_id = $1',
      [agentId],
    );
    const x = r.rows[0] as {
      connector_attachments: string[];
      connector_exclusions: string[];
      updated_at: Date;
    };
    return {
      attachments: x.connector_attachments,
      exclusions: x.connector_exclusions,
      updatedAt: x.updated_at,
    };
  });
}

async function setLists(
  agentId: string,
  lists: { attachments?: string[]; exclusions?: string[] },
): Promise<void> {
  await withPg(async (c) => {
    if (lists.attachments !== undefined) {
      await c.query('UPDATE agents_v1_agents SET connector_attachments = $2::jsonb WHERE agent_id = $1', [
        agentId,
        JSON.stringify(lists.attachments),
      ]);
    }
    if (lists.exclusions !== undefined) {
      await c.query('UPDATE agents_v1_agents SET connector_exclusions = $2::jsonb WHERE agent_id = $1', [
        agentId,
        JSON.stringify(lists.exclusions),
      ]);
    }
  });
}

// --- log capture: the plugin logs through the default (stdout) logger. ----
let logLines: Array<Record<string, unknown>>;
let writeSpy: ReturnType<typeof vi.spyOn> | undefined;

function conversionLogs(msg?: string): Array<Record<string, unknown>> {
  return logLines.filter(
    (l) =>
      typeof l.msg === 'string' &&
      l.msg.startsWith('agents_legacy_default_') &&
      (msg === undefined || l.msg === msg),
  );
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

beforeEach(() => {
  world = freshWorld();
  logLines = [];
  const original = process.stdout.write.bind(process.stdout);
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    let captured = false;
    for (const line of text.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        logLines.push(parsed);
        captured = true;
      } catch {
        // not a log line
      }
    }
    if (captured) return true;
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as never);
});

afterEach(async () => {
  writeSpy?.mockRestore();
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  await withPg((c) => c.query('DROP TABLE IF EXISTS agents_v1_agents'));
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const O = 'owner-o';
const OTHER = 'someone-else';

describe('legacy connector-default conversion (agents init)', () => {
  it("attaches to the owner's personal agents only — never a team agent, even one the owner administers; snapshots with onlyIfNotCopied as the owner; clears the flag", async () => {
    world.teamRoles = { [`t-admin/${O}`]: 'admin', [`t-other/${OTHER}`]: 'admin' };
    let h = await boot();
    const personal = await newAgent(h, O, { name: 'Mine' });
    const teamAdmin = await newAgent(h, O, { teamId: 't-admin' });
    const othersPersonal = await newAgent(h, OTHER);
    const nonMemberTeam = await newAgent(h, OTHER, { teamId: 't-other' });

    world.legacy = [{ ownerUserId: O, connectorId: 'linear' }];
    h = await reboot();

    expect((await row(personal)).attachments).toEqual(['linear']);
    // An attachment on a team agent would reach every member — wider than the
    // default ever was (only the owner's sessions). Not a target.
    expect((await row(teamAdmin)).attachments).toEqual([]);
    expect((await row(othersPersonal)).attachments).toEqual([]);
    expect((await row(nonMemberTeam)).attachments).toEqual([]);

    // Snapshot ran as the real owner, with onlyIfNotCopied, for the one target.
    expect(world.snapshotCalls).toHaveLength(1);
    for (const call of world.snapshotCalls) {
      expect(call.userId).toBe(O);
      expect(call.input).toMatchObject({
        connectorId: 'linear',
        toolNamespaces: ['ns_linear'],
        onlyIfNotCopied: true,
      });
    }
    expect(world.snapshotCalls.map((c) => c.input.agentId).sort()).toEqual(
      [personal],
    );
    // Resolved as the owner too — never a synthetic actor.
    expect(world.resolveCalls.every((c) => c.userId === O && c.ctxUserId === O)).toBe(true);

    expect(world.clearCalls).toEqual([{ ownerUserId: O, connectorId: 'linear' }]);
    expect(world.legacy).toEqual([]);

    // Team agents are not targets at all — no skip line for them.
    expect(conversionLogs('agents_legacy_default_skipped')).toEqual([]);
    const summary = conversionLogs('agents_legacy_default_converted');
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      level: 'info',
      ownerUserId: O,
      connectorId: 'linear',
      attached: 1,
      cleared: true,
    });

    // The agents plugin itself is fine after the conversion.
    const resolved = await h.bus.call<ResolveInput, ResolveOutput>(
      'agents:resolve',
      h.ctx({ userId: O }),
      { agentId: personal, userId: O },
    );
    expect(resolved.agent.connectorAttachments).toEqual(['linear']);
  });

  it('skips an agent that excluded the connector (it was not effective there) and still clears the flag', async () => {
    let h = await boot();
    const excluded = await newAgent(h, O, { name: 'Excluded' });
    const plain = await newAgent(h, O, { name: 'Plain' });
    await setLists(excluded, { exclusions: ['linear'] });

    world.legacy = [{ ownerUserId: O, connectorId: 'linear' }];
    h = await reboot();

    expect(await row(excluded)).toMatchObject({ attachments: [], exclusions: ['linear'] });
    expect((await row(plain)).attachments).toEqual(['linear']);
    expect(world.snapshotCalls.map((c) => c.input.agentId)).toEqual([plain]);
    expect(world.legacy).toEqual([]);
    expect(conversionLogs('agents_legacy_default_skipped')).toEqual([
      expect.objectContaining({ level: 'warn', agentId: excluded, connectorId: 'linear', reason: 'excluded' }),
    ]);
  });

  it('a re-run is a no-op for an agent that already has the attachment (heals the snapshot, does not rewrite the row)', async () => {
    let h = await boot();
    const agentId = await newAgent(h, O);
    world.legacy = [{ ownerUserId: O, connectorId: 'linear' }];
    h = await reboot();
    const first = await row(agentId);
    expect(first.attachments).toEqual(['linear']);

    // The flag comes back (say, the clear was lost) — the next boot must not
    // duplicate or rewrite anything.
    world.legacy = [{ ownerUserId: O, connectorId: 'linear' }];
    world.snapshotCalls = [];
    h = await reboot();
    const second = await row(agentId);
    expect(second.attachments).toEqual(['linear']);
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
    // Snapshot still runs (onlyIfNotCopied makes it a no-op in tool-policy).
    expect(world.snapshotCalls).toEqual([
      expect.objectContaining({ input: expect.objectContaining({ agentId, onlyIfNotCopied: true }) }),
    ]);
    expect(world.legacy).toEqual([]);

    // And with nothing left to convert, a third boot touches nothing.
    world.snapshotCalls = [];
    world.clearCalls = [];
    h = await reboot();
    expect(world.snapshotCalls).toEqual([]);
    expect(world.clearCalls).toEqual([]);
  });

  it('crash between attach and clear: the flag survives, the next boot attaches nothing new and clears it', async () => {
    let h = await boot();
    const agentId = await newAgent(h, O);
    world.legacy = [{ ownerUserId: O, connectorId: 'linear' }];
    world.clearThrows = 1;
    h = await reboot(); // init must still succeed
    expect(h.bus.hasService('agents:resolve')).toBe(true);
    const first = await row(agentId);
    expect(first.attachments).toEqual(['linear']);
    expect(world.legacy).toEqual([{ ownerUserId: O, connectorId: 'linear' }]);
    expect(conversionLogs('agents_legacy_default_clear_failed')).toEqual([
      expect.objectContaining({ level: 'warn', ownerUserId: O, connectorId: 'linear' }),
    ]);

    h = await reboot();
    const second = await row(agentId);
    expect(second.attachments).toEqual(['linear']);
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
    expect(world.legacy).toEqual([]);
  });

  it('a failed snapshot is transient: the attachment stays, the flag is NOT cleared, the next boot finishes', async () => {
    let h = await boot();
    const agentId = await newAgent(h, O);
    world.legacy = [{ ownerUserId: O, connectorId: 'linear' }];
    world.snapshotThrows = 1;
    h = await reboot();
    expect((await row(agentId)).attachments).toEqual(['linear']);
    expect(world.clearCalls).toEqual([]);
    expect(world.legacy).toHaveLength(1);
    expect(conversionLogs('agents_legacy_default_snapshot_failed')).toEqual([
      expect.objectContaining({ level: 'warn', agentId, connectorId: 'linear' }),
    ]);

    h = await reboot();
    expect(world.snapshotCalls).toHaveLength(2);
    expect(world.legacy).toEqual([]);
  });

  it('attachment-cap overflow on one agent is logged and skipped; other agents convert, the flag clears, boot succeeds', async () => {
    let h = await boot();
    const full = await newAgent(h, O, { name: 'Full' });
    const roomy = await newAgent(h, O, { name: 'Roomy' });
    const fifty = Array.from({ length: 50 }, (_, i) => `c${i}`);
    await setLists(full, { attachments: fifty });

    world.legacy = [{ ownerUserId: O, connectorId: 'linear' }];
    h = await reboot();

    expect(h.bus.hasService('agents:resolve')).toBe(true);
    expect((await row(full)).attachments).toEqual(fifty);
    expect((await row(roomy)).attachments).toEqual(['linear']);
    expect(world.legacy).toEqual([]);
    expect(conversionLogs('agents_legacy_default_skipped')).toEqual([
      expect.objectContaining({ level: 'warn', agentId: full, connectorId: 'linear', reason: 'attachment-cap' }),
    ]);
    // No snapshot for the agent it never reached.
    expect(world.snapshotCalls.map((c) => c.input.agentId)).toEqual([roomy]);
  });

  it('several owners/connectors convert independently', async () => {
    let h = await boot();
    const mine = await newAgent(h, O);
    const theirs = await newAgent(h, OTHER);
    world.legacy = [
      { ownerUserId: O, connectorId: 'gmail' },
      { ownerUserId: O, connectorId: 'linear' },
      { ownerUserId: OTHER, connectorId: 'linear' },
    ];
    h = await reboot();
    expect((await row(mine)).attachments).toEqual(['gmail', 'linear']);
    expect((await row(theirs)).attachments).toEqual(['linear']);
    expect(world.legacy).toEqual([]);
  });

  it('no list hook (no @ax/connectors) → nothing happens', async () => {
    let h = await boot();
    const agentId = await newAgent(h, O);
    world.listHook = 'absent';
    world.legacy = [{ ownerUserId: O, connectorId: 'linear' }];
    h = await reboot();
    expect((await row(agentId)).attachments).toEqual([]);
    expect(world.snapshotCalls).toEqual([]);
    expect(world.clearCalls).toEqual([]);
    expect(h.bus.hasService('agents:resolve')).toBe(true);
  });

  it('the list hook throwing never fails boot', async () => {
    let h = await boot();
    const agentId = await newAgent(h, O);
    world.listHook = 'throws';
    h = await reboot();
    expect(h.bus.hasService('agents:resolve')).toBe(true);
    const resolved = await h.bus.call<ResolveInput, ResolveOutput>(
      'agents:resolve',
      h.ctx({ userId: O }),
      { agentId, userId: O },
    );
    expect(resolved.agent.id).toBe(agentId);
    expect(conversionLogs('agents_legacy_default_list_failed')).toEqual([
      expect.objectContaining({ level: 'warn' }),
    ]);
  });
});
