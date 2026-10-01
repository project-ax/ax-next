import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCatalog, fetchImpact, fetchPolicy, ModelsHttpError, savePolicy } from '../models-admin';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[] = [];
let respond: (c: Call) => Response;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  respond = () => json(200, {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const c: Call = {
        method: init?.method ?? 'GET',
        path: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(c);
      return respond(c);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const POLICY = { source: 'admin', version: 2, allowed: ['a/b'], default: 'a/b', updatedAt: 'T', updatedBy: 'u' };

describe('fetchPolicy', () => {
  it('GETs the policy with the session cookie', async () => {
    respond = () => json(200, POLICY);
    expect(await fetchPolicy()).toEqual(POLICY);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/admin/models/policy' });
  });
  it('keeps the unreadable-policy warning', async () => {
    respond = () => json(200, { ...POLICY, source: 'builtin', version: 0, warning: 'saved-policy-unreadable' });
    expect((await fetchPolicy()).warning).toBe('saved-policy-unreadable');
  });
  it('rejects a 200 that is not a policy', async () => {
    respond = () => json(200, { providers: [] });
    await expect(fetchPolicy()).rejects.toMatchObject({ name: 'ModelsHttpError', serverError: 'unexpected-response' });
  });
  it('carries the status and server error code on a failure', async () => {
    respond = () => json(403, { error: 'forbidden' });
    await expect(fetchPolicy()).rejects.toMatchObject({ status: 403, serverError: 'forbidden' });
  });
});

describe('fetchCatalog', () => {
  const provider = { id: 'openrouter', name: 'OpenRouter', status: 'live', fetchedAt: 'T', models: [{ ref: 'openrouter/a/b', label: 'B' }] };
  it('GETs the catalog, asking for a refresh only when told to', async () => {
    respond = () => json(200, { providers: [provider] });
    expect(await fetchCatalog()).toEqual([provider]);
    await fetchCatalog({ refresh: true });
    expect(calls.map((c) => c.path)).toEqual(['/admin/models/catalog', '/admin/models/catalog?refresh=1']);
  });
  it.each([
    ['no providers array', {}],
    ['an unknown status', { providers: [{ ...provider, status: 'weird' }] }],
    ['a model without a ref', { providers: [{ ...provider, models: [{ label: 'x' }] }] }],
  ])('rejects %s', async (_l, body) => {
    respond = () => json(200, body);
    await expect(fetchCatalog()).rejects.toBeInstanceOf(ModelsHttpError);
  });
});

describe('savePolicy', () => {
  it('PUTs the draft with the admin CSRF header and returns the saved policy', async () => {
    respond = () => json(200, POLICY);
    const saved = await savePolicy({ baseVersion: 1, allowed: ['a/b'], default: 'a/b' });
    expect(saved).toEqual(POLICY);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: '/admin/models/policy',
      body: { baseVersion: 1, allowed: ['a/b'], default: 'a/b' },
    });
    expect(calls[0]!.headers['x-requested-with']).toBe('ax-admin');
  });
  it('surfaces a stale-version conflict', async () => {
    respond = () => json(409, { error: 'stale-version' });
    await expect(savePolicy({ baseVersion: 0, allowed: ['a/b'], default: 'a/b' })).rejects.toMatchObject({
      status: 409,
      serverError: 'stale-version',
    });
  });
});

describe('fetchImpact', () => {
  it('POSTs the models to be removed and returns the per-model counts', async () => {
    respond = () => json(200, { affected: [{ model: 'a/b', agentCount: 3 }] });
    expect(await fetchImpact(['a/b'])).toEqual([{ model: 'a/b', agentCount: 3 }]);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/admin/agents/models/impact', body: { remove: ['a/b'] } });
    expect(calls[0]!.headers['x-requested-with']).toBe('ax-admin');
  });
  it('rejects a malformed answer', async () => {
    respond = () => json(200, { affected: [{ model: 'a/b' }] });
    await expect(fetchImpact(['a/b'])).rejects.toBeInstanceOf(ModelsHttpError);
  });
});
