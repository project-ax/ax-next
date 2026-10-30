// Guard: scripts/delete-user-agents.mjs — the part of delete_user.sh that runs INSIDE
// the host pod — deletes a user's personal agents the way the product does, through
// the host's own `DELETE /admin/agents/:id`, and stops at the first refusal.
//
// WHY THIS EXISTS (TASK-994). delete_user.sh used to remove `agents_v1_agents` rows
// with raw SQL. That skipped `agents:deleted`, so no plugin ever cleaned up after the
// agent: its chats, sessions, routines, files and facts stayed behind with nothing
// pointing at them. The helper goes through the route instead, so every cleanup
// subscriber runs in the live host.
//
// These tests run the helper EXACTLY as delete_user.sh does —
// `node --input-type=module -e "$(cat scripts/delete-user-agents.mjs)"`, token and
// agent ids on stdin — against a stand-in host on 127.0.0.1. What they pin:
//   - one DELETE per agent, in order, carrying the CSRF header and a session cookie;
//   - that cookie and header pass the host's OWN checks (packages/http-server's
//     verifyCookieValue / evaluateCsrf), for both key encodings the host accepts —
//     the helper re-implements the cookie format (it can only use node built-ins
//     in the pod), so this is what notices if the two ever drift apart;
//   - the first answer that is not 204 stops the run (exit 1), and later agents are
//     never requested; a host that cannot be reached stops it the same way;
//   - a malformed key, port or stdin exits 2 before a single request goes out.
//
// No network beyond loopback, no cluster.

import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HELPER = join(REPO_ROOT, 'scripts', 'delete-user-agents.mjs');

const TOKEN = randomBytes(32).toString('hex');
const HEX_KEY = randomBytes(32).toString('hex');
const B64_KEY = randomBytes(32).toString('base64');
const KEYS = [
  ['a 64-hex-char key', HEX_KEY, Buffer.from(HEX_KEY, 'hex')],
  ['a base64 key', B64_KEY, Buffer.from(B64_KEY, 'base64')],
];

/** A stand-in host: records every request and answers with `statusFor(agentId)`. */
async function fakeHost(statusFor = () => 204) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const id = decodeURIComponent((req.url ?? '').replace(/^\/admin\/agents\//, ''));
    const status = statusFor(id);
    if (status === 204) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `refused ${id}`, padding: 'x'.repeat(2000) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Run the helper the way delete_user.sh does. Async: the fake host lives in this process. */
function runHelper({ stdin, env }) {
  // `$(cat file)` drops the file's trailing newlines; pass the same string.
  const source = readFileSync(HELPER, 'utf8').replace(/\n+$/, '');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      // Only what the pod would give it — nothing inherited from whoever runs the tests.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, out: stdout + stderr }));
    // A helper that refuses before reading stdin may exit first; that EPIPE is not a failure.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

const stdinFor = (ids, token = TOKEN) => `${token}\n${ids.join('\n')}\n`;

function expectedCookie(keyBytes, token = TOKEN) {
  const sig = createHmac('sha256', keyBytes).update(token).digest('base64url');
  return `ax_auth_session=${Buffer.from(token).toString('base64url')}.${sig}`;
}

describe('scripts/delete-user-agents.mjs', () => {
  it.each(KEYS)(
    'sends one authenticated DELETE per agent with the CSRF header (%s)',
    async (_label, key, keyBytes) => {
      const host = await fakeHost();
      try {
        const ids = ['agt_one', 'agt two/3'];
        const r = await runHelper({
          stdin: stdinFor(ids),
          env: { AX_HTTP_PORT: String(host.port), AX_HTTP_COOKIE_KEY: key },
        });
        expect(r.status, r.out).toBe(0);
        expect(r.stdout).toBe('deleted agt_one\ndeleted agt two/3\n');
        expect(host.requests.map((q) => `${q.method} ${q.url}`)).toEqual([
          'DELETE /admin/agents/agt_one',
          // The id is a path SEGMENT: a slash in it must not reach another route.
          'DELETE /admin/agents/agt%20two%2F3',
        ]);
        for (const q of host.requests) {
          expect(q.headers['x-requested-with']).toBe('ax-admin');
          expect(q.headers.cookie).toBe(expectedCookie(keyBytes));
        }
      } finally {
        await host.close();
      }
    },
  );

  it.each(KEYS)(
    "signs a cookie the host's own verifier accepts, with a header its CSRF guard passes (%s)",
    async (_label, key) => {
      // The real implementations, not a re-derivation: if packages/http-server ever
      // changes its cookie format, this goes red instead of every delete getting a 401.
      const { parseCookieKey, verifyCookieValue } = await import(
        '../../packages/http-server/src/cookies.ts'
      );
      const { evaluateCsrf } = await import('../../packages/http-server/src/csrf.ts');
      const host = await fakeHost();
      try {
        const r = await runHelper({
          stdin: stdinFor(['agt_one']),
          env: { AX_HTTP_PORT: String(host.port), AX_HTTP_COOKIE_KEY: key },
        });
        expect(r.status, r.out).toBe(0);
        const [q] = host.requests;
        const wire = q.headers.cookie.replace(/^ax_auth_session=/, '');
        expect(verifyCookieValue(parseCookieKey(key), wire)).toBe(TOKEN);
        // No Origin and an empty allow-list: the header alone has to carry it.
        expect(evaluateCsrf(q.method, q.headers, { allowedOrigins: [] })).toBeNull();
      } finally {
        await host.close();
      }
    },
  );

  it('stops at the first refusal and exits non-zero', async () => {
    const host = await fakeHost((id) => (id === 'b' ? 500 : 204));
    try {
      const r = await runHelper({
        stdin: stdinFor(['a', 'b', 'c']),
        env: { AX_HTTP_PORT: String(host.port), AX_HTTP_COOKIE_KEY: HEX_KEY },
      });
      expect(r.status).toBe(1);
      expect(host.requests.map((q) => q.url)).toEqual(['/admin/agents/a', '/admin/agents/b']);
      expect(r.stdout).toBe('deleted a\n');
      const failed = r.stderr.split('\n').find((l) => l.startsWith('failed '));
      expect(failed).toMatch(/^failed b 500 \{"error":"refused b"/);
      // The body is quoted for the operator, capped so a huge answer cannot flood them.
      expect(failed.length).toBeLessThanOrEqual('failed b 500 '.length + 500);
    } finally {
      await host.close();
    }
  });

  it('stops when the host cannot be reached at all', async () => {
    const host = await fakeHost();
    const port = host.port;
    await host.close(); // nothing listens there any more: a restarting host
    const r = await runHelper({
      stdin: stdinFor(['a', 'b']),
      env: { AX_HTTP_PORT: String(port), AX_HTTP_COOKIE_KEY: HEX_KEY },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^failed a /m);
  });

  it.each([
    ['no cookie key', { AX_HTTP_COOKIE_KEY: undefined }],
    ['a cookie key that is not hex or base64 of 32 bytes', { AX_HTTP_COOKIE_KEY: 'not-a-key' }],
    ['a 63-hex-char cookie key', { AX_HTTP_COOKIE_KEY: HEX_KEY.slice(1) }],
    ['a base64 cookie key of 16 bytes', { AX_HTTP_COOKIE_KEY: randomBytes(16).toString('base64') }],
    ['no port', { AX_HTTP_PORT: undefined }],
    ['a port that is not a number', { AX_HTTP_PORT: '90x' }],
    ['a port out of range', { AX_HTTP_PORT: '70000' }],
    ['an empty token line', { stdin: '\nagt_one\n' }],
    ['no agent ids', { stdin: `${TOKEN}\n` }],
  ])('refuses %s before making any request (exit 2)', async (_label, change) => {
    const host = await fakeHost();
    try {
      const env = { AX_HTTP_PORT: String(host.port), AX_HTTP_COOKIE_KEY: HEX_KEY };
      for (const name of ['AX_HTTP_PORT', 'AX_HTTP_COOKIE_KEY']) {
        if (name in change) {
          if (change[name] === undefined) delete env[name];
          else env[name] = change[name];
        }
      }
      const r = await runHelper({ stdin: change.stdin ?? stdinFor(['agt_one']), env });
      expect(r.status, r.out).toBe(2);
      expect(host.requests).toEqual([]);
      expect(r.stdout).toBe('');
      // A refusal must never echo the key it refused.
      expect(r.out).not.toContain(HEX_KEY.slice(1));
    } finally {
      await host.close();
    }
  });
});
