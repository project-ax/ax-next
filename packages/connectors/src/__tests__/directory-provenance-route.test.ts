import { describe, it, expect, vi } from 'vitest';
import { HookBus, PluginError, type AgentContext } from '@ax/core';
import {
  createConnectorRouteHandlers,
  type RouteRequest,
  type RouteResponse,
} from '../admin-routes.js';
import { serverAddressesChanged, soleServerUrl } from '../directory-provenance.js';
import type { Capabilities, Connector, McpServerSpec, UpsertInput } from '../types.js';

// ---------------------------------------------------------------------------
// TASK-1102 — directory provenance on the admin connector routes.
//
// POST /admin/connectors may carry `fromDirectory: { directoryId, version }`
// beside the connector's fields (the editor was filled from a directory
// listing). The route gates it, strips it before `connectors:upsert` (the
// connector is written exactly as a hand-entered one) and, after a successful
// create, hands it to `connectors:directory-provenance-record`. A PATCH that
// changes a server address calls `connectors:directory-provenance-mark-edited`.
// Both hooks are optional (@ax/connector-directory) and never fail a write.
//
// No Docker: a bare HookBus with stubs. The hook names are written out here on
// purpose: they are the contract with the directory plugin (no import).
// ---------------------------------------------------------------------------

const RECORD_HOOK = 'connectors:directory-provenance-record';
const MARK_HOOK = 'connectors:directory-provenance-mark-edited';
const ID = 'linear-0a1b2c3d';
const LISTING_URL = 'https://mcp.linear.app/mcp';
const STAMP = '2026-11-09T00:00:00.000Z';

function caps(url = LISTING_URL): Capabilities {
  return {
    allowedHosts: [],
    credentials: [],
    mcpServers: [{ name: ID, transport: 'http', url, allowedHosts: [], credentials: [] }],
    packages: { npm: [], pypi: [] },
  };
}

const BODY = {
  connectorId: ID,
  name: 'Linear',
  usageNote: 'Use it for issues.',
  keyMode: 'personal',
  capabilities: caps(),
};
const FROM = { directoryId: 'app.linear/linear', version: '1.0.0' };

const STORED: Connector = {
  id: ID,
  name: 'Linear',
  description: '',
  usageNote: 'Use it for issues.',
  keyMode: 'personal',
  capabilities: caps(),
  createdAt: STAMP,
  updatedAt: STAMP,
  canEdit: true,
};

/** What the stub store answers: the connector the write describes. */
function connectorFrom(input: UpsertInput): Connector {
  return {
    id: input.connectorId,
    name: input.name,
    description: input.description ?? '',
    usageNote: input.usageNote ?? '',
    keyMode: input.keyMode,
    capabilities: input.capabilities,
    createdAt: STAMP,
    updatedAt: STAMP,
    canEdit: true,
  };
}

function pluginError(code: string, message: string, hookName: string): PluginError {
  return new PluginError({ code, plugin: 'stub', hookName, message });
}

/** 'ok' answers, 'throws' fails after noting the call, null = not registered. */
type ProvenanceStub = 'ok' | 'throws' | null;

interface Stubs {
  /** `connectors:get`: 'missing' is a free id (not-found), 'stored' the live STORED. */
  get: 'missing' | 'stored';
  /** When set, `connectors:upsert` throws it after noting its input. */
  upsertError: PluginError | null;
}

function setup(
  opts: { get?: Stubs['get']; record?: ProvenanceStub; mark?: ProvenanceStub } = {},
) {
  const stubs: Stubs = { get: opts.get ?? 'missing', upsertError: null };
  const upserts: Array<Record<string, unknown>> = [];
  const records: unknown[] = [];
  const marks: unknown[] = [];
  const bus = new HookBus();
  bus.registerService('auth:require-user', 'auth-stub', async () => ({
    user: { id: 'root', isAdmin: true },
  }));
  bus.registerService('connectors:get', 'connectors-stub', async () => {
    if (stubs.get === 'stored') return { connector: STORED, ownerUserId: 'root' };
    throw pluginError('not-found', `connector '${ID}' not found`, 'connectors:get');
  });
  bus.registerService(
    'connectors:upsert',
    'connectors-stub',
    async (_c: AgentContext, input: UpsertInput) => {
      upserts.push({ ...input });
      if (stubs.upsertError !== null) throw stubs.upsertError;
      return { connector: connectorFrom(input), created: input.createOnly === true };
    },
  );
  const record = opts.record === undefined ? 'ok' : opts.record;
  if (record !== null) {
    bus.registerService(RECORD_HOOK, 'directory-stub', async (_c: AgentContext, input: unknown) => {
      records.push(input);
      // The directory's own refusal of a value outside its exact caps.
      if (record === 'throws') {
        throw pluginError('invalid-payload', 'invalid provenance input', RECORD_HOOK);
      }
      return { recorded: true };
    });
  }
  const mark = opts.mark === undefined ? 'ok' : opts.mark;
  if (mark !== null) {
    bus.registerService(MARK_HOOK, 'directory-stub', async (_c: AgentContext, input: unknown) => {
      marks.push(input);
      if (mark === 'throws') throw new Error('provenance table unavailable');
      return { marked: true };
    });
  }
  const handlers = createConnectorRouteHandlers({ bus, mode: 'admin' });
  return { stubs, upserts, records, marks, handlers };
}
type Setup = ReturnType<typeof setup>;

/** A string body is sent as is (raw JSON text); anything else as JSON. */
function makeReq(body: unknown, params: Record<string, string> = {}): RouteRequest {
  return {
    headers: {},
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    cookies: {},
    query: {},
    params,
    signedCookie: () => null,
  };
}

interface Answer {
  status: number;
  body: unknown;
}

async function answer(run: (res: RouteResponse) => Promise<void>): Promise<Answer> {
  const captured: Answer = { status: 0, body: undefined };
  const res: RouteResponse = {
    status(n: number) {
      captured.status = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text(s: string) {
      captured.body = s;
    },
    end() {},
  };
  await run(res);
  return captured;
}

const post =(s: Setup, body: unknown): Promise<Answer> =>
  answer((res) => s.handlers.create(makeReq(body), res));
const patch = (s: Setup, body: unknown): Promise<Answer> =>
  answer((res) => s.handlers.update(makeReq(body, { id: ID }), res));

/** The handlers build their own ctx, so read the logger's stdout lines. */
async function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    const result = await run();
    return { result, logs: chunks.flatMap((c) => c.split('\n')).filter((l) => l.length > 0) };
  } finally {
    spy.mockRestore();
  }
}

function logged(logs: string[], msg: string): Array<Record<string, unknown>> {
  return logs.flatMap((line) => {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      return entry.msg === msg ? [entry] : [];
    } catch {
      return [];
    }
  });
}

describe('POST /admin/connectors with fromDirectory (TASK-1102)', () => {
  it('POST with fromDirectory writes the hand-entered connector, then records the listing', async () => {
    const fromListing = setup();
    const listed = await post(fromListing, { ...BODY, fromDirectory: FROM });
    const byHand = setup();
    const typed = await post(byHand, BODY);

    expect(listed.status).toBe(201);
    expect(typed.status).toBe(201);
    // The same write either way: the listing never becomes part of the connector.
    expect(fromListing.upserts).toHaveLength(1);
    expect(fromListing.upserts[0]).toStrictEqual(byHand.upserts[0]);
    expect(fromListing.upserts[0]).not.toHaveProperty('fromDirectory');
    expect(byHand.upserts[0]).not.toHaveProperty('fromDirectory');
    expect(fromListing.records).toEqual([
      {
        connectorId: 'linear-0a1b2c3d',
        directoryId: 'app.linear/linear',
        version: '1.0.0',
        serverUrl: 'https://mcp.linear.app/mcp',
      },
    ]);
    expect(byHand.records).toEqual([]);
    expect(listed.body).toEqual({ connector: expect.objectContaining({ id: ID }), created: true });
    expect((listed.body as { connector: object }).connector).not.toHaveProperty('fromDirectory');
  });

  it('a malformed fromDirectory is ignored: created, nothing recorded', async () => {
    const malformed: unknown[] = [
      'app.linear/linear',
      null,
      [],
      { directoryId: 'app.linear/linear' },
      { ...FROM, edited: false },
      { directoryId: 'x'.repeat(257), version: '1.0.0' },
      { directoryId: '', version: '1.0.0' },
      { directoryId: 1, version: '1.0.0' },
      // The version half of the same gate.
      { version: '1.0.0' },
      { directoryId: 'app.linear/linear', version: '' },
      { directoryId: 'app.linear/linear', version: 'v'.repeat(257) },
    ];
    for (const fromDirectory of malformed) {
      const s = setup();
      const { result, logs } = await captureLogs(() => post(s, { ...BODY, fromDirectory }));
      const label = JSON.stringify(fromDirectory);
      expect(result.status, label).toBe(201);
      expect(s.records, label).toEqual([]);
      expect(s.upserts[0], label).not.toHaveProperty('fromDirectory');
      // One info line, and none of the client's strings in any line.
      expect(logged(logs, 'connectors_directory_provenance_malformed'), label).toEqual([
        expect.objectContaining({ level: 'info' }),
      ]);
      const text = logs.join('\n');
      for (const echoed of ['app.linear/linear', '1.0.0', 'xxxxxxxx', 'vvvvvvvv']) {
        expect(text, label).not.toContain(echoed);
      }
    }

    // An own `__proto__` key, as JSON.parse delivers it, is an extra key too.
    const smuggled = setup();
    const raw = JSON.stringify({ ...BODY, fromDirectory: FROM }).replace(
      '"fromDirectory":{',
      '"fromDirectory":{"__proto__":{"edited":false},',
    );
    expect((await post(smuggled, raw)).status).toBe(201);
    expect(smuggled.records).toEqual([]);

    // 256 code units each is inside the route's coarse gate: forwarded, and
    // the directory hook owns the exact caps.
    const edge = setup();
    const long = { directoryId: 'x'.repeat(256), version: 'v'.repeat(256) };
    expect((await post(edge, { ...BODY, fromDirectory: long })).status).toBe(201);
    expect(edge.records).toEqual([{ connectorId: ID, ...long, serverUrl: LISTING_URL }]);
  });

  it('an otherwise invalid body is still a 400 from the existing rules', async () => {
    const s = setup();
    s.stubs.upsertError = pluginError('invalid-payload', 'name is required', 'connectors:upsert');
    const r = await post(s, { ...BODY, name: '', fromDirectory: FROM });
    expect(r).toEqual({ status: 400, body: { error: 'name is required' } });
    expect(s.upserts).toHaveLength(1);
    expect(s.upserts[0]).not.toHaveProperty('fromDirectory');
    expect(s.records).toEqual([]);
  });

  it('a taken id is a 409 and records nothing', async () => {
    const s = setup({ get: 'stored' });
    const taken = await post(s, { ...BODY, fromDirectory: FROM });
    expect(taken).toEqual({ status: 409, body: { error: 'connector-id-taken' } });
    expect(s.upserts).toEqual([]);
    expect(s.records).toEqual([]);
    // The store's own re-check (an id the pre-check could not pick) is a 409 too.
    s.stubs.get = 'missing';
    s.stubs.upsertError = pluginError(
      'connector-id-taken',
      `connector id '${ID}' is already in use`,
      'connectors:upsert',
    );
    const raced = await post(s, { ...BODY, fromDirectory: FROM });
    expect(raced).toEqual({ status: 409, body: { error: 'connector-id-taken' } });
    expect(s.records).toEqual([]);
    // Control: the same body records once the id is free.
    s.stubs.upsertError = null;
    expect((await post(s, { ...BODY, fromDirectory: FROM })).status).toBe(201);
    expect(s.records).toHaveLength(1);
  });

  it('a provenance failure never fails the create', async () => {
    const s = setup({ record: 'throws' });
    const { result, logs } = await captureLogs(() => post(s, { ...BODY, fromDirectory: FROM }));
    expect(result).toEqual({
      status: 201,
      body: { connector: expect.objectContaining({ id: ID }), created: true },
    });
    // It was asked; its refusal is logged, never answered.
    expect(s.records).toHaveLength(1);
    expect(logged(logs, 'connectors_directory_provenance_failed')).toEqual([
      expect.objectContaining({
        level: 'warn',
        connectorId: ID,
        hook: RECORD_HOOK,
        code: 'invalid-payload',
      }),
    ]);
    expect(logs.join('\n')).not.toContain('app.linear/linear');
    // Codes, not the message.
    expect(logs.join('\n')).not.toContain('invalid provenance input');
  });

  it('without the directory, create and PATCH behave as before', async () => {
    const s = setup({ record: null, mark: null });
    const created = await captureLogs(() => post(s, { ...BODY, fromDirectory: FROM }));
    expect(created.result.status).toBe(201);
    expect(s.upserts[0]).not.toHaveProperty('fromDirectory');
    s.stubs.get = 'stored';
    const patched = await captureLogs(() =>
      patch(s, { capabilities: caps('https://mcp.linear.app/v2') }),
    );
    expect(patched.result.status).toBe(200);
    // Skipped, not attempted: nothing is logged for a hook that isn't there.
    expect(
      [...created.logs, ...patched.logs].filter((l) => l.includes('connectors_directory_provenance')),
    ).toEqual([]);
  });
});

describe('PATCH /admin/connectors/:id and directory provenance (TASK-1102)', () => {
  it('PATCH that changes a server address marks the record edited', async () => {
    const s = setup({ get: 'stored' });
    const r = await patch(s, { capabilities: caps('https://mcp.linear.app/v2') });
    expect(r.status).toBe(200);
    expect(s.marks).toEqual([{ connectorId: 'linear-0a1b2c3d' }]);
    expect(s.records).toEqual([]);
  });

  it('PATCH of only the name or usage note marks nothing', async () => {
    const s = setup({ get: 'stored' });
    const full = await patch(s, { name: 'Linear (team)', usageNote: 'x', capabilities: caps() });
    expect(full.status).toBe(200);
    expect((await patch(s, { name: 'Linear (team)' })).status).toBe(200);
    expect(s.marks).toEqual([]);
    // Control: the mark hook is live here, and an address change reaches it.
    expect((await patch(s, { capabilities: caps('https://mcp.linear.app/v2') })).status).toBe(200);
    expect(s.marks).toEqual([{ connectorId: ID }]);
  });

  it('a refused PATCH marks nothing', async () => {
    const s = setup({ get: 'stored' });
    s.stubs.upsertError = pluginError(
      'invalid-payload',
      'capabilities.mcpServers is not valid',
      'connectors:upsert',
    );
    const refused = await patch(s, { capabilities: caps('https://mcp.linear.app/v2') });
    expect(refused).toEqual({ status: 400, body: { error: 'capabilities.mcpServers is not valid' } });
    expect(s.marks).toEqual([]);
    // Control: the same edit marks once the write commits.
    s.stubs.upsertError = null;
    expect((await patch(s, { capabilities: caps('https://mcp.linear.app/v2') })).status).toBe(200);
    expect(s.marks).toEqual([{ connectorId: ID }]);
  });

  it('a mark failure never fails the PATCH', async () => {
    const s = setup({ get: 'stored', mark: 'throws' });
    const { result, logs } = await captureLogs(() =>
      patch(s, { capabilities: caps('https://mcp.linear.app/v2') }),
    );
    expect(result).toEqual({
      status: 200,
      body: { connector: expect.objectContaining({ id: ID }), created: false },
    });
    expect(s.marks).toEqual([{ connectorId: ID }]);
    expect(logged(logs, 'connectors_directory_provenance_failed')).toEqual([
      expect.objectContaining({ level: 'warn', connectorId: ID, hook: MARK_HOOK }),
    ]);
  });

  it('PATCH drops a fromDirectory field', async () => {
    const s = setup({ get: 'stored' });
    const r = await patch(s, { name: 'Linear', fromDirectory: FROM });
    expect(r.status).toBe(200);
    expect(s.upserts).toHaveLength(1);
    expect(s.upserts[0]).not.toHaveProperty('fromDirectory');
    expect(s.records).toEqual([]);
    expect(s.marks).toEqual([]);
  });
});

describe('serverAddressesChanged / soleServerUrl', () => {
  const A = 'https://a.example/mcp';
  const B = 'https://b.example/mcp';
  const server = (name: string, url?: string): McpServerSpec =>
    url === undefined
      ? { name, transport: 'http', allowedHosts: [], credentials: [] }
      : { name, transport: 'http', url, allowedHosts: [], credentials: [] };
  const of = (...mcpServers: McpServerSpec[]): Pick<Capabilities, 'mcpServers'> => ({ mcpServers });

  it('serverAddressesChanged compares the ordered list of addresses only', () => {
    expect(serverAddressesChanged(of(server('a', A), server('b', B)), of(server('a', A), server('b', B)))).toBe(false);
    // Other server fields changing is not an address change.
    expect(
      serverAddressesChanged(of(server('a', A)), of({ ...server('renamed', A), allowedHosts: ['a.example'] })),
    ).toBe(false);
    // Both without an address.
    expect(serverAddressesChanged(of(server('a')), of(server('a')))).toBe(false);
    expect(serverAddressesChanged(of(), of())).toBe(false);

    // Changed, added, removed, swapped, and an address appearing.
    expect(serverAddressesChanged(of(server('a', A)), of(server('a', B)))).toBe(true);
    expect(serverAddressesChanged(of(server('a', A)), of(server('a', A), server('b', B)))).toBe(true);
    expect(serverAddressesChanged(of(server('a', A), server('b', B)), of(server('a', A)))).toBe(true);
    expect(serverAddressesChanged(of(server('a', A), server('b', B)), of(server('b', B), server('a', A)))).toBe(true);
    expect(serverAddressesChanged(of(server('a')), of(server('a', A)))).toBe(true);
  });

  it('soleServerUrl is the address of exactly one server, else null', () => {
    expect(soleServerUrl(of(server('a', A)))).toBe(A);
    expect(soleServerUrl(of())).toBeNull();
    expect(soleServerUrl(of(server('a', A), server('b', B)))).toBeNull();
    expect(soleServerUrl(of(server('a')))).toBeNull();
  });
});
