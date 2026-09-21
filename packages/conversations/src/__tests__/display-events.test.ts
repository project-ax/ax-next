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
import { createConversationsPlugin } from '../plugin.js';
import type {
  AppendEventInput,
  AppendEventOutput,
  CreateInput,
  CreateOutput,
  GetInput,
  GetOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// TASK-66 — display event log end-to-end (out-of-git Part B / B1 / B3).
//
// Drives the full @ax/conversations plugin against a real Postgres
// testcontainer: fires the host display events the runner/orchestrator emit
// (chat:turn-end, chat:turn-error, chat:permission-request), then reads them
// back via conversations:get to prove:
//   - redisplay comes from the event log (turn events → Turn[]);
//   - host-only UI (cards, surfaced errors) survives reload on displayEvents;
//   - a later card-resolution frame folds the earlier card to terminal state.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_ctx, input: unknown) => {
        const call = input as { agentId: string };
        return { agent: { id: call.agentId, visibility: 'personal' } };
      },
      // conversations manifest declares these calls; stub for bootstrap.
      'workspace:list': async () => ({ paths: [] as string[] }),
      'workspace:read': async () => ({ found: false as const }),
      'workspace:apply': async () => ({
        version: 'v-stub',
        delta: { before: null, after: 'v-stub', changes: [] },
      }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
}

async function createConv(h: TestHarness, userId: string): Promise<string> {
  const created = await h.bus.call<CreateInput, CreateOutput>(
    'conversations:create',
    h.ctx({ userId }),
    { userId, agentId: 'agt_a' },
  );
  return created.conversationId;
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
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_events');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_conversations');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('TASK-66 display event log — persist + read', () => {
  // Persist a turn via the conversations:append-event hook — the same hook the
  // @ax/ipc-core event.turn-end handler calls (awaited, before the 202). We
  // exercise the hook directly here (the dispatcher → handler → ack wiring +
  // persist-before-ack barrier is covered in @ax/ipc-core's dispatcher test).
  async function appendTurn(
    h: TestHarness,
    conversationId: string,
    role: 'user' | 'assistant' | 'tool',
    blocks: unknown[],
  ): Promise<void> {
    await h.bus.call<AppendEventInput, AppendEventOutput>(
      'conversations:append-event',
      h.ctx({ conversationId }),
      { conversationId, kind: 'turn', role, payload: { blocks } },
    );
  }

  it('persists turn frames and conversations:get reads them back as Turn[]', async () => {
    const h = await makeHarness();
    const userId = 'userA';
    const conversationId = await createConv(h, userId);

    // The runner ships a user turn then an assistant turn (role-tagged).
    await appendTurn(h, conversationId, 'user', [{ type: 'text', text: 'hello' }]);
    await appendTurn(h, conversationId, 'assistant', [
      { type: 'text', text: 'hi back' },
    ]);

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId }),
      { conversationId, userId },
    );

    expect(got.turns).toHaveLength(2);
    expect(got.turns[0]).toMatchObject({
      role: 'user',
      turnIndex: 0,
      contentBlocks: [{ type: 'text', text: 'hello' }],
    });
    expect(got.turns[1]).toMatchObject({
      role: 'assistant',
      turnIndex: 1,
      contentBlocks: [{ type: 'text', text: 'hi back' }],
    });
    // No host-only events fired → displayEvents is empty (but present).
    expect(got.displayEvents).toEqual([]);
  });

  it('persists a host-only permission card and a surfaced error; conversations:get returns them on displayEvents (host-only UI on reload)', async () => {
    const h = await makeHarness();
    const userId = 'userA';
    const conversationId = await createConv(h, userId);
    const cctx = h.ctx({ userId, conversationId });

    // An assistant turn, a JIT approval card, and a surfaced error.
    await appendTurn(h, conversationId, 'assistant', [
      { type: 'text', text: 'working on it' },
    ]);
    await h.bus.fire('chat:permission-request', cctx, {
      kind: 'skill',
      skillId: 'linear',
      description: 'Linear skill',
      hosts: ['api.linear.app'],
      slots: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
    });
    await h.bus.fire('chat:turn-error', cctx, {
      reqId: 'r1',
      reason: 'sandbox-terminated',
    });

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId }),
      { conversationId, userId },
    );

    // The turn renders via the existing path...
    expect(got.turns).toHaveLength(1);
    expect(got.turns[0]!.role).toBe('assistant');

    // ...AND the host-only events the jsonl never sees survive reload.
    const card = got.displayEvents.find((e) => e.kind === 'permission-card');
    const err = got.displayEvents.find((e) => e.kind === 'turn-error');
    expect(card).toBeDefined();
    expect(card!.payload).toMatchObject({ kind: 'skill', skillId: 'linear' });
    expect(card!.key).toBe('skill:linear');
    expect(err).toBeDefined();
    expect(err!.payload).toMatchObject({ error: 'sandbox-terminated' });
  });

  /*
    TASK-498 — THE `detail` LINE HAS TO SURVIVE THE ROUND TRIP.

    `persistTurnError` used to store `{ reqId, error }` and drop `detail` on
    the floor, and that was invisible for as long as nothing replayed these
    events at all. Once the agent view started rendering them on reload, a
    `dev-service-failed` showed its actionable line live ("which service, at
    which path" — TASK-160) and lost it on refresh: the same failure, worded
    two different ways depending on when you looked at it.

    This asserts the REAL path — `chat:turn-error` fired at the bus, through
    the subscriber, into the event log, back out of `conversations:get`. A
    reviewer found the first version of this feature tested with hand-built
    `displayEvents` carrying a `detail` the producer could never have written,
    which passed over a dead field. Synthetic fixtures cannot catch a producer
    that does not produce.
  */
  it('carries a turn-error detail line through persist and back out (TASK-498)', async () => {
    const h = await makeHarness();
    const userId = 'userA';
    const conversationId = await createConv(h, userId);
    const cctx = h.ctx({ userId, conversationId });

    await h.bus.fire('chat:turn-error', cctx, {
      reqId: 'r-detail',
      reason: 'dev-service-failed',
      detail: "service 'kafka' couldn't write /opt/kafka",
    });

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId }),
      { conversationId, userId },
    );
    const err = got.displayEvents.find((e) => e.kind === 'turn-error');
    expect(err).toBeDefined();
    expect(err!.payload).toMatchObject({
      error: 'dev-service-failed',
      detail: "service 'kafka' couldn't write /opt/kafka",
    });
  });

  it('omits an absent turn-error detail rather than storing an empty one (TASK-498)', async () => {
    // An empty `detail` would render as a blank line under the label — the
    // renderer joins the two on a newline — so absence has to stay absence.
    const h = await makeHarness();
    const userId = 'userA';
    const conversationId = await createConv(h, userId);

    await h.bus.fire('chat:turn-error', h.ctx({ userId, conversationId }), {
      reqId: 'r-plain',
      reason: 'sandbox-terminated',
      detail: '',
    });

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId }),
      { conversationId, userId },
    );
    const err = got.displayEvents.find((e) => e.kind === 'turn-error');
    expect(err).toBeDefined();
    expect(err!.payload).not.toHaveProperty('detail');
  });

  it('folds a later card-resolution frame onto the earlier card (terminal state on replay)', async () => {
    const h = await makeHarness();
    const userId = 'userA';
    const conversationId = await createConv(h, userId);
    const cctx = h.ctx({ userId, conversationId });

    // The card is raised pending...
    await h.bus.fire('chat:permission-request', cctx, {
      kind: 'skill',
      skillId: 'linear',
      hosts: ['api.linear.app'],
      status: 'pending',
    });
    // ...then a later frame for the SAME card resolves it.
    await h.bus.fire('chat:permission-request', cctx, {
      kind: 'skill',
      skillId: 'linear',
      hosts: ['api.linear.app'],
      status: 'approved',
    });

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId }),
      { conversationId, userId },
    );

    const cards = got.displayEvents.filter((e) => e.kind === 'permission-card');
    // Folded to ONE card in its terminal (approved) state.
    expect(cards).toHaveLength(1);
    expect(cards[0]!.payload).toMatchObject({ status: 'approved' });
  });

  it('orders folded display events by the TERMINAL event seq, not the first appearance', async () => {
    const h = await makeHarness();
    const userId = 'userA';
    const conversationId = await createConv(h, userId);
    const cctx = h.ctx({ userId, conversationId });

    // card A appears pending (seq 1)...
    await h.bus.fire('chat:permission-request', cctx, {
      kind: 'skill',
      skillId: 'alpha',
      hosts: ['a.example'],
      status: 'pending',
    });
    // ...then a DIFFERENT host card B lands (seq 2)...
    await h.bus.fire('chat:permission-request', cctx, {
      kind: 'host',
      host: 'b.example',
      sessionId: 's1',
    });
    // ...then card A RESOLVES (seq 3). Its terminal seq (3) is now AFTER B's
    // (2), so the fold must place A LAST — not back in its seq-1 slot.
    await h.bus.fire('chat:permission-request', cctx, {
      kind: 'skill',
      skillId: 'alpha',
      hosts: ['a.example'],
      status: 'approved',
    });

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId }),
      { conversationId, userId },
    );
    const cards = got.displayEvents.filter((e) => e.kind === 'permission-card');
    expect(cards.map((c) => c.key)).toEqual(['host:b.example', 'skill:alpha']);
    expect(cards[1]!.payload).toMatchObject({ status: 'approved' });
  });

  it('the host-only subscribers ignore events with no conversation context (no ctx.conversationId)', async () => {
    const h = await makeHarness();
    const userId = 'userA';
    const conversationId = await createConv(h, userId);

    // Fire host-only events WITHOUT conversationId on the ctx — a canary /
    // admin probe. The chat:turn-error / chat:permission-request subscribers
    // must skip (no row to attribute them to) rather than throw.
    await h.bus.fire('chat:permission-request', h.ctx({ userId }), {
      kind: 'skill',
      skillId: 'linear',
      hosts: ['api.linear.app'],
    });
    await h.bus.fire('chat:turn-error', h.ctx({ userId }), {
      reqId: 'r1',
      reason: 'sandbox-terminated',
    });

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId }),
      { conversationId, userId },
    );
    expect(got.turns).toEqual([]);
    expect(got.displayEvents).toEqual([]);
  });
});
