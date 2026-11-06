/** Artifact cards in the chat thread (agent artifacts, Task 13). */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  let stored: Map<string, Record<string, unknown>>;
  let getFault: PluginError | null = null;
  let listFault: PluginError | null = null;
  let listCalls = 0;
  let getCalls = 0;
  // Ids the list leaves out, as if past its 1000-row cap.
  let pastListCap: Set<string>;

  beforeEach(() => {
    bus = new HookBus();
    turns = [];
    getFault = null;
    listFault = null;
    listCalls = 0;
    getCalls = 0;
    pastListCap = new Set();
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
    stored = new Map([
      [ID1, { artifactId: ID1, agentId: 'a1', title: 'Q3 report', kind: 'document', extension: 'PDF', currentVersion: 1 }],
      [ID2, { artifactId: ID2, agentId: 'a1', title: 'Other', kind: 'document', extension: 'PDF', currentVersion: 1 }],
    ]);
    bus.registerService('artifacts:list', 'artifacts', async (_c, i: unknown) => {
      listCalls++;
      if (listFault !== null) throw listFault;
      const agentId = (i as { agentId: string }).agentId;
      return {
        artifacts: [...stored.values()].filter((a) => a['agentId'] === agentId && !pastListCap.has(a['artifactId'] as string)),
      };
    });
    bus.registerService('artifacts:get', 'artifacts', async (_c, i: unknown) => {
      getCalls++;
      if (getFault !== null) throw getFault;
      const a = stored.get((i as { artifactId: string }).artifactId);
      if (a === undefined) throw new PluginError({ code: 'not-found', plugin: 'artifacts', message: 'nope' });
      return { artifact: a };
    });
    bus.registerService('conversations:list', 'conversations', async () => [row]);
    bus.registerService('conversations:get', 'conversations', async () => {
      if (row === undefined) throw new PluginError({ code: 'not-found', plugin: 'x', message: 'x' });
      return { conversation: row, turns, displayEvents: [] };
    });
  });

  async function thread(
    results: unknown[],
    ctx: AgentContext = initCtx,
    toolName = 'artifact_publish',
  ): Promise<Array<Record<string, unknown>>> {
    turns = [
      { turnId: 't1', turnIndex: 0, role: 'user', contentBlocks: [{ type: 'text', text: 'go' }], createdAt: '2026-08-01T10:00:00.000Z' },
      {
        turnId: 't2', turnIndex: 1, role: 'assistant', createdAt: '2026-08-01T10:00:01.000Z',
        contentBlocks: results.map((_, i) => ({ type: 'tool_use', id: `p${i}`, name: toolName, input: {} })),
      },
      {
        turnId: 't3', turnIndex: 2, role: 'tool', createdAt: '2026-08-01T10:00:02.000Z',
        contentBlocks: results.map((r, i) => ({ type: 'tool_result', tool_use_id: `p${i}`, content: JSON.stringify(r) })),
      },
    ];
    const h = makeWorkspaceHandlers({ bus, initCtx: ctx });
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

  // U1: a show_visual chart is shown by its own chart card, never as an
  // artifact card, and the store is not even asked about it.
  it('a show_visual result makes no artifact card and no store read', async () => {
    const t = await thread([{ artifactId: ID1, title: 'Issues per cycle', summary: 'Down 12%.' }], initCtx, 'show_visual');
    expect(t.some((m) => m['artifacts'] !== undefined)).toBe(false);
    expect(listCalls + getCalls).toBe(0);
  });

  // U1: the store hides a chat visual (list leaves it out, get is not-found),
  // so even a forged publish result naming one shows no card.
  it('a publish result naming a chat visual shows no card', async () => {
    stored.delete(ID1);
    const t = await thread([published()]);
    expect(t.some((m) => m['artifacts'] !== undefined)).toBe(false);
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

  it('two publishes of one artifact in a turn show one card at the stored current version', async () => {
    stored.set(ID1, { ...stored.get(ID1), currentVersion: 3 });
    const t = await thread([published({ version: 3 }), published({ version: 2 }), published({ artifactId: ID2, title: 'Other' })]);
    const cards = t.find((m) => m['artifacts'] !== undefined)!['artifacts'] as Array<{ artifactId: string; version: number }>;
    expect(cards.map((c) => [c.artifactId, c.version])).toStrictEqual([[ID1, 3], [ID2, 1]]);
  });

  it('a forged title, kind and version are replaced by the stored artifact', async () => {
    const t = await thread([published({ title: 'Payroll (private)', kind: 'image', extension: 'PNG', version: 9 })]);
    const cards = t.find((m) => m['artifacts'] !== undefined)!['artifacts'];
    expect(cards).toStrictEqual([
      { artifactId: ID1, version: 1, title: 'Q3 report', kind: 'document', extension: 'PDF' },
    ]);
  });

  it('a list refusal (not a member) shows no cards and is not an outage', async () => {
    listFault = new PluginError({ code: 'not-found', plugin: 'artifacts', message: 'nope' });
    const t = await thread([published()]);
    expect(t.some((m) => m['artifacts'] !== undefined)).toBe(false);
    expect(getCalls).toBe(0);
  });

  it('an unknown or foreign artifact id is dropped, with no chip either', async () => {
    stored.set(ID2, { ...stored.get(ID2), agentId: 'someone-elses-agent' });
    const t = await thread([published({ artifactId: ID2 }), published({ artifactId: 'ffffffffffffffffffffffffffffffff' })]);
    expect(t.some((m) => m['artifacts'] !== undefined)).toBe(false);
    expect(t.flatMap((m) => (m['attachments'] as unknown[] | undefined) ?? [])).toStrictEqual([]);
  });

  it('a hook outage omits the cards rather than trusting the tool text', async () => {
    // The list is the first read; the fallback get's own outage is pinned below.
    listFault = new PluginError({ code: 'unavailable', plugin: 'artifacts', message: 'db down' });
    const t = await thread([published()]);
    expect(t.some((m) => m['artifacts'] !== undefined)).toBe(false);
    expect(t.flatMap((m) => (m['attachments'] as unknown[] | undefined) ?? [])).toStrictEqual([]);
  });

  it('reads the store with one list call when every claimed id is in it', async () => {
    const t = await thread([published(), published({ artifactId: ID2, title: 'Other' })]);
    expect(t.find((m) => m['artifacts'] !== undefined)!['artifacts']).toHaveLength(2);
    expect(listCalls).toBe(1);
    expect(getCalls).toBe(0);
  });

  it('an artifact past the list cap is still verified, by one get', async () => {
    pastListCap.add(ID2);
    const t = await thread([published(), published({ artifactId: ID2, title: 'Other' })]);
    const cards = t.find((m) => m['artifacts'] !== undefined)!['artifacts'] as Array<{ artifactId: string }>;
    expect(cards.map((c) => c.artifactId)).toStrictEqual([ID1, ID2]);
    expect(listCalls).toBe(1);
    expect(getCalls).toBe(1);
  });

  it('100 claimed ids cost at most 1 list and 20 gets', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => i.toString(16).padStart(32, '0'));
    await thread(ids.map((artifactId) => published({ artifactId })));
    expect(listCalls).toBeLessThanOrEqual(1);
    expect(getCalls).toBeLessThanOrEqual(20);
  });

  it('a list outage omits the cards, with one code-only log line', async () => {
    const ctx = makeAgentContext({ sessionId: 'init', agentId: '@ax/channel-web', userId: 'system' });
    const warn = vi.spyOn(ctx.logger, 'warn');
    listFault = new PluginError({ code: 'unavailable', plugin: 'artifacts', message: 'db down' });
    const t = await thread([published(), published({ artifactId: ID2 })], ctx);
    expect(t.some((m) => m['artifacts'] !== undefined)).toBe(false);
    const lines = warn.mock.calls.filter((c) => c[0] === 'workspace_artifact_cards_unverified');
    expect(lines).toStrictEqual([['workspace_artifact_cards_unverified', { code: 'unavailable' }]]);
  });

  it('several failing fallback gets log once for the thread, not once per id', async () => {
    const ctx = makeAgentContext({ sessionId: 'init', agentId: '@ax/channel-web', userId: 'system' });
    const warn = vi.spyOn(ctx.logger, 'warn');
    pastListCap = new Set([ID1, ID2]);
    getFault = new PluginError({ code: 'unavailable', plugin: 'artifacts', message: 'db down' });
    const t = await thread([published(), published({ artifactId: ID2 })], ctx);
    expect(t.some((m) => m['artifacts'] !== undefined)).toBe(false);
    expect(getCalls).toBe(2);
    expect(warn.mock.calls.filter((c) => c[0] === 'workspace_artifact_cards_unverified')).toHaveLength(1);
  });
});
