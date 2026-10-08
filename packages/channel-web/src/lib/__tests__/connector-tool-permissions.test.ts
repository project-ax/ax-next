import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  changedRows,
  clampDescription,
  getToolPermissions,
  groupTools,
  initialVerdicts,
  prefillVerdict,
  putToolPermissions,
  savedVerdicts,
  titleFromToolKey,
  toolRows,
  ToolPermissionsError,
  type InventoryTool,
  type ToolPermissions,
  type ToolVerdict,
} from '../connector-tool-permissions';

const tool = (key: string, readOnly: boolean | null, outward: boolean | null = null): InventoryTool => ({
  toolKey: `mcp.linear.${key}`,
  name: key,
  title: key,
  description: '',
  readOnly,
  outward,
});

const perms = (over: Partial<ToolPermissions> = {}): ToolPermissions => ({
  status: 'ok',
  checkedAt: null,
  tools: [],
  defaults: [],
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe('prefillVerdict', () => {
  it('allows a read-only tool and asks first for everything else', () => {
    expect(prefillVerdict({ readOnly: true })).toBe('allow');
    expect(prefillVerdict({ readOnly: false })).toBe('hold');
    expect(prefillVerdict({ readOnly: null })).toBe('hold');
  });
});

describe('initialVerdicts', () => {
  it('lets a saved default win over the prefill and keeps saved defaults for unlisted tools', () => {
    const p = perms({
      tools: [tool('search', true), tool('create', false), tool('read', true)],
      defaults: [
        { toolKey: 'mcp.linear.read', verdict: 'deny' },
        { toolKey: 'mcp.linear.gone', verdict: 'allow' },
      ],
    });
    expect(Object.fromEntries(initialVerdicts(p))).toEqual({
      'mcp.linear.search': 'allow',
      'mcp.linear.create': 'hold',
      'mcp.linear.read': 'deny',
      'mcp.linear.gone': 'allow',
    });
  });
});

describe('toolRows', () => {
  it('adds rows for saved defaults the inventory does not list, titled from the key', () => {
    const rows = toolRows(
      perms({
        tools: [tool('search', true)],
        defaults: [
          { toolKey: 'mcp.linear.search', verdict: 'deny' },
          { toolKey: 'mcp.linear.archive.all', verdict: 'hold' },
        ],
      }),
    );
    expect(rows.map((r) => r.title)).toEqual(['search', 'archive.all']);
    expect(rows[1]!.readOnly).toBeNull();
  });
  it('titleFromToolKey falls back to the whole key when it has fewer than two dots', () => {
    expect(titleFromToolKey('mcp.linear.search_issues')).toBe('search_issues');
    expect(titleFromToolKey('weird')).toBe('weird');
  });
});

describe('groupTools', () => {
  it('splits read-only tools from everything else, unknowns included', () => {
    const groups = groupTools([tool('a', true), tool('b', false), tool('c', null)]);
    expect(groups.looksUp.map((t) => t.name)).toEqual(['a']);
    expect(groups.makesChanges.map((t) => t.name)).toEqual(['b', 'c']);
  });
});

describe('changedRows', () => {
  const m = (o: Record<string, ToolVerdict>) => new Map(Object.entries(o));
  it('returns only rows that differ from the saved default, counting unsaved prefills', () => {
    expect(
      changedRows(m({ a: 'allow', b: 'hold' }), m({ a: 'allow', b: 'deny', c: 'hold' })),
    ).toEqual([
      { toolKey: 'b', verdict: 'deny' },
      { toolKey: 'c', verdict: 'hold' },
    ]);
  });
  it('clears a saved default that has no current verdict', () => {
    expect(changedRows(m({ a: 'allow' }), m({}))).toEqual([{ toolKey: 'a', verdict: null }]);
  });
  it('is empty when nothing changed', () => {
    expect(changedRows(m({ a: 'deny' }), m({ a: 'deny' }))).toEqual([]);
  });
  it('treats a fresh load with only saved defaults and no inventory as unchanged', () => {
    const p = perms({ status: 'unreachable', defaults: [{ toolKey: 'x.y.z', verdict: 'allow' }] });
    expect(changedRows(savedVerdicts(p), initialVerdicts(p))).toEqual([]);
  });
});

describe('clampDescription', () => {
  it('clamps long text and leaves short text alone', () => {
    expect(clampDescription('  hi  ')).toBe('hi');
    const long = clampDescription('x'.repeat(400));
    expect(long).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('fetch wrappers', () => {
  it('GETs the right base with credentials and refresh, and drops malformed rows', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: 'ok',
          checkedAt: '2026-10-01T00:00:00Z',
          tools: [{ toolKey: 'mcp.l.a', name: 'a', title: 'A', description: 'd', readOnly: true, outward: 'yes' }, { name: 'no-key' }],
          defaults: [{ toolKey: 'mcp.l.a', verdict: 'allow' }, { toolKey: 'mcp.l.b', verdict: 'maybe' }],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await getToolPermissions('lin ear', '/admin/connectors', { refresh: true });
    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/connectors/lin%20ear/tool-permissions?refresh=1',
      { credentials: 'include' },
    );
    expect(result.tools).toEqual([
      { toolKey: 'mcp.l.a', name: 'a', title: 'A', description: 'd', readOnly: true, outward: null },
    ]);
    expect(result.defaults).toEqual([{ toolKey: 'mcp.l.a', verdict: 'allow' }]);
  });
  it('throws with the status on a non-ok GET', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    const err = await getToolPermissions('x', '/admin/connectors').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolPermissionsError);
    expect((err as ToolPermissionsError).status).toBe(403);
  });
  it('PUTs the verdicts with the CSRF header, in chunks of at most 500', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    const rows = Array.from({ length: 501 }, (_, i) => ({ toolKey: `k${i}`, verdict: 'deny' as const }));
    await putToolPermissions('x', '/admin/connectors', rows);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/admin/connectors/x/tool-permissions');
    expect(init).toMatchObject({ method: 'PUT', credentials: 'include' });
    expect((init!.headers as Record<string, string>)['x-requested-with']).toBe('ax-admin');
    expect(JSON.parse(String(init!.body)).verdicts).toHaveLength(500);
  });
  it('throws on a failed PUT', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 400 })));
    await expect(putToolPermissions('x', '/admin/connectors', [{ toolKey: 'a', verdict: 'allow' }])).rejects.toThrow();
  });
});
