import { describe, expect, it } from 'vitest';
import { REWRITES_THE_SURFACE } from '@ax/core/surface-text';
import {
  DESCRIPTION_MAX,
  MAX_HEADERS_CONSIDERED,
  MAX_REMOTES_CONSIDERED,
  TITLE_MAX,
} from '../limits.js';
import {
  cleanText,
  deriveAuth,
  derivePublisher,
  pickRemote,
  planEntry,
  type DirectoryRow,
  type EntryPlan,
} from '../normalize.js';
import { header, listing, npmPackage, remote } from './support/listing.js';

const NAME = 'com.example/server';

function upserted(plan: EntryPlan): DirectoryRow {
  if (plan.kind !== 'upsert') throw new Error(`expected an upsert, got ${JSON.stringify(plan)}`);
  return plan.row;
}

/** True when `s` holds a UTF-16 surrogate half with no partner. */
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

describe('planEntry: which listings become rows', () => {
  it('keeps a listing with a streamable-http remote', () => {
    expect(planEntry(listing({ name: NAME, title: 'Example' }))).toEqual({
      kind: 'upsert',
      row: {
        id: NAME,
        title: 'Example',
        description: 'A test server',
        publisher: 'example.com',
        publisherProof: 'domain',
        url: 'https://mcp.example.com/mcp',
        auth: 'none',
        keyHeader: null,
        version: '1.0.0',
        updatedAt: new Date('2026-11-01T00:00:00Z'),
        deprecated: false,
      },
    });
  });

  it('keeps an sse-only listing', () => {
    const row = upserted(
      planEntry(listing({ name: NAME, remotes: [remote('https://sse.example.com/sse', 'sse')] })),
    );
    expect(row.url).toBe('https://sse.example.com/sse');
  });

  it('prefers streamable-http over sse when both are listed', () => {
    const row = upserted(
      planEntry(
        listing({
          name: NAME,
          remotes: [
            // Listed first, and it declares a key: neither may leak into the row.
            remote('https://sse.example.com/sse', 'sse', [
              header('X-API-Key', { isRequired: true, isSecret: true }),
            ]),
            remote('https://mcp.example.com/mcp'),
          ],
        }),
      ),
    );
    expect(row.url).toBe('https://mcp.example.com/mcp');
    expect(row.auth).toBe('none');
    expect(row.keyHeader).toBeNull();
  });

  it('a package-only listing deletes any stored row', () => {
    const gone = { kind: 'delete', id: NAME, reason: 'no-usable-remote' };
    expect(planEntry(listing({ name: NAME, remotes: [], packages: [npmPackage()] }))).toEqual(gone);

    const noRemotesKey = listing({ name: NAME, packages: [npmPackage()] }) as {
      server: Record<string, unknown>;
    };
    delete noRemotesKey.server['remotes'];
    expect(planEntry(noRemotesKey)).toEqual(gone);

    expect(
      planEntry(listing({ name: NAME, remotes: [remote('https://mcp.example.com/mcp', 'stdio')] })),
    ).toEqual(gone);
  });

  it.each([
    ['plain http', 'http://x.example/mcp'],
    ['a templated host', 'https://{tenant}.example.com/mcp'],
    ['a templated path', 'https://x.example/{t}/mcp'],
    ['userinfo', 'https://u:p@x.example/mcp'],
    ['a newline inside the host', 'https://x.example\n.evil.example/x'],
    ['leading whitespace', ' https://x.example/mcp'],
    ['an href over 2048', 'https://x.example/' + 'a'.repeat(2048)],
    // 1,018 characters raw, 6,018 once each é is percent-encoded.
    ['a path that percent-encodes past 2048', 'https://x.example/' + 'é'.repeat(1000)],
    ['a zero-width character', 'https://x.exa​mple/mcp'],
    ['not a URL', 'mcp.example.com/mcp'],
    ['not a string', 42],
  ])('refuses unusable remote URLs: %s', (_label, url) => {
    expect(
      planEntry(listing({ name: NAME, remotes: [{ type: 'streamable-http', url }] })),
    ).toEqual({ kind: 'delete', id: NAME, reason: 'no-usable-remote' });
  });

  it('an href of exactly 2048 is kept', () => {
    const url = 'https://x.example/' + 'a'.repeat(2030);
    expect(url).toHaveLength(2048);
    expect(upserted(planEntry(listing({ name: NAME, remotes: [remote(url)] }))).url).toBe(url);
  });

  it('a listing whose first remote is bad and second is good keeps the second', () => {
    const row = upserted(
      planEntry(
        listing({
          name: NAME,
          remotes: [remote('https://{tenant}.example.com/mcp'), remote('https://good.example.com/mcp')],
        }),
      ),
    );
    expect(row.url).toBe('https://good.example.com/mcp');
  });

  it('looks at no more than MAX_REMOTES_CONSIDERED remotes', () => {
    const bad = Array.from({ length: MAX_REMOTES_CONSIDERED }, () => remote('http://x.example/mcp'));
    expect(
      planEntry(listing({ name: NAME, remotes: [...bad, remote('https://good.example.com/mcp')] })),
    ).toEqual({ kind: 'delete', id: NAME, reason: 'no-usable-remote' });
    const row = upserted(
      planEntry(
        listing({ name: NAME, remotes: [...bad.slice(1), remote('https://good.example.com/mcp')] }),
      ),
    );
    expect(row.url).toBe('https://good.example.com/mcp');
  });

  it('stores the WHATWG href, so a lookalike host shows as punycode', () => {
    const row = upserted(
      planEntry(listing({ name: NAME, remotes: [remote('https://nоtion.com/mcp')] })),
    );
    expect(row.url).toBe('https://xn--ntion-jye.com/mcp');

    const normalized = upserted(
      planEntry(listing({ name: NAME, remotes: [remote('HTTPS://MCP.Example.COM:443/mcp')] })),
    );
    expect(normalized.url).toBe('https://mcp.example.com/mcp');
  });

  it('status deleted deletes; deprecated keeps and flags; an unknown status deletes; isLatest:false is skipped', () => {
    expect(planEntry(listing({ name: NAME, status: 'deleted' }))).toEqual({
      kind: 'delete',
      id: NAME,
      reason: 'deleted',
    });
    // The registry's word on deletion wins over what else is wrong with the entry.
    expect(planEntry(listing({ name: NAME, status: 'deleted', remotes: [] }))).toEqual({
      kind: 'delete',
      id: NAME,
      reason: 'deleted',
    });

    expect(upserted(planEntry(listing({ name: NAME, status: 'deprecated' }))).deprecated).toBe(true);
    expect(upserted(planEntry(listing({ name: NAME, status: 'active' }))).deprecated).toBe(false);
    expect(upserted(planEntry(listing({ name: NAME, meta: { status: undefined } }))).deprecated).toBe(
      false,
    );

    for (const status of ['quarantined', 'DELETED', 7, null]) {
      expect(planEntry(listing({ name: NAME, meta: { status } }))).toEqual({
        kind: 'delete',
        id: NAME,
        reason: 'invalid-fields',
      });
    }

    expect(planEntry(listing({ name: NAME, isLatest: false }))).toEqual({
      kind: 'skip',
      reason: 'not-latest',
    });
    // A superseded version says nothing about the latest, even when it says "deleted".
    expect(planEntry(listing({ name: NAME, isLatest: false, status: 'deleted' }))).toEqual({
      kind: 'skip',
      reason: 'not-latest',
    });
  });

  it('a name that fails the registry pattern or exceeds 200 is skipped as malformed', () => {
    const malformed = { kind: 'skip', reason: 'malformed' };
    for (const name of [
      'no-slash',
      'a/b/c',
      'com.example/has space',
      '/server',
      'com.example/',
      'com.example/‮server',
      'com.example/' + 'a'.repeat(189), // 201
      '',
      42,
    ]) {
      expect(planEntry(listing({ name: name as string }))).toEqual(malformed);
    }
    const exactly200 = 'com.example/' + 'a'.repeat(188);
    expect(exactly200).toHaveLength(200);
    expect(upserted(planEntry(listing({ name: exactly200 }))).id).toBe(exactly200);

    expect(planEntry({ _meta: {} })).toEqual(malformed);
    expect(planEntry({ server: 'com.example/server' })).toEqual(malformed);
    expect(planEntry({ server: [NAME] })).toEqual(malformed);
  });

  it('non-object input is skipped', () => {
    for (const raw of [null, [], 'x', 42, undefined, true]) {
      expect(planEntry(raw)).toEqual({ kind: 'skip', reason: 'malformed' });
    }
  });

  it('version must be 1..255 with no surface-rewriting characters', () => {
    for (const version of ['', 'v'.repeat(256), '1.0‮', '1.0\u0000', '1.0\ud800', 1, null]) {
      const raw = listing({ name: NAME }) as { server: Record<string, unknown> };
      raw.server['version'] = version;
      expect(planEntry(raw)).toEqual({ kind: 'delete', id: NAME, reason: 'invalid-fields' });
    }
    const noVersion = listing({ name: NAME }) as { server: Record<string, unknown> };
    delete noVersion.server['version'];
    expect(planEntry(noVersion)).toEqual({ kind: 'delete', id: NAME, reason: 'invalid-fields' });
    // Never rewritten: it is compared verbatim later.
    const max = 'v'.repeat(255);
    expect(upserted(planEntry(listing({ name: NAME, version: max }))).version).toBe(max);
    expect(upserted(planEntry(listing({ name: NAME, version: '2.0.0-beta+build.5' }))).version).toBe(
      '2.0.0-beta+build.5',
    );
  });

  it('updatedAt falls back to statusChangedAt then publishedAt; none parseable deletes', () => {
    const at = (meta: Record<string, unknown>) =>
      upserted(planEntry(listing({ name: NAME, meta }))).updatedAt.toISOString();

    expect(
      at({
        updatedAt: '2026-11-03T00:00:00Z',
        statusChangedAt: '2026-11-02T00:00:00Z',
        publishedAt: '2026-11-01T00:00:00Z',
      }),
    ).toBe('2026-11-03T00:00:00.000Z');
    expect(
      at({
        updatedAt: 'yesterday',
        statusChangedAt: '2026-11-02T00:00:00Z',
        publishedAt: '2026-11-01T00:00:00Z',
      }),
    ).toBe('2026-11-02T00:00:00.000Z');
    expect(at({ updatedAt: undefined, publishedAt: '2026-10-01T00:00:00Z' })).toBe(
      '2026-10-01T00:00:00.000Z',
    );

    const invalid = { kind: 'delete', id: NAME, reason: 'invalid-fields' };
    expect(
      planEntry(
        listing({
          name: NAME,
          meta: { updatedAt: 'nope', statusChangedAt: 42, publishedAt: undefined },
        }),
      ),
    ).toEqual(invalid);

    const noMeta = listing({ name: NAME }) as Record<string, unknown>;
    delete noMeta['_meta'];
    expect(planEntry(noMeta)).toEqual(invalid);
  });

  it('a timestamp counts only as an RFC 3339 date-time with a four-digit year', () => {
    const at = (updatedAt: string) =>
      planEntry(
        listing({
          name: NAME,
          meta: { updatedAt, statusChangedAt: undefined, publishedAt: undefined },
        }),
      );
    // Go's RFC3339Nano, and an offset.
    expect(upserted(at('2025-09-10T12:34:56.123456789Z')).updatedAt.toISOString()).toBe(
      '2025-09-10T12:34:56.123Z',
    );
    expect(upserted(at('2026-11-01T05:30:00+05:30')).updatedAt.toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    // Date.parse accepts each of these. The expanded years are instants a
    // Postgres TIMESTAMPTZ cannot hold, so storing one would fail its page on
    // every sync; "1" is a V8 guess, not a date.
    for (const junk of [
      '-271821-04-20T00:00:00Z',
      '+275760-09-13T00:00:00Z',
      '1',
      'Tue, 03 Nov 2026 00:00:00 GMT',
      '2026-13-01T00:00:00Z',
      '2026-11-01',
    ]) {
      expect(at(junk)).toEqual({ kind: 'delete', id: NAME, reason: 'invalid-fields' });
    }
  });
});

describe('derivePublisher', () => {
  it.each([
    ['com.linear', 'domain', 'linear.com'],
    ['app.linear', 'domain', 'linear.app'],
    ['com.figma.mcp', 'domain', 'mcp.figma.com'],
    ['ac.inference.sh', 'domain', 'sh.inference.ac'],
    ['xn--p1ai.example', 'domain', 'example.xn--p1ai'],
    // The TLD is the namespace's FIRST label: `com.123` is the domain 123.com,
    // and `123.com` would be a domain under a numeric TLD, which no domain is.
    ['com.123', 'domain', '123.com'],
    ['123.com', 'account', '123.com'],
    ['io.github.octocat', 'account', 'octocat'],
    ['io.github.Octo-Cat', 'account', 'Octo-Cat'],
    ['IO.GITHUB.x', 'account', 'x'],
    // Anything under io.github is a GitHub account claim, never github.io.
    ['io.github', 'account', 'io.github'],
    ['io.github.a.b', 'account', 'io.github.a.b'],
    ['io.github.' + 'a'.repeat(40), 'account', 'io.github.' + 'a'.repeat(40)],
    ['Com.Example', 'account', 'Com.Example'],
    ['localhost', 'account', 'localhost'],
    ['com.-bad', 'account', 'com.-bad'],
    ['com..linear', 'account', 'com..linear'],
  ])('%s is %s %s', (namespace, publisherProof, publisher) => {
    expect(derivePublisher(namespace)).toEqual({ publisher, publisherProof });
  });
});

describe('deriveAuth', () => {
  it('no headers, or none that are required credentials, is none', () => {
    expect(deriveAuth(undefined)).toStrictEqual({ auth: 'none' });
    expect(deriveAuth([])).toStrictEqual({ auth: 'none' });
    expect(deriveAuth({ name: 'X-API-Key' })).toStrictEqual({ auth: 'none' });
    // Optional secret: the registry's "omit to sign in" pattern.
    expect(deriveAuth([header('X-API-Key', { isRequired: false, isSecret: true })])).toStrictEqual({
      auth: 'none',
    });
    expect(deriveAuth([header('X-API-Key', { isSecret: true })])).toStrictEqual({ auth: 'none' });
    // Required, but not a credential.
    expect(deriveAuth([header('x-project-id', { isRequired: true })])).toStrictEqual({
      auth: 'none',
    });
  });

  it('one required credential header is key, named when usable', () => {
    expect(
      deriveAuth([header('X-API-Key', { isRequired: true, isSecret: true })]),
    ).toStrictEqual({ auth: 'key', keyHeader: 'X-API-Key' });
    expect(deriveAuth([header('Authorization', { isRequired: true })])).toStrictEqual({
      auth: 'key',
      keyHeader: 'Authorization',
    });
    expect(
      deriveAuth([
        header('Authorization', { isRequired: true }),
        header('authorization', { isRequired: true, isSecret: true }),
      ]),
    ).toStrictEqual({ auth: 'key', keyHeader: 'Authorization' });
    const max = 'x'.repeat(64);
    expect(deriveAuth([header(max, { isRequired: true, isSecret: true })])).toStrictEqual({
      auth: 'key',
      keyHeader: max,
    });
  });

  it('two different required credentials is key with no header name', () => {
    expect(
      deriveAuth([
        header('X-API-Key', { isRequired: true, isSecret: true }),
        header('X-Tenant-Secret', { isRequired: true, isSecret: true }),
      ]),
    ).toStrictEqual({ auth: 'key' });
  });

  it.each([
    ['empty', ''],
    ['a space', 'X API Key'],
    ['65 characters', 'x'.repeat(65)],
    ['Cyrillic', 'ключ'],
  ])('a header name that cannot be one (%s) is key with no header name', (_label, name) => {
    expect(deriveAuth([header(name, { isRequired: true, isSecret: true })])).toStrictEqual({
      auth: 'key',
    });
  });

  it('looks at no more than MAX_HEADERS_CONSIDERED headers', () => {
    const filler = Array.from({ length: MAX_HEADERS_CONSIDERED }, (_, i) => header(`x-opt-${i}`));
    expect(
      deriveAuth([...filler, header('X-API-Key', { isRequired: true, isSecret: true })]),
    ).toStrictEqual({ auth: 'none' });
  });

  it('never claims sign-in', () => {
    const inputs: unknown[] = [
      undefined,
      [],
      [header('Authorization', { isRequired: true })],
      [header('X-API-Key', { isRequired: false, isSecret: true })],
      [{ name: 'Authorization', isRequired: true, isSecret: true, format: 'oauth' }],
    ];
    for (const input of inputs) expect(deriveAuth(input).auth).not.toBe('signin');
  });

  it('flows into the row through planEntry', () => {
    const row = upserted(
      planEntry(
        listing({
          name: NAME,
          remotes: [
            remote('https://mcp.example.com/mcp', 'streamable-http', [
              header('X-API-Key', { isRequired: true, isSecret: true }),
            ]),
          ],
        }),
      ),
    );
    expect(row).toMatchObject({ auth: 'key', keyHeader: 'X-API-Key' });
  });
});

describe('pickRemote', () => {
  it('returns the chosen remote and its own headers, or null', () => {
    const headers = [header('X-API-Key', { isRequired: true, isSecret: true })];
    expect(pickRemote([remote('https://mcp.example.com/mcp', 'streamable-http', headers)])).toEqual({
      url: 'https://mcp.example.com/mcp',
      headers,
    });
    expect(pickRemote(undefined)).toBeNull();
    expect(pickRemote({ url: 'https://mcp.example.com/mcp' })).toBeNull();
    expect(pickRemote([null, 'x', remote('https://mcp.example.com/mcp', 'websocket')])).toBeNull();
  });
});

describe('text cleaning', () => {
  it('title and description are clamped to their caps', () => {
    const row = upserted(
      planEntry(
        listing({
          name: NAME,
          title: 't'.repeat(TITLE_MAX + 1),
          description: 'd'.repeat(DESCRIPTION_MAX + 1),
        }),
      ),
    );
    expect(row.title).toBe('t'.repeat(TITLE_MAX));
    expect(row.description).toBe('d'.repeat(DESCRIPTION_MAX));
  });

  it('a surrogate pair straddling the cap is dropped whole', () => {
    const title = 'a'.repeat(TITLE_MAX - 1) + '\u{1F600}' + 'b';
    const row = upserted(planEntry(listing({ name: NAME, title })));
    expect(row.title).toBe('a'.repeat(TITLE_MAX - 1));
    expect(hasLoneSurrogate(row.title)).toBe(false);
  });

  it('controls, bidi and zero-width characters become spaces, never U+FFFD', () => {
    expect(cleanText('Not\u0000ion‮', TITLE_MAX)).toBe('Not ion');
    expect(cleanText('No​tion', TITLE_MAX)).toBe('No tion');
    expect(cleanText('a\u0000b', TITLE_MAX)).not.toContain('�');
    const row = upserted(planEntry(listing({ name: NAME, title: 'Bad\u0000Title‮' })));
    expect(row.title).toBe('Bad Title');
  });

  it('a lone surrogate becomes U+FFFD', () => {
    expect(cleanText('a\ud800b', TITLE_MAX)).toBe('a�b');
  });

  it('newlines and runs of whitespace collapse to single spaces', () => {
    expect(cleanText('  Line one\n\n  line\ttwo\r\n', DESCRIPTION_MAX)).toBe('Line one line two');
    // The clamp can leave a trailing space; it is trimmed.
    expect(cleanText('a'.repeat(TITLE_MAX - 1) + ' b', TITLE_MAX)).toBe('a'.repeat(TITLE_MAX - 1));
  });

  it('the result never carries a surface-rewriting character', () => {
    const hostile =
      '‮evil⁦ ‍﻿ x\u0085y؜⁠z\u0007\u001b[31m\u009b' + '\ud800';
    const out = cleanText(hostile, DESCRIPTION_MAX);
    expect(REWRITES_THE_SURFACE.test(out)).toBe(false);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it('a missing, non-string, empty or invisible title falls back to the id', () => {
    for (const title of [undefined, 42, '', '   ', '​‮\n']) {
      const raw = listing({ name: NAME }) as { server: Record<string, unknown> };
      if (title !== undefined) raw.server['title'] = title;
      expect(upserted(planEntry(raw)).title).toBe(NAME);
    }
  });

  it('a missing or non-string description is empty', () => {
    for (const description of [undefined, 42]) {
      const raw = listing({ name: NAME }) as { server: Record<string, unknown> };
      if (description === undefined) delete raw.server['description'];
      else raw.server['description'] = description;
      expect(upserted(planEntry(raw)).description).toBe('');
    }
  });
});
