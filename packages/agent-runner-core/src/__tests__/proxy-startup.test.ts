import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxyBootstrapPath, setupProxy, withProxyToken } from '../proxy-startup.js';
import type { RunnerEnv } from '../env.js';

// Snapshot a few env vars setupProxy mutates so the test suite stays
// deterministic — tests run sequentially in vitest by default but
// process.env is process-global, so be defensive.
const ENV_KEYS_TO_SAVE = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'AX_AUTH_TOKEN',
  'AX_RUNNER_ENDPOINT',
  'AX_SESSION_ID',
  'GITHUB_TOKEN',
  'SOME_REAL_SECRET',
  'GIT_SSL_CAINFO',
  'DENO_CERT',
] as const;

describe('proxyBootstrapPath (regression: missing --require target killed every production turn)', () => {
  // Regression coverage for TWO incidents where the file
  // proxyBootstrapPath() resolves to went missing at runtime, killing every
  // SDK subprocess with env.proxyUnixSocket or env.proxyEndpoint set
  // (NODE_OPTIONS=--require="<path-to-a-file-that-does-not-exist>" is a
  // hard Node startup failure):
  //
  //   1. proxy-startup.ts moved from @ax/agent-claude-sdk-runner into
  //      @ax/agent-runner-core but the CJS bootstrap it resolves relative
  //      to its own module (dist/proxy-startup.js -> dist/proxy-
  //      bootstrap.cjs) kept being copied into the OLD package's dist by
  //      the OLD package's postbuild. This package's own dist never got a
  //      copy.
  //   2. The fix for #1 — a `postbuild` script here (`cp src/proxy-
  //      bootstrap.cjs dist/`) — never fired on the paths that matter:
  //      root `pnpm build` is `tsc --build` (no per-package postbuild
  //      lifecycle), the container image builds via `pnpm --filter @ax/cli
  //      build` which walks tsc project references but does not run a
  //      dependency's postbuild, and the Dockerfile excludes **/dist from
  //      the build context. So proxy-bootstrap.cjs was STILL absent from
  //      dist/ (and from the built container) even with the postbuild
  //      script in place.
  //
  // The real fix: proxy-bootstrap.cts (a TypeScript source with the .cts
  // extension) is a normal tsc build INPUT under "module": "NodeNext" —
  // tsc emits it to dist/proxy-bootstrap.cjs on every build path with no
  // lifecycle hook involved at all.
  //
  // A test that only regex-matches the NODE_OPTIONS *string* shape
  // (`--require="...proxy-bootstrap.cjs"`, asserted further down) would
  // pass even when the target file doesn't exist anywhere on disk — that
  // shape assertion is exactly what shipped through incident #2 undetected.
  // The assertion below closes that gap: it resolves the REAL path
  // proxyBootstrapPath() returns and checks the file is actually there.

  it('tsc emits proxy-bootstrap.cjs into dist/ — the exact file proxyBootstrapPath() resolves to in production', () => {
    // Unconditional, not a fallback: this asserts the build ARTIFACT
    // exists, full stop. CI's `pnpm build` (or `pnpm typecheck`, which also
    // invokes `tsc --build`) runs before tests, so by the time this suite
    // executes, dist/proxy-bootstrap.cjs must already be on disk — tsc is
    // what puts it there now, not a postbuild copy step. If this fails,
    // either the tree hasn't been built yet (run `pnpm --filter
    // @ax/agent-runner-core build` first) or the .cts -> .cjs emission is
    // broken — in which case every proxy-configured SDK subprocess in
    // production is dead at startup (incidents #1 and #2 above).
    const packageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const distArtifact = path.join(packageDir, 'dist', 'proxy-bootstrap.cjs');
    expect(existsSync(distArtifact)).toBe(true);
  });

  it('proxyBootstrapPath() resolves to that same dist/ file at runtime', () => {
    // proxyBootstrapPath() is defined relative to proxy-startup.ts's own
    // module. Under vitest that's src/, so the resolved path names
    // src/proxy-bootstrap.cjs — a file that never exists (the source is
    // proxy-bootstrap.cts). This pins the RELATIONSHIP: whatever directory
    // proxyBootstrapPath() resolves relative to, the basename it asks for
    // is exactly the basename tsc emits into dist/ alongside the compiled
    // proxy-startup.js. Combined with the previous test (which proves the
    // dist/ file exists), this is the full chain the previous "existsSync
    // with a fallback" assertion was supposed to establish but couldn't,
    // because the fallback branch could never fail.
    expect(path.basename(proxyBootstrapPath())).toBe('proxy-bootstrap.cjs');
  });

  it("the .cts source now compiles to a normal build product — no postbuild lifecycle hook required", () => {
    // Pins the NEW guarantee this fix relies on: proxy-bootstrap.cts is a
    // tsc build input (like every other file in src/), not something a
    // lifecycle script has to copy after the fact. Asserts there is no
    // postbuild script left in package.json to bit-rot back into this
    // exact bug a third time, and that the .cts source is where
    // proxyBootstrapPath() (via its sibling .cjs) expects to find it.
    const packageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const pkgJsonPath = path.join(packageDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.postbuild).toBeUndefined();

    const srcDir = path.join(packageDir, 'src');
    const bootstrapSource = path.join(
      srcDir,
      path.basename(proxyBootstrapPath()).replace(/\.cjs$/, '.cts'),
    );
    expect(existsSync(bootstrapSource)).toBe(true);
  });
});

describe('withProxyToken (TASK-52)', () => {
  const TOKEN = 'a'.repeat(32);

  it('embeds the token as Basic ax:<token> userinfo on an http proxy URL', () => {
    expect(withProxyToken('http://127.0.0.1:9000', TOKEN)).toBe(
      `http://ax:${TOKEN}@127.0.0.1:9000`,
    );
  });

  it('returns the URL unchanged when the token is undefined (back-compat)', () => {
    expect(withProxyToken('http://127.0.0.1:9000', undefined)).toBe(
      'http://127.0.0.1:9000',
    );
  });

  it('returns the URL unchanged for a malformed (non-32-hex) token', () => {
    expect(withProxyToken('http://127.0.0.1:9000', 'not-a-hex-token')).toBe(
      'http://127.0.0.1:9000',
    );
  });

  it('does not append a trailing slash to a bare-authority URL', () => {
    // new URL() canonicalizes a bare authority by appending '/'; the helper
    // strips it so the proxy URL stays byte-identical to the no-token form.
    expect(withProxyToken('http://127.0.0.1:9000', TOKEN)).not.toMatch(/\/$/);
  });
});

describe('setupProxy', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS_TO_SAVE) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS_TO_SAVE) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // -------------------------------------------------------------------
  // Direct mode — AX_PROXY_ENDPOINT (subprocess sandbox).
  // -------------------------------------------------------------------

  it('direct mode: forwards process.env.ANTHROPIC_API_KEY (the placeholder); no ANTHROPIC_BASE_URL; no bridge', async () => {
    process.env.ANTHROPIC_API_KEY = 'ax-cred:0123456789abcdef0123456789abcdef';
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer',
      workspaceRoot: '/ws',
      proxyEndpoint: 'http://127.0.0.1:54321',
    };
    const out = await setupProxy(env);
    // setupProxy now also stamps HTTPS_PROXY/HTTP_PROXY/NODE_OPTIONS so
    // the SDK subprocess routes its outbound fetch through the bridge
    // (see proxy-bootstrap.cjs). Pin the credential placeholder here;
    // the proxy + bootstrap details are covered by their own assertions.
    expect(out.providerEnv.ANTHROPIC_API_KEY).toBe(
      'ax-cred:0123456789abcdef0123456789abcdef',
    );
    expect(out.providerEnv.HTTPS_PROXY).toBe('http://127.0.0.1:54321');
    expect(out.providerEnv.HTTP_PROXY).toBe('http://127.0.0.1:54321');
    // The bootstrap path is JSON.stringify-quoted so install paths with
    // spaces don't split NODE_OPTIONS at the whitespace boundary.
    expect(out.providerEnv.NODE_OPTIONS).toMatch(
      /--require="[^"]*proxy-bootstrap\.cjs"/,
    );
    expect(out.providerEnv.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(out.stop).toBeUndefined();
    // Direct mode: sandbox-subprocess set HTTPS_PROXY in the child env at
    // spawn time. setupProxy MUST NOT clobber that. We didn't set it in
    // this test process either, so it stays undefined.
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
  });

  it('direct mode: embeds proxyToken as Basic userinfo in the SDK subprocess proxy URL (TASK-52)', async () => {
    process.env.ANTHROPIC_API_KEY = 'ax-cred:0123456789abcdef0123456789abcdef';
    const token = 'c'.repeat(32);
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer',
      workspaceRoot: '/ws',
      proxyEndpoint: 'http://127.0.0.1:9000',
      proxyToken: token,
    };
    const out = await setupProxy(env);
    // The SDK subprocess reads HTTP(S)_PROXY; with the token embedded as
    // Basic userinfo, curl/undici/python all auto-send
    // `Proxy-Authorization: Basic ax:<token>` so the listener can attribute
    // their egress (incl. blocks) to this session.
    expect(out.providerEnv.HTTPS_PROXY).toBe(`http://ax:${token}@127.0.0.1:9000`);
    expect(out.providerEnv.HTTP_PROXY).toBe(`http://ax:${token}@127.0.0.1:9000`);
  });

  it('direct mode: leaves the proxy URL untouched when no token is present (back-compat)', async () => {
    process.env.ANTHROPIC_API_KEY = 'ax-cred:0123456789abcdef0123456789abcdef';
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer',
      workspaceRoot: '/ws',
      proxyEndpoint: 'http://127.0.0.1:9000',
    };
    const out = await setupProxy(env);
    expect(out.providerEnv.HTTPS_PROXY).toBe('http://127.0.0.1:9000');
    expect(out.providerEnv.HTTP_PROXY).toBe('http://127.0.0.1:9000');
  });

  // PR 4 (provider layer): setupProxy() runs BEFORE `session.get-config`, so
  // it cannot know which provider the agent targets and must not require any
  // particular vendor's key. It used to hard-require ANTHROPIC_API_KEY, which
  // meant an OpenRouter-only session died at boot before it could dial
  // anything. That assert now lives in @ax/agent-claude-sdk-runner, which
  // genuinely only ever talks to api.anthropic.com.
  it('direct mode: an OpenRouter-only session (no ANTHROPIC_API_KEY anywhere) boots and forwards OPENROUTER_API_KEY', async () => {
    // beforeEach deleted ANTHROPIC_API_KEY; assert that explicitly so the
    // test can't quietly start passing because some other key was present.
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    process.env.OPENROUTER_API_KEY = 'ax-cred:0123456789abcdef0123456789abcdef';
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer',
      workspaceRoot: '/ws',
      proxyEndpoint: 'http://127.0.0.1:54321',
    };
    const out = await setupProxy(env);
    // The generic value-shape forward (any `ax-cred:<32-hex>`-valued env var)
    // carries the OpenRouter placeholder through — no per-vendor special case.
    expect(out.providerEnv.OPENROUTER_API_KEY).toBe(
      'ax-cred:0123456789abcdef0123456789abcdef',
    );
    expect(out.providerEnv.ANTHROPIC_API_KEY).toBeUndefined();
    // Still a fully-formed startup: proxy + bootstrap wired as usual.
    expect(out.providerEnv.HTTPS_PROXY).toBe('http://127.0.0.1:54321');
    expect(out.providerEnv.NODE_OPTIONS).toMatch(
      /--require="[^"]*proxy-bootstrap\.cjs"/,
    );
  });

  it('direct mode: an ANTHROPIC_API_KEY that is not the ax-cred:<32-hex> placeholder is NOT forwarded', async () => {
    // I1 defense: a regressed wiring that lands a real `sk-ant-...` key (or
    // any non-placeholder string) in the runner's env must never reach the
    // provider-facing env. The value-shape forward is the filter — only the
    // exact format minted by @ax/credential-proxy's registry passes.
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer',
      workspaceRoot: '/ws',
      proxyEndpoint: 'http://127.0.0.1:54321',
    };
    const realLookingKeys = [
      'sk-ant-real-looking-key',
      'ax-cred:short',
      'ax-cred:0123456789abcdef0123456789abcdeg', // non-hex 'g'
      'ax-cred:0123456789ABCDEF0123456789ABCDEF', // uppercase
      'ax-cred:',
      'AX-CRED:0123456789abcdef0123456789abcdef', // wrong case prefix
    ];
    for (const k of realLookingKeys) {
      process.env.ANTHROPIC_API_KEY = k;
      const out = await setupProxy(env);
      expect(out.providerEnv.ANTHROPIC_API_KEY).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------
  // Bridge mode — AX_PROXY_UNIX_SOCKET (k8s sandbox).
  // -------------------------------------------------------------------

  // -------------------------------------------------------------------
  // Capability minimization (I5): control-plane env vars must NOT be
  // forwarded into the SDK subprocess. The Bash tool can spawn arbitrary
  // commands the model requests; an `echo $AX_AUTH_TOKEN` would land the
  // bearer in tool output → model context → assistant reply. A regression
  // here is a real exfiltration path.
  // -------------------------------------------------------------------

  it('direct mode: does NOT forward AX_* control-plane env into the SDK subprocess', async () => {
    process.env.ANTHROPIC_API_KEY = 'ax-cred:0123456789abcdef0123456789abcdef';
    process.env.AX_AUTH_TOKEN = 'ipc-bearer-secret';
    process.env.AX_RUNNER_ENDPOINT = 'http://host.internal:9090';
    process.env.AX_SESSION_ID = 'sess-1234';
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer-secret',
      workspaceRoot: '/ws',
      proxyEndpoint: 'http://127.0.0.1:54321',
    };
    const out = await setupProxy(env);
    expect(out.providerEnv.AX_AUTH_TOKEN).toBeUndefined();
    expect(out.providerEnv.AX_RUNNER_ENDPOINT).toBeUndefined();
    expect(out.providerEnv.AX_SESSION_ID).toBeUndefined();
    // Sanity: PATH (allow-listed) IS forwarded so the Bash tool works.
    expect(out.providerEnv.PATH).toBe(process.env.PATH);
  });

  it('direct mode: does NOT forward AX_INSTALLED_SKILLS_JSON into the SDK subprocess (I-P1-3)', async () => {
    // AX_INSTALLED_SKILLS_JSON is consumed BY THE RUNNER in main() BEFORE
    // the SDK spawns. The materialized files land at
    // $CLAUDE_CONFIG_DIR/skills/<id>/SKILL.md which the SDK discovers
    // naturally. Forwarding the raw JSON would put the full skill content
    // into every SDK call's env unnecessarily (bloat) and is excluded from
    // ENV_ALLOWLIST. This test pins that contract so a future ENV_ALLOWLIST
    // expansion can't accidentally re-include it.
    process.env.ANTHROPIC_API_KEY = 'ax-cred:0123456789abcdef0123456789abcdef';
    process.env['AX_INSTALLED_SKILLS_JSON'] = JSON.stringify([
      { id: 'github', skillMd: '---\nname: github\n---\nBody' },
    ]);
    const savedSkills = process.env['AX_INSTALLED_SKILLS_JSON'];
    try {
      const env: RunnerEnv = {
        runnerEndpoint: 'unix:///tmp/x.sock',
        sessionId: 's',
        authToken: 'ipc-bearer',
        workspaceRoot: '/ws',
        proxyEndpoint: 'http://127.0.0.1:54321',
      };
      const out = await setupProxy(env);
      expect(out.providerEnv['AX_INSTALLED_SKILLS_JSON']).toBeUndefined();
    } finally {
      if (savedSkills === undefined) {
        delete process.env['AX_INSTALLED_SKILLS_JSON'];
      } else {
        process.env['AX_INSTALLED_SKILLS_JSON'] = savedSkills;
      }
    }
  });

  it('direct mode: forwards skill slot env vars whose value is an ax-cred placeholder', async () => {
    // Phase 1 (skill-install) canary: when the agent has a skill attached
    // whose credentials bind a slot (e.g. GITHUB_TOKEN), the
    // credential-proxy stamps `<SLOT>=ax-cred:<hex>` onto the runner pod
    // env. Without forwarding into the SDK subprocess env, the model's
    // Bash tool sees `$GITHUB_TOKEN` as empty and the proxy substitution
    // path never fires — defeating the I3 canary scenario. The forward
    // is gated by value-shape (`ax-cred:<32-hex>`) so real env vars stay
    // out of the SDK subprocess.
    process.env.ANTHROPIC_API_KEY = 'ax-cred:0123456789abcdef0123456789abcdef';
    process.env.GITHUB_TOKEN = 'ax-cred:fedcba9876543210fedcba9876543210';
    // A real-shape secret that happens to share the slot's env-var
    // namespace must NOT be forwarded — proves the forward is value-
    // shape-gated, not env-var-name-pattern-gated.
    process.env.SOME_REAL_SECRET = 'sk-real-looking-secret';
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer',
      workspaceRoot: '/ws',
      proxyEndpoint: 'http://127.0.0.1:54321',
    };
    const out = await setupProxy(env);
    expect(out.providerEnv.GITHUB_TOKEN).toBe(
      'ax-cred:fedcba9876543210fedcba9876543210',
    );
    expect(out.providerEnv.SOME_REAL_SECRET).toBeUndefined();
  });

  it('forwards GIT_SSL_CAINFO into the SDK subprocess env so the Bash tool git trusts the proxy MITM cert (TASK-12)', async () => {
    // TASK-12: the model's `git clone` runs inside the SDK subprocess via
    // the Bash tool. That subprocess's env is built from providerEnv, NOT
    // the runner's process.env. git (libcurl/OpenSSL) verifies the proxy
    // MITM cert against GIT_SSL_CAINFO — NODE_EXTRA_CA_CERTS / SSL_CERT_FILE
    // only steer Node's TLS. The sandbox stamps GIT_SSL_CAINFO onto the
    // runner env; this asserts the runner forwards it through to the SDK
    // subprocess (the GIT_ prefix allowlist carries it). Without it, git
    // clone over the proxy dies with `unable to get local issuer
    // certificate` — the CLI-1 walk-fail.
    process.env.ANTHROPIC_API_KEY = 'ax-cred:0123456789abcdef0123456789abcdef';
    process.env.GIT_SSL_CAINFO = '/var/run/ax/proxy-ca/ca.crt';
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer',
      workspaceRoot: '/ws',
      proxyEndpoint: 'http://127.0.0.1:54321',
    };
    const out = await setupProxy(env);
    expect(out.providerEnv.GIT_SSL_CAINFO).toBe('/var/run/ax/proxy-ca/ca.crt');
  });

  it('forwards DENO_CERT into the SDK subprocess env so Deno-compiled CLIs trust the proxy MITM cert (TASK-62)', async () => {
    // TASK-62: a Deno-compiled CLI (e.g. `npx @schpet/linear-cli`) the model
    // runs via the Bash tool inherits the SDK subprocess env, which is built
    // from providerEnv — NOT the runner's process.env. Deno uses rustls with
    // a bundled Mozilla root store and ignores NODE_EXTRA_CA_CERTS /
    // SSL_CERT_FILE; only DENO_CERT (a PEM path added to its trust anchors)
    // makes it accept the proxy's MITM leaf cert. DENO_CERT is not covered by
    // an ENV_ALLOWLIST prefix, so setupProxy must forward it explicitly (like
    // NODE_EXTRA_CA_CERTS / SSL_CERT_FILE). Without it the CLI's HTTPS call
    // dies with `invalid peer certificate: UnknownIssuer`.
    process.env.ANTHROPIC_API_KEY = 'ax-cred:0123456789abcdef0123456789abcdef';
    process.env.DENO_CERT = '/var/run/ax/proxy-ca/ca.crt';
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer',
      workspaceRoot: '/ws',
      proxyEndpoint: 'http://127.0.0.1:54321',
    };
    const out = await setupProxy(env);
    expect(out.providerEnv.DENO_CERT).toBe('/var/run/ax/proxy-ca/ca.crt');
  });

  it('throws when both proxyEndpoint and proxyUnixSocket are set (mutually exclusive)', async () => {
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer',
      workspaceRoot: '/ws',
      proxyEndpoint: 'http://127.0.0.1:54321',
      proxyUnixSocket: '/var/run/ax/proxy.sock',
    };
    await expect(setupProxy(env)).rejects.toThrow(/mutually exclusive/);
  });

  it('bridge mode: stops the bridge AND restores HTTP_PROXY/HTTPS_PROXY if downstream validation throws', async () => {
    // Regression: setupProxy used to start the bridge, then if the
    // ANTHROPIC_API_KEY check failed, return without calling stop() —
    // the TCP listener stayed bound on 127.0.0.1 until the runner exited.
    // A later fix also surfaced a second leak on the same path:
    // setupProxy() rewrites process.env.HTTP_PROXY/HTTPS_PROXY before the
    // placeholder check, and the catch was leaving them pointed at the
    // (now-stopped) loopback bridge — so any best-effort retry or
    // teardown that re-read process.env dialed a dead port. Both
    // contracts are pinned below.
    //
    // PR 4 moved that ANTHROPIC_API_KEY check out to the claude-sdk runner,
    // so nothing after the bridge start throws on its own any more. The
    // contract under test is "if ANY later step throws", though — so we make
    // one throw: the env-forwarding loop enumerates process.env, and a
    // throwing getter on one enumerable key blows it up at exactly the point
    // the old assert did. Substituting process.env wholesale (rather than
    // defineProperty on the real one, which Node's env object rejects for
    // accessors) keeps the blast radius inside this test.
    //
    // We capture the bridge port BEFORE the rejection by reading
    // process.env.HTTPS_PROXY synchronously after setupProxy() throws but
    // before the env-restore runs — i.e., we install sentinel values up
    // front and rely on the catch swapping them back. The port itself
    // can't be read post-throw anymore, so the rebind check uses a fresh
    // listener on an ephemeral port and just verifies that creating a
    // second bridge succeeds (it would fail if the prior one held its
    // port).
    const sockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-test-bridge-cleanup-'));
    const sockPath = path.join(sockDir, 'proxy.sock');
    const upstream = net.createServer();
    await new Promise<void>((resolve) => upstream.listen(sockPath, resolve));

    // Sentinel values so we can tell whether the catch's env-restore ran.
    // HTTP_PROXY gets a non-empty sentinel; HTTPS_PROXY stays undefined so
    // we can verify the "delete vs assign" branch too.
    process.env.HTTP_PROXY = 'http://sentinel.pre-setup.invalid/';

    const realProcessEnv = process.env;
    const explodingEnv: NodeJS.ProcessEnv = { ...realProcessEnv };
    Object.defineProperty(explodingEnv, 'AX_TEST_EXPLODING_ENV_VAR', {
      enumerable: true,
      configurable: true,
      get(): string {
        throw new Error('synthetic downstream failure');
      },
    });
    process.env = explodingEnv;

    try {
      const env: RunnerEnv = {
        runnerEndpoint: 'unix:///tmp/x.sock',
        sessionId: 's',
        authToken: 'ipc-bearer',
        workspaceRoot: '/ws',
        proxyUnixSocket: sockPath,
      };
      // setupProxy starts the bridge, then throws while building the
      // provider-facing env.
      await expect(setupProxy(env)).rejects.toThrow(
        /synthetic downstream failure/,
      );

      // Env-restore contract: HTTP_PROXY was sentinel before the call →
      // must be that sentinel afterwards. HTTPS_PROXY was undefined →
      // must be undefined (deleted, not the literal "undefined").
      expect(process.env.HTTP_PROXY).toBe('http://sentinel.pre-setup.invalid/');
      expect(process.env.HTTPS_PROXY).toBeUndefined();

      // Bridge-stop contract: a second bridge against the same upstream
      // socket must succeed. If the prior bridge's listener leaked, the
      // import-level state in @ax/credential-proxy-bridge typically still
      // succeeds (it picks a fresh ephemeral port), so this is a weak
      // check — but it at least exercises the post-failure resume path.
      const { startWebProxyBridge } = await import('@ax/credential-proxy-bridge');
      const second = await startWebProxyBridge(sockPath);
      second.stop();
    } finally {
      // Put the real env back BEFORE afterEach's per-key restore runs.
      process.env = realProcessEnv;
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await fs.rm(sockDir, { recursive: true, force: true });
    }
  });

  it('bridge mode: starts the bridge, rewrites process.env.HTTPS_PROXY, returns stop()', async () => {
    process.env.ANTHROPIC_API_KEY = 'ax-cred:fedcba9876543210fedcba9876543210';

    // Spin up a no-op Unix socket server so the bridge has something to
    // dial. The bridge doesn't actually open a connection at start — it
    // listens for incoming TCP — but constructing the undici Agent
    // doesn't need the socket to exist either. We make one anyway so the
    // test doesn't depend on undici's tolerance for missing paths.
    const sockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-test-bridge-'));
    const sockPath = path.join(sockDir, 'proxy.sock');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    try {
      const env: RunnerEnv = {
        runnerEndpoint: 'unix:///tmp/x.sock',
        sessionId: 's',
        authToken: 'ipc-bearer',
        workspaceRoot: '/ws',
        proxyUnixSocket: sockPath,
      };
      const out = await setupProxy(env);
      try {
        expect(out.stop).toBeInstanceOf(Function);
        // process.env.HTTP_PROXY / HTTPS_PROXY now point at a loopback
        // bridge port on 127.0.0.1.
        expect(process.env.HTTP_PROXY).toMatch(
          /^http:\/\/127\.0\.0\.1:\d+$/,
        );
        expect(process.env.HTTPS_PROXY).toBe(process.env.HTTP_PROXY);
        // providerEnv carries the placeholder; no ANTHROPIC_BASE_URL.
        // Plus the proxy + NODE_OPTIONS bootstrap so the SDK subprocess
        // routes its outbound fetch through the bridge.
        expect(out.providerEnv.ANTHROPIC_API_KEY).toBe(
          'ax-cred:fedcba9876543210fedcba9876543210',
        );
        expect(out.providerEnv.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(out.providerEnv.HTTP_PROXY).toBe(out.providerEnv.HTTPS_PROXY);
        expect(out.providerEnv.NODE_OPTIONS).toMatch(
          /--require="[^"]*proxy-bootstrap\.cjs"/,
        );
        expect(out.providerEnv.ANTHROPIC_BASE_URL).toBeUndefined();
      } finally {
        out.stop?.();
      }
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      await fs.rm(sockDir, { recursive: true, force: true });
    }
  });

  it('bridge mode: embeds proxyToken as Basic userinfo on the local bridge proxy URL (TASK-52)', async () => {
    process.env.ANTHROPIC_API_KEY = 'ax-cred:fedcba9876543210fedcba9876543210';
    const token = 'd'.repeat(32);
    const sockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-test-bridge-'));
    const sockPath = path.join(sockDir, 'proxy.sock');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    try {
      const env: RunnerEnv = {
        runnerEndpoint: 'unix:///tmp/x.sock',
        sessionId: 's',
        authToken: 'ipc-bearer',
        workspaceRoot: '/ws',
        proxyUnixSocket: sockPath,
        proxyToken: token,
      };
      const out = await setupProxy(env);
      try {
        // The local bridge URL the SDK subprocess + the runner's own
        // dispatcher use now carries the token as Basic userinfo, so
        // Proxy-Authorization rides on every request through the bridge.
        const expected = new RegExp(`^http://ax:${token}@127\\.0\\.0\\.1:\\d+$`);
        expect(out.providerEnv.HTTPS_PROXY).toMatch(expected);
        expect(out.providerEnv.HTTP_PROXY).toBe(out.providerEnv.HTTPS_PROXY);
        // process.env (the runner's own dispatcher reads this) carries the
        // token-bearing URL too.
        expect(process.env.HTTP_PROXY).toMatch(expected);
        expect(process.env.HTTPS_PROXY).toBe(process.env.HTTP_PROXY);
      } finally {
        out.stop?.();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(sockDir, { recursive: true, force: true });
    }
  });
});
