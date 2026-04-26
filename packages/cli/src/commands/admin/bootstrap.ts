// ax-next admin bootstrap [--email <e>] [--display-name <n>]
//                         [--http-base <url>] [--with-default-agent]
//
// One-shot first-admin creation against /auth/dev-bootstrap (Invariant I12).
// The dev-bootstrap path is dev-only — the server refuses to register it
// when NODE_ENV=production. We rely on that and on AX_DEV_BOOTSTRAP_TOKEN
// being a shared secret between operator and server.
//
// Idempotency (I12):
//   The auth route returns `{user, isNew: boolean}`. On `isNew=false` we
//   print `bootstrap_already_done` and exit 0 — re-running is safe.
//
// Cookie discipline:
//   The session cookie is sensitive. We print it ONLY to STDERR so an
//   operator can `2>cookie.txt 1>summary.txt` to redirect them separately.
//   STDOUT carries the human-readable summary; nothing secret lands there.
//
// Network surface:
//   We POST to <base>/auth/dev-bootstrap. With --with-default-agent we
//   then POST to <base>/admin/agents using the cookie we just received.
//   Both calls include `X-Requested-With: ax-admin` to satisfy
//   @ax/http-server's CSRF rule for state-changing requests.

const PLUGIN_NAME = '@ax/cli';

const USAGE = `usage: ax-next admin bootstrap [options]

  --email <e>             email address for the first admin user
  --display-name <n>      display name for the first admin user
  --http-base <url>       server base URL (default: env AX_HTTP_BASE
                          or http://localhost:8080)
  --with-default-agent    after bootstrap, create a default personal agent

env:
  AX_DEV_BOOTSTRAP_TOKEN  required, shared secret with the server's
                          auth plugin (matches devBootstrap.token in config)
  AX_HTTP_BASE            default base URL when --http-base is not given

The dev-bootstrap path is dev-only and refuses to run when
NODE_ENV=production on the server side. Use OIDC for production sign-in.

The session cookie is printed to STDERR (not STDOUT) so it can be
captured separately, e.g.:

  ax-next admin bootstrap --email me@example.com 2>cookie.env 1>summary.txt`;

const DEFAULT_HTTP_BASE = 'http://localhost:8080';

// Sane-default agent shape. allowedTools/mcpConfigIds carry one entry each
// because the admin route REJECTS the wildcard-bypass shape (allowedTools=[]
// AND mcpConfigIds=[]) — the wildcard is reserved for dev-agents-stub. Bash
// is the only first-party tool guaranteed registered in the multi-tenant
// preset's tool-dispatcher, so it's the safest pick. Operators can edit the
// agent later via PATCH /admin/agents/:id.
const DEFAULT_AGENT_BODY = {
  displayName: 'Default Personal Agent',
  systemPrompt: 'You are a helpful assistant.',
  allowedTools: ['bash'],
  mcpConfigIds: [],
  model: 'claude-sonnet-4-5',
  visibility: 'personal' as const,
};

interface ParsedArgs {
  email?: string;
  displayName?: string;
  httpBase?: string;
  withDefaultAgent: boolean;
}

interface ParseError {
  error: string;
}

function parseArgs(argv: string[]): ParsedArgs | ParseError {
  const out: ParsedArgs = { withDefaultAgent: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') {
      return { error: 'help' };
    }
    if (a === '--with-default-agent') {
      out.withDefaultAgent = true;
      continue;
    }
    if (a === '--email' || a === '--display-name' || a === '--http-base') {
      const v = argv[i + 1];
      if (v === undefined) return { error: `${a} requires a value` };
      if (a === '--email') out.email = v;
      else if (a === '--display-name') out.displayName = v;
      else out.httpBase = v;
      i++;
      continue;
    }
    return { error: `unknown argument: ${a}` };
  }
  return out;
}

export interface RunAdminBootstrapOptions {
  argv: string[];
  /** Defaults to `process.env`. Tests pass an explicit map. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.stdout — human summary, never secrets. */
  stdout?: (line: string) => void;
  /** Defaults to process.stderr — diagnostics + the session cookie. */
  stderr?: (line: string) => void;
  /**
   * Test-only seam. When set, replaces the global `fetch` for HTTP calls.
   * Production uses Node's built-in fetch.
   */
  fetchImpl?: typeof fetch;
}

interface DevBootstrapResponse {
  user: {
    id: string;
    email: string | null;
    displayName: string | null;
    isAdmin: boolean;
  };
  isNew: boolean;
}

interface CreateAgentResponse {
  agent: { id: string };
}

/**
 * Pull the session cookie out of `Set-Cookie` headers. The auth plugin's
 * cookie name is `ax_auth_session`; we hard-code it here because the CLI
 * never connects to the kernel at runtime. Returns null if absent.
 */
function extractSessionCookie(setCookieHeaders: string[]): string | null {
  for (const raw of setCookieHeaders) {
    const eq = raw.indexOf('=');
    if (eq <= 0) continue;
    const name = raw.slice(0, eq);
    if (name !== 'ax_auth_session') continue;
    // Cookie value runs to the first `;` (the rest is attributes:
    // Path=/, HttpOnly, Secure, SameSite=Lax, etc.). RFC 6265 says
    // values must not contain `;` so a plain split is safe.
    const semi = raw.indexOf(';', eq + 1);
    return semi === -1 ? raw.slice(eq + 1) : raw.slice(eq + 1, semi);
  }
  return null;
}

/**
 * Browsers' native `Headers.getSetCookie()` returns a string[]; node-fetch
 * compatibility shims sometimes return a single comma-joined string from
 * `.get('set-cookie')`. We support both so library-mode tests can pass any
 * reasonable Response back.
 */
function getSetCookieList(res: Response): string[] {
  const h = res.headers;
  // Modern: undici/Node 22+ supports getSetCookie().
  const fn = (h as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof fn === 'function') {
    return fn.call(h);
  }
  const single = h.get('set-cookie');
  return single === null ? [] : [single];
}

export async function runAdminBootstrapCommand(
  opts: RunAdminBootstrapOptions,
): Promise<number> {
  const out = opts.stdout ?? ((line: string) => process.stdout.write(line + '\n'));
  const err = opts.stderr ?? ((line: string) => process.stderr.write(line + '\n'));
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const parsed = parseArgs(opts.argv);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      out(USAGE);
      return 0;
    }
    err(`admin bootstrap: ${parsed.error}`);
    err(USAGE);
    return 2;
  }

  const token = env.AX_DEV_BOOTSTRAP_TOKEN;
  if (token === undefined || token === '') {
    err(
      'admin bootstrap: AX_DEV_BOOTSTRAP_TOKEN is unset. Set it to the same value as the server\'s devBootstrap.token config and try again.',
    );
    return 2;
  }

  const httpBase =
    parsed.httpBase ?? env.AX_HTTP_BASE ?? DEFAULT_HTTP_BASE;
  // Strip a single trailing slash so URL composition is predictable.
  const base = httpBase.endsWith('/') ? httpBase.slice(0, -1) : httpBase;

  // Step 1: POST /auth/dev-bootstrap.
  const bootstrapBody: Record<string, string> = { token };
  if (parsed.displayName !== undefined) bootstrapBody.displayName = parsed.displayName;
  if (parsed.email !== undefined) bootstrapBody.email = parsed.email;

  let bootstrapRes: Response;
  try {
    bootstrapRes = await fetchImpl(`${base}/auth/dev-bootstrap`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // CSRF gate in @ax/http-server. The header is checked structurally
        // (presence + non-empty value) rather than against an allowlist.
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify(bootstrapBody),
    });
  } catch (e) {
    err(`admin bootstrap: failed to reach ${base}/auth/dev-bootstrap: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  if (!bootstrapRes.ok) {
    // Drain body for diagnostics, but don't echo arbitrarily long content.
    let detail = '';
    try {
      const t = await bootstrapRes.text();
      detail = t.length > 200 ? `${t.slice(0, 200)}…` : t;
    } catch {
      /* ignore */
    }
    if (bootstrapRes.status === 401) {
      err('admin bootstrap: server rejected token (401). Check AX_DEV_BOOTSTRAP_TOKEN matches the server config.');
    } else if (bootstrapRes.status === 404) {
      err('admin bootstrap: server returned 404 — dev-bootstrap may be disabled (NODE_ENV=production or no token configured).');
    } else {
      err(`admin bootstrap: server returned ${bootstrapRes.status}: ${detail}`);
    }
    return 1;
  }

  const cookie = extractSessionCookie(getSetCookieList(bootstrapRes));
  if (cookie === null) {
    err('admin bootstrap: server response missing ax_auth_session cookie. Check server logs.');
    return 1;
  }

  let bootstrapJson: DevBootstrapResponse;
  try {
    bootstrapJson = (await bootstrapRes.json()) as DevBootstrapResponse;
  } catch (e) {
    err(`admin bootstrap: server response was not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  if (bootstrapJson.isNew === false) {
    out(`[ok] bootstrap_already_done — user ${bootstrapJson.user.id} already exists.`);
    // Cookie is still valid for follow-up calls — print it to STDERR so
    // an operator who wants to do further admin work has it. STDOUT stays
    // free of secrets.
    err(`# session cookie (sensitive — do not commit):`);
    err(`ax_auth_session=${cookie}`);
    return 0;
  }

  out(`[ok] dev-bootstrap user created (user_id=${bootstrapJson.user.id}).`);

  // Step 2 (optional): POST /admin/agents.
  let agentId: string | null = null;
  if (parsed.withDefaultAgent) {
    let agentRes: Response;
    try {
      agentRes = await fetchImpl(`${base}/admin/agents`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'ax-admin',
          // Manual cookie threading — the CLI is one-shot, no cookie jar.
          cookie: `ax_auth_session=${cookie}`,
        },
        body: JSON.stringify(DEFAULT_AGENT_BODY),
      });
    } catch (e) {
      err(`admin bootstrap: failed to reach ${base}/admin/agents: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    if (!agentRes.ok) {
      let detail = '';
      try {
        const t = await agentRes.text();
        detail = t.length > 200 ? `${t.slice(0, 200)}…` : t;
      } catch {
        /* ignore */
      }
      err(`admin bootstrap: agent creation failed (${agentRes.status}): ${detail}`);
      return 1;
    }
    let agentJson: CreateAgentResponse;
    try {
      agentJson = (await agentRes.json()) as CreateAgentResponse;
    } catch (e) {
      err(`admin bootstrap: agent response was not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    agentId = agentJson.agent.id;
    out(`[ok] default agent created (agent_id=${agentId}).`);
  }

  // Cookie value to STDERR. Sensitive: an attacker with this cookie can
  // act as the admin until expiry. Operators should redirect 2> to a file
  // they protect, then `rm` it after the session expires.
  err('');
  err('# session cookie (sensitive — do not commit, do not paste in chat):');
  err(`ax_auth_session=${cookie}`);

  // Curl-ready follow-up snippet on STDOUT — no secret values, just the
  // shape an operator needs.
  out('');
  out('Try:');
  out(`  curl -b "ax_auth_session=$AX_AUTH_SESSION" ${base}/admin/me`);
  if (!parsed.withDefaultAgent) {
    out(`  curl -b "ax_auth_session=$AX_AUTH_SESSION" ${base}/admin/agents`);
  }
  out('');
  out('Note: The dev-bootstrap path is dev-only and refuses to run in');
  out('NODE_ENV=production. Use OIDC for production sign-in.');

  // Plugin-name comment to satisfy a future grep — keeps this file
  // discoverable as part of @ax/cli.
  void PLUGIN_NAME;
  return 0;
}
