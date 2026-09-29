/**
 * TASK-715 — the framer under a metered-tunnel policy.
 *
 * A tunnel to a metered host (the model provider) asks its policy about EVERY
 * request head before anything is forwarded or substituted. `splice` is the only
 * verdict under which the credential is substituted; `plain` forwards the head
 * with the placeholder still inert; `deny` drops the request and everything
 * after it.
 */
import { describe, it, expect } from 'vitest';
import {
  RequestFramer,
  forceIdentityEncoding,
  parseRequestHead,
  type MeteredRequestPolicy,
  type Replacer,
  type RequestHeadInfo,
  type RequestVerdict,
} from '../request-framer.js';

const PH = 'ax-cred:' + 'a'.repeat(32);
const REAL = 'sk-ant-REAL-key';

const replacer: Replacer = {
  replaceAll: (s) => s.split(PH).join(REAL),
  replaceAllBuffer: (b) => {
    const s = b.toString('latin1');
    const r = s.split(PH).join(REAL);
    return r === s ? b : Buffer.from(r, 'latin1');
  },
};

function head(...lines: string[]): Buffer {
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1');
}

/** A policy that records what it was asked and answers from a script. */
function policy(answer: (info: RequestHeadInfo, n: number) => RequestVerdict): {
  policy: MeteredRequestPolicy;
  seen: RequestHeadInfo[];
} {
  const seen: RequestHeadInfo[] = [];
  return {
    seen,
    policy: {
      onRequestHead: (info) => {
        seen.push(info);
        return answer(info, seen.length);
      },
    },
  };
}

const SPLICE: RequestVerdict = { kind: 'splice' };

describe('parseRequestHead', () => {
  it('reads method, target, version and a Content-Length body size', () => {
    const info = parseRequestHead(
      head('POST /v1/messages?beta=true HTTP/1.1', 'Host: h', 'Content-Length: 12'),
    );
    expect(info).toEqual({
      method: 'POST',
      target: '/v1/messages?beta=true',
      version: 'HTTP/1.1',
      contentLength: 12,
      folded: false,
    });
  });

  it('reports an obsolete folded header line, which a metered tunnel cannot normalise', () => {
    const info = parseRequestHead(
      head('POST /v1/messages HTTP/1.1', 'Accept-Encoding: gzip,', '  br', 'Host: h'),
    );
    expect(info?.folded).toBe(true);
  });

  it('reports a chunked body as null, not as a length', () => {
    const info = parseRequestHead(
      head('POST /v1/messages HTTP/1.1', 'Transfer-Encoding: chunked'),
    );
    expect(info?.contentLength).toBeNull();
  });

  it.each([
    ['empty request line', head('', 'Host: h')],
    ['lower-case method', head('post /v1/messages HTTP/1.1')],
    ['missing version', head('POST /v1/messages')],
    ['two spaces', head('POST  /v1/messages HTTP/1.1')],
    ['an HTTP/2 preface line', head('PRI * HTTP/2.0')],
    ['a tab instead of a space', head('POST\t/v1/messages HTTP/1.1')],
  ])('returns null for a malformed request line: %s', (_name, h) => {
    expect(parseRequestHead(h)).toBeNull();
  });
});

describe('forceIdentityEncoding', () => {
  it('replaces every Accept-Encoding, any case, with a single identity line', () => {
    const out = forceIdentityEncoding(
      head(
        'POST /v1/messages HTTP/1.1',
        'Host: h',
        'accept-encoding: gzip, deflate, br',
        'X-Keep: 1',
        'ACCEPT-ENCODING : zstd',
      ),
    ).toString('latin1');
    expect(out).toBe(
      ['POST /v1/messages HTTP/1.1', 'Host: h', 'X-Keep: 1', 'Accept-Encoding: identity', '', ''].join(
        '\r\n',
      ),
    );
  });

  it('adds identity when the client sent no Accept-Encoding at all', () => {
    const out = forceIdentityEncoding(head('GET /v1/models HTTP/1.1', 'Host: h')).toString('latin1');
    expect(out).toContain('Accept-Encoding: identity\r\n\r\n');
    expect(out.match(/accept-encoding/gi)).toHaveLength(1);
  });

  it('leaves a head with an obsolete folded header line untouched', () => {
    const h = head('POST /v1/messages HTTP/1.1', 'Accept-Encoding: gzip,', '  br', 'Host: h');
    expect(forceIdentityEncoding(h).equals(h)).toBe(true);
  });

  it('does not touch a header that merely mentions accept-encoding in a value', () => {
    const out = forceIdentityEncoding(
      head('POST / HTTP/1.1', 'X-Note: accept-encoding: gzip'),
    ).toString('latin1');
    expect(out).toContain('X-Note: accept-encoding: gzip');
  });
});

describe('RequestFramer with a metered policy', () => {
  it("'splice' substitutes the credential and forces identity encoding, body untouched", () => {
    const { policy: p, seen } = policy(() => SPLICE);
    const framer = new RequestFramer(replacer, [], { metered: p });
    const body = `{"note":"${PH}"}`;
    const h = head(
      'POST /v1/messages HTTP/1.1',
      'Host: api.provider.test',
      `x-api-key: ${PH}`,
      'Accept-Encoding: gzip',
      `Content-Length: ${body.length}`,
    );
    const out = framer.process(Buffer.concat([h, Buffer.from(body)]));
    const text = out.out.toString('latin1');

    expect(out.injected).toBe(true);
    expect(text).toContain(`x-api-key: ${REAL}`);
    expect(text).toContain('Accept-Encoding: identity');
    expect(text).not.toMatch(/gzip/);
    // Bodies are never substituted, spliced or not.
    expect(text.endsWith(body)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', target: '/v1/messages', contentLength: body.length });
  });

  it("'plain' forwards the head with the placeholder INERT, encoding untouched", () => {
    const { policy: p } = policy(() => ({ kind: 'plain' }));
    const framer = new RequestFramer(replacer, [], { metered: p });
    const h = head(
      'POST /v1/messages/batches HTTP/1.1',
      `x-api-key: ${PH}`,
      'Accept-Encoding: gzip',
      'Content-Length: 0',
    );
    const out = framer.process(h);
    expect(out.injected).toBe(false);
    expect(out.denied).toBeUndefined();
    expect(out.out.equals(h)).toBe(true);
    expect(out.out.toString('latin1')).not.toContain(REAL);
  });

  it("'plain' also leaves a Basic-auth placeholder inert", () => {
    const { policy: p } = policy(() => ({ kind: 'plain' }));
    const framer = new RequestFramer(replacer, [], { metered: p });
    const b64 = Buffer.from(`x:${PH}`).toString('base64');
    const h = head('GET /x HTTP/1.1', `Authorization: Basic ${b64}`);
    const out = framer.process(h);
    expect(out.injected).toBe(false);
    expect(out.out.equals(h)).toBe(true);
  });

  it("'deny' forwards nothing of the refused request and the framer then accepts nothing", () => {
    const { policy: p } = policy(() => ({
      kind: 'deny',
      status: 429,
      reason: 'busy',
      message: 'slow down',
    }));
    const framer = new RequestFramer(replacer, [], { metered: p });
    const h = head('POST /v1/messages HTTP/1.1', `x-api-key: ${PH}`, 'Content-Length: 2');
    const out = framer.process(Buffer.concat([h, Buffer.from('{}')]));
    expect(out.denied).toEqual({ status: 429, reason: 'busy', message: 'slow down' });
    expect(out.out.length).toBe(0);
    expect(out.injected).toBe(false);

    // A later chunk (even a perfectly good request) is dropped: the tunnel is being closed.
    const again = framer.process(head('GET /v1/models HTTP/1.1', `x-api-key: ${PH}`));
    expect(again.out.length).toBe(0);
    expect(again.injected).toBe(false);
  });

  it('on a keep-alive tunnel the first request is forwarded and the second one denied', () => {
    const { policy: p, seen } = policy((_i, n) =>
      n === 1 ? SPLICE : { kind: 'deny', status: 429, reason: 'usage-limit-daily', message: 'over' },
    );
    const framer = new RequestFramer(replacer, [], { metered: p });
    const first = head('POST /v1/messages HTTP/1.1', `x-api-key: ${PH}`, 'Content-Length: 2');
    const second = head('POST /v1/messages HTTP/1.1', `x-api-key: ${PH}`, 'Content-Length: 2');
    const out = framer.process(
      Buffer.concat([first, Buffer.from('{}'), second, Buffer.from('{}')]),
    );
    const text = out.out.toString('latin1');
    expect(seen).toHaveLength(2);
    expect(out.denied?.reason).toBe('usage-limit-daily');
    expect(text.match(/x-api-key: /g)).toHaveLength(1);
    expect(text).toContain(REAL);
    expect(text.endsWith('{}')).toBe(true);
  });

  it('asks the policy for a head split across chunks only once, when it is complete', () => {
    const { policy: p, seen } = policy(() => SPLICE);
    const framer = new RequestFramer(replacer, [], { metered: p });
    const h = head('POST /v1/messages HTTP/1.1', `x-api-key: ${PH}`, 'Content-Length: 0');
    framer.process(h.subarray(0, 20));
    expect(seen).toHaveLength(0);
    const out = framer.process(h.subarray(20));
    expect(seen).toHaveLength(1);
    expect(out.out.toString('latin1')).toContain(REAL);
  });

  it('a malformed request line is refused with 400 and the policy is never consulted', () => {
    const { policy: p, seen } = policy(() => SPLICE);
    const framer = new RequestFramer(replacer, [], { metered: p });
    const out = framer.process(head('post /v1/messages HTTP/1.1', `x-api-key: ${PH}`));
    expect(out.denied?.status).toBe(400);
    expect(out.denied?.reason).toBe('malformed-request');
    expect(out.out.length).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('a leading blank line (an empty head) is refused, so request/response pairing cannot be skewed', () => {
    const { policy: p } = policy(() => SPLICE);
    const framer = new RequestFramer(replacer, [], { metered: p });
    const out = framer.process(
      Buffer.from(`\r\n\r\nPOST /v1/messages HTTP/1.1\r\nx-api-key: ${PH}\r\n\r\n`, 'latin1'),
    );
    expect(out.denied?.status).toBe(400);
    expect(out.out.toString('latin1')).not.toContain(REAL);
  });

  it('an oversized head is refused on a metered tunnel instead of being substituted', () => {
    const { policy: p, seen } = policy(() => SPLICE);
    let oversized = 0;
    const framer = new RequestFramer(replacer, [], {
      metered: p,
      maxHeadBytes: 64,
      onOversizedHead: () => {
        oversized++;
      },
    });
    const out = framer.process(
      Buffer.from(`POST /v1/messages HTTP/1.1\r\nx-api-key: ${PH}\r\nX-Pad: ${'a'.repeat(200)}`, 'latin1'),
    );
    expect(oversized).toBe(1);
    expect(out.denied?.status).toBe(400);
    expect(out.out.length).toBe(0);
    expect(out.injected).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('a canary hidden in a Basic blob is still caught, and the gate is not consulted for it', () => {
    const { policy: p, seen } = policy(() => SPLICE);
    const framer = new RequestFramer(replacer, ['CANARY-TOKEN'], { metered: p });
    const b64 = Buffer.from('user:CANARY-TOKEN').toString('base64');
    const out = framer.process(head('GET /x HTTP/1.1', `Authorization: Basic ${b64}`));
    expect(out.canaryToken).toBe('CANARY-TOKEN');
    expect(out.out.length).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('a chunked request head is spliced, then the rest of the tunnel is passthrough (never substituted)', () => {
    const { policy: p, seen } = policy(() => SPLICE);
    const framer = new RequestFramer(replacer, [], { metered: p });
    const h = head('POST /v1/messages HTTP/1.1', `x-api-key: ${PH}`, 'Transfer-Encoding: chunked');
    const out1 = framer.process(Buffer.concat([h, Buffer.from('2\r\n{}\r\n0\r\n\r\n')]));
    expect(seen[0]?.contentLength).toBeNull();
    expect(out1.out.toString('latin1')).toContain(REAL);

    // A second request on the same tunnel is not re-framed: no policy call, no substitution.
    const second = head('POST /v1/messages HTTP/1.1', `x-api-key: ${PH}`, 'Content-Length: 0');
    const out2 = framer.process(second);
    expect(seen).toHaveLength(1);
    expect(out2.out.equals(second)).toBe(true);
    expect(out2.out.toString('latin1')).not.toContain(REAL);
  });

  it('without a policy the framer is exactly what it was (substitutes every head, no encoding rewrite)', () => {
    const framer = new RequestFramer(replacer, []);
    const h = head('POST /anything HTTP/1.1', `x-api-key: ${PH}`, 'Accept-Encoding: gzip');
    const out = framer.process(h);
    expect(out.out.toString('latin1')).toContain(REAL);
    expect(out.out.toString('latin1')).toContain('Accept-Encoding: gzip');
    expect(out.denied).toBeUndefined();
  });
});
