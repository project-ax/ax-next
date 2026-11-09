import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginError } from '@ax/core';
import { DEFAULT_REGISTRY_URL, MAX_CURSOR_CHARS, MAX_PAGE_BYTES } from '../limits.js';
import {
  RegistryError,
  fetchRegistryPage,
  fetchRegistryPageWithRetry,
  parseRegistryUrl,
  registryPageUrl,
  waitUnlessAborted,
} from '../registry-client.js';
import { createFakeRegistry, page, waitForAbort } from './support/fake-registry.js';

const BASE = parseRegistryUrl('https://registry.test');
const MIB = 1024 * 1024;

/** The RegistryError a call rejects with; fails the test on anything else. */
async function failure(p: Promise<unknown>): Promise<RegistryError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(RegistryError);
    return err as RegistryError;
  }
  throw new Error('expected the call to reject');
}

function json(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init });
}

describe('parseRegistryUrl', () => {
  it('accepts the official registry and a subregistry, dropping trailing slashes', () => {
    expect(parseRegistryUrl(DEFAULT_REGISTRY_URL).origin).toBe(DEFAULT_REGISTRY_URL);
    expect(parseRegistryUrl('https://sub.example/registry/').pathname).toBe('/registry');
    expect(parseRegistryUrl('https://sub.example/registry//').pathname).toBe('/registry');
    const withPort = parseRegistryUrl('https://sub.example:8443/registry');
    expect(withPort.port).toBe('8443');
  });

  it.each([
    'http://registry.example',
    'https://u:p@registry.example',
    'https://registry.example/?a=1',
    'https://registry.example/#x',
    'not a url',
    // Empty query / fragment markers, which the parser reports as no query.
    'https://registry.example/?',
    'https://registry.example/#',
    // Whitespace the parser would silently strip or drop.
    ' https://registry.example',
    'https://registry.ex\nample',
    '',
  ])('refuses %j with invalid-config', (raw) => {
    let caught: unknown;
    try {
      parseRegistryUrl(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-config');
    expect((caught as PluginError).plugin).toBe('@ax/connector-directory');
  });

  it('never echoes the configured URL, which may carry a password', () => {
    let message = '';
    try {
      parseRegistryUrl('https://admin:hunter2@registry.example');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('registry.example');
  });
});

describe('registryPageUrl', () => {
  it('asks for the latest version of each server, a full page at a time', () => {
    expect(registryPageUrl(BASE, {}).href).toBe(
      'https://registry.test/v0.1/servers?limit=100&version=latest',
    );
  });

  it('adds updated_since as ISO and the cursor as one query value', () => {
    const since = registryPageUrl(BASE, { since: new Date('2026-11-09T00:00:00Z') });
    expect(since.searchParams.get('updated_since')).toBe('2026-11-09T00:00:00.000Z');

    const cursor = 'io.github.a/b:1.0.0&evil=1';
    const next = registryPageUrl(BASE, { cursor });
    expect(next.searchParams.get('cursor')).toBe(cursor);
    expect(next.searchParams.get('evil')).toBeNull();
    expect(next.origin).toBe('https://registry.test');
    expect(next.pathname).toBe('/v0.1/servers');
  });

  it('keeps a subregistry base path and never changes the base', () => {
    const base = new URL('https://sub.test/registry');
    expect(registryPageUrl(base, {}).pathname).toBe('/registry/v0.1/servers');
    expect(registryPageUrl(parseRegistryUrl('https://sub.test/registry/'), {}).pathname).toBe(
      '/registry/v0.1/servers',
    );
    expect(base.href).toBe('https://sub.test/registry');
  });
});

describe('fetchRegistryPage', () => {
  it('GETs with redirect: manual, an AbortSignal and accept: application/json', async () => {
    const fake = createFakeRegistry(() => page([]));
    await fetchRegistryPage(fake.fetchImpl, BASE, { cursor: 'c1' });

    expect(fake.requests.map((u) => u.href)).toEqual([
      registryPageUrl(BASE, { cursor: 'c1' }).href,
    ]);
    const init = fake.inits[0]!;
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Nothing but accept: no credential, no cookie, no identifying header.
    const headers = new Headers(init.headers);
    expect([...headers.keys()]).toEqual(['accept']);
    expect(headers.get('accept')).toBe('application/json');
  });

  it('returns servers and nextCursor', async () => {
    const servers = [{ server: { name: 'com.example/a' } }, { server: { name: 'com.example/b' } }];
    const fake = createFakeRegistry(() => page(servers, 'com.example/b:1.0.0'));
    expect(await fetchRegistryPage(fake.fetchImpl, BASE, {})).toEqual({
      servers,
      nextCursor: 'com.example/b:1.0.0',
    });
  });

  it('an empty or missing nextCursor means last page', async () => {
    for (const body of [
      '{"servers":[],"metadata":{"nextCursor":""}}',
      '{"servers":[],"metadata":{"count":0}}',
      '{"servers":[],"metadata":{"nextCursor":null}}',
      '{"servers":[],"metadata":null}',
      '{"servers":[]}',
    ]) {
      const fake = createFakeRegistry(() => json(body));
      const out = await fetchRegistryPage(fake.fetchImpl, BASE, {});
      expect(out).toStrictEqual({ servers: [] });
    }
  });

  it('a cursor of exactly MAX_CURSOR_CHARS is kept', async () => {
    const cursor = 'c'.repeat(MAX_CURSOR_CHARS);
    const fake = createFakeRegistry(() => page([], cursor));
    expect((await fetchRegistryPage(fake.fetchImpl, BASE, {})).nextCursor).toBe(cursor);
  });

  it.each<[string, () => Response, string]>([
    [
      '301',
      () => new Response(null, { status: 301, headers: { location: 'https://elsewhere.example/' } }),
      'redirect',
    ],
    [
      '307',
      () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/' } }),
      'redirect',
    ],
    [
      'a fetch that followed a redirect anyway',
      () => Object.defineProperty(page([]), 'redirected', { value: true }),
      'redirect',
    ],
    ['503', () => new Response('busy', { status: 503 }), 'http-503'],
    ['404', () => new Response(null, { status: 404 }), 'http-404'],
    [
      'a content-length over MAX_PAGE_BYTES',
      () => json('{"servers":[]}', { headers: { 'content-length': String(MAX_PAGE_BYTES + 1) } }),
      'too-large',
    ],
    ['not JSON', () => json('not json'), 'invalid-json'],
    ['an empty body', () => json(''), 'invalid-json'],
    ['a JSON array', () => json('[]'), 'invalid-shape'],
    ['servers that is not an array', () => json('{"servers":{}}'), 'invalid-shape'],
    ['no servers', () => json('{"metadata":{}}'), 'invalid-shape'],
    ['a nextCursor over MAX_CURSOR_CHARS', () => page([], 'c'.repeat(MAX_CURSOR_CHARS + 1)), 'invalid-shape'],
    ['a nextCursor that is not a string', () => json('{"servers":[],"metadata":{"nextCursor":7}}'), 'invalid-shape'],
    ['metadata that is not an object', () => json('{"servers":[],"metadata":"x"}'), 'invalid-shape'],
    [
      'a body that breaks off mid-stream',
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"servers":['));
              controller.error(new TypeError('terminated'));
            },
          }),
          { status: 200 },
        ),
      'network',
    ],
  ])('%s fails with the fixed reason', async (_label, respond, reason) => {
    const fake = createFakeRegistry(respond);
    const err = await failure(fetchRegistryPage(fake.fetchImpl, BASE, {}));
    expect(err.reason).toBe(reason);
    expect(err.message).toBe(`registry request failed: ${reason}`);
  });

  it('a streamed body past the cap with no content-length is too-large, and reading stops', async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls <= 8) controller.enqueue(new Uint8Array(MIB).fill(0x20));
          else controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const fake = createFakeRegistry(() => new Response(body, { status: 200 }));
    const err = await failure(fetchRegistryPage(fake.fetchImpl, BASE, {}));
    expect(err.reason).toBe('too-large');
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(MAX_PAGE_BYTES / MIB + 2);
  });

  it('a rejected fetch is network', async () => {
    const fake = createFakeRegistry(() => Promise.reject(new TypeError('fetch failed')));
    expect((await failure(fetchRegistryPage(fake.fetchImpl, BASE, {}))).reason).toBe('network');
  });

  it('a request that outlives timeoutMs is timeout', async () => {
    const fake = createFakeRegistry((_url, init) => waitForAbort(init));
    const err = await failure(fetchRegistryPage(fake.fetchImpl, BASE, {}, { timeoutMs: 20 }));
    expect(err.reason).toBe('timeout');
  });

  it("the caller's signal aborting mid-request is aborted", async () => {
    const controller = new AbortController();
    const fake = createFakeRegistry((_url, init) => {
      const pending = waitForAbort(init);
      controller.abort();
      return pending;
    });
    const err = await failure(
      fetchRegistryPage(fake.fetchImpl, BASE, {}, { signal: controller.signal }),
    );
    expect(err.reason).toBe('aborted');
  });

  it("a caller's own deadline running out reads as timeout, not aborted", async () => {
    const fake = createFakeRegistry((_url, init) => waitForAbort(init));
    const err = await failure(
      fetchRegistryPage(fake.fetchImpl, BASE, {}, { signal: AbortSignal.timeout(20) }),
    );
    expect(err.reason).toBe('timeout');
  });

  it('an already-aborted caller signal is aborted without a request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = createFakeRegistry(() => page([]));
    const err = await failure(
      fetchRegistryPage(fake.fetchImpl, BASE, {}, { signal: controller.signal }),
    );
    expect(err.reason).toBe('aborted');
    expect(fake.requests).toHaveLength(0);
  });

  it("a caller's deadline that ran out between pages is timeout, without a request", async () => {
    // The sync's run budget, as the plugin builds it: a deadline joined with
    // the shutdown signal. Spent before the next page, it is still a timeout.
    const budget = AbortSignal.timeout(1);
    await vi.waitFor(() => expect(budget.aborted).toBe(true));
    const signal = AbortSignal.any([budget, new AbortController().signal]);
    const fake = createFakeRegistry(() => page([]));
    const err = await failure(fetchRegistryPage(fake.fetchImpl, BASE, {}, { signal }));
    expect(err.reason).toBe('timeout');
    expect(fake.requests).toHaveLength(0);
  });

  it('never echoes response text', async () => {
    const SECRET = 'UPSTREAM-SECRET';
    const answers: Array<() => Response> = [
      () => new Response(SECRET, { status: 500 }),
      () => json(SECRET),
      () => json(`{"servers":"${SECRET}"}`),
      () => new Response(null, { status: 302, headers: { location: `https://${SECRET}.example/` } }),
    ];
    for (const respond of answers) {
      const fake = createFakeRegistry(respond);
      const err = await failure(fetchRegistryPage(fake.fetchImpl, BASE, {}));
      expect(err.message).not.toContain(SECRET);
      expect(String(err)).not.toContain(SECRET);
      expect(JSON.stringify(err)).not.toContain(SECRET);
      expect(err.cause).toBeUndefined();
    }
  });
});

describe('fetchRegistryPageWithRetry', () => {
  type Answer = (init: RequestInit) => Response | Promise<Response>;

  /** A fake answering each request with the next answer, in order. */
  function inTurn(...answers: Answer[]) {
    return createFakeRegistry((_url, init) => {
      const next = answers.shift();
      if (next === undefined) throw new Error('asked for the page once too often');
      return next(init);
    });
  }

  /** A sleep that only records how long it was asked to wait. */
  function recordingSleep() {
    const waits: number[] = [];
    return {
      waits,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    };
  }

  const status = (n: number) => () => new Response(null, { status: n });

  it('a page that fails once with 503 and then answers is returned, after one 1 s wait', async () => {
    const fake = inTurn(status(503), () => page([], 'c2'));
    const { waits, sleep } = recordingSleep();
    expect(
      await fetchRegistryPageWithRetry(fake.fetchImpl, BASE, { cursor: 'c1' }, { sleep }),
    ).toEqual({ servers: [], nextCursor: 'c2' });
    expect(waits).toEqual([1_000]);
    // The retry asks for the same page again.
    const same = registryPageUrl(BASE, { cursor: 'c1' }).href;
    expect(fake.requests.map((u) => u.href)).toEqual([same, same]);
  });

  it('three 503s in a row: two retries, 1 s then 4 s apart, and the 503 is final', async () => {
    const fake = createFakeRegistry(status(503));
    const { waits, sleep } = recordingSleep();
    const err = await failure(fetchRegistryPageWithRetry(fake.fetchImpl, BASE, {}, { sleep }));
    expect(err.reason).toBe('http-503');
    expect(fake.requests).toHaveLength(3);
    expect(waits).toEqual([1_000, 4_000]);
  });

  it.each<[string, Answer]>([
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
    ['429', status(429)],
    ['500', status(500)],
    ['502', status(502)],
    ['599', status(599)],
    ['a request that outlives its own deadline', (init) => waitForAbort(init)],
  ])('%s is asked for again', async (_label, first) => {
    const fake = inTurn(first, () => page([]));
    const { waits, sleep } = recordingSleep();
    // A live caller signal, as the plugin always passes (run budget + shutdown).
    const signal = new AbortController().signal;
    expect(
      await fetchRegistryPageWithRetry(fake.fetchImpl, BASE, {}, { signal, sleep, timeoutMs: 20 }),
    ).toEqual({ servers: [] });
    expect(fake.requests).toHaveLength(2);
    expect(waits).toEqual([1_000]);
  });

  it.each<[string, Answer, string]>([
    ['404', status(404), 'http-404'],
    ['400', status(400), 'http-400'],
    ['not JSON', () => json('not json'), 'invalid-json'],
    [
      'a redirect',
      () => new Response(null, { status: 301, headers: { location: 'https://elsewhere.example/' } }),
      'redirect',
    ],
    [
      'a content-length over MAX_PAGE_BYTES',
      () => json('{"servers":[]}', { headers: { 'content-length': String(MAX_PAGE_BYTES + 1) } }),
      'too-large',
    ],
    ['a JSON array', () => json('[]'), 'invalid-shape'],
  ])('%s is final at once: no retry', async (_label, respond, reason) => {
    const fake = createFakeRegistry((_url, init) => respond(init));
    const { waits, sleep } = recordingSleep();
    const err = await failure(fetchRegistryPageWithRetry(fake.fetchImpl, BASE, {}, { sleep }));
    expect(err.reason).toBe(reason);
    expect(fake.requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('a shutdown abort is never retried', async () => {
    const controller = new AbortController();
    const fake = createFakeRegistry((_url, init) => {
      const pending = waitForAbort(init);
      controller.abort();
      return pending;
    });
    const { waits, sleep } = recordingSleep();
    const err = await failure(
      fetchRegistryPageWithRetry(fake.fetchImpl, BASE, {}, { signal: controller.signal, sleep }),
    );
    expect(err.reason).toBe('aborted');
    expect(fake.requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('a run budget that runs out is never retried, though it reads as timeout', async () => {
    const fake = createFakeRegistry((_url, init) => waitForAbort(init));
    const { waits, sleep } = recordingSleep();
    const err = await failure(
      fetchRegistryPageWithRetry(fake.fetchImpl, BASE, {}, {
        signal: AbortSignal.timeout(20),
        timeoutMs: 60_000,
        sleep,
      }),
    );
    expect(err.reason).toBe('timeout');
    expect(fake.requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('a shutdown during the wait ends it there, without asking again', async () => {
    const controller = new AbortController();
    const fake = createFakeRegistry(status(503));
    const waits: number[] = [];
    const err = await failure(
      fetchRegistryPageWithRetry(fake.fetchImpl, BASE, {}, {
        signal: controller.signal,
        sleep: async (ms) => {
          waits.push(ms);
          controller.abort();
        },
      }),
    );
    expect(err.reason).toBe('aborted');
    expect(fake.requests).toHaveLength(1);
    expect(waits).toEqual([1_000]);
  });

  it('a run budget that runs out during the wait ends it as timeout, without asking again', async () => {
    const fake = createFakeRegistry(status(503));
    const err = await failure(
      fetchRegistryPageWithRetry(fake.fetchImpl, BASE, {}, {
        signal: AbortSignal.timeout(20),
        sleep: async (_ms, signal) => {
          await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        },
      }),
    );
    expect(err.reason).toBe('timeout');
    expect(fake.requests).toHaveLength(1);
  });
});

describe('waitUnlessAborted', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits the time it is given', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let done = false;
    void waitUnlessAborted(1_000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('ends as soon as the signal aborts, leaving no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const wait = waitUnlessAborted(4_000, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    // No clock advance: only the abort can end this wait.
    controller.abort();
    await wait;
    expect(vi.getTimerCount()).toBe(0);
    // Already aborted: no wait and no timer at all.
    await waitUnlessAborted(4_000, controller.signal);
    expect(vi.getTimerCount()).toBe(0);
  });
});
