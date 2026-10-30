// Runs INSIDE the host pod: delete_user.sh pipes it to
// `node --input-type=module -e "$(cat scripts/delete-user-agents.mjs)"`.
// It deletes a user's personal agents through the host's own
// DELETE /admin/agents/:id, so agents:deleted fires and every plugin cleans
// up its rows for the agent. Node built-ins only (the pod has nothing else
// we can rely on), and no imports from the repo: this file is sent as text.
//
//   stdin   line 1: a session token minted for the agents' owner;
//           every further non-empty line: one agent id.
//   env     AX_HTTP_PORT, AX_HTTP_COOKIE_KEY: the host container's own.
//   stdout  "deleted <id>" per agent, in order.
//   exit 0  all deleted.
//        1  the first answer that is not 204 (or no answer at all) stops it:
//           "failed <id> <status> <body>" on stderr. Later ids are not tried.
//        2  bad input; nothing was requested.
//
// scripts/__tests__/delete-user-agents.test.js runs this file exactly as
// delete_user.sh does and checks its cookie against packages/http-server's
// own verifier.

import { createHmac } from 'node:crypto';
import { request } from 'node:http';

// packages/auth-better/src/plugin.ts (DEFAULT_SESSION_COOKIE_NAME): auth reads
// this cookie, then looks the token up in auth_better_v1_sessions.
const COOKIE_NAME = 'ax_auth_session';
// packages/http-server/src/csrf.ts: a DELETE without an allowed Origin must carry it.
const CSRF_HEADER = ['x-requested-with', 'ax-admin'];
const BODY_SHOWN = 500;

function refuse(message) {
  process.stderr.write(`delete-user-agents: ${message}\n`);
  process.exitCode = 2;
}

/** packages/http-server/src/cookies.ts parseCookieKey: 64 hex chars, or base64 of exactly 32 bytes. */
function parseCookieKey(raw) {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const b64 = Buffer.from(raw, 'base64');
  return b64.length === 32 ? b64 : null;
}

/** packages/http-server/src/cookies.ts signCookieValue: `<base64url(value)>.<base64url(HMAC-SHA256(key, value))>`. */
function signCookieValue(key, value) {
  const payload = Buffer.from(value, 'utf8');
  const sig = createHmac('sha256', key).update(payload).digest();
  return `${payload.toString('base64url')}.${sig.toString('base64url')}`;
}

/** One DELETE. Resolves with the status and body, or rejects when there is no answer. */
function deleteAgent(port, id, cookie) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'DELETE',
        // A path SEGMENT: an id can never reach another route.
        path: `/admin/agents/${encodeURIComponent(id)}`,
        headers: { cookie: `${COOKIE_NAME}=${cookie}`, [CSRF_HEADER[0]]: CSRF_HEADER[1] },
        // No keep-alive pool to hold the process open; and no client timeout: a
        // delete waits on every agents:deleted subscriber, and the host bounds those.
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** One line, no control characters, at most BODY_SHOWN characters. */
function shown(text) {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, BODY_SHOWN);
}

async function main() {
  const rawPort = process.env.AX_HTTP_PORT ?? '';
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!(port >= 1 && port <= 65535)) return refuse('AX_HTTP_PORT is not a port number');
  const key = parseCookieKey(process.env.AX_HTTP_COOKIE_KEY ?? '');
  // Never echo the value: it signs every login cookie the host accepts.
  if (key === null) return refuse('AX_HTTP_COOKIE_KEY is not a 32-byte key (64 hex chars or base64)');

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const [first = '', ...rest] = Buffer.concat(chunks).toString('utf8').split('\n');
  const token = first.trim();
  const ids = rest.map((line) => line.trim()).filter((line) => line.length > 0);
  if (token.length === 0) return refuse('no session token on the first line of stdin');
  if (ids.length === 0) return refuse('no agent ids on stdin');

  const cookie = signCookieValue(key, token);
  for (const id of ids) {
    let res;
    try {
      res = await deleteAgent(port, id, cookie);
    } catch (err) {
      process.stderr.write(`failed ${id} no-answer ${shown(err?.code ?? String(err))}\n`);
      process.exitCode = 1;
      return;
    }
    if (res.status !== 204) {
      process.stderr.write(`failed ${id} ${res.status} ${shown(res.body)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`deleted ${id}\n`);
  }
}

await main();
