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
      { name: 'search', title: 'search', description: 'Find things', readOnly: true, outward: false, inputSchema: null },
      { name: 'send', title: 'Send it', description: '', readOnly: false, outward: true, inputSchema: null },
      { name: 'bare', title: 'bare', description: '', readOnly: null, outward: null, inputSchema: null },
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

  it('keeps a tool\'s inputSchema as the server sent it', () => {
    const schema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
    const { tools } = normalizeTools([{ name: 'get', inputSchema: schema }]);
    expect(tools[0]!.inputSchema).toEqual(schema);
  });

  it('a schema that is not a plain object is null', () => {
    const { tools, dropped } = normalizeTools([
      { name: 'arr', inputSchema: [] },
      { name: 'str', inputSchema: 'x' },
      { name: 'nul', inputSchema: null },
      { name: 'num', inputSchema: 7 },
      { name: 'absent' },
    ]);
    expect(dropped).toBe(0);
    expect(tools.map((t) => [t.name, t.inputSchema])).toEqual([
      ['arr', null],
      ['str', null],
      ['nul', null],
      ['num', null],
      ['absent', null],
    ]);
  });

  /** A schema whose JSON is exactly `bytes` UTF-8 bytes long (ASCII padding). */
  function schemaOfBytes(bytes: number): Record<string, unknown> {
    const base = JSON.stringify({ type: 'object', description: '' }).length;
    return { type: 'object', description: 'd'.repeat(bytes - base) };
  }

  it('a schema over 32 KiB is null and the tool is kept', () => {
    const cap = INVENTORY_LIMITS.maxInputSchemaBytes;
    expect(cap).toBe(32_768);
    const atCap = schemaOfBytes(cap);
    expect(Buffer.byteLength(JSON.stringify(atCap), 'utf8')).toBe(cap);
    // Counted in UTF-8 bytes, not UTF-16 units: 17,000 two-byte characters
    // are far under 32,768 characters but over 32,768 bytes.
    const wide = { type: 'object', description: '\u00e9'.repeat(17_000) };
    expect(JSON.stringify(wide).length).toBeLessThan(cap);
    const { tools, dropped } = normalizeTools([
      { name: 'at-cap', inputSchema: atCap },
      { name: 'over', inputSchema: schemaOfBytes(cap + 1) },
      { name: 'wide', inputSchema: wide },
      { name: 'small', inputSchema: { type: 'object' } },
    ]);
    expect(dropped).toBe(0);
    expect(tools.map((t) => t.name)).toEqual(['at-cap', 'over', 'wide', 'small']);
    expect(tools[0]!.inputSchema).toEqual(atCap);
    expect(tools[1]!.inputSchema).toBeNull();
    expect(tools[2]!.inputSchema).toBeNull();
    expect(tools[3]!.inputSchema).toEqual({ type: 'object' });
  });

  it('a schema that cannot be serialized reads as too big', () => {
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.self = cyclic;
    const { tools } = normalizeTools([{ name: 'loop', inputSchema: cyclic }]);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.inputSchema).toBeNull();
  });

  it('schemas past 1 MiB for one server are null; earlier ones are kept', () => {
    const perServer = INVENTORY_LIMITS.maxInputSchemaBytesPerServer;
    expect(perServer).toBe(1_048_576);
    const each = 30_000;
    const fit = Math.floor(perServer / each); // 34 schemas fit; the 35th would pass 1 MiB
    const raw = Array.from({ length: fit + 3 }, (_, i) => ({ name: `t${i}`, inputSchema: schemaOfBytes(each) }));
    const { tools, dropped } = normalizeTools(raw);
    expect(dropped).toBe(0);
    expect(tools).toHaveLength(fit + 3);
    expect(tools.slice(0, fit).every((t) => t.inputSchema !== null)).toBe(true);
    expect(tools.slice(fit).every((t) => t.inputSchema === null)).toBe(true);
    // A refused schema doesn't count toward the total: one that still fits
    // in what is left is kept.
    const left = perServer - fit * each;
    const tail = normalizeTools([...raw, { name: 'tiny', inputSchema: schemaOfBytes(left) }]).tools.at(-1)!;
    expect(tail.name).toBe('tiny');
    expect(tail.inputSchema).not.toBeNull();
  });

  it('a dropped tool\'s schema does not count toward the server total', () => {
    const big = schemaOfBytes(INVENTORY_LIMITS.maxInputSchemaBytes);
    const dupes = Array.from({ length: 40 }, () => ({ name: 'dup', inputSchema: big }));
    const { tools, dropped } = normalizeTools([...dupes, { name: 'last', inputSchema: big }]);
    expect(dropped).toBe(39);
    expect(tools.map((t) => [t.name, t.inputSchema !== null])).toEqual([
      ['dup', true],
      ['last', true],
    ]);
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
        { name: 'a', title: 'a', description: '', readOnly: true, outward: null, inputSchema: { type: 'object' } },
        { name: 'b', title: 'b', description: '', readOnly: null, outward: true, inputSchema: { type: 'object' } },
      ],
    });
    const posts = server.requests.filter((r) => r.method === 'POST');
    expect(posts.every((r) => r.headers.get('authorization') === 'Bearer secret-token')).toBe(true);
    expect(posts.filter((r) => (r.body as { method: string }).method === 'tools/list')).toHaveLength(2);
  });

  it('keeps inputSchema through the SDK\'s parse, extra keywords and all, and still drops outputSchema', async () => {
    const schema = {
      type: 'object',
      $defs: { id: { type: 'string', pattern: '^[a-z]+$' } },
      properties: { id: { $ref: '#/$defs/id' } },
      required: ['id'],
      additionalProperties: false,
    };
    const server = fakeMcpServer({
      pages: [[{ name: 'get', inputSchema: schema, outputSchema: { type: 'object' } }]],
    });
    const out = await listServerTools({ url: URL_OK, headers: {}, baseFetch: server.baseFetch });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.tools[0]!.inputSchema).toEqual(schema);
    expect(out.tools[0]).not.toHaveProperty('outputSchema');
  });

  it('SECURITY: a top-level __proto__ in a schema never becomes the kept schema\'s prototype', async () => {
    // Raw wire bytes: a JS object literal would set the prototype here, not
    // send the key. The SDK's catchall parse turns a top-level `__proto__`
    // key into the parsed object's prototype.
    const body = (id: unknown) =>
      `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"tools":[{"name":"get","inputSchema":` +
      `{"type":"object","__proto__":{"polluted":1},"properties":{"id":{"type":"string","__proto__":{"nested":1}}}}}]}}`;
    const server = fakeMcpServer({ toolsListBody: body });
    const out = await listServerTools({ url: URL_OK, headers: {}, baseFetch: server.baseFetch });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const schema = out.tools[0]!.inputSchema!;
    expect(schema).not.toBeNull();
    expect(Object.getPrototypeOf(schema)).toBe(Object.prototype);
    expect('polluted' in schema).toBe(false);
    expect((schema as { polluted?: unknown }).polluted).toBeUndefined();
    // What a fresh answer holds is exactly what the cache round-trip
    // (JSON.stringify on put, JSON.parse on get) gives back.
    expect(schema).toStrictEqual(JSON.parse(JSON.stringify(schema)));
    expect(Object.getPrototypeOf((schema.properties as Record<string, object>).id)).toBe(Object.prototype);
  });

  it('stops at the page cap even if the server keeps handing out cursors', async () => {
    const server = fakeMcpServer({
      pages: Array.from({ length: 50 }, (_, i) => [{ name: `t${i}`, inputSchema: { type: 'object' } }]),
    });
    const out = await listServerTools({ url: URL_OK, headers: {}, baseFetch: server.baseFetch, limits: { maxPages: 3 } });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.tools).toHaveLength(3);
  });

  // TASK-817 — only a 401 says "the credential you sent was refused" (a 403
  // is a credential that was accepted but may not do this), so only a 401 is
  // marked `rejected`, which is what lets the caller renew a token.
  it('maps HTTP 401 to needs-auth, marked rejected', async () => {
    const server = fakeMcpServer({ status: 401 });
    expect(await listServerTools({ url: URL_OK, headers: {}, baseFetch: server.baseFetch })).toEqual({
      kind: 'needs-auth',
      rejected: true,
    });
  });

  it('maps HTTP 403 to needs-auth, not marked rejected', async () => {
    const server = fakeMcpServer({ status: 403 });
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

  it('reports an oversized event-stream page as a size refusal rather than a timeout', async () => {
    const server = fakeMcpServer();
    const out = await listServerTools({
      url: URL_OK, headers: {},
      baseFetch: async (url, init) => {
        const msg = typeof init.body === 'string' ? JSON.parse(init.body) : {};
        if (msg.method !== 'tools/list') return server.baseFetch(url, init);
        return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [], padding: 'x'.repeat(5_000) } })}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
      limits: { maxResponseBytes: 1_000, requestTimeoutMs: 800, serverBudgetMs: 2_000 },
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
