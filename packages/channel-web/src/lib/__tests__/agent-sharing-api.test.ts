import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SharingRequestError,
  searchPeople,
  setAudience,
  setOwners,
  sharingErrorMessage,
} from '../agent-sharing-api';
import { SHARING_COPY } from '../sharing-copy';

const VIEW = {
  audience: { kind: 'just-me' },
  owners: [{ id: 'u', displayName: 'U', creator: true }],
};

function stub(res: Response) {
  const f = vi.fn(async () => res);
  vi.stubGlobal('fetch', f);
  return f;
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('setAudience', () => {
  it('PUTs the body with the CSRF header and returns sharing', async () => {
    const f = stub(json(200, { sharing: VIEW }));
    const out = await setAudience('agt/1', { kind: 'everyone' });
    expect(out).toEqual(VIEW);
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/admin/agents/agt%2F1/audience');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ kind: 'everyone' }));
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      'x-requested-with': 'ax-admin',
    });
    expect(init.credentials).toBe('include');
  });
});

describe('setOwners', () => {
  it('PUTs { userIds }', async () => {
    const f = stub(json(200, { sharing: VIEW }));
    await setOwners('a1', ['u1', 'u2']);
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/admin/agents/a1/owners');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ userIds: ['u1', 'u2'] }));
    expect(init.headers).toMatchObject({ 'x-requested-with': 'ax-admin' });
  });
});

describe('searchPeople', () => {
  it('GETs with the query encoded and returns the people', async () => {
    const people = [{ id: 'p1', displayName: 'Pat' }];
    const f = stub(json(200, { people }));
    const ctl = new AbortController();
    expect(await searchPeople('a&b', ctl.signal)).toEqual(people);
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/admin/people?q=a%26b');
    expect(init.signal).toBe(ctl.signal);
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('keeps only well-formed people and only id and displayName', async () => {
    stub(
      json(200, {
        people: [
          { id: 'p1', displayName: 'Pat', email: 'pat@example.com' },
          { id: 'p2' },
          { id: 3, displayName: 'Three' },
          { id: 'p4', displayName: null },
          null,
          'p5',
          { id: 'p6', displayName: 'Sam' },
        ],
      }),
    );
    expect(await searchPeople('pat')).toEqual([
      { id: 'p1', displayName: 'Pat' },
      { id: 'p6', displayName: 'Sam' },
    ]);
  });
});

describe('refusals', () => {
  it.each([
    [403, 'forbidden'],
    [400, 'unknown-person'],
    [429, 'rate-limited'],
  ])("throw SharingRequestError with status %i and the server's code", async (status, code) => {
    stub(json(status, { error: code }));
    for (const call of [
      () => setAudience('a', { kind: 'just-me' }),
      () => setOwners('a', ['u']),
      () => searchPeople('pat'),
    ]) {
      stub(json(status, { error: code }));
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SharingRequestError);
      expect((err as SharingRequestError).status).toBe(status);
      expect((err as SharingRequestError).code).toBe(code);
    }
  });

  it("a body that isn't JSON still throws, with code null", async () => {
    stub(new Response('<html>bad gateway</html>', { status: 502 }));
    const err = await setOwners('a', ['u']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SharingRequestError);
    expect((err as SharingRequestError).status).toBe(502);
    expect((err as SharingRequestError).code).toBeNull();
  });

  it('a non-string error field gives code null', async () => {
    stub(json(400, { error: { nested: true } }));
    const err = await searchPeople('pat').catch((e: unknown) => e);
    expect((err as SharingRequestError).code).toBeNull();
  });

  it('an ok answer without the expected shape throws', async () => {
    stub(json(200, { nope: 1 }));
    await expect(setAudience('a', { kind: 'just-me' })).rejects.toBeInstanceOf(
      SharingRequestError,
    );
    stub(json(200, { nope: 1 }));
    await expect(searchPeople('pat')).rejects.toBeInstanceOf(SharingRequestError);
  });
});

describe('sharingErrorMessage', () => {
  const refused = (status: number, code: string | null) =>
    new SharingRequestError('/admin/agents/a/audience', status, code);

  it.each([
    ['403 forbidden', refused(403, 'forbidden'), SHARING_COPY.errors.forbidden('Fern')],
    ['400 unknown-person', refused(400, 'unknown-person'), SHARING_COPY.errors.unknownPerson],
    ['503', refused(503, 'accounts-unavailable'), SHARING_COPY.errors.accountsUnavailable],
    ['404', refused(404, 'not-found'), SHARING_COPY.errors.notFound('Fern')],
    ['400 duplicate-person', refused(400, 'duplicate-person'), SHARING_COPY.errors.duplicatePerson],
    ['400 creator-required', refused(400, 'creator-required'), SHARING_COPY.errors.creatorRequired],
    ['another 400', refused(400, 'invalid-audience'), SHARING_COPY.errors.generic],
    ['a network failure', new Error('network'), SHARING_COPY.errors.generic],
  ])('turns %s into words', (_name, error, words) => {
    expect(sharingErrorMessage(error, 'Fern')).toBe(words);
  });
});
