// ---------------------------------------------------------------------------
// TASK-1247: GET /admin/people, the sharing picker's "find a person by name".
//
// No Docker. The rules (the query, the name fence) are pure, and the handler
// takes its sign-in check and its store as plain functions. The SQL and the
// route as the plugin mounts it are in people-search-db.test.ts.
//
// Every invisible or bidi character here is built with String.fromCharCode,
// never typed as an escape (mistakes/2026-11-13-TASK-1093.md).
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';
import { PluginError, makeAgentContext, type Logger } from '@ax/core';
import type { HttpRequest, HttpResponse } from '@ax/http-server';
import {
  createPeopleSearchHandler,
  fencePersonName,
  parsePeopleQuery,
  type PeopleSearchDeps,
  type PersonMatch,
} from '../people-search.js';

/** RIGHT-TO-LEFT OVERRIDE: reverses how everything after it is drawn. */
const RLO = String.fromCharCode(0x202e);
/** ZERO WIDTH SPACE: invisible. */
const ZWSP = String.fromCharCode(0x200b);
const NUL = String.fromCharCode(0x0);
const ELLIPSIS = String.fromCharCode(0x2026);
/** One code point, two UTF-16 units. */
const GRIN = String.fromCodePoint(0x1f600);

interface LoggedError {
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function recordingLogger(): { logger: Logger; errors: LoggedError[] } {
  const errors: LoggedError[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg, bindings) => {
      errors.push({ msg, bindings });
    },
    child: () => logger,
  };
  return { logger, errors };
}

interface Setup {
  currentUserId?: PeopleSearchDeps['currentUserId'];
  store?: (query: string) => Promise<PersonMatch[]>;
  now?: () => number;
}

/** The handler with a stub sign-in (the `x-test-user` header) and a spied store. */
function setup(over: Setup = {}) {
  const { logger, errors } = recordingLogger();
  const findPeople = vi.fn(over.store ?? (async (): Promise<PersonMatch[]> => []));
  const deps: PeopleSearchDeps = {
    currentUserId:
      over.currentUserId ?? (async (req) => req.headers['x-test-user'] ?? 'usr_me'),
    findPeople,
    ctx: makeAgentContext({ sessionId: 'test', agentId: 'test', userId: 'system', logger }),
    ...(over.now !== undefined ? { now: over.now } : {}),
  };
  return { handler: createPeopleSearchHandler(deps), findPeople, errors };
}

interface Answer {
  status: number | undefined;
  headers: Record<string, string>;
  body: unknown;
}

async function ask(
  handler: (req: HttpRequest, res: HttpResponse) => Promise<void>,
  query: Record<string, string>,
  user = 'usr_me',
): Promise<Answer> {
  const answer: Answer = { status: undefined, headers: {}, body: undefined };
  const res = {
    status(n: number) {
      answer.status = n;
      return res;
    },
    header(name: string, value: string) {
      answer.headers[name.toLowerCase()] = value;
      return res;
    },
    json(v: unknown) {
      answer.body = v;
    },
  };
  const req = { query, headers: { 'x-test-user': user } };
  await handler(req as unknown as HttpRequest, res as unknown as HttpResponse);
  return answer;
}

function signedOut(): never {
  throw new PluginError({
    code: 'unauthenticated',
    plugin: '@ax/auth-better',
    hookName: 'auth:require-user',
    message: 'no session cookie',
  });
}

describe('parsePeopleQuery', () => {
  it('takes 2 to 64 characters, trimmed', () => {
    expect(parsePeopleQuery('  al ')).toBe('al');
    expect(parsePeopleQuery('x'.repeat(64))).toBe('x'.repeat(64));
    // Code points, not UTF-16 units: 64 of these are 128 units.
    expect(parsePeopleQuery(GRIN.repeat(64))).toBe(GRIN.repeat(64));
    for (const raw of [
      'a',
      '',
      '   a   ',
      GRIN,
      undefined,
      null,
      42,
      ['al'],
      'x'.repeat(65),
      GRIN.repeat(65),
    ]) {
      expect(parsePeopleQuery(raw)).toBeNull();
    }
  });

  it('refuses a query with a control or invisible character in it', () => {
    // A NUL would reach Postgres, which refuses it in text: a 500 for a typo.
    expect(parsePeopleQuery(`al${NUL}`)).toBeNull();
    expect(parsePeopleQuery(`Ali${RLO}ce`)).toBeNull();
    expect(parsePeopleQuery(`al${ZWSP}ice`)).toBeNull();
    expect(parsePeopleQuery('al\tice')).toBeNull();
  });
});

describe('fencePersonName', () => {
  it('drops bidi and zero-width characters, collapses whitespace and caps at 80', () => {
    expect(fencePersonName(`Ali${RLO}ce`)).toBe('Ali ce');
    expect(fencePersonName('  Bob \n Stone ')).toBe('Bob Stone');
    expect(fencePersonName(`Zo${ZWSP}${ZWSP}e`)).toBe('Zo e');
    expect(fencePersonName('x'.repeat(80))).toBe('x'.repeat(80));
    const cut = fencePersonName('x'.repeat(200));
    expect(cut).toBe(`${'x'.repeat(79)}${ELLIPSIS}`);
    expect([...(cut ?? '')]).toHaveLength(80);
    // Counted in code points, so a character is never cut in half.
    expect(fencePersonName(GRIN.repeat(100))).toBe(`${GRIN.repeat(79)}${ELLIPSIS}`);
  });

  it('is null when nothing legible is left', () => {
    expect(fencePersonName(ZWSP)).toBeNull();
    expect(fencePersonName('   ')).toBeNull();
    expect(fencePersonName('')).toBeNull();
    expect(fencePersonName(null)).toBeNull();
  });
});

describe('GET /admin/people handler', () => {
  it('answers 401 when nobody is signed in, and never searches', async () => {
    const { handler, findPeople } = setup({ currentUserId: async () => signedOut() });
    const a = await ask(handler, { q: 'ali' });
    expect(a.status).toBe(401);
    expect(a.body).toEqual({ error: 'unauthenticated' });
    expect(findPeople).toHaveBeenCalledTimes(0);
  });

  it('answers a logged 500 when the session check itself fails, and never searches', async () => {
    const { handler, findPeople, errors } = setup({
      currentUserId: async () => {
        throw new Error('connection terminated unexpectedly');
      },
    });
    const a = await ask(handler, { q: 'ali' });
    expect(a.status).toBe(500);
    expect(a.body).toEqual({ error: 'internal' });
    expect(errors.map((e) => e.msg)).toEqual(['auth_people_search_require_user_failed']);
    expect(findPeople).toHaveBeenCalledTimes(0);
  });

  it('answers 400 invalid-query for a missing, one-character or 65-character q', async () => {
    const { handler, findPeople } = setup();
    for (const query of [{}, { q: 'a' }, { q: 'x'.repeat(65) }]) {
      const a = await ask(handler, query);
      expect(a.status).toBe(400);
      expect(a.body).toEqual({ error: 'invalid-query' });
    }
    expect(findPeople).toHaveBeenCalledTimes(0);
  });

  it('searches for the trimmed query and answers only id and displayName', async () => {
    const { handler, findPeople } = setup({
      store: async () => [{ id: 'u1', displayName: 'Ada', email: 'ada@x' } as never],
    });
    const a = await ask(handler, { q: '  ad ' });
    expect(findPeople).toHaveBeenCalledTimes(1);
    expect(findPeople).toHaveBeenCalledWith('ad');
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ people: [{ id: 'u1', displayName: 'Ada' }] });
    expect(JSON.stringify(a.body)).not.toContain('@');
  });

  it('answers at most 10 people with fenced names, whatever the store hands it', async () => {
    const { handler } = setup({
      store: async () => [
        { id: 'u1', displayName: `Ev${RLO}e` },
        { id: 'u2', displayName: ZWSP },
        ...Array.from({ length: 12 }, (_, i) => ({ id: `z${i}`, displayName: `Zed ${i}` })),
      ],
    });
    const a = await ask(handler, { q: 'ev' });
    expect(a.status).toBe(200);
    expect(a.body).toEqual({
      people: [
        { id: 'u1', displayName: 'Ev e' },
        { id: 'z0', displayName: 'Zed 0' },
        { id: 'z1', displayName: 'Zed 1' },
        { id: 'z2', displayName: 'Zed 2' },
        { id: 'z3', displayName: 'Zed 3' },
        { id: 'z4', displayName: 'Zed 4' },
        { id: 'z5', displayName: 'Zed 5' },
        { id: 'z6', displayName: 'Zed 6' },
        { id: 'z7', displayName: 'Zed 7' },
        { id: 'z8', displayName: 'Zed 8' },
      ],
    });
  });

  it("allows 60 searches a minute per person, then 429 with retry-after 60; another person is unaffected; a minute later it's open again", async () => {
    let t = 1_000_000;
    const { handler, findPeople } = setup({ now: () => t });
    for (let i = 0; i < 60; i++) {
      expect((await ask(handler, { q: 'ali' }, 'usr_a')).status).toBe(200);
    }
    const refused = await ask(handler, { q: 'ali' }, 'usr_a');
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBe('60');
    expect(refused.body).toEqual({ error: 'rate-limited', message: expect.any(String) });
    expect((refused.body as { message: string }).message.length).toBeGreaterThan(0);
    // The refused search never reached the store.
    expect(findPeople).toHaveBeenCalledTimes(60);

    expect((await ask(handler, { q: 'ali' }, 'usr_b')).status).toBe(200);

    t += 59_999;
    expect((await ask(handler, { q: 'ali' }, 'usr_a')).status).toBe(429);
    t += 1;
    expect((await ask(handler, { q: 'ali' }, 'usr_a')).status).toBe(200);
  });

  it('sets cache-control private, no-store on 200, 400, 401 and 429', async () => {
    const { handler } = setup({ now: () => 0 });
    const ok = await ask(handler, { q: 'ali' });
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('private, no-store');

    const bad = await ask(handler, { q: 'a' });
    expect(bad.status).toBe(400);
    expect(bad.headers['cache-control']).toBe('private, no-store');

    for (let i = 0; i < 58; i++) await ask(handler, { q: 'ali' });
    const limited = await ask(handler, { q: 'ali' });
    expect(limited.status).toBe(429);
    expect(limited.headers['cache-control']).toBe('private, no-store');

    const out = setup({ currentUserId: async () => signedOut() });
    const unauth = await ask(out.handler, { q: 'ali' });
    expect(unauth.status).toBe(401);
    expect(unauth.headers['cache-control']).toBe('private, no-store');
  });
});
