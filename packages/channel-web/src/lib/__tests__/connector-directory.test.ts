/**
 * TASK-1101 — the admin MCP directory client: the route call, the defensive
 * normalizer (registry text is untrusted, and the client never upgrades
 * trust), the listing → create-editor prefill, and server-address matching.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectorServerAddresses,
  directoryHost,
  normalizeDirectoryPage,
  prefillFromDirectoryEntry,
  searchDirectory,
  serverAddressKey,
} from '../connector-directory';
import type { Connector, ConnectorMcpServerSpec, ConnectorPrefill } from '../connectors';
import { prefillForRemoteForm } from '../connector-request-prefill';
import { remoteDraftFromProposal } from '../remote-mcp-form';
import { directoryEntry, directoryPage } from './directory-fixtures';

afterEach(() => vi.restoreAllMocks());

/** Answer every fetch with a fresh Response (a body can be read only once). */
function stubFetch(body: unknown, status = 200) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}

/** The "turned off" page, written out by hand. */
const OFF = { enabled: false, entries: [], syncedAt: null, stale: false, verifiedOnly: false };

/** One listing as JSON on the wire: overrides may carry any value, and `omit` drops keys. */
function wire(overrides: Record<string, unknown> = {}, omit: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = { ...directoryEntry(), ...overrides };
  for (const key of omit) delete out[key];
  return out;
}

/** A synced page on the wire around raw listings. */
function wirePage(entries: unknown[]): Record<string, unknown> {
  return {
    enabled: true,
    entries,
    syncedAt: '2026-11-09T10:00:00.000Z',
    stale: false,
    verifiedOnly: false,
  };
}

const entriesOf = (raw: unknown[]) => normalizeDirectoryPage(wirePage(raw)).entries;

describe('searchDirectory', () => {
  it('asks the admin route with the query, credentials and signal', async () => {
    const fetchMock = stubFetch(directoryPage({ entries: [directoryEntry()] }));
    const signal = new AbortController().signal;

    const page = await searchDirectory('notion', { signal });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/admin/connectors/directory?q=notion');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(signal);
    expect(page.entries[0]).toStrictEqual(directoryEntry());
  });

  it('encodes the query and cursor as single values', async () => {
    const fetchMock = stubFetch(directoryPage());

    await searchDirectory('a&b #c%+d', { cursor: 'eyJvIjoyMH0' });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe('/admin/connectors/directory?q=a%26b+%23c%25%2Bd&cursor=eyJvIjoyMH0');
    // Read back the way the host's router reads it (`url.searchParams`).
    const params = new URL(url, 'https://ax.example').searchParams;
    expect(params.getAll('q')).toEqual(['a&b #c%+d']);
    expect(params.getAll('cursor')).toEqual(['eyJvIjoyMH0']);

    await searchDirectory('linear');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/admin/connectors/directory?q=linear');
  });

  it('reads a 404 as the directory being off', async () => {
    stubFetch({ error: 'not-found' }, 404);
    await expect(searchDirectory('')).resolves.toStrictEqual(OFF);
  });

  it.each([500, 403, 400])('throws on any other failure (%i)', async (status) => {
    stubFetch({ error: 'nope' }, status);
    await expect(searchDirectory('x')).rejects.toThrow(`search directory: ${status}`);
  });
});

describe('normalizeDirectoryPage', () => {
  it('never upgrades trust', () => {
    const proofs = entriesOf([
      wire({ id: 'a/exact', publisherProof: 'domain' }),
      wire({ id: 'a/cased', publisherProof: 'Domain' }),
      wire({ id: 'a/claimed', publisherProof: 'verified' }),
      wire({ id: 'a/missing' }, ['publisherProof']),
    ]).map((e) => [e.id, e.publisherProof]);
    expect(proofs).toEqual([
      ['a/exact', 'domain'],
      ['a/cased', 'account'],
      ['a/claimed', 'account'],
      ['a/missing', 'account'],
    ]);

    const auths = entriesOf([
      wire({ id: 'b/key', auth: 'key' }),
      wire({ id: 'b/signin', auth: 'signin' }),
      wire({ id: 'b/oauth', auth: 'oauth' }),
      wire({ id: 'b/cased', auth: 'Key' }),
      wire({ id: 'b/missing' }, ['auth']),
    ]).map((e) => [e.id, e.auth]);
    expect(auths).toEqual([
      ['b/key', 'key'],
      ['b/signin', 'signin'],
      ['b/oauth', 'none'],
      ['b/cased', 'none'],
      ['b/missing', 'none'],
    ]);
  });

  it("drops listings it can't use", () => {
    const kept = entriesOf([
      wire({}, ['id']),
      wire({ id: '' }),
      wire({ id: 42 }),
      wire({ id: 'c/no-url' }, ['url']),
      wire({ id: 'c/http', url: 'http://mcp.example.com/mcp' }),
      wire({ id: 'c/junk', url: 'not a url' }),
      // The editor's `serverHost` refuses these, so the listing could never save.
      wire({ id: 'c/port', url: 'https://mcp.example.com:8443/mcp' }),
      wire({ id: 'c/fragment', url: 'https://mcp.example.com/mcp#x' }),
      wire({ id: 'c/long', url: `https://mcp.example.com/${'a'.repeat(2048)}` }),
      wire({ id: 'c/userinfo', url: 'https://user:pw@mcp.example.com/mcp' }),
      null,
      'a listing',
      wire({ id: 'c/good' }),
    ]);
    expect(kept.map((e) => e.id)).toEqual(['c/good']);
  });

  it('falls back to the id when the title is empty', () => {
    const titles = entriesOf([
      wire({ id: 'd/empty', title: '' }),
      wire({ id: 'd/missing' }, ['title']),
      wire({ id: 'd/spaces', title: '   ' }),
      wire({ id: 'd/number', title: 7 }),
    ]).map((e) => e.title);
    expect(titles).toEqual(['d/empty', 'd/missing', 'd/spaces', 'd/number']);

    const [junk] = entriesOf([
      wire({ description: 1, publisher: null, version: {}, updatedAt: ['2026'] }),
    ]);
    expect(junk).toMatchObject({ description: '', publisher: '', version: '', updatedAt: '' });
  });

  it('keeps keyHeader only when it is a valid header name', () => {
    const entries = entriesOf([
      wire({ id: 'e/valid', auth: 'key', keyHeader: 'X-API-Key' }),
      wire({ id: 'e/longest', auth: 'key', keyHeader: 'X'.repeat(64) }),
      wire({ id: 'e/space', auth: 'key', keyHeader: 'Bad Header' }),
      wire({ id: 'e/too-long', auth: 'key', keyHeader: 'X'.repeat(65) }),
      wire({ id: 'e/not-text', auth: 'key', keyHeader: 42 }),
      // A header on a listing that claims no key would contradict it.
      wire({ id: 'e/not-key', auth: 'none', keyHeader: 'X-API-Key' }),
    ]);
    expect(entries).toHaveLength(6);
    const [valid, longest, ...dropped] = entries;
    expect(valid?.keyHeader).toBe('X-API-Key');
    expect(longest?.keyHeader).toBe('X'.repeat(64));
    for (const e of dropped) expect(e).not.toHaveProperty('keyHeader');
    // An unusable header leaves a key listing a key listing.
    expect(dropped.map((e) => e.auth)).toEqual(['key', 'key', 'key', 'none']);
  });

  it('marks deprecated only when exactly true', () => {
    const entries = entriesOf([
      wire({ deprecated: true }),
      wire({ deprecated: 'yes' }),
      wire({ deprecated: false }),
    ]);
    expect(entries).toHaveLength(3);
    const [marked, ...unmarked] = entries;
    expect(marked?.deprecated).toBe(true);
    for (const e of unmarked) expect(e).not.toHaveProperty('deprecated');
  });

  it("keeps nextCursor only in the route's alphabet", () => {
    const pageWith = (nextCursor: unknown) =>
      normalizeDirectoryPage({ ...wirePage([]), nextCursor });
    expect(pageWith('abc_-1').nextCursor).toBe('abc_-1');
    expect(pageWith('A'.repeat(64)).nextCursor).toBe('A'.repeat(64));
    for (const bad of ['a b', 'A'.repeat(65), '', 'a/b=', 42]) {
      expect(pageWith(bad)).not.toHaveProperty('nextCursor');
    }
  });

  it('reads flags only when exactly true', () => {
    expect(
      normalizeDirectoryPage({
        enabled: true,
        entries: [],
        syncedAt: '2026-11-09T10:00:00.000Z',
        stale: true,
        verifiedOnly: true,
      }),
    ).toStrictEqual({
      enabled: true,
      entries: [],
      syncedAt: '2026-11-09T10:00:00.000Z',
      stale: true,
      verifiedOnly: true,
    });
    expect(
      normalizeDirectoryPage({
        enabled: 'true',
        entries: 'x',
        syncedAt: 1_762_682_400_000,
        stale: 1,
        verifiedOnly: 'yes',
      }),
    ).toStrictEqual(OFF);
    for (const body of [null, 'x', [], 42]) {
      expect(normalizeDirectoryPage(body)).toStrictEqual(OFF);
    }
  });
});

describe('prefillFromDirectoryEntry', () => {
  const key = directoryEntry({ auth: 'key', keyHeader: 'X-API-Key' });

  it('a key listing with a header: one header slot on the leading server', () => {
    const p = prefillFromDirectoryEntry(key);
    expect(p.capabilities).toStrictEqual({
      allowedHosts: [],
      credentials: [
        {
          slot: expect.stringMatching(/^HEADER_[0-9A-F]{32}$/),
          kind: 'api-key',
          headerName: 'X-API-Key',
          server: p.connectorId,
        },
      ],
      mcpServers: [
        {
          name: p.connectorId,
          transport: 'http',
          url: 'https://mcp.linear.app/mcp',
          allowedHosts: [],
          credentials: [],
        },
      ],
      packages: { npm: [], pypi: [] },
    });
    expect(p.name).toBe('Linear');
    expect(p.usageNote).toBe('Find, create and update Linear issues.');
    expect(p.keyMode).toBe('personal');
    expect(p.fromDirectory).toStrictEqual({ directoryId: 'app.linear/linear', version: '1.4.0' });
    expect(p).not.toHaveProperty('leftOut');
  });

  it('a key listing without a header gets no slot', () => {
    const p = prefillFromDirectoryEntry(directoryEntry({ auth: 'key' }));
    expect(p.capabilities.credentials).toEqual([]);
    expect(p.capabilities.mcpServers).toHaveLength(1);
    expect(p.keyMode).toBe('personal');
  });

  it('a sign-in listing gets one OAuth slot naming the server', () => {
    const p = prefillFromDirectoryEntry(directoryEntry({ auth: 'signin' }));
    expect(p.capabilities.credentials).toStrictEqual([
      { slot: 'MCP_OAUTH', kind: 'oauth', server: p.connectorId },
    ]);
    expect(p.capabilities.mcpServers[0]?.name).toBe(p.connectorId);
    expect(p.keyMode).toBe('personal');
  });

  it('a listing with no declared key gets no slot and still starts personal', () => {
    const p = prefillFromDirectoryEntry(directoryEntry());
    expect(p.capabilities.credentials).toEqual([]);
    expect(p.capabilities.allowedHosts).toEqual([]);
    expect(p.keyMode).toBe('personal');
  });

  it('connectorId is a fresh id the server accepts', () => {
    const idFor = (title: string) =>
      prefillFromDirectoryEntry(directoryEntry({ title })).connectorId;
    const titles = [
      'Linear MCP',
      'com.stripe/mcp',
      '日本語',
      'x'.repeat(120),
      'Directory',
      '  --Weird__Name--  ',
    ];
    for (const title of titles) {
      const id = idFor(title);
      // The server's rule: packages/connectors/src/store.ts ID_RE and ID_MAX.
      expect(id).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
      expect(id.length).toBeLessThanOrEqual(128);
      expect(id).toMatch(/-[0-9a-f]{8}$/);
      // Reserved: a route path uses the same segment.
      expect(['directory', 'authored']).not.toContain(id);
    }
    expect(idFor('Linear MCP')).toMatch(/^linear-mcp-[0-9a-f]{8}$/);
    expect(idFor('com.stripe/mcp')).toMatch(/^com-stripe-mcp-[0-9a-f]{8}$/);
    expect(idFor('日本語')).toMatch(/^connector-[0-9a-f]{8}$/);
    expect(idFor('  --Weird__Name--  ')).toMatch(/^weird-name-[0-9a-f]{8}$/);
    expect(idFor('x'.repeat(120))).toMatch(/^x{48}-[0-9a-f]{8}$/);
    // A cut that lands just after a separator drops it, rather than doubling the dash.
    expect(idFor(`${'a'.repeat(47)} tail`)).toMatch(/^a{47}-[0-9a-f]{8}$/);

    const entry = directoryEntry();
    expect(prefillFromDirectoryEntry(entry).connectorId).not.toBe(
      prefillFromDirectoryEntry(entry).connectorId,
    );
  });

  it('lands in the remote editor exactly as mapped', () => {
    const prefills = {
      key: prefillFromDirectoryEntry(key),
      signin: prefillFromDirectoryEntry(directoryEntry({ auth: 'signin' })),
      none: prefillFromDirectoryEntry(directoryEntry()),
    };
    for (const p of Object.values(prefills)) {
      const r = prefillForRemoteForm(p);
      expect(r.leftOut).toEqual([]);
      expect(r.capabilities.credentials).toStrictEqual(p.capabilities.credentials);
      expect(r.capabilities.mcpServers[0]?.url).toBe(p.capabilities.mcpServers[0]?.url);
      expect(r.fromDirectory).toStrictEqual(p.fromDirectory);
      // Nothing else is reshaped on the way in.
      expect(r).toStrictEqual({ ...p, leftOut: [] });
    }

    const draftOf = (p: ConnectorPrefill) => {
      const r = prefillForRemoteForm(p);
      return remoteDraftFromProposal(r.name, r.capabilities);
    };
    const keyDraft = draftOf(prefills.key);
    expect(keyDraft.headers).toStrictEqual([
      { slot: expect.any(String), name: 'X-API-Key', value: '', saved: false },
    ]);
    expect(keyDraft.useKey).toBe(true);
    expect(draftOf(prefills.signin).signIn).toBe('oauth');
    expect(draftOf(prefills.none)).toMatchObject({
      name: 'Linear',
      url: 'https://mcp.linear.app/mcp',
      headers: [],
      signIn: 'none',
      useKey: false,
    });
  });
});

describe('server addresses', () => {
  function connector(id: string, mcpServers: ConnectorMcpServerSpec[]): Connector {
    return {
      id,
      name: id,
      description: '',
      usageNote: '',
      keyMode: 'personal',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      capabilities: { allowedHosts: [], credentials: [], mcpServers, packages: { npm: [], pypi: [] } },
    };
  }

  it('directoryHost shows only the host', () => {
    expect(directoryHost('https://mcp.linear.app/mcp')).toBe('mcp.linear.app');
    expect(directoryHost('https://bücher.example/mcp')).toBe('xn--bcher-kva.example');
    expect(directoryHost('https://mcp.example.com:8443/x')).toBe('mcp.example.com:8443');
    expect(directoryHost('https://who:pw@mcp.example.com/x?token=1#top')).toBe('mcp.example.com');
    expect(directoryHost('not a url')).toBe('');
  });

  it('serverAddressKey treats one server written differently as one', () => {
    expect(serverAddressKey('https://MCP.Linear.app:443/mcp/')).toBe(
      serverAddressKey(' https://mcp.linear.app/mcp '),
    );
    expect(serverAddressKey('https://mcp.linear.app/mcp')).not.toBe(
      serverAddressKey('https://mcp.linear.app/sse'),
    );
    expect(serverAddressKey('https://mcp.example.com/mcp?tenant=a')).not.toBe(
      serverAddressKey('https://mcp.example.com/mcp?tenant=b'),
    );
    expect(serverAddressKey('nope')).toBeNull();
  });

  it('connectorServerAddresses collects every server of every connector', () => {
    const addresses = connectorServerAddresses([
      connector('two-servers', [
        { name: 'a', transport: 'http', url: 'https://MCP.linear.app/mcp/', allowedHosts: [], credentials: [] },
        { name: 'b', transport: 'http', url: 'https://api.example.com/sse', allowedHosts: [], credentials: [] },
      ]),
      connector('no-address', [
        { name: 'c', transport: 'http', allowedHosts: [], credentials: [] },
        { name: 'd', transport: 'http', url: 'not a url', allowedHosts: [], credentials: [] },
      ]),
    ]);
    expect(addresses.size).toBe(2);
    // The consumer's lookup: a listing is "added" when its own key is in the set.
    expect(addresses.has(serverAddressKey('https://mcp.linear.app/mcp') ?? '')).toBe(true);
    expect(addresses.has(serverAddressKey('https://api.example.com/sse') ?? '')).toBe(true);
    expect(addresses.has(serverAddressKey('https://mcp.linear.app/sse') ?? '')).toBe(false);
  });
});
