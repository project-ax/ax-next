import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createLogger, makeAgentContext, type AgentContext } from '@ax/core';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type {
  AppendEventInput,
  AppendEventOutput,
  AppendTranscriptInput,
  AppendTranscriptOutput,
  CreateInput,
  CreateOutput,
  GetTranscriptInput,
  GetTranscriptOutput,
  ReplaceTranscriptInput,
  ReplaceTranscriptOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// TASK-67 — resume transcript hooks + B3 divergence detector (Part B / B2 / B3).
//
// Drives the @ax/conversations plugin against a real Postgres testcontainer:
//   - the delta-ship append/resync verdict (prefixHash + fromSeq guard);
//   - replace + get round-trip the jsonl byte-identically;
//   - the B3 structural detector fires loudly on a simulated OMISSION and stays
//     quiet across the normal / lagging / resync sequences.
// ---------------------------------------------------------------------------

const USER_ID = 'u-tx';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

// Captured structured-log records so we can assert on the B3 detector firing.
let logRecords: Array<{ msg: string; rec: Record<string, unknown> }> = [];

function capturingCtx(h: TestHarness, userId: string): AgentContext {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId,
    logger: createLogger({
      reqId: 'tx-test',
      writer: (line: string) => {
        try {
          const rec = JSON.parse(line) as Record<string, unknown>;
          logRecords.push({ msg: String(rec.msg ?? ''), rec });
        } catch {
          /* ignore non-JSON */
        }
      },
    }),
  });
}

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_ctx, input: unknown) => {
        const call = input as { agentId: string };
        return { agent: { id: call.agentId, visibility: 'personal' } };
      },
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

function emptyHash(): string {
  return createHash('sha256').digest('hex');
}

function prefixHashOf(lines: string[]): string {
  const h = createHash('sha256');
  for (const l of lines) {
    h.update(l);
    h.update('\n');
  }
  return h.digest('hex');
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  logRecords = [];
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const USER = '{"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}';
const ASSISTANT =
  '{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"yo"}]}}';
const ASSISTANT2 =
  '{"type":"assistant","uuid":"a2","message":{"role":"assistant","content":[{"type":"text","text":"more"}]}}';

describe('conversations transcript hooks (TASK-67)', () => {
  it('appends on a matching prefixHash + fromSeq', async () => {
    const h = await makeHarness();
    const conv = await createConv(h, USER_ID);

    const out = await h.bus.call<AppendTranscriptInput, AppendTranscriptOutput>(
      'conversations:append-transcript',
      h.ctx({ userId: USER_ID }),
      { conversationId: conv, fromSeq: 0, prefixHash: emptyHash(), lines: [USER, ASSISTANT] },
    );
    expect(out).toEqual({ outcome: 'appended', maxSeq: 2 });

    const got = await h.bus.call<GetTranscriptInput, GetTranscriptOutput>(
      'conversations:get-transcript',
      h.ctx({ userId: USER_ID }),
      { conversationId: conv },
    );
    expect(got.bytes).toBe([USER, ASSISTANT].map((l) => l + '\n').join(''));
    expect(got.maxSeq).toBe(2);
  });

  it('returns resync-required when the prefixHash diverges (SDK rewrote bytes)', async () => {
    const h = await makeHarness();
    const conv = await createConv(h, USER_ID);
    await h.bus.call<AppendTranscriptInput, AppendTranscriptOutput>(
      'conversations:append-transcript',
      h.ctx({ userId: USER_ID }),
      { conversationId: conv, fromSeq: 0, prefixHash: emptyHash(), lines: [USER] },
    );

    // fromSeq matches (1) but prefixHash is wrong → the earlier byte was rewritten.
    const out = await h.bus.call<AppendTranscriptInput, AppendTranscriptOutput>(
      'conversations:append-transcript',
      h.ctx({ userId: USER_ID }),
      { conversationId: conv, fromSeq: 1, prefixHash: 'deadbeef', lines: [ASSISTANT] },
    );
    expect(out.outcome).toBe('resync-required');
    expect(out.maxSeq).toBe(1); // nothing appended

    // Resync re-ships the whole file.
    const replaced = await h.bus.call<
      ReplaceTranscriptInput,
      ReplaceTranscriptOutput
    >('conversations:replace-transcript', h.ctx({ userId: USER_ID }), {
      conversationId: conv,
      lines: [USER, ASSISTANT, ASSISTANT2],
    });
    expect(replaced.maxSeq).toBe(3);
    const got = await h.bus.call<GetTranscriptInput, GetTranscriptOutput>(
      'conversations:get-transcript',
      h.ctx({ userId: USER_ID }),
      { conversationId: conv },
    );
    expect(got.bytes).toBe([USER, ASSISTANT, ASSISTANT2].map((l) => l + '\n').join(''));
  });

  it('treats an empty-lines append as a prefix-integrity probe (appended on match, no insert)', async () => {
    const h = await makeHarness();
    const conv = await createConv(h, USER_ID);
    await h.bus.call<AppendTranscriptInput, AppendTranscriptOutput>(
      'conversations:append-transcript',
      h.ctx({ userId: USER_ID }),
      { conversationId: conv, fromSeq: 0, prefixHash: emptyHash(), lines: [USER, ASSISTANT] },
    );
    // Empty-lines probe with the CORRECT prefix → appended, nothing inserted.
    const probe = await h.bus.call<AppendTranscriptInput, AppendTranscriptOutput>(
      'conversations:append-transcript',
      h.ctx({ userId: USER_ID }),
      { conversationId: conv, fromSeq: 2, prefixHash: prefixHashOf([USER, ASSISTANT]), lines: [] },
    );
    expect(probe).toEqual({ outcome: 'appended', maxSeq: 2 });
    // Empty-lines probe with a WRONG prefix → resync-required (the SDK rewrote
    // an earlier line in place).
    const stale = await h.bus.call<AppendTranscriptInput, AppendTranscriptOutput>(
      'conversations:append-transcript',
      h.ctx({ userId: USER_ID }),
      { conversationId: conv, fromSeq: 2, prefixHash: 'deadbeef', lines: [] },
    );
    expect(stale.outcome).toBe('resync-required');
  });

  it('returns resync-required when fromSeq is stale', async () => {
    const h = await makeHarness();
    const conv = await createConv(h, USER_ID);
    await h.bus.call<AppendTranscriptInput, AppendTranscriptOutput>(
      'conversations:append-transcript',
      h.ctx({ userId: USER_ID }),
      { conversationId: conv, fromSeq: 0, prefixHash: emptyHash(), lines: [USER, ASSISTANT] },
    );
    const out = await h.bus.call<AppendTranscriptInput, AppendTranscriptOutput>(
      'conversations:append-transcript',
      h.ctx({ userId: USER_ID }),
      { conversationId: conv, fromSeq: 1, prefixHash: prefixHashOf([USER]), lines: [ASSISTANT2] },
    );
    expect(out.outcome).toBe('resync-required');
  });

  it('B3 detector STAYS QUIET across a normal aligned display/resume sequence', async () => {
    const h = await makeHarness();
    const conv = await createConv(h, USER_ID);
    const ctx = capturingCtx(h, USER_ID);

    // Display log: user, assistant turns (the host emits these via append-event).
    await h.bus.call<AppendEventInput, AppendEventOutput>(
      'conversations:append-event',
      ctx,
      { conversationId: conv, kind: 'turn', role: 'user', payload: { blocks: [] } },
    );
    await h.bus.call<AppendEventInput, AppendEventOutput>(
      'conversations:append-event',
      ctx,
      { conversationId: conv, kind: 'turn', role: 'assistant', payload: { blocks: [] } },
    );
    // Resume rows: matching roles. Append triggers the detector.
    await h.bus.call<AppendTranscriptInput, AppendTranscriptOutput>(
      'conversations:append-transcript',
      ctx,
      { conversationId: conv, fromSeq: 0, prefixHash: emptyHash(), lines: [USER, ASSISTANT] },
    );

    expect(
      logRecords.find((r) => r.msg === 'transcript_display_divergence'),
    ).toBeUndefined();
  });

  it('B3 detector STAYS QUIET when one store lags (length differs, prefix aligns)', async () => {
    const h = await makeHarness();
    const conv = await createConv(h, USER_ID);
    const ctx = capturingCtx(h, USER_ID);

    // Display has only the user turn so far; resume already has user + assistant.
    await h.bus.call<AppendEventInput, AppendEventOutput>(
      'conversations:append-event',
      ctx,
      { conversationId: conv, kind: 'turn', role: 'user', payload: { blocks: [] } },
    );
    await h.bus.call<AppendTranscriptInput, AppendTranscriptOutput>(
      'conversations:append-transcript',
      ctx,
      { conversationId: conv, fromSeq: 0, prefixHash: emptyHash(), lines: [USER, ASSISTANT] },
    );

    expect(
      logRecords.find((r) => r.msg === 'transcript_display_divergence'),
    ).toBeUndefined();
  });

  it('B3 detector FIRES LOUDLY on a simulated omission (display dropped the user turn)', async () => {
    const h = await makeHarness();
    const conv = await createConv(h, USER_ID);
    const ctx = capturingCtx(h, USER_ID);

    // Display log starts with an ASSISTANT turn (the user turn was OMITTED).
    await h.bus.call<AppendEventInput, AppendEventOutput>(
      'conversations:append-event',
      ctx,
      { conversationId: conv, kind: 'turn', role: 'assistant', payload: { blocks: [] } },
    );
    // Resume rows start with the user turn → prefix position 0 diverges.
    await h.bus.call<AppendTranscriptInput, AppendTranscriptOutput>(
      'conversations:append-transcript',
      ctx,
      { conversationId: conv, fromSeq: 0, prefixHash: emptyHash(), lines: [USER, ASSISTANT] },
    );

    const fired = logRecords.find(
      (r) => r.msg === 'transcript_display_divergence',
    );
    expect(fired).toBeDefined();
    expect(fired!.rec.position).toBe(0);
    expect(fired!.rec.displayRole).toBe('assistant');
    expect(fired!.rec.resumeRole).toBe('user');
    // TASK-85: the divergence alarm is logged at WARN, not ERROR. It is
    // alarm-only (never throws, TASK-67/B3); a benign by-design resume must not
    // surface an ERROR-level record.
    expect(fired!.rec.level).toBe('warn');
  });

  it('B3 detector collapses consecutive same-role runs (intermediate assistant lines are not omissions)', async () => {
    const h = await makeHarness();
    const conv = await createConv(h, USER_ID);
    const ctx = capturingCtx(h, USER_ID);

    // Display: user, assistant (one folded turn).
    await h.bus.call<AppendEventInput, AppendEventOutput>(
      'conversations:append-event',
      ctx,
      { conversationId: conv, kind: 'turn', role: 'user', payload: { blocks: [] } },
    );
    await h.bus.call<AppendEventInput, AppendEventOutput>(
      'conversations:append-event',
      ctx,
      { conversationId: conv, kind: 'turn', role: 'assistant', payload: { blocks: [] } },
    );
    // Resume: user, assistant, assistant (SDK wrote an intermediate tool_use line
    // + the final reply — two assistant rows). Collapsed they are one run, so NO
    // divergence.
    await h.bus.call<AppendTranscriptInput, AppendTranscriptOutput>(
      'conversations:append-transcript',
      ctx,
      {
        conversationId: conv,
        fromSeq: 0,
        prefixHash: emptyHash(),
        lines: [USER, ASSISTANT, ASSISTANT2],
      },
    );

    expect(
      logRecords.find((r) => r.msg === 'transcript_display_divergence'),
    ).toBeUndefined();
  });
});
