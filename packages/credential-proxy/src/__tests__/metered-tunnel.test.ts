/**
 * TASK-715 — MeteredTunnel's own invariants, without sockets.
 */
import { describe, it, expect } from 'vitest';
import { MeteredTunnel, requestAllowed } from '../metered-tunnel.js';
import type { ProviderAdmit, ProviderCallSettlement, ProviderMeter } from '../provider-usage.js';
import type { RequestHeadInfo } from '../request-framer.js';

function meter() {
  const settled: ProviderCallSettlement[] = [];
  let admits = 0;
  const m: ProviderMeter = {
    hosts: new Set(['api.provider.test']),
    requests: ['POST /v1/messages', 'GET /v1/models/*'],
    admit: (): ProviderAdmit => {
      admits++;
      return { ok: true };
    },
    settle: (s) => {
      settled.push(s);
    },
  };
  return { m, settled, admits: () => admits, open: () => admits - settled.length };
}

const post = (over: Partial<RequestHeadInfo> = {}): RequestHeadInfo => ({
  method: 'POST',
  target: '/v1/messages',
  version: 'HTTP/1.1',
  contentLength: 10,
  folded: false,
  ...over,
});

describe('MeteredTunnel', () => {
  it('after end() it takes no slot and tracks nothing: a late request head is refused, not admitted', () => {
    const { m, admits, open } = meter();
    const t = new MeteredTunnel(m);
    t.end();
    const v = t.onRequestHead(post());
    expect(v.kind).toBe('deny');
    expect(admits()).toBe(0);
    expect(open()).toBe(0);
  });

  it('a request whose headers are folded is plain, and takes no slot', () => {
    const { m, admits } = meter();
    const t = new MeteredTunnel(m);
    expect(t.onRequestHead(post({ folded: true }))).toEqual({ kind: 'plain' });
    expect(admits()).toBe(0);
  });

  it('an HTTP/1.0 request line is plain', () => {
    const { m, admits } = meter();
    const t = new MeteredTunnel(m);
    expect(t.onRequestHead(post({ version: 'HTTP/1.0' }))).toEqual({ kind: 'plain' });
    expect(admits()).toBe(0);
  });

  it('every admitted request is settled exactly once, however the tunnel ends', () => {
    const { m, settled, open } = meter();
    const t = new MeteredTunnel(m);
    expect(t.onRequestHead(post())).toEqual({ kind: 'splice' });
    expect(t.onRequestHead(post())).toEqual({ kind: 'splice' });
    t.end();
    t.end();
    expect(settled).toHaveLength(2);
    expect(open()).toBe(0);
  });
});

describe('requestAllowed', () => {
  const patterns = ['POST /v1/messages', 'GET /v1/models/*'];
  it.each([
    ['POST', '/v1/messages', true],
    ['POST', '/v1/messages?beta=true', true],
    ['POST', '/v1/messages#frag', true],
    ['GET', '/v1/models/claude-sonnet-4-5', true],
    ['GET', '/v1/models/a.b_c:d-1', true],
    ['GET', '/v1/models/', false],
    ['GET', '/v1/models/../x', false],
    ['GET', '/v1/models/a/b', false],
    ['GET', '/v1/models/%2e%2e', false],
    ['POST', '/v1/messages/', false],
    ['post', '/v1/messages', false],
    ['DELETE', '/v1/messages', false],
    ['POST', 'v1/messages', false],
    ['POST', 'https://x/v1/messages', false],
  ])('%s %s -> %s', (method, target, expected) => {
    expect(requestAllowed(method, target, patterns)).toBe(expected);
  });
});
