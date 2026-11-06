import { describe, expect, it } from 'vitest';

import { parseContentOrigin } from '../content-origin.js';

const bindHost = '0.0.0.0';

describe('parseContentOrigin', () => {
  it('accepts a separate site', () =>
    expect(
      parseContentOrigin({
        origin: 'https://ax-usercontent.example.net',
        frameAncestors: 'https://ax.example.com',
        bindHost,
      }),
    ).toEqual({
      host: '0.0.0.0',
      port: 9091,
      publicOrigin: 'https://ax-usercontent.example.net',
      frameAncestors: ['https://ax.example.com'],
    }));

  it("accepts kind's 127.0.0.1 content next to a localhost app", () => {
    expect(
      parseContentOrigin({
        origin: 'http://127.0.0.1:9091',
        port: '9091',
        frameAncestors: 'http://localhost:9090, http://localhost:19090,http://localhost:5173',
        bindHost,
      }),
    ).toEqual({
      host: '0.0.0.0',
      port: 9091,
      publicOrigin: 'http://127.0.0.1:9091',
      frameAncestors: ['http://localhost:9090', 'http://localhost:19090', 'http://localhost:5173'],
    });
  });

  it.each([
    ['http://localhost:9091', 'http://localhost:9090'],
    ['https://c.ax.example.com', 'https://ax.example.com'],
    ['https://example.com', 'https://app.example.com'],
    ['https://AX.example.com', 'https://ax.example.com'],
    ['https://ax-usercontent.example.net', 'https://ax.example.com,https://x.ax-usercontent.example.net'],
  ])('refuses %s next to %s (same cookie host or a subdomain)', (o, a) =>
    expect(() => parseContentOrigin({ origin: o, frameAncestors: a, bindHost })).toThrow(
      /AX_CONTENT_ORIGIN/,
    ),
  );

  it('refuses a missing origin naming AX_CONTENT_ORIGIN, and a path, query, credentials or ftp: scheme', () => {
    const fa = 'https://ax.example.com';
    expect(() => parseContentOrigin({ frameAncestors: fa, bindHost })).toThrow(/AX_CONTENT_ORIGIN/);
    expect(() => parseContentOrigin({ origin: '', frameAncestors: fa, bindHost })).toThrow(
      /AX_CONTENT_ORIGIN/,
    );
    for (const bad of [
      'https://c.example.net/x',
      'https://c.example.net/',
      'https://c.example.net?q=1',
      'https://c.example.net#h',
      'https://u:p@c.example.net',
      'https://u@c.example.net',
      'ftp://c.example.net',
      'javascript:alert(1)',
      'c.example.net',
      'https://c.example.net:99999',
      'https://c.example.net\r\nx-evil: 1',
      'https://c.example.net; script-src *',
      'https://[::1]:9091',
    ]) {
      expect(() => parseContentOrigin({ origin: bad, frameAncestors: fa, bindHost }), bad).toThrow(
        /AX_CONTENT_ORIGIN/,
      );
    }
  });

  it('defaults the port to 9091, accepts 0..65535, and refuses anything else naming AX_CONTENT_PORT', () => {
    const base = { origin: 'https://c.example.net', frameAncestors: 'https://ax.example.com', bindHost };
    expect(parseContentOrigin({ ...base, port: '' }).port).toBe(9091);
    expect(parseContentOrigin({ ...base, port: '65535' }).port).toBe(65535);
    for (const bad of ['-1', '65536', '1.5', 'abc', ' 80', '0x50', '1e3']) {
      expect(() => parseContentOrigin({ ...base, port: bad }), bad).toThrow(/AX_CONTENT_PORT/);
    }
  });

  it('port 0 (test fixtures) omits publicOrigin so minted URLs use the bound port (P13)', () => {
    const r = parseContentOrigin({
      origin: 'http://127.0.0.1:9091',
      port: '0',
      frameAncestors: 'http://localhost:9090',
      bindHost: '127.0.0.1',
    });
    expect(r).toEqual({ host: '127.0.0.1', port: 0, frameAncestors: ['http://localhost:9090'] });
    expect('publicOrigin' in r).toBe(false);
  });

  it('refuses a missing, empty or malformed frame-ancestor list naming AX_CONTENT_FRAME_ANCESTORS', () => {
    const base = { origin: 'https://c.example.net', bindHost };
    for (const bad of [undefined, '', ' , ', 'https://ax.example.com/app', "'self'", 'https://ax.example.com *']) {
      expect(() => parseContentOrigin({ ...base, frameAncestors: bad }), String(bad)).toThrow(
        /AX_CONTENT_FRAME_ANCESTORS/,
      );
    }
  });
});
