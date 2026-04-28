// ax-next credentials set <ref>     — stdin-only secret writer (Phase 1b)
// ax-next credentials login <provider> — PKCE OAuth flow (Phase 3, anthropic)
//
// `set`: reads the secret from stdin so it doesn't leak to `ps` /
// `/proc/<pid>/cmdline` / shell history. We also don't echo it back on
// stdout or stderr; the only confirmation is the ref. Paranoid? Sure.
// Also correct.
//
// `login anthropic`: PKCE flow against Claude Max. Binds 127.0.0.1:1455
// for the redirect, opens the user's browser, waits for the callback,
// validates state (CSRF), exchanges the code, stashes a kind:'anthropic-oauth'
// blob via credentials:set. Verifier + state never leave the host process
// (I13). 60s timeout — if the user takes longer, we exit with a usable
// error and leave nothing behind.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HookBus, bootstrap, makeAgentContext, PluginError } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createCredentialsAnthropicOauthPlugin } from '@ax/credentials-anthropic-oauth';
import { openBrowser } from './open-browser.js';

const DEFAULT_SQLITE_PATH = './ax-next-chat.sqlite';
// Single-tenant CLI default. Phase 9.5+ multi-tenant replaces this with a
// real auth identity. The (userId, ref) storage key (Phase 3, I14) keeps
// the door open without forcing the change today.
const CLI_USER_ID = 'cli';
// Fixed port + redirect — Anthropic-whitelisted; do NOT use a random port.
// Pinned to the IPv4 literal so the listener (also bound on 127.0.0.1)
// and the browser's redirect target resolve to the same address. Using
// `localhost` here would break on hosts where it resolves to ::1 first.
// Matches v1's setup (~/dev/ai/ax/src/host/oauth.ts:18).
const OAUTH_REDIRECT_PORT = 1455;
const OAUTH_REDIRECT_URI = 'http://127.0.0.1:1455/callback';
const OAUTH_TIMEOUT_MS = 60_000;
const DEFAULT_OAUTH_REF = 'anthropic-personal';

export interface RunCredentialsOptions {
  /** argv slice starting at the subcommand args, e.g. ['set', 'gh-token']. */
  argv: string[];
  /** The secret source. Reads all chunks to EOF, UTF-8 decodes, strips one trailing \n. */
  stdin: NodeJS.ReadableStream | AsyncIterable<Buffer | string>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Defaults to ./ax-next-chat.sqlite (same as main()). Tests override. */
  sqlitePath?: string;
  /**
   * Test-only override — replaces the platform browser-opener. Production
   * code uses `openBrowser` from './open-browser.js' directly.
   */
  openBrowserImpl?: (url: string) => void;
}

const USAGE = `usage:
  ax-next credentials set <ref>
    <ref> must match [a-z0-9][a-z0-9_.-]{0,127}
    the secret is read from stdin (NOT argv) — pipe or paste then EOF

  ax-next credentials login anthropic [<ref>]
    PKCE OAuth flow against Claude Max. Default ref: 'anthropic-personal'.
    Opens a browser; waits up to 60 seconds for the redirect.

env:
  AX_CREDENTIALS_KEY  required, 32 bytes (64 hex chars or 44 base64 chars)`;

export async function runCredentialsCommand(opts: RunCredentialsOptions): Promise<number> {
  const out = opts.stdout ?? ((line: string) => process.stdout.write(line + '\n'));
  const err = opts.stderr ?? ((line: string) => process.stderr.write(line + '\n'));

  const verb = opts.argv[0];
  if (verb === 'login') {
    return runLoginCommand(opts, out, err);
  }
  if (verb !== 'set') {
    err(USAGE);
    return 2;
  }
  const ref = opts.argv[1];
  if (ref === undefined || ref === '') {
    err(USAGE);
    return 2;
  }

  // Read stdin to a Buffer (preserves bytes), then UTF-8 decode.
  const chunks: Buffer[] = [];
  for await (const chunk of opts.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
  }
  let value = Buffer.concat(chunks).toString('utf8');
  // Strip exactly one trailing \n — covers `echo $TOKEN | ax-next ...` and a
  // single hand-typed newline before EOF. Don't trim aggressively: the user
  // might genuinely want trailing whitespace inside their token.
  if (value.endsWith('\n')) value = value.slice(0, -1);

  const bus = new HookBus();
  let handle;
  try {
    handle = await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: opts.sqlitePath ?? DEFAULT_SQLITE_PATH }),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
      ],
      config: {},
    });
  } catch (e) {
    // bootstrap errors (e.g. credentials plugin init when AX_CREDENTIALS_KEY
    // is missing) come through here. No handle yet — nothing to shut down.
    if (e instanceof PluginError) {
      err(`error: ${e.message}`);
      return 1;
    }
    err('error: unexpected failure');
    return 1;
  }

  try {
    try {
      await bus.call(
        'credentials:set',
        makeAgentContext({ sessionId: 'cli', agentId: 'cli', userId: CLI_USER_ID }),
        {
          ref,
          userId: CLI_USER_ID,
          kind: 'api-key',
          payload: new TextEncoder().encode(value),
        },
      );
    } catch (e) {
      if (e instanceof PluginError) {
        // PluginError messages are curated by @ax/credentials specifically to
        // avoid echoing plaintext. Still — only surface `.message`, never `.cause`.
        err(`error: ${e.message}`);
        return 1;
      }
      // Unexpected failure. We don't stringify `e` because it might (somehow) have
      // captured the secret value in a message. Be boring on purpose.
      err('error: unexpected failure');
      return 1;
    }

    out(`credential '${ref}' stored`);
    return 0;
  } finally {
    await handle.shutdown();
  }
}

// ── credentials login ────────────────────────────────────────────────

interface LoginOutput {
  authorizeUrl: string;
  codeVerifier: string;
  state: string;
}
interface ExchangeOutput {
  payload: Uint8Array;
  expiresAt: number;
  kind: 'anthropic-oauth';
}

async function runLoginCommand(
  opts: RunCredentialsOptions,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const provider = opts.argv[1];
  if (provider !== 'anthropic') {
    err(USAGE);
    return 2;
  }
  const ref = opts.argv[2] ?? DEFAULT_OAUTH_REF;

  const bus = new HookBus();
  let handle;
  try {
    handle = await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: opts.sqlitePath ?? DEFAULT_SQLITE_PATH }),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
        createCredentialsAnthropicOauthPlugin(),
      ],
      config: {},
    });
  } catch (e) {
    if (e instanceof PluginError) {
      err(`error: ${e.message}`);
      return 1;
    }
    err('error: unexpected failure');
    return 1;
  }

  try {
    // 1. Build the authorize URL + PKCE verifier + state.
    let login: LoginOutput;
    try {
      login = await bus.call<{ redirectUri: string }, LoginOutput>(
        'credentials:login:anthropic-oauth',
        makeAgentContext({ sessionId: 'cli', agentId: 'cli', userId: CLI_USER_ID }),
        { redirectUri: OAUTH_REDIRECT_URI },
      );
    } catch (e) {
      err(`error: ${(e as Error).message}`);
      return 1;
    }

    // 2. Stand up the redirect listener with the request handler ALREADY
    //    attached (otherwise a fast browser can hit /callback before
    //    `waitForCallback` wires the handler — race). Bind on the fixed
    //    port — Anthropic's whitelisted redirect_uri is :1455. EADDRINUSE
    //    means another instance is mid-flow or some other service holds
    //    the port; fail clearly.
    let listener: { server: Server; codePromise: Promise<string> };
    try {
      listener = await startRedirectListener(login.state);
    } catch (e) {
      err(`error: ${(e as Error).message}`);
      return 1;
    }

    // 3. Open the browser, then await the callback.
    out('Opening browser to authorize Anthropic OAuth.');
    out('If the browser does not open, visit:');
    out(`  ${login.authorizeUrl}`);
    try {
      (opts.openBrowserImpl ?? openBrowser)(login.authorizeUrl);
    } catch (e) {
      // Don't abort — the user can still paste the URL manually.
      err(`warn: failed to launch browser (${(e as Error).message})`);
    }

    let code: string;
    try {
      code = await listener.codePromise;
    } catch (e) {
      err(`error: ${(e as Error).message}`);
      return 1;
    } finally {
      // Best-effort close — the test suite waits on it before asserting
      // EADDRINUSE behavior. Fire-and-forget on close failure.
      await new Promise<void>((r) => listener.server.close(() => r()));
    }

    // 4. Exchange the code for a token blob.
    let exchanged: ExchangeOutput;
    try {
      exchanged = await bus.call<
        { code: string; codeVerifier: string; state: string; redirectUri: string },
        ExchangeOutput
      >(
        'credentials:exchange:anthropic-oauth',
        makeAgentContext({ sessionId: 'cli', agentId: 'cli', userId: CLI_USER_ID }),
        {
          code,
          codeVerifier: login.codeVerifier,
          state: login.state,
          redirectUri: OAUTH_REDIRECT_URI,
        },
      );
    } catch (e) {
      err(`error: ${(e as Error).message}`);
      return 1;
    }

    // 5. Stash the blob via credentials:set.
    try {
      await bus.call(
        'credentials:set',
        makeAgentContext({ sessionId: 'cli', agentId: 'cli', userId: CLI_USER_ID }),
        {
          ref,
          userId: CLI_USER_ID,
          kind: exchanged.kind,
          payload: exchanged.payload,
          expiresAt: exchanged.expiresAt,
        },
      );
    } catch (e) {
      err(`error: ${(e as Error).message}`);
      return 1;
    }

    out(`Anthropic OAuth credential stored as ref='${ref}'`);
    return 0;
  } finally {
    await handle.shutdown();
  }
}

/**
 * Bind 127.0.0.1:1455 with the request handler ALREADY attached, so a
 * browser that hits /callback the moment the listener is up gets handled.
 * Returns the server (for close()) and a promise that resolves with the
 * authorization code (or rejects with state-mismatch / OAuth-error / timeout).
 */
function startRedirectListener(expectedState: string): Promise<{
  server: Server;
  codePromise: Promise<string>;
}> {
  return new Promise((resolve, reject) => {
    let done = false;
    let codeResolve!: (code: string) => void;
    let codeReject!: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      codeResolve = res;
      codeReject = rej;
    });

    const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
      const url = new URL(req.url ?? '/', OAUTH_REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      if (done) {
        res.writeHead(409, { 'content-type': 'text/plain' });
        res.end('already processed');
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const errorParam = url.searchParams.get('error');
      if (errorParam !== null) {
        done = true;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          '<html><body><h2>Authorization failed</h2><p>You can close this tab and re-run <code>ax-next credentials login anthropic</code>.</p></body></html>',
        );
        codeReject(new Error(`OAuth error from Anthropic: ${errorParam}`));
        return;
      }
      if (state !== expectedState) {
        done = true;
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end('<html><body><h2>State mismatch</h2></body></html>');
        codeReject(new Error('OAuth state mismatch — possible CSRF; aborting'));
        return;
      }
      if (code === null || code === '') {
        done = true;
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end('<html><body><h2>Missing code</h2></body></html>');
        codeReject(new Error('redirect missing authorization code'));
        return;
      }
      done = true;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<html><body><h2>Authorization successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>',
      );
      codeResolve(code);
    };

    const server = createServer(onRequest);
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        reject(
          new Error(
            `port ${OAUTH_REDIRECT_PORT} is in use — another OAuth flow may be running`,
          ),
        );
        return;
      }
      // Post-bind errors propagate via codePromise; pre-bind errors come here.
      reject(e);
    });
    server.listen(OAUTH_REDIRECT_PORT, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (addr === null || addr.port !== OAUTH_REDIRECT_PORT) {
        server.close();
        reject(new Error('redirect listener failed to bind 127.0.0.1:1455'));
        return;
      }

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        codeReject(new Error(`OAuth flow timed out after ${OAUTH_TIMEOUT_MS / 1000}s`));
      }, OAUTH_TIMEOUT_MS);
      timer.unref();

      resolve({ server, codePromise });
    });
  });
}
