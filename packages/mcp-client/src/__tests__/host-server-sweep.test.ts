// ---------------------------------------------------------------------------
// TASK-792 — boot sweep that retires stored host MCP server rows.
//
// Boots a real HookBus with an in-memory storage plugin (get/set/list-prefix/
// delete/delete-prefix) and a stub credentials store, then runs the sweep
// directly. Every `mcp-server:<id>` row goes (whatever it holds), each live
// row's `mcp:<id>:` credentials go with it, and the index goes last.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { HookBus, createLogger, makeAgentContext } from '@ax/core';
import { sweepHostMcpServers } from '../host-server-sweep.js';

const enc = new TextEncoder();

type Cred = { scope: 'global' | 'user' | 'agent'; ownerId: string | null; ref: string };

interface Setup {
  rows: Record<string, unknown>;
  creds?: Cred[];
  /** Register credentials:list / credentials:delete. Default true. */
  credentials?: boolean;
  /** `credentials:delete` throws for any ref starting with this. */
  deleteThrowsFor?: string;
  /** `credentials:list` throws. */
  listThrows?: boolean;
}

function setup(s: Setup) {
  const bus = new HookBus();
  const store = new Map<string, Uint8Array>(
    Object.entries(s.rows).map(([k, v]) => [
      k,
      typeof v === 'string' ? enc.encode(v) : v instanceof Uint8Array ? v : enc.encode(JSON.stringify(v)),
    ]),
  );
  const creds: Cred[] = [...(s.creds ?? [])];
  let listCalls = 0;

  bus.registerService<{ key: string }, { value: Uint8Array | undefined }>(
    'storage:get',
    'mem',
    async (_c, { key }) => ({ value: store.get(key) }),
  );
  bus.registerService<{ key: string; value: Uint8Array }, void>(
    'storage:set',
    'mem',
    async (_c, { key, value }) => {
      store.set(key, value);
    },
  );
  bus.registerService<{ prefix: string }, { entries: Array<{ key: string; value: Uint8Array }> }>(
    'storage:list-prefix',
    'mem',
    async (_c, { prefix }) => ({
      entries: [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    }),
  );
  bus.registerService<{ key: string }, { deleted: number }>(
    'storage:delete',
    'mem',
    async (_c, { key }) => ({ deleted: store.delete(key) ? 1 : 0 }),
  );
  bus.registerService<{ prefix: string }, { deleted: number }>(
    'storage:delete-prefix',
    'mem',
    async () => {
      throw new Error('the sweep must not use delete-prefix');
    },
  );

  if (s.credentials !== false) {
    bus.registerService<Record<string, never>, { credentials: Cred[] }>(
      'credentials:list',
      'creds',
      async () => {
        listCalls += 1;
        if (s.listThrows === true) throw new Error('vault down');
        return { credentials: creds.map((c) => ({ ...c })) };
      },
    );
    bus.registerService<Cred, void>('credentials:delete', 'creds', async (_c, c) => {
      if (s.deleteThrowsFor !== undefined && c.ref.startsWith(s.deleteThrowsFor)) {
        throw new Error('vault hiccup');
      }
      const i = creds.findIndex(
        (x) => x.scope === c.scope && x.ownerId === c.ownerId && x.ref === c.ref,
      );
      if (i >= 0) creds.splice(i, 1);
    });
  }

  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    reqId: 'req-test',
    writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const ctx = makeAgentContext({ sessionId: 'init', agentId: 'a', userId: 'init', logger });
  return {
    bus,
    ctx,
    store,
    creds,
    lines,
    listCalls: () => listCalls,
    run: () => sweepHostMcpServers(bus, ctx),
  };
}

const httpRow = (id: string) => ({
  id,
  enabled: true,
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  headers: { Authorization: { credentialRef: `mcp:${id}:header:Authorization` } },
});

describe('sweepHostMcpServers', () => {
  it('deletes every mcp-server:<id> row whatever it holds, plus the index', async () => {
    const t = setup({
      rows: {
        'mcp-server-index': ['remote', 'sse', 'local', 'junk', 'gone'],
        'mcp-server:remote': httpRow('remote'),
        'mcp-server:sse': { id: 'sse', enabled: false, transport: 'sse', url: 'https://x.test/sse' },
        'mcp-server:local': { id: 'local', enabled: true, transport: 'stdio', command: 'npx', args: [] },
        'mcp-server:junk': '{not json',
        'mcp-server:gone': new Uint8Array(0), // tombstone
        'mcp-server:orphan': httpRow('orphan'), // not in the index
      },
    });
    // Tombstones are removed but not counted.
    expect(await t.run()).toBe(5);
    expect([...t.store.keys()]).toEqual([]);
    expect(t.lines.filter((l) => l.msg === 'mcp_host_servers_swept')).toHaveLength(1);
    expect(t.lines.find((l) => l.msg === 'mcp_host_servers_swept')).toMatchObject({ count: 5 });
  });

  it("purges each server's mcp:<id>: credentials of any kind, and nothing else", async () => {
    const t = setup({
      rows: {
        'mcp-server-index': ['a'],
        'mcp-server:a': httpRow('a'),
      },
      creds: [
        { scope: 'global', ownerId: null, ref: 'mcp:a:header:Authorization' },
        { scope: 'user', ownerId: 'u1', ref: 'mcp:a:env:GH_TOKEN' },
        { scope: 'agent', ownerId: 'ag1', ref: 'mcp:a:header:X-Key' },
        // Another server whose id shares a prefix with `a`.
        { scope: 'global', ownerId: null, ref: 'mcp:ab:header:Z' },
        { scope: 'global', ownerId: null, ref: 'mcp:a' },
        { scope: 'agent', ownerId: 'ag1', ref: 'account:anthropic' },
        { scope: 'global', ownerId: null, ref: 'provider:openai:key' },
      ],
    });
    expect(await t.run()).toBe(1);
    expect(t.creds.map((c) => c.ref).sort()).toEqual([
      'account:anthropic',
      'mcp:a',
      'mcp:ab:header:Z',
      'provider:openai:key',
    ]);
  });

  it('lists credentials once for the whole sweep', async () => {
    const t = setup({
      rows: { 'mcp-server:a': httpRow('a'), 'mcp-server:b': httpRow('b'), 'mcp-server:c': httpRow('c') },
      creds: [
        { scope: 'global', ownerId: null, ref: 'mcp:a:header:Authorization' },
        { scope: 'global', ownerId: null, ref: 'mcp:c:header:Authorization' },
      ],
    });
    expect(await t.run()).toBe(3);
    expect(t.listCalls()).toBe(1);
    expect(t.creds).toEqual([]);
  });

  it('does not purge a tombstone (no credentials:list when nothing is live)', async () => {
    const t = setup({
      rows: { 'mcp-server:gone': new Uint8Array(0), 'mcp-server-index': [] },
      creds: [{ scope: 'global', ownerId: null, ref: 'mcp:gone:header:A' }],
    });
    expect(await t.run()).toBe(0);
    expect(t.store.size).toBe(0);
    expect(t.listCalls()).toBe(0);
    expect(t.creds).toHaveLength(1);
    // count 0 → quiet, even though a tombstone and the index were removed.
    expect(t.lines.filter((l) => l.msg === 'mcp_host_servers_swept')).toEqual([]);
  });

  it("deletes a row whose id contains ':' but never purges for it", async () => {
    const t = setup({
      rows: { 'mcp-server:a:header': httpRow('a:header') },
      creds: [{ scope: 'global', ownerId: null, ref: 'mcp:a:header:Authorization' }],
    });
    expect(await t.run()).toBe(1);
    expect(t.store.size).toBe(0);
    expect(t.creds).toHaveLength(1);
  });

  it('a failed purge keeps that row and the index for the next boot; others still go', async () => {
    const t = setup({
      rows: {
        'mcp-server-index': ['bad', 'good'],
        'mcp-server:bad': httpRow('bad'),
        'mcp-server:good': httpRow('good'),
      },
      creds: [
        { scope: 'global', ownerId: null, ref: 'mcp:bad:header:Authorization' },
        { scope: 'global', ownerId: null, ref: 'mcp:good:header:Authorization' },
      ],
      deleteThrowsFor: 'mcp:bad:',
    });
    expect(await t.run()).toBe(1);
    expect([...t.store.keys()].sort()).toEqual(['mcp-server-index', 'mcp-server:bad']);
    expect(t.creds.map((c) => c.ref)).toEqual(['mcp:bad:header:Authorization']);
    const warn = t.lines.find((l) => l.msg === 'mcp_host_server_sweep_purge_failed');
    expect(warn).toMatchObject({ serverId: 'bad' });
    expect(String(warn?.err)).toContain('vault hiccup');
  });

  it('a failed credentials:list keeps every live row and the index; tombstones still go', async () => {
    const t = setup({
      rows: {
        'mcp-server-index': ['a', 'b'],
        'mcp-server:a': httpRow('a'),
        'mcp-server:b': httpRow('b'),
        'mcp-server:gone': new Uint8Array(0),
      },
      listThrows: true,
    });
    expect(await t.run()).toBe(0);
    expect([...t.store.keys()].sort()).toEqual(['mcp-server-index', 'mcp-server:a', 'mcp-server:b']);
    expect(
      t.lines.filter((l) => l.msg === 'mcp_host_server_sweep_purge_failed').map((l) => l.serverId),
    ).toEqual(['a', 'b']);
    expect(t.lines.filter((l) => l.msg === 'mcp_host_servers_swept')).toEqual([]);
  });

  it('is idempotent: a second run removes nothing and logs nothing', async () => {
    const t = setup({
      rows: { 'mcp-server-index': ['a'], 'mcp-server:a': httpRow('a') },
      creds: [{ scope: 'global', ownerId: null, ref: 'mcp:a:header:Authorization' }],
    });
    expect(await t.run()).toBe(1);
    t.lines.length = 0;
    expect(await t.run()).toBe(0);
    expect(t.lines).toEqual([]);
  });

  it('still deletes rows when no credentials service is loaded', async () => {
    const t = setup({
      rows: { 'mcp-server-index': ['a'], 'mcp-server:a': httpRow('a') },
      credentials: false,
    });
    expect(await t.run()).toBe(1);
    expect(t.store.size).toBe(0);
  });

  it('leaves unrelated keys alone, including ones that merely share a prefix', async () => {
    const t = setup({
      rows: {
        'mcp-server:a': httpRow('a'),
        'mcp-server-indexx': 'keep',
        'mcp-servers:x': 'keep',
        'mcp-serverx': 'keep',
        'credentials:global:mcp:a:header:A': 'keep',
        'agents:a': 'keep',
      },
    });
    expect(await t.run()).toBe(1);
    expect([...t.store.keys()].sort()).toEqual([
      'agents:a',
      'credentials:global:mcp:a:header:A',
      'mcp-server-indexx',
      'mcp-servers:x',
      'mcp-serverx',
    ]);
  });

  it('an empty store is a quiet no-op', async () => {
    const t = setup({ rows: {} });
    expect(await t.run()).toBe(0);
    expect(t.lines).toEqual([]);
  });

  it('never logs a row value or a credential ref', async () => {
    const t = setup({
      rows: { 'mcp-server:a': { ...httpRow('a'), url: 'https://secret-host.test/?token=s3cret' } },
      creds: [{ scope: 'global', ownerId: null, ref: 'mcp:a:header:Authorization' }],
      deleteThrowsFor: 'mcp:a:',
    });
    await t.run();
    const all = JSON.stringify(t.lines);
    expect(all).not.toContain('s3cret');
    expect(all).not.toContain('mcp:a:header:Authorization');
  });
});
