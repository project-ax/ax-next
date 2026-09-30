/**
 * Wire-client tests for `lib/routines.ts` — Phase D Task 11.
 *
 * Mirrors the shape the server contracts in `@ax/routines-admin-routes`:
 *   - GET    /settings/routines                      → { routines: [...] }
 *   - GET    /settings/routines/:agentId/fires?path= → { fires: [...] }
 *   - POST   /settings/routines/:agentId/fire        → { status }
 *
 * Pinned behaviors (the assertions are a contract):
 *   - `list()` hydrates server-supplied `lastRunAt: string | null` to Date.
 *   - `recentFires()` URL-encodes the agentId path segment.
 *   - `fireNow()` POSTs JSON; payload field is omitted when not provided.
 *   - Errors surface the server's own words: a string `{ error: '<reason>' }`
 *     (what `@ax/routines-admin-routes` REALLY sends, see the TASK-719 block
 *     below) or an object `{ error: { message } }`. A person never reads a bare
 *     "HTTP 400" when the server said something.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { routines } from '../lib/routines';
import { StorageFullError } from '../lib/storage-full';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
afterEach(() => fetchMock.mockReset());

function mockJson(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

/** The rejection of `p`, so a test can look at more than a substring of it. */
async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection, got a resolution');
}

const save = () =>
  routines.save({ agentId: 'a', path: '.ax/routines/x.md', sourceMd: 'md' });
const remove = () => routines.remove({ agentId: 'a', path: '.ax/routines/x.md' });

describe('lib/routines', () => {
  it('list hydrates lastRunAt to Date', async () => {
    mockJson(200, {
      routines: [
        {
          agentId: 'agt_a',
          path: 'p',
          name: 'r',
          description: 'd',
          trigger: { kind: 'interval', every: '24h' },
          conversation: 'shared',
          lastStatus: 'ok',
          lastError: null,
          lastRunAt: '2026-05-17T00:00:00.000Z',
        },
      ],
    });
    const out = await routines.list();
    expect(out[0]!.lastRunAt instanceof Date).toBe(true);
  });

  it('list keeps a null lastRunAt as null (never fired)', async () => {
    mockJson(200, {
      routines: [
        {
          agentId: 'agt_a',
          path: 'p',
          name: 'r',
          description: 'd',
          trigger: { kind: 'interval', every: '24h' },
          conversation: 'shared',
          lastStatus: null,
          lastError: null,
          lastRunAt: null,
        },
      ],
    });
    const out = await routines.list();
    expect(out[0]!.lastRunAt).toBeNull();
  });

  it('recentFires URL-encodes the agentId', async () => {
    mockJson(200, { fires: [] });
    await routines.recentFires({ agentId: 'agt:with/slash', path: 'p' });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('agt%3Awith%2Fslash');
  });

  it('recentFires sets the limit query param when provided', async () => {
    mockJson(200, { fires: [] });
    await routines.recentFires({ agentId: 'a', path: 'p', limit: 20 });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('limit=20');
  });

  it('recentFires hydrates firedAt to Date', async () => {
    mockJson(200, {
      fires: [
        {
          id: 1,
          agentId: 'a',
          path: 'p',
          firedAt: '2026-05-17T01:23:45.000Z',
          triggerSource: 'manual',
          status: 'ok',
          error: null,
          conversationId: 'cnv',
          renderedPrompt: 'hello',
        },
      ],
    });
    const out = await routines.recentFires({ agentId: 'a', path: 'p' });
    expect(out[0]!.firedAt instanceof Date).toBe(true);
  });

  it('fireNow posts payload when provided', async () => {
    mockJson(200, { status: 'ok' });
    await routines.fireNow({ agentId: 'a', path: 'p', payload: { x: 1 } });
    const body = JSON.parse(
      fetchMock.mock.calls[0]![1]!.body as string,
    ) as { payload?: unknown };
    expect(body.payload).toEqual({ x: 1 });
  });

  it('fireNow omits payload when undefined', async () => {
    mockJson(200, { status: 'ok' });
    await routines.fireNow({ agentId: 'a', path: 'p' });
    const body = JSON.parse(
      fetchMock.mock.calls[0]![1]!.body as string,
    ) as Record<string, unknown>;
    expect('payload' in body).toBe(false);
    expect(body.path).toBe('p');
  });

  it('surfaces server error message', async () => {
    mockJson(403, { error: { message: 'forbidden' } });
    await expect(routines.list()).rejects.toThrow('forbidden');
  });

  it('falls back to HTTP <status> when error body is unparseable', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    await expect(routines.list()).rejects.toThrow('HTTP 500');
  });

  it('listAgentDefaults GETs the owner-scoped path and returns defaults', async () => {
    mockJson(200, {
      defaults: [
        { defaultRoutineId: 'skill-reflection', name: 'skill-reflection', enabled: false },
      ],
    });
    const out = await routines.listAgentDefaults('agt:with/slash');
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe('/settings/routines/agt%3Awith%2Fslash/defaults');
    expect(out[0]!.enabled).toBe(false);
  });

  it('setAgentDefaultEnabled POSTs { enabled } to the per-default path', async () => {
    mockJson(200, { ok: true });
    await routines.setAgentDefaultEnabled({
      agentId: 'a1',
      defaultRoutineId: 'skill-reflection',
      enabled: false,
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe('/settings/routines/a1/defaults/skill-reflection');
    const body = JSON.parse(
      fetchMock.mock.calls[0]![1]!.body as string,
    ) as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });

  it('setAgentDefaultEnabled surfaces the server error message', async () => {
    mockJson(403, { error: { message: 'forbidden' } });
    await expect(
      routines.setAgentDefaultEnabled({
        agentId: 'a1',
        defaultRoutineId: 'skill-reflection',
        enabled: true,
      }),
    ).rejects.toThrow('forbidden');
  });

  it('list exposes the full editable fields (promptBody, activeHours, silenceToken, silenceMaxChars)', async () => {
    mockJson(200, {
      routines: [
        {
          agentId: 'agt_a',
          path: '.ax/routines/r.md',
          name: 'r',
          description: 'd',
          trigger: { kind: 'interval', every: '1h' },
          conversation: 'shared',
          lastStatus: 'ok',
          lastError: null,
          lastRunAt: null,
          promptBody: 'do the thing',
          activeHours: { start: '09:00', end: '17:00', tz: 'UTC' },
          silenceToken: 'NOTHING',
          silenceMaxChars: 500,
        },
      ],
    });
    const out = await routines.list();
    expect(out[0]!.promptBody).toBe('do the thing');
    expect(out[0]!.activeHours).toEqual({ start: '09:00', end: '17:00', tz: 'UTC' });
    expect(out[0]!.silenceToken).toBe('NOTHING');
    expect(out[0]!.silenceMaxChars).toBe(500);
  });

  it('save PUTs JSON {path, sourceMd} to the agent route and returns {path}', async () => {
    mockJson(200, { path: '.ax/routines/hb.md' });
    const out = await routines.save({
      agentId: 'agt:x/y',
      path: '.ax/routines/hb.md',
      sourceMd: '---\nname: hb\n---\nbody',
    });
    expect(out.path).toBe('.ax/routines/hb.md');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/settings/routines/agt%3Ax%2Fy');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['X-Requested-With']).toBe('ax-admin');
    const body = JSON.parse(init.body as string) as { path: string; sourceMd: string };
    expect(body).toEqual({ path: '.ax/routines/hb.md', sourceMd: '---\nname: hb\n---\nbody' });
  });

  it('save surfaces the server error message', async () => {
    mockJson(400, { error: { message: 'interval.every: minimum is 60s' } });
    await expect(
      routines.save({ agentId: 'a', path: '.ax/routines/x.md', sourceMd: 'bad' }),
    ).rejects.toThrow('minimum is 60s');
  });

  it('remove DELETEs the agent route with ?path (encoded) and resolves void', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204 } as Response);
    await expect(
      routines.remove({ agentId: 'agt_a', path: '.ax/routines/hb.md' }),
    ).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/settings/routines/agt_a?path=.ax%2Froutines%2Fhb.md');
    expect(init.method).toBe('DELETE');
  });

  it('remove surfaces the server error message', async () => {
    mockJson(403, { error: { message: 'forbidden' } });
    await expect(
      routines.remove({ agentId: 'a', path: '.ax/routines/x.md' }),
    ).rejects.toThrow('forbidden');
  });

  it('webhookToken GETs the agent webhook-token route and returns the token', async () => {
    mockJson(200, { token: 'wh-abc123' });
    const out = await routines.webhookToken('agt:x/y');
    expect(out.token).toBe('wh-abc123');
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe('/settings/routines/agt%3Ax%2Fy/webhook-token');
  });
});

/*
  TASK-719: what a failed save or delete SAYS.

  The bug (older than this task). `readError` read `body.error?.message`, but
  `@ax/routines-admin-routes` sends `{ error: '<string>' }`: every one of its
  400/403/404 answers is a bare string. `'…'.message` is undefined, so the
  person saw "HTTP 400" for a validator's "interval.every: minimum is 60s". The
  tests above mock `{ error: { message } }`, a shape no server ever sent, which
  is why nothing caught it. Everything below mocks what the server REALLY sends.
*/
describe('lib/routines: what a failed request says', () => {
  describe('the server sends a string error (its real shape)', () => {
    it('save shows the validator reason, not "HTTP 400"', async () => {
      mockJson(400, { error: '.ax/routines/x.md: interval.every: minimum is 60s' });
      const err = await failure(save());
      expect(err.message).toBe('.ax/routines/x.md: interval.every: minimum is 60s');
    });

    it('remove shows the reason, not "HTTP 400"', async () => {
      mockJson(400, { error: 'a policy said no' });
      expect((await failure(remove())).message).toBe('a policy said no');
    });

    it('a read and a POST show it too (one reader for all four verbs)', async () => {
      mockJson(403, { error: 'forbidden' });
      expect((await failure(routines.list())).message).toBe('forbidden');
      mockJson(400, { error: 'path must be of the form .ax/routines/<name>.md' });
      expect(
        (await failure(routines.fireNow({ agentId: 'a', path: 'p' }))).message,
      ).toBe('path must be of the form .ax/routines/<name>.md');
    });
  });

  describe('the shapes that carry nothing to show fall back to the status, never to JSON', () => {
    it.each([
      ['an empty string', { error: '' }],
      ['a blank string', { error: '   ' }],
      ['an object with no message', { error: { code: 'x' } }],
      ['an object with a non-string message', { error: { message: 42 } }],
      ['a non-string error', { error: 7 }],
      ['no error field at all', { detail: 'something' }],
      ['an array', []],
      ['a bare string', 'oops'],
      ['null', null],
    ])('%s reads as "HTTP 400"', async (_name, body) => {
      mockJson(400, body);
      const err = await failure(save());
      expect(err.message).toBe('HTTP 400');
      expect(err.message).not.toMatch(/[{}[\]]/);
    });

    it('a body that is not JSON reads as "HTTP <status>" (a 413 too)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 413,
        json: async () => {
          throw new Error('not json');
        },
      } as unknown as Response);
      expect((await failure(save())).message).toBe('HTTP 413');
    });
  });

  describe('a 413 storage-full: the server sentence, alone', () => {
    it("save shows the server's own sentence, as a StorageFullError with no status or code in it", async () => {
      mockJson(413, {
        error: 'storage-full',
        message: "We couldn't save that routine because your storage is full. An admin can make more room, then you can try again.",
      });
      const err = await failure(save());
      expect(err).toBeInstanceOf(StorageFullError);
      expect(err.message).toBe(
        "We couldn't save that routine because your storage is full. An admin can make more room, then you can try again.",
      );
      expect((err as StorageFullError).status).toBe(413);
    });

    it('remove shows the server sentence', async () => {
      mockJson(413, {
        error: 'storage-full',
        message: "We couldn't remove that routine because your storage is full. An admin can make more room, then you can try again.",
      });
      const err = await failure(remove());
      expect(err).toBeInstanceOf(StorageFullError);
      expect(err.message).toBe(
        "We couldn't remove that routine because your storage is full. An admin can make more room, then you can try again.",
      );
    });

    it('save wears the SAVE sentence when the server sent none', async () => {
      for (const body of [{ error: 'storage-full' }, { error: 'storage-full', message: '  ' }]) {
        mockJson(413, body);
        const err = await failure(save());
        expect(err).toBeInstanceOf(StorageFullError);
        expect(err.message).toBe(
          "We couldn't save that routine because your storage is full. An admin can make more room, then you can try again.",
        );
      }
    });

    it('remove wears the REMOVE sentence when the server sent none, not the save one', async () => {
      mockJson(413, { error: 'storage-full' });
      const err = await failure(remove());
      expect(err).toBeInstanceOf(StorageFullError);
      expect(err.message).toBe(
        "We couldn't remove that routine because your storage is full. An admin can make more room, then you can try again.",
      );
    });

    it('never reads the message of a 413 that is not the storage refusal', async () => {
      mockJson(413, { error: 'body-too-large', message: 'zzz not this' });
      const err = await failure(save());
      expect(err).not.toBeInstanceOf(StorageFullError);
      expect(err.message).toBe('body-too-large');
    });

    it('does not treat the storage code on any other status as the refusal', async () => {
      mockJson(400, { error: 'storage-full', message: 'zzz not this' });
      const err = await failure(save());
      expect(err).not.toBeInstanceOf(StorageFullError);
      expect(err.message).not.toContain('zzz');
    });
  });

  it('a 500 with a string error shows it; one with no usable body says "HTTP 500"', async () => {
    mockJson(500, { error: 'internal' });
    expect((await failure(save())).message).toBe('internal');
    mockJson(500, {});
    expect((await failure(save())).message).toBe('HTTP 500');
  });
});
