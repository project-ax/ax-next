import { describe, it, expect } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import {
  INVENTORY_LIMITS,
  listServerTools,
  mapOutward,
  mapReadOnly,
  normalizeTools,
} from '../connector-inventory/list-tools.js';

// ---------------------------------------------------------------------------
// tools/list against a fake streamable-HTTP MCP server (a `baseFetch` that
// speaks just enough JSON-RPC), plus the pure annotation mapping.
// ---------------------------------------------------------------------------

describe('annotation mapping', () => {
  it.each([
    [{ readOnlyHint: true }, true],
    [{ readOnlyHint: false }, false],
    [{}, null],
    [undefined, null],
    [{ readOnlyHint: 'yes' }, null],
  ])('readOnly(%j) = %s', (ann, want) => {
    expect(mapReadOnly(ann)).toBe(want);
  });

  it.each([
    [{ destructiveHint: true }, true],
    [{ openWorldHint: true }, true],
    [{ destructiveHint: false, openWorldHint: true }, true],
    [{ destructiveHint: false, openWorldHint: false }, false],
    [{ destructiveHint: false }, null],
    [{ openWorldHint: false }, null],
    [{}, null],
    [undefined, null],
  ])('outward(%j) = %s', (ann, want) => {
    expect(mapOutward(ann)).toBe(want);
  });
});

describe('normalizeTools', () => {
  it('maps hints, falls back title→name, and strips control/bidi characters', () => {
    const { tools, dropped } = normalizeTools([
      {
        name: 'search',
        description: 'Find\u0007 things‮',
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      { name: 'send', title: 'Send it', annotations: { readOnlyHint: false, openWorldHint: true } },
      { name: 'bare' },
    ]);
    expect(dropped).toBe(0);
    expect(tools).toEqual([
      { name: 'search', title: 'search', description: 'Find things', readOnly: true, outward: false },
      { name: 'send', title: 'Send it', description: '', readOnly: false, outward: true },
      { name: 'bare', title: 'bare', description: '', readOnly: null, outward: null },
    ]);
  });

  it('uses annotations.title when there is no top-level title', () => {
    expect(normalizeTools([{ name: 'x', annotations: { title: 'Nice X' } }]).tools[0]!.title).toBe('Nice X');
  });

  it('drops malformed names, duplicates and anything past the count cap', () => {
    const raw = [
      { name: '' },
      { name: 'has space' },
      { name: 'x'.repeat(INVENTORY_LIMITS.maxNameLength + 1) },
      { name: 'ok' },
      { name: 'ok' },
      'not-an-object',
    ];
    const { tools, dropped } = normalizeTools(raw);
    expect(tools.map((t) => t.name)).toEqual(['ok']);
    expect(dropped).toBe(5);

    const many = Array.from({ length: INVENTORY_LIMITS.maxTools + 3 }, (_, i) => ({ name: `t${i}` }));
    const capped = normalizeTools(many);
    expect(capped.tools).toHaveLength(INVENTORY_LIMITS.maxTools);
    expect(capped.dropped).toBe(3);
  });

  it('caps description length', () => {
    const t = normalizeTools([{ name: 'x', description: 'd'.repeat(10_000) }]).tools[0]!;
    expect(t.description.length).toBe(INVENTORY_LIMITS.maxDescriptionLength);
  });
});

// --- fake MCP server -------------------------------------------------------

interface FakeServerOpts {
  pages?: unknown[][];
  status?: number;
  toolsListBody?: (id: unknown) => string;
}

function fakeMcpServer(opts: FakeServerOpts = {}) {
  const requests: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  const pages = opts.pages ?? [[]];
  const baseFetch = async (url: string, init: Record<string, unknown>): Promise<Response> => {
    const method = String(init.method ?? 'GET');
    const headers = new Headers(init.headers as HeadersInit);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, headers, body });
    if (opts.status !== undefined) return new Response('nope', { status: opts.status });
    if (method !== 'POST') return new Response(null, { status: 405 });
    const msg = body as { id?: unknown; method: string; params?: { cursor?: string } };
    const json = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), {
        headers: { 'content-type': 'application/json' },
      });
    switch (msg.method) {
      case 'initialize':
        return json({
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake', version: '1' },
        });
      case 'notifications/initialized':
        return new Response(null, { status: 202 });
      case 'tools/list': {
        if (opts.toolsListBody !== undefined) {
          return new Response(opts.toolsListBody(msg.id), { headers: { 'content-type': 'application/json' } });
        }
        const idx = msg.params?.cursor !== undefined ? Number(msg.params.cursor) : 0;
        const next = idx + 1 < pages.length ? String(idx + 1) : undefined;
        return json({ tools: pages[idx], ...(next !== undefined ? { nextCursor: next } : {}) });
      }
      default:
        return json({});
    }
  };
  return { baseFetch, requests };
}

const URL_OK = 'https://mcp.example.com/mcp';

describe('listServerTools', () => {
  it('pages through tools/list, sends the auth headers, and maps annotations', async () => {
    const server = fakeMcpServer({
      pages: [
        [{ name: 'a', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
        [{ name: 'b', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } }],
      ],
    });
    const out = await listServerTools({
      url: URL_OK,
      headers: { Authorization: 'Bearer secret-token' },
      baseFetch: server.baseFetch,
    });
    expect(out).toEqual({
      kind: 'ok',
      dropped: 0,
      tools: [
        { name: 'a', title: 'a', description: '', readOnly: true, outward: null },
        { name: 'b', title: 'b', description: '', readOnly: null, outward: true },
      ],
    });
    const posts = server.requests.filter((r) => r.method === 'POST');
    expect(posts.every((r) => r.headers.get('authorization') === 'Bearer secret-token')).toBe(true);
    expect(posts.filter((r) => (r.body as { method: string }).method === 'tools/list')).toHaveLength(2);
  });

  it('stops at the page cap even if the server keeps handing out cursors', async () => {
    const server = fakeMcpServer({
      pages: Array.from({ length: 50 }, (_, i) => [{ name: `t${i}`, inputSchema: { type: 'object' } }]),
    });
    const out = await listServerTools({ url: URL_OK, headers: {}, baseFetch: server.baseFetch, limits: { maxPages: 3 } });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.tools).toHaveLength(3);
  });

  it.each([401, 403])('maps HTTP %s to needs-auth', async (status) => {
    const server = fakeMcpServer({ status });
    expect(await listServerTools({ url: URL_OK, headers: {}, baseFetch: server.baseFetch })).toEqual({
      kind: 'needs-auth',
    });
  });

  it('maps a 500 to unreachable', async () => {
    const server = fakeMcpServer({ status: 500 });
    expect(await listServerTools({ url: URL_OK, headers: {}, baseFetch: server.baseFetch })).toEqual({
      kind: 'unreachable',
      reason: 'http-500',
    });
  });

  it('rejects an oversize tools/list response', async () => {
    const huge = (id: unknown) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { tools: [{ name: 'x', description: 'y'.repeat(5_000), inputSchema: { type: 'object' } }] },
      });
    const server = fakeMcpServer({ toolsListBody: huge });
    const out = await listServerTools({
      url: URL_OK,
      headers: {},
      baseFetch: server.baseFetch,
      limits: { maxResponseBytes: 1_000 },
    });
    expect(out).toEqual({ kind: 'unreachable', reason: 'response-too-large' });
  });

  it.each(['http://mcp.example.com/mcp', 'https://10.0.0.1/mcp', 'https://169.254.169.254/'])(
    'refuses SSRF-shaped url %s without making a request',
    async (url) => {
      const server = fakeMcpServer();
      expect(await listServerTools({ url, headers: {}, baseFetch: server.baseFetch })).toEqual({
        kind: 'unreachable',
        reason: 'blocked',
      });
      expect(server.requests).toHaveLength(0);
    },
  );

  it('refuses a hostname that resolves to a private address (real dispatcher path)', async () => {
    const out = await listServerTools({
      url: 'https://internal.example.test/mcp',
      headers: {},
      resolver: async () => [{ address: '10.0.0.5', family: 4 }],
    });
    expect(out).toEqual({ kind: 'unreachable', reason: 'blocked' });
  });
});
