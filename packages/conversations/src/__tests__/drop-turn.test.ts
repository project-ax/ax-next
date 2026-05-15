import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type { CreateInput, CreateOutput } from '../types.js';

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

async function makeHarnessWithWorkspace(workspaceData: Map<string, Uint8Array>) {
  let lastApplied: { changes: Array<{ path: string; kind: string; content?: Uint8Array }> } | undefined;
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_c, input: unknown) => ({
        agent: { id: (input as { agentId: string }).agentId, visibility: 'personal' },
      }),
      'workspace:list': async (_c, input: unknown) => {
        const glob = (input as { pathGlob: string }).pathGlob;
        const slug = /\/([^/]+)\.jsonl$/.exec(glob)?.[1] ?? '';
        const path = `.claude/projects/proj/${slug}.jsonl`;
        return { paths: workspaceData.has(path) ? [path] : [] };
      },
      'workspace:read': async (_c, input: unknown) => {
        const path = (input as { path: string }).path;
        const bytes = workspaceData.get(path);
        return bytes === undefined ? { found: false } as const : { found: true, bytes, version: 'v1' };
      },
      'workspace:apply': async (_c, input: unknown) => {
        lastApplied = input as never;
        const changes = (input as { changes: Array<{ path: string; kind: string; content?: Uint8Array }> }).changes;
        for (const c of changes) if (c.kind === 'put' && c.content !== undefined) workspaceData.set(c.path, c.content);
        return { version: 'v2', delta: { before: 'v1', after: 'v2', changes: [] } };
      },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(),
    ],
  });
  harnesses.push(h);
  return { h, getLastApplied: () => lastApplied };
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
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_turns');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_conversations');
  } finally { await cleanup.end().catch(() => {}); }
});

afterAll(async () => { if (container) await container.stop(); });

describe('conversations:drop-turn (Phase B — runner-native jsonl rewrite)', () => {
  it('drops the line whose uuid matches turnId', async () => {
    const data = new Map<string, Uint8Array>();
    const lines = [
      jsonlLine({ uuid: 't1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'first' }] } }),
      jsonlLine({ uuid: 't2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'second' }] } }),
    ];
    data.set('.claude/projects/proj/sess_a.jsonl', new TextEncoder().encode(lines.join('\n') + '\n'));

    const { h, getLastApplied } = await makeHarnessWithWorkspace(data);
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create', h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'a1' },
    );
    await h.bus.call('conversations:store-runner-session', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId, runnerSessionId: 'sess_a',
    });

    await h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId, userId: 'u1', turnId: 't1',
    });

    const applied = getLastApplied();
    if (applied === undefined) throw new Error('expected workspace:apply call');
    const written = new TextDecoder().decode(applied.changes[0]!.content);
    expect(written).not.toContain('t1');
    expect(written).toContain('t2');
  });

  it('drops the most recent turn when turnId is empty', async () => {
    const data = new Map<string, Uint8Array>();
    const lines = [
      jsonlLine({ uuid: 't1' }),
      jsonlLine({ uuid: 't2' }),
    ];
    data.set('.claude/projects/proj/sess_b.jsonl', new TextEncoder().encode(lines.join('\n') + '\n'));

    const { h, getLastApplied } = await makeHarnessWithWorkspace(data);
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create', h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'a1' },
    );
    await h.bus.call('conversations:store-runner-session', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId, runnerSessionId: 'sess_b',
    });

    await h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId, userId: 'u1', turnId: '',
    });
    const applied = getLastApplied();
    if (applied === undefined) throw new Error('expected workspace:apply call');
    const written = new TextDecoder().decode(applied.changes[0]!.content);
    expect(written).toContain('t1');
    expect(written).not.toContain('t2');
  });

  it('is a no-op when the conversation has no runnerSessionId', async () => {
    const data = new Map<string, Uint8Array>();
    const { h } = await makeHarnessWithWorkspace(data);
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create', h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'a1' },
    );
    // No store-runner-session call — drop-turn just returns.
    await h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId, userId: 'u1', turnId: 't1',
    });
  });

  it('throws not-found for an unknown conversation_id', async () => {
    const data = new Map<string, Uint8Array>();
    const { h } = await makeHarnessWithWorkspace(data);
    await expect(
      h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
        conversationId: 'cnv_missing', userId: 'u1', turnId: 't1',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
