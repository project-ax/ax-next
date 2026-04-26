import { describe, it, expect } from 'vitest';
import { runAdminBootstrapCommand } from '../commands/admin/bootstrap.js';
import { runAdminCommand } from '../commands/admin.js';

// ---------------------------------------------------------------------------
// Tests for `ax-next admin bootstrap`. We don't stand up a real kernel here —
// the dev-bootstrap server-side path already has its own integration tests
// in @ax/auth (postgres testcontainer). The CLI's job is:
//   1. Validate args + env (AX_DEV_BOOTSTRAP_TOKEN required, etc.).
//   2. POST /auth/dev-bootstrap with the right shape + CSRF header.
//   3. Extract the session cookie from Set-Cookie, print to STDERR not STDOUT.
//   4. Branch on `isNew`: print bootstrap_already_done on idempotent re-run.
//   5. (--with-default-agent) POST /admin/agents with the cookie threaded.
//
// We exercise that wire shape with a stub fetch that records calls and
// returns canned responses. Heavier acceptance happens in Task 17's e2e test.
// ---------------------------------------------------------------------------

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface StubResponse {
  status: number;
  body: unknown;
  setCookie?: string[];
}

function makeFetchStub(
  responses: StubResponse[],
): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headersIn = (init?.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(headersIn)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    const r = responses[i++];
    if (r === undefined) throw new Error(`fetch stub ran out of responses at call ${i}`);
    const h = new Headers({ 'content-type': 'application/json' });
    for (const sc of r.setCookie ?? []) h.append('set-cookie', sc);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: h });
  };
  return { fetchImpl, calls };
}

function captureStreams(): {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    out,
    err,
  };
}

describe('admin bootstrap command — argument parsing & env validation', () => {
  it('errors with non-zero exit when AX_DEV_BOOTSTRAP_TOKEN is unset', async () => {
    const cap = captureStreams();
    const code = await runAdminBootstrapCommand({
      argv: [],
      env: {},
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    expect(code).toBe(2);
    expect(cap.err.some((l) => l.includes('AX_DEV_BOOTSTRAP_TOKEN'))).toBe(true);
  });

  it('errors with non-zero exit when AX_DEV_BOOTSTRAP_TOKEN is empty string', async () => {
    const cap = captureStreams();
    const code = await runAdminBootstrapCommand({
      argv: [],
      env: { AX_DEV_BOOTSTRAP_TOKEN: '' },
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    expect(code).toBe(2);
  });

  it('--help prints usage and exits 0', async () => {
    const cap = captureStreams();
    const code = await runAdminBootstrapCommand({
      argv: ['--help'],
      env: { AX_DEV_BOOTSTRAP_TOKEN: 't' },
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    expect(code).toBe(0);
    expect(cap.out.some((l) => l.includes('admin bootstrap'))).toBe(true);
  });

  it('rejects --email without a value', async () => {
    const cap = captureStreams();
    const code = await runAdminBootstrapCommand({
      argv: ['--email'],
      env: { AX_DEV_BOOTSTRAP_TOKEN: 't' },
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    expect(code).toBe(2);
  });

  it('rejects unknown flag', async () => {
    const cap = captureStreams();
    const code = await runAdminBootstrapCommand({
      argv: ['--bogus'],
      env: { AX_DEV_BOOTSTRAP_TOKEN: 't' },
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    expect(code).toBe(2);
  });
});

describe('admin bootstrap command — happy path', () => {
  it('first run posts to /auth/dev-bootstrap and prints user_id on stdout, cookie on stderr', async () => {
    const stub = makeFetchStub([
      {
        status: 200,
        body: {
          user: {
            id: 'usr_first',
            email: 'me@example.com',
            displayName: 'Me',
            isAdmin: true,
          },
          isNew: true,
        },
        setCookie: [
          'ax_auth_session=secret-cookie-value; Path=/; HttpOnly; SameSite=Lax',
        ],
      },
    ]);
    const cap = captureStreams();
    const code = await runAdminBootstrapCommand({
      argv: ['--email', 'me@example.com', '--display-name', 'Me'],
      env: { AX_DEV_BOOTSTRAP_TOKEN: 'tkn', AX_HTTP_BASE: 'http://srv:9000' },
      stdout: cap.stdout,
      stderr: cap.stderr,
      fetchImpl: stub.fetchImpl,
    });
    expect(code).toBe(0);

    // Wire shape.
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.url).toBe('http://srv:9000/auth/dev-bootstrap');
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers['x-requested-with']).toBe('ax-admin');
    const body = JSON.parse(call.body) as Record<string, string>;
    expect(body.token).toBe('tkn');
    expect(body.email).toBe('me@example.com');
    expect(body.displayName).toBe('Me');

    // Output discipline.
    expect(cap.out.some((l) => l.includes('usr_first'))).toBe(true);
    expect(cap.out.some((l) => l.includes('dev-bootstrap user created'))).toBe(true);
    // Cookie NEVER on stdout.
    expect(cap.out.some((l) => l.includes('secret-cookie-value'))).toBe(false);
    // Cookie ON stderr.
    expect(cap.err.some((l) => l.includes('ax_auth_session=secret-cookie-value'))).toBe(true);
  });

  it('--http-base flag overrides env', async () => {
    const stub = makeFetchStub([
      {
        status: 200,
        body: { user: { id: 'usr_x' }, isNew: true },
        setCookie: ['ax_auth_session=c; Path=/'],
      },
    ]);
    const cap = captureStreams();
    const code = await runAdminBootstrapCommand({
      argv: ['--http-base', 'http://flag-override:1/'],
      env: { AX_DEV_BOOTSTRAP_TOKEN: 't', AX_HTTP_BASE: 'http://env-override:2' },
      stdout: cap.stdout,
      stderr: cap.stderr,
      fetchImpl: stub.fetchImpl,
    });
    expect(code).toBe(0);
    // Trailing slash stripped.
    expect(stub.calls[0]!.url).toBe('http://flag-override:1/auth/dev-bootstrap');
  });

  it('default base is http://localhost:8080 when neither flag nor env set', async () => {
    const stub = makeFetchStub([
      {
        status: 200,
        body: { user: { id: 'usr_x' }, isNew: true },
        setCookie: ['ax_auth_session=c; Path=/'],
      },
    ]);
    const cap = captureStreams();
    await runAdminBootstrapCommand({
      argv: [],
      env: { AX_DEV_BOOTSTRAP_TOKEN: 't' },
      stdout: cap.stdout,
      stderr: cap.stderr,
      fetchImpl: stub.fetchImpl,
    });
    expect(stub.calls[0]!.url).toBe('http://localhost:8080/auth/dev-bootstrap');
  });
});

describe('admin bootstrap command — idempotent re-run (Invariant I12)', () => {
  it('prints bootstrap_already_done on isNew=false, exits 0, no agent call', async () => {
    const stub = makeFetchStub([
      {
        status: 200,
        body: {
          user: { id: 'usr_existing', email: null, displayName: null, isAdmin: true },
          isNew: false,
        },
        setCookie: ['ax_auth_session=c2; Path=/'],
      },
    ]);
    const cap = captureStreams();
    const code = await runAdminBootstrapCommand({
      argv: ['--with-default-agent'], // Even with this flag, idempotent skip applies.
      env: { AX_DEV_BOOTSTRAP_TOKEN: 'tkn', AX_HTTP_BASE: 'http://srv' },
      stdout: cap.stdout,
      stderr: cap.stderr,
      fetchImpl: stub.fetchImpl,
    });
    expect(code).toBe(0);
    // Only one HTTP call: the bootstrap. We do NOT POST /admin/agents on
    // the idempotent path — operator can do that explicitly later.
    expect(stub.calls).toHaveLength(1);
    expect(cap.out.some((l) => l.includes('bootstrap_already_done'))).toBe(true);
    expect(cap.out.some((l) => l.includes('usr_existing'))).toBe(true);
    // Cookie still printed to stderr (operator may want to use it).
    expect(cap.err.some((l) => l.includes('ax_auth_session=c2'))).toBe(true);
  });
});

describe('admin bootstrap command — --with-default-agent', () => {
  it('posts to /admin/agents with the session cookie and prints agent_id', async () => {
    const stub = makeFetchStub([
      {
        status: 200,
        body: { user: { id: 'usr_a' }, isNew: true },
        setCookie: ['ax_auth_session=session-cookie; Path=/; HttpOnly'],
      },
      {
        status: 201,
        body: {
          agent: {
            id: 'agt_1',
            displayName: 'Default Personal Agent',
            visibility: 'personal',
          },
        },
      },
    ]);
    const cap = captureStreams();
    const code = await runAdminBootstrapCommand({
      argv: ['--with-default-agent'],
      env: { AX_DEV_BOOTSTRAP_TOKEN: 'tkn' },
      stdout: cap.stdout,
      stderr: cap.stderr,
      fetchImpl: stub.fetchImpl,
    });
    expect(code).toBe(0);
    expect(stub.calls).toHaveLength(2);
    const agentCall = stub.calls[1]!;
    expect(agentCall.url).toBe('http://localhost:8080/admin/agents');
    expect(agentCall.method).toBe('POST');
    expect(agentCall.headers['cookie']).toBe('ax_auth_session=session-cookie');
    expect(agentCall.headers['x-requested-with']).toBe('ax-admin');
    const body = JSON.parse(agentCall.body) as Record<string, unknown>;
    expect(body.displayName).toBe('Default Personal Agent');
    expect(body.visibility).toBe('personal');
    // The wildcard-bypass shape (allowedTools=[] AND mcpConfigIds=[]) is
    // rejected by the admin route. Our defaults must avoid it.
    expect((body.allowedTools as string[]).length).toBeGreaterThan(0);

    expect(cap.out.some((l) => l.includes('agt_1'))).toBe(true);
  });

  it('exits 1 when agent creation fails (e.g. 403)', async () => {
    const stub = makeFetchStub([
      {
        status: 200,
        body: { user: { id: 'usr_a' }, isNew: true },
        setCookie: ['ax_auth_session=cookie; Path=/'],
      },
      { status: 403, body: { error: 'forbidden' } },
    ]);
    const cap = captureStreams();
    const code = await runAdminBootstrapCommand({
      argv: ['--with-default-agent'],
      env: { AX_DEV_BOOTSTRAP_TOKEN: 'tkn' },
      stdout: cap.stdout,
      stderr: cap.stderr,
      fetchImpl: stub.fetchImpl,
    });
    expect(code).toBe(1);
    expect(cap.err.some((l) => l.toLowerCase().includes('agent creation failed'))).toBe(true);
  });
});

describe('admin bootstrap command — error paths', () => {
  it('exits 1 on 401 from server with helpful message about token', async () => {
    const stub = makeFetchStub([{ status: 401, body: { error: 'unauthorized' } }]);
    const cap = captureStreams();
    const code = await runAdminBootstrapCommand({
      argv: [],
      env: { AX_DEV_BOOTSTRAP_TOKEN: 'wrong-token' },
      stdout: cap.stdout,
      stderr: cap.stderr,
      fetchImpl: stub.fetchImpl,
    });
    expect(code).toBe(1);
    expect(cap.err.some((l) => l.includes('AX_DEV_BOOTSTRAP_TOKEN'))).toBe(true);
  });

  it('exits 1 on 404 with hint about NODE_ENV=production', async () => {
    const stub = makeFetchStub([{ status: 404, body: { error: 'not-found' } }]);
    const cap = captureStreams();
    const code = await runAdminBootstrapCommand({
      argv: [],
      env: { AX_DEV_BOOTSTRAP_TOKEN: 'whatever' },
      stdout: cap.stdout,
      stderr: cap.stderr,
      fetchImpl: stub.fetchImpl,
    });
    expect(code).toBe(1);
    expect(cap.err.some((l) => l.toLowerCase().includes('production'))).toBe(true);
  });

  it('exits 1 when fetch itself throws (network error)', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('econnrefused');
    };
    const cap = captureStreams();
    const code = await runAdminBootstrapCommand({
      argv: [],
      env: { AX_DEV_BOOTSTRAP_TOKEN: 't' },
      stdout: cap.stdout,
      stderr: cap.stderr,
      fetchImpl,
    });
    expect(code).toBe(1);
    expect(cap.err.some((l) => l.includes('failed to reach'))).toBe(true);
  });

  it('exits 1 when server response lacks ax_auth_session cookie', async () => {
    const stub = makeFetchStub([
      {
        status: 200,
        body: { user: { id: 'usr_x' }, isNew: true },
        // No setCookie at all — server bug.
      },
    ]);
    const cap = captureStreams();
    const code = await runAdminBootstrapCommand({
      argv: [],
      env: { AX_DEV_BOOTSTRAP_TOKEN: 't' },
      stdout: cap.stdout,
      stderr: cap.stderr,
      fetchImpl: stub.fetchImpl,
    });
    expect(code).toBe(1);
    expect(cap.err.some((l) => l.includes('ax_auth_session'))).toBe(true);
  });
});

describe('admin command dispatcher', () => {
  it('routes `bootstrap` to runAdminBootstrapCommand', async () => {
    const stub = makeFetchStub([
      {
        status: 200,
        body: { user: { id: 'usr_disp' }, isNew: true },
        setCookie: ['ax_auth_session=c; Path=/'],
      },
    ]);
    const cap = captureStreams();
    const code = await runAdminCommand({
      argv: ['bootstrap'],
      env: { AX_DEV_BOOTSTRAP_TOKEN: 't' },
      stdout: cap.stdout,
      stderr: cap.stderr,
      fetchImpl: stub.fetchImpl,
    });
    expect(code).toBe(0);
    expect(cap.out.some((l) => l.includes('usr_disp'))).toBe(true);
  });

  it('exits 2 with usage on missing subcommand', async () => {
    const cap = captureStreams();
    const code = await runAdminCommand({
      argv: [],
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    expect(code).toBe(2);
    expect(cap.err.some((l) => l.includes('bootstrap'))).toBe(true);
  });

  it('exits 2 on unknown subcommand', async () => {
    const cap = captureStreams();
    const code = await runAdminCommand({
      argv: ['nonsense'],
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    expect(code).toBe(2);
    expect(cap.err.some((l) => l.toLowerCase().includes('unknown subcommand'))).toBe(true);
  });
});
