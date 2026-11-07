/**
 * `/a/<code>`: the one path the share page answers, and the one path a Google
 * sign-in may come back to besides `/` (Review Focus 1). Anything that is not
 * exactly `/a/` + a 32-character share code is refused — that is what keeps
 * the sign-in return from being an open redirect.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { applyShareReferrerPolicy, parseShareRoute } from '../lib/share-route';

const CODE = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123_-';

describe('parseShareRoute', () => {
  it('accepts /a/ + a share code', () => {
    expect(CODE).toHaveLength(32);
    expect(parseShareRoute(`/a/${CODE}`)).toEqual({ code: CODE });
  });

  it.each([
    '/a/' + 'A'.repeat(31),
    '/a/' + 'A'.repeat(33),
    '/a/x/y',
    `/a/${CODE}/`,
    '//evil.example',
    '/a/%2e%2e',
    `//evil.example/a/${CODE}`,
    `https://evil.example/a/${CODE}`,
    `/a/${CODE}?next=//evil.example`,
    `/a/${CODE}#x`,
    `/b/${CODE}`,
    `/a/${CODE.slice(0, 31)}.`,
    `/a/${CODE}\n`,
    '/',
    '',
  ])('parseShareRoute refuses %s', (p) => expect(parseShareRoute(p)).toBeNull());
});

describe('applyShareReferrerPolicy', () => {
  afterEach(() => {
    document.head.querySelectorAll('meta[name="referrer"]').forEach((m) => m.remove());
  });

  it('on /a/<code>, the page sends no referrer, so the code cannot leak through one', () => {
    applyShareReferrerPolicy(`/a/${CODE}`);
    applyShareReferrerPolicy(`/a/${CODE}`);
    const metas = document.head.querySelectorAll('meta[name="referrer"]');
    expect(metas).toHaveLength(1);
    expect(metas[0]?.getAttribute('content')).toBe('no-referrer');
  });

  it('anywhere else, nothing changes', () => {
    applyShareReferrerPolicy('/');
    applyShareReferrerPolicy('/a/short');
    expect(document.head.querySelector('meta[name="referrer"]')).toBeNull();
  });
});
