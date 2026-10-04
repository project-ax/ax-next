import { describe, it, expect } from 'vitest';
import { createLogger, makeAgentContext, type HookBus } from '@ax/core';
import { sweepStdioConfigs } from '../stdio-sweep.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

type Cred = { scope: 'global' | 'user' | 'agent'; ownerId: string | null; ref: string };

interface FakeBusOptions {
  /** Hooks `hasService` reports as registered. Default: both credentials hooks. */
  services?: string[];
  /** Make `credentials:list` throw (a credential hiccup). */
  listThrows?: boolean;
}

function fakeBus(initial: Record<string, unknown>, creds: Cred[], opts: FakeBusOptions = {}) {
  const services = new Set(opts.services ?? ['credentials:list', 'credentials:delete']);
  const store = new Map<string, Uint8Array>(
    Object.entries(initial).map(([k, v]) => [
      k,
      enc.encode(typeof v === 'string' ? v : JSON.stringify(v)),
    ]),
  );
  const deleted: string[] = [];
  const bus = {
    hasService: (h: string) => services.has(h),
    call: async (hook: string, _ctx: unknown, input: { key: string; value: Uint8Array; ref: string }) => {
      if (hook === 'storage:get') return { value: store.get(input.key) };
      if (hook === 'storage:set') {
        store.set(input.key, input.value);
        return undefined;
      }
      if (hook === 'credentials:list') {
        if (opts.listThrows === true) throw new Error('credentials backend down');
        return { credentials: creds };
      }
      if (hook === 'credentials:delete') {
        deleted.push(input.ref);
        return undefined;
      }
      throw new Error(`unexpected hook ${hook}`);
    },
  } as unknown as HookBus;
  return { bus, store, deleted };
}

const ctx = makeAgentContext({ sessionId: 'init', agentId: 'a', userId: 'init' });

// A context whose logger records instead of writing to stdout.
function loggingCtx() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    reqId: 'req-test',
    writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return {
    ctx: makeAgentContext({ sessionId: 'init', agentId: 'a', userId: 'init', logger }),
    lines,
  };
}

const stdioRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  enabled: true,
  transport: 'stdio',
  command: 'npx',
  args: [],
  ...extra,
});

describe('sweepStdioConfigs', () => {
  it('deletes stdio rows, rewrites the index, purges their env slots, keeps http rows', async () => {
    const { bus, store, deleted } = fakeBus(
      {
        'mcp-server-index': ['local', 'remote'],
        'mcp-server:local': stdioRow('local', {
          env: { GH_TOKEN: '' },
          credentialRefs: { GH_TOKEN: 'x' },
        }),
        'mcp-server:remote': {
          id: 'remote',
          enabled: true,
          transport: 'streamable-http',
          url: 'https://mcp.example.com',
        },
      },
      [
        { scope: 'global', ownerId: null, ref: 'mcp:local:env:GH_TOKEN' },
        { scope: 'global', ownerId: null, ref: 'mcp:remote:header:Authorization' },
      ],
    );
    expect(await sweepStdioConfigs(bus, ctx)).toBe(1);
    expect(JSON.parse(dec.decode(store.get('mcp-server-index')!))).toEqual(['remote']);
    expect(store.get('mcp-server:local')!.length).toBe(0);
    expect(deleted).toEqual(['mcp:local:env:GH_TOKEN']);
    // The http row is untouched.
    expect(JSON.parse(dec.decode(store.get('mcp-server:remote')!)).url).toBe(
      'https://mcp.example.com',
    );
  });

  it('purges every slot named in either env or credentialRefs, and nothing else', async () => {
    const { bus, deleted } = fakeBus(
      {
        'mcp-server-index': ['local'],
        'mcp-server:local': stdioRow('local', {
          env: { A: '' },
          credentialRefs: { B: 'cred-b' },
        }),
      },
      [
        { scope: 'global', ownerId: null, ref: 'mcp:local:env:A' },
        { scope: 'user', ownerId: 'u1', ref: 'mcp:local:env:B' },
        { scope: 'global', ownerId: null, ref: 'mcp:local:env:UNDECLARED' },
        { scope: 'global', ownerId: null, ref: 'mcp:other:env:A' },
      ],
    );
    expect(await sweepStdioConfigs(bus, ctx)).toBe(1);
    expect(deleted.sort()).toEqual(['mcp:local:env:A', 'mcp:local:env:B']);
  });

  it('is a no-op for http / sse rows (a second pass finds nothing)', async () => {
    const { bus } = fakeBus(
      {
        'mcp-server-index': ['remote'],
        'mcp-server:remote': {
          id: 'remote',
          enabled: true,
          transport: 'sse',
          url: 'https://x.example',
        },
      },
      [],
    );
    expect(await sweepStdioConfigs(bus, ctx)).toBe(0);
  });

  it('is idempotent: a second sweep after a real one deletes nothing', async () => {
    const { bus } = fakeBus(
      { 'mcp-server-index': ['local'], 'mcp-server:local': stdioRow('local') },
      [],
    );
    expect(await sweepStdioConfigs(bus, ctx)).toBe(1);
    expect(await sweepStdioConfigs(bus, ctx)).toBe(0);
  });

  it('is a no-op with no index', async () => {
    expect(await sweepStdioConfigs(fakeBus({}, []).bus, ctx)).toBe(0);
  });

  it('leaves a corrupt index alone (loadConfigs reports it)', async () => {
    const { bus, store } = fakeBus({ 'mcp-server-index': 'not json' }, []);
    expect(await sweepStdioConfigs(bus, ctx)).toBe(0);
    expect(dec.decode(store.get('mcp-server-index')!)).toBe('not json');
  });

  it('leaves a non-JSON row alone (loadConfigs already skips it)', async () => {
    const { bus, store } = fakeBus(
      { 'mcp-server-index': ['bad'], 'mcp-server:bad': 'not json' },
      [],
    );
    expect(await sweepStdioConfigs(bus, ctx)).toBe(0);
    expect(dec.decode(store.get('mcp-server:bad')!)).toBe('not json');
  });

  it('skips an indexed id with no row (stale index entry)', async () => {
    const { bus } = fakeBus({ 'mcp-server-index': ['ghost'] }, []);
    expect(await sweepStdioConfigs(bus, ctx)).toBe(0);
  });

  it('still deletes the row when the credentials services are not loaded', async () => {
    const { bus, store, deleted } = fakeBus(
      {
        'mcp-server-index': ['local'],
        'mcp-server:local': stdioRow('local', { env: { GH_TOKEN: '' } }),
      },
      [{ scope: 'global', ownerId: null, ref: 'mcp:local:env:GH_TOKEN' }],
      { services: [] },
    );
    expect(await sweepStdioConfigs(bus, ctx)).toBe(1);
    expect(store.get('mcp-server:local')!.length).toBe(0);
    expect(JSON.parse(dec.decode(store.get('mcp-server-index')!))).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it('still deletes the row when the credential purge throws', async () => {
    const { bus, store } = fakeBus(
      {
        'mcp-server-index': ['local'],
        'mcp-server:local': stdioRow('local', { env: { GH_TOKEN: '' } }),
      },
      [],
      { listThrows: true },
    );
    expect(await sweepStdioConfigs(bus, ctx)).toBe(1);
    expect(store.get('mcp-server:local')!.length).toBe(0);
  });

  it('one stdio row whose id deleteConfig rejects does not stop the sweep', async () => {
    // 'BAD ID' fails ID_RE, so deleteConfig throws for it. The next row must
    // still be swept and the sweep must resolve (plugin init must not fail).
    const { bus, store } = fakeBus(
      {
        'mcp-server-index': ['BAD ID', 'good'],
        'mcp-server:BAD ID': stdioRow('BAD ID'),
        'mcp-server:good': stdioRow('good'),
      },
      [],
    );
    expect(await sweepStdioConfigs(bus, ctx)).toBe(1);
    expect(store.get('mcp-server:good')!.length).toBe(0);
    expect(JSON.parse(dec.decode(store.get('mcp-server-index')!))).toEqual(['BAD ID']);
  });

  it('logs nothing when there is nothing to sweep (the default logger writes to stdout)', async () => {
    const empty = loggingCtx();
    expect(await sweepStdioConfigs(fakeBus({}, []).bus, empty.ctx)).toBe(0);
    expect(empty.lines).toEqual([]);

    const httpOnly = loggingCtx();
    const { bus } = fakeBus(
      {
        'mcp-server-index': ['remote'],
        'mcp-server:remote': {
          id: 'remote',
          enabled: true,
          transport: 'streamable-http',
          url: 'https://mcp.example.com',
        },
      },
      [],
    );
    expect(await sweepStdioConfigs(bus, httpOnly.ctx)).toBe(0);
    expect(httpOnly.lines).toEqual([]);
  });

  it('logs the count and nothing else (no ids, commands or env names) when it sweeps', async () => {
    const { ctx: c, lines } = loggingCtx();
    const { bus } = fakeBus(
      {
        'mcp-server-index': ['local'],
        'mcp-server:local': stdioRow('local', { command: 'secret-binary', env: { GH_TOKEN: '' } }),
      },
      [],
    );
    expect(await sweepStdioConfigs(bus, c)).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'mcp_stdio_configs_swept', count: 1 });
    const wire = JSON.stringify(lines);
    expect(wire).not.toContain('secret-binary');
    expect(wire).not.toContain('GH_TOKEN');
  });
});
