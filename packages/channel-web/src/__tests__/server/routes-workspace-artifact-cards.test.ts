/** Artifact cards in the chat thread (agent artifacts, Task 13). */
import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { makeWorkspaceHandlers } from '../../server/routes-workspace.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

const ID1 = '0123456789abcdef0123456789abcdef';
const ID2 = 'fedcba9876543210fedcba9876543210';

function mkReq(params: Record<string, string>): RouteRequest {
  return { headers: {}, body: Buffer.alloc(0), cookies: {}, query: {}, params, signedCookie: () => null };
}
function mkRes(): { res: RouteResponse; captured: { body: unknown } } {
  const captured = { body: undefined as unknown };
  const res: RouteResponse = {
    status() { return res; },
    json(v: unknown) { captured.body = v; },
    text() {}, end() {},
  };
  return { res, captured };
}
const initCtx: AgentContext = makeAgentContext({ sessionId: 'init', agentId: '@ax/channel-web', userId: 'system' });

const published = (over: Record<string, unknown> = {}) => ({
  artifactId: ID1, version: 1, title: 'Q3 report', kind: 'document', extension: 'PDF',
  downloadUrl: `ax://artifact/${ID1}`, displayName: 'q3.pdf', mediaType: 'application/pdf',
  sizeBytes: 10, sha256: 'a'.repeat(64), path: 'q3.pdf', ...over,
});

describe('artifact cards in buildThread', () => {
  let bus: HookBus;
  let turns: unknown[];

  beforeEach(() => {
    bus = new HookBus();
    turns = [];
    bus.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u1', isAdmin: false } }));
    bus.registerService('agents:list-for-user', 'agents', async () => ({
      agents: [{ id: 'a1', displayName: 'Inbox', visibility: 'personal' }],
    }));
    bus.registerService('agents:resolve', 'agents', async () => ({
      agent: { id: 'a1', displayName: 'Inbox', visibility: 'personal' },
    }));
    const row = {
      conversationId: 'c1', userId: 'u1', agentId: 'a1', title: null, activeSessionId: null,
      activeReqId: null, createdAt: '2026-08-01T10:00:00.000Z', lastActivityAt: null,
    };
    bus.registerService('conversations:list', 'conversations', async () => [row]);
    bus.registerService('conversations:get', 'conversations', async () => {
      if (row === undefined) throw new PluginError({ code: 'not-found', plugin: 'x', message: 'x' });
      return { conversation: row, turns, displayEvents: [] };
    });
  });

  async function thread(results: unknown[]): Promise<Array<Record<string, unknown>>> {
    turns = [
      { turnId: 't1', turnIndex: 0, role: 'user', contentBlocks: [{ type: 'text', text: 'go' }], createdAt: '2026-08-01T10:00:00.000Z' },
      {
        turnId: 't2', turnIndex: 1, role: 'assistant', createdAt: '2026-08-01T10:00:01.000Z',
        contentBlocks: results.map((_, i) => ({ type: 'tool_use', id: `p${i}`, name: 'artifact_publish', input: {} })),
      },
      {
        turnId: 't3', turnIndex: 2, role: 'tool', createdAt: '2026-08-01T10:00:02.000Z',
        contentBlocks: results.map((r, i) => ({ type: 'tool_result', tool_use_id: `p${i}`, content: JSON.stringify(r) })),
      },
    ];
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await h.agentDetail(mkReq({ agentId: 'a1' }), res);
    return (captured.body as { thread: Array<Record<string, unknown>> }).thread;
  }

  it('a publish result with a version becomes an artifact card and no download chip', async () => {
    const t = await thread([published()]);
    const msg = t.find((m) => m['artifacts'] !== undefined)!;
    expect(msg['artifacts']).toStrictEqual([
      { artifactId: ID1, version: 1, title: 'Q3 report', kind: 'document', extension: 'PDF' },
    ]);
    expect(t.flatMap((m) => (m['attachments'] as unknown[] | undefined) ?? [])).toStrictEqual([]);
  });

  it('a legacy publish result without a version still becomes a download chip', async () => {
    const legacy = published();
    delete (legacy as Record<string, unknown>)['version'];
    const t = await thread([legacy]);
    expect(t.some((m) => m['artifacts'] !== undefined)).toBe(false);
    expect(t.flatMap((m) => (m['attachments'] as unknown[] | undefined) ?? [])).toHaveLength(1);
  });

  it('a title with a newline renders as one fenced line', async () => {
    const t = await thread([published({ title: 'Q3\nreport‮' })]);
    const a = (t.find((m) => m['artifacts'] !== undefined)!['artifacts'] as Array<{ title: string }>)[0]!;
    expect(a.title).toBe('Q3 report');
  });

  it('two publishes of one artifact in a turn show one card at the higher version', async () => {
    const t = await thread([published({ version: 3 }), published({ version: 2 }), published({ artifactId: ID2, title: 'Other' })]);
    const cards = t.find((m) => m['artifacts'] !== undefined)!['artifacts'] as Array<{ artifactId: string; version: number }>;
    expect(cards.map((c) => [c.artifactId, c.version])).toStrictEqual([[ID1, 3], [ID2, 1]]);
  });
});
