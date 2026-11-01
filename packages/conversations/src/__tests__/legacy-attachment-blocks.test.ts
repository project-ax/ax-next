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
// Old conversations after attachment blocks moved from paths to ids.
//
// `attachment` blocks stored before TASK-995 carry `{ path, displayName, … }`.
// They no longer match the content-block schema, and a turn with ANY block
// that fails the schema is skipped whole on read — so without a shim the turn's
// text would vanish along with the chip. `conversations:get` turns such a
// block into a plain "no longer available" line BEFORE validation, so the turn
// still renders. Its download is gone either way (accepted, design §10).
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

describe('conversations:get — attachment blocks stored before ids', () => {
  it('keeps an old turn whose upload block has a path, rendering it as text', async () => {
    const got = await storeAndRead('user', [
      { type: 'text', text: 'see this' },
      {
        type: 'attachment',
        path: '.ax/uploads/c/t/x__a.pdf',
        displayName: 'a.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 10,
      },
    ]);
    expect(got.turns).toHaveLength(1);
    expect(got.turns[0]!.role).toBe('user');
    expect(got.turns[0]!.contentBlocks).toEqual([
      { type: 'text', text: 'see this' },
      { type: 'text', text: 'a.pdf (this file is no longer available)' },
    ]);
  });

  it('keeps an old tool turn whose artifact chip has a path', async () => {
    const got = await storeAndRead('tool', [
      { type: 'tool_result', tool_use_id: 'toolu-1', content: 'published' },
      {
        type: 'attachment',
        path: 'out/r.png',
        displayName: 'r.png',
        mediaType: 'image/png',
        sizeBytes: 3,
      },
    ]);
    expect(got.turns).toHaveLength(1);
    expect(got.turns[0]!.contentBlocks).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu-1', content: 'published' },
      { type: 'text', text: 'r.png (this file is no longer available)' },
    ]);
  });

  it.each([
    ['no displayName', {}],
    ['an empty displayName', { displayName: '' }],
    ['a non-string displayName', { displayName: 42 }],
    ['a displayName over 255 characters', { displayName: 'n'.repeat(256) }],
    // (JSONB cannot hold U+0000, so no stored row carries it.)
    ['a displayName that is only control characters', { displayName: '\n\t\u0007\u007f' }],
  ])('a legacy block with %s reads "A file …"', async (_label, name) => {
    const got = await storeAndRead('user', [
      { type: 'attachment', path: '.ax/uploads/c/t/x__a.pdf', mediaType: 'application/pdf', sizeBytes: 10, ...name },
    ]);
    expect(got.turns[0]!.contentBlocks).toEqual([
      { type: 'text', text: 'A file (this file is no longer available)' },
    ]);
  });

  it('keeps a legacy name on one line (control characters dropped)', async () => {
    const got = await storeAndRead('user', [
      {
        type: 'attachment',
        path: '.ax/uploads/c/t/x__a.pdf',
        displayName: 'q4\nreport\u0007.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 10,
      },
    ]);
    expect(got.turns[0]!.contentBlocks).toEqual([
      { type: 'text', text: 'q4report.pdf (this file is no longer available)' },
    ]);
  });

  it('leaves a current id-addressed block untouched', async () => {
    const block = {
      type: 'attachment',
      attachmentId: '3f1c2b9e-7d4a-4c1e-9b8f-2a6d5e4c3b1a',
      filename: 'a.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 10,
    };
    const got = await storeAndRead('user', [{ type: 'text', text: 'see this' }, block]);
    expect(got.turns[0]!.contentBlocks).toEqual([{ type: 'text', text: 'see this' }, block]);
  });

  // Chips are never rebuilt from text any more: a line that looks like the
  // runner's old upload mention — even one naming this very conversation's old
  // upload folder — is just what the person typed.
  it('a typed line that looks like an old upload mention stays text', async () => {
    const typed = (conversationId: string): string =>
      `User attached 'a.pdf' at .ax/uploads/${conversationId}/t/ab12__a.pdf (application/pdf)`;
    let expected = '';
    const got = await storeAndRead('user', (conversationId) => {
      expected = typed(conversationId);
      return [{ type: 'text', text: expected }];
    });
    expect(got.turns[0]!.contentBlocks).toEqual([{ type: 'text', text: expected }]);
  });
});
