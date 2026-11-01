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
// TASK-1017: a stored `agent_file` block that fails today's strict schema (a
// key rule tightened since it was written, an extra field) must cost its chip,
// not its turn. A turn with ANY block that fails the schema is skipped whole on
// read, so `conversations:get` turns such a block into a "no longer available"
// text line BEFORE validation.
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
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
}

/**
 * Store one turn's blocks exactly as an older release wrote them — the
 * display-log append does not validate blocks, so old shapes land verbatim —
 * and read the conversation back.
 */
async function storeAndRead(
  role: 'user' | 'assistant' | 'tool',
  blocks: unknown[] | ((conversationId: string) => unknown[]),
): Promise<GetOutput> {
  const h = await makeHarness();
  const { conversationId } = await h.bus.call<CreateInput, CreateOutput>(
    'conversations:create',
    h.ctx({ userId: 'userA' }),
    { userId: 'userA', agentId: 'agt_a' },
  );
  await h.bus.call<AppendEventInput, AppendEventOutput>(
    'conversations:append-event',
    h.ctx({ conversationId }),
    {
      conversationId,
      kind: 'turn',
      role,
      payload: { blocks: typeof blocks === 'function' ? blocks(conversationId) : blocks },
    },
  );
  return h.bus.call<GetInput, GetOutput>(
    'conversations:get',
    h.ctx({ userId: 'userA' }),
    { conversationId, userId: 'userA' },
  );
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

describe('conversations:get — invalid stored agent_file blocks', () => {
  it("a stored agent_file block whose key fails today's rule keeps its turn", async () => {
    const got = await storeAndRead('assistant', [
      { type: 'text', text: 'Here you go.' },
      { type: 'agent_file', path: 'notes: q3.md', mediaType: 'text/markdown', sizeBytes: 2 },
    ]);
    expect(got.turns).toHaveLength(1);
    expect(got.turns[0]!.contentBlocks).toEqual([
      { type: 'text', text: 'Here you go.' },
      { type: 'text', text: 'notes: q3.md (this file is no longer available)' },
    ]);
  });

  it('a nested key shows its last segment', async () => {
    const got = await storeAndRead('assistant', [
      { type: 'agent_file', path: 'reports/a:b.pdf', mediaType: 'application/pdf', sizeBytes: 2 },
    ]);
    expect(got.turns[0]!.contentBlocks).toEqual([
      { type: 'text', text: 'a:b.pdf (this file is no longer available)' },
    ]);
  });

  it('an agent_file block with a field the strict schema refuses degrades too', async () => {
    const got = await storeAndRead('assistant', [
      { type: 'agent_file', path: 'ok.pdf', filename: 'x', mediaType: 'application/pdf', sizeBytes: 2 },
    ]);
    expect(got.turns[0]!.contentBlocks).toEqual([
      { type: 'text', text: 'ok.pdf (this file is no longer available)' },
    ]);
  });

  it.each([
    ['a non-string path', 42],
    ['an empty path', ''],
    // A bare control character is a VALID key (the schema allows it), so the
    // leading space is what makes this one invalid; the name rule then strips
    // the control character and the trim leaves nothing.
    ['a path of only a control character', ' \u0007'],
  ])('a key with no usable name (%s) reads A file', async (_label, path) => {
    const got = await storeAndRead('assistant', [
      { type: 'agent_file', path, mediaType: 'application/pdf', sizeBytes: 2 },
    ]);
    expect(got.turns).toHaveLength(1);
    expect(got.turns[0]!.contentBlocks).toEqual([
      { type: 'text', text: 'A file (this file is no longer available)' },
    ]);
  });

  it('a valid agent_file block passes through unchanged', async () => {
    const block = {
      type: 'agent_file',
      path: 'reports/q3.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 10,
    };
    const got = await storeAndRead('assistant', [{ type: 'text', text: 'done' }, block]);
    expect(got.turns[0]!.contentBlocks).toEqual([{ type: 'text', text: 'done' }, block]);
  });
});
