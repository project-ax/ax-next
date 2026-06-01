import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type {
  CreateInput,
  CreateOutput,
  GetTranscriptInput,
  GetTranscriptOutput,
  ReplaceTranscriptInput,
  ReplaceTranscriptOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// TASK-75 — drop-turn against the out-of-git transcript-row store.
//
// Pre-TASK-67, drop-turn rewrote the runner's native jsonl in the git
// workspace (workspace:list/read/apply over `.claude/projects/**/<sid>.jsonl`).
// TASK-67 moved the resume transcript into `conversations_v1_transcripts` rows
// and gitignored `.claude/projects/`, so the workspace glob now returns ZERO
// paths and drop-turn SILENTLY NO-OPS — a silenced routine turn survives on
// resume. This suite seeds the transcript ROWS (via conversations:replace-
// transcript) and asserts the dropped turn is gone from
// conversations:get-transcript. The "drops the line whose uuid matches turnId"
// + "drops the most recent turn" cases FAIL pre-fix (both turns survive the
// no-op) and pass once drop-turn reads/writes the rows.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

function jsonlLine(over: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'will-be-set',
    timestamp: '2026-05-14T12:00:00.000Z',
    message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ...over,
  });
}

async function makeHarness() {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_c, input: unknown) => ({
        agent: { id: (input as { agentId: string }).agentId, visibility: 'personal' },
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

/** Bind a conversation, seed its transcript rows, return the conversationId. */
async function seedConversationWithTranscript(
  h: TestHarness,
  userId: string,
  runnerSessionId: string,
  lines: string[],
): Promise<string> {
  const conv = await h.bus.call<CreateInput, CreateOutput>(
    'conversations:create',
    h.ctx({ userId }),
    { userId, agentId: 'a1' },
  );
  await h.bus.call('conversations:store-runner-session', h.ctx({ userId }), {
    conversationId: conv.conversationId,
    runnerSessionId,
  });
  await h.bus.call<ReplaceTranscriptInput, ReplaceTranscriptOutput>(
    'conversations:replace-transcript',
    h.ctx({ userId }),
    { conversationId: conv.conversationId, lines },
  );
  return conv.conversationId;
}

async function getTranscriptBytes(
  h: TestHarness,
  userId: string,
  conversationId: string,
): Promise<string> {
  const got = await h.bus.call<GetTranscriptInput, GetTranscriptOutput>(
    'conversations:get-transcript',
    h.ctx({ userId }),
    { conversationId },
  );
  return got.bytes;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_transcripts');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_turns');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_conversations');
  } finally { await cleanup.end().catch(() => {}); }
});

afterAll(async () => { if (container) await stopPostgresContainer(container); });

describe('conversations:drop-turn (TASK-75 — transcript-row rewrite)', () => {
  it('drops the line whose uuid matches turnId from the transcript rows', async () => {
    const h = await makeHarness();
    const lines = [
      jsonlLine({ uuid: 't1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'first' }] } }),
      jsonlLine({ uuid: 't2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'second' }] } }),
    ];
    const conv = await seedConversationWithTranscript(h, 'u1', 'sess_a', lines);

    await h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
      conversationId: conv, userId: 'u1', turnId: 't1',
    });

    const bytes = await getTranscriptBytes(h, 'u1', conv);
    expect(bytes).not.toContain('"uuid":"t1"');
    expect(bytes).toContain('"uuid":"t2"');
  });

  it('drops the assistant chunks sharing the dropped turn message.id', async () => {
    const h = await makeHarness();
    const lines = [
      jsonlLine({ uuid: 't1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'a' }] } }),
      jsonlLine({ uuid: 't1b', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'b' }] } }),
      jsonlLine({ uuid: 't2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'survivor' }] } }),
    ];
    const conv = await seedConversationWithTranscript(h, 'u1', 'sess_c', lines);

    await h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
      conversationId: conv, userId: 'u1', turnId: 't1',
    });

    const bytes = await getTranscriptBytes(h, 'u1', conv);
    // The whole coalesced model response (m1) is gone; the survivor stays.
    expect(bytes).not.toContain('"uuid":"t1"');
    expect(bytes).not.toContain('"uuid":"t1b"');
    expect(bytes).toContain('"uuid":"t2"');
  });

  it('drops the most recent turn when turnId is empty', async () => {
    const h = await makeHarness();
    const lines = [jsonlLine({ uuid: 't1' }), jsonlLine({ uuid: 't2' })];
    const conv = await seedConversationWithTranscript(h, 'u1', 'sess_b', lines);

    await h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
      conversationId: conv, userId: 'u1', turnId: '',
    });

    const bytes = await getTranscriptBytes(h, 'u1', conv);
    expect(bytes).toContain('"uuid":"t1"');
    expect(bytes).not.toContain('"uuid":"t2"');
  });

  it('round-trips the surviving rows byte-identically (no re-serialization)', async () => {
    const h = await makeHarness();
    // Distinct message.id per line so dropping t1 (m1) does NOT coalesce-drop
    // t2 — they are separate model responses.
    const line1 = jsonlLine({ uuid: 't1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'first' }] } });
    const line2 = jsonlLine({ uuid: 't2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'second' }] } });
    const conv = await seedConversationWithTranscript(h, 'u1', 'sess_d', [line1, line2]);

    await h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
      conversationId: conv, userId: 'u1', turnId: 't1',
    });

    // The survivor row is the verbatim seeded line + the SDK's trailing '\n'.
    const bytes = await getTranscriptBytes(h, 'u1', conv);
    expect(bytes).toBe(line2 + '\n');
  });

  it('is a no-op when the conversation has no runnerSessionId', async () => {
    const h = await makeHarness();
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create', h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'a1' },
    );
    // No store-runner-session call — drop-turn just returns. With no runner
    // session there is no resume transcript to rewrite.
    await h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId, userId: 'u1', turnId: 't1',
    });
    const bytes = await getTranscriptBytes(h, 'u1', conv.conversationId);
    expect(bytes).toBe('');
  });

  it('is a no-op when the transcript has no rows', async () => {
    const h = await makeHarness();
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create', h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'a1' },
    );
    await h.bus.call('conversations:store-runner-session', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId, runnerSessionId: 'sess_e',
    });
    // Bound session but the runner shipped no transcript yet — drop-turn must
    // not throw, just return.
    await h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId, userId: 'u1', turnId: 't1',
    });
    const bytes = await getTranscriptBytes(h, 'u1', conv.conversationId);
    expect(bytes).toBe('');
  });

  it('is a no-op (leaves the transcript intact) when turnId matches no line', async () => {
    const h = await makeHarness();
    const lines = [jsonlLine({ uuid: 't1' }), jsonlLine({ uuid: 't2' })];
    const conv = await seedConversationWithTranscript(h, 'u1', 'sess_f', lines);

    await h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
      conversationId: conv, userId: 'u1', turnId: 'no-such-uuid',
    });

    const bytes = await getTranscriptBytes(h, 'u1', conv);
    expect(bytes).toContain('"uuid":"t1"');
    expect(bytes).toContain('"uuid":"t2"');
  });

  it('throws not-found for an unknown conversation_id', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
        conversationId: 'cnv_missing', userId: 'u1', turnId: 't1',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
