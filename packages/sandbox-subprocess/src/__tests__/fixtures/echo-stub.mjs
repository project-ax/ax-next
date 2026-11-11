#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Tiny runner stub for open-session tests.
//
// Writes its env to stdout as a single JSON line, then stays alive until
// killed (SIGTERM/SIGKILL) by the test. Task 11's real native runner replaces
// this; for now we just need a node process that stays up long enough to
// assert on its env and to let us exercise kill() / natural-exit paths.
//
// Extra env we dump beyond the AX_* values — FOO — is used by the
// allowlist-leak test to prove non-allowlist parent env does NOT reach the
// child (it will render as null here).
//
// After the env line, the stub writes a SECOND JSON line: a "probe"
// describing what the runner can see where the SDK discovers skills (the
// per-session `$CLAUDE_CONFIG_DIR/skills/` dir; the runner passes
// `settingSources: ['user']`, so that is the only place). This is what the
// skill-discovery acceptance test reads. The probe is best-effort — fields
// that can't be resolved (missing CLAUDE_CONFIG_DIR, no installed skill) are
// emitted as `null` with an error, so the env-only tests don't trip on it.
// ---------------------------------------------------------------------------
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const env = {
  // Every AX_* name the child received, sorted, so a test can pin the whole
  // control-variable surface (a name nobody stamps any more stays absent).
  AX_NAMES: Object.keys(process.env).filter((name) => name.startsWith('AX_')).sort(),
  AX_RUNNER_ENDPOINT: process.env.AX_RUNNER_ENDPOINT ?? null,
  AX_SESSION_ID: process.env.AX_SESSION_ID ?? null,
  AX_AUTH_TOKEN: process.env.AX_AUTH_TOKEN ?? null,
  // Session-scoped scratch root (subprocess: a per-session tempdir nested
  // in the IPC socket dir). Echoed so open-session.test.ts can assert the
  // child saw it and that it points at a real on-disk directory.
  AX_EPHEMERAL_ROOT: process.env.AX_EPHEMERAL_ROOT ?? null,
  // The deployment's MCP client name, forwarded from the host only when set.
  AX_MCP_CLIENT_NAME: process.env.AX_MCP_CLIENT_NAME ?? null,
  // credential-proxy env (set only when proxyConfig was passed to
  // sandbox:open-session).
  AX_PROXY_ENDPOINT: process.env.AX_PROXY_ENDPOINT ?? null,
  AX_PROXY_UNIX_SOCKET: process.env.AX_PROXY_UNIX_SOCKET ?? null,
  // TASK-52: per-session proxy token for egress attribution. The runner reads
  // it and embeds it as Proxy-Authorization Basic userinfo on the proxy URL.
  AX_PROXY_TOKEN: process.env.AX_PROXY_TOKEN ?? null,
  HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
  HTTP_PROXY: process.env.HTTP_PROXY ?? null,
  NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS ?? null,
  SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? null,
  // TASK-12: git (libcurl/OpenSSL) verifies the proxy MITM cert against
  // GIT_SSL_CAINFO, NOT the Node-side NODE_EXTRA_CA_CERTS / SSL_CERT_FILE.
  // Echoed so open-session.test.ts can assert it points at the per-session
  // CA file whenever proxyConfig is present.
  GIT_SSL_CAINFO: process.env.GIT_SSL_CAINFO ?? null,
  // TASK-62: Deno-compiled CLIs (rustls + bundled Mozilla roots) ignore
  // NODE_EXTRA_CA_CERTS / SSL_CERT_FILE and honor only DENO_CERT for the proxy
  // MITM cert. Echoed so open-session.test.ts can assert it points at the
  // per-session CA file whenever proxyConfig is present.
  DENO_CERT: process.env.DENO_CERT ?? null,
  // Test assertion only needs to know the placeholder is `ax-cred:<hex>`
  // shape (Phase 2 substitution) vs. unset. Echo a presence-only marker
  // so a real key — set in process.env by an over-eager test runner or
  // a developer's local secrets — never lands in captured test logs.
  ANTHROPIC_API_KEY: (() => {
    const v = process.env.ANTHROPIC_API_KEY;
    if (typeof v !== 'string' || v.length === 0) return null;
    return v.startsWith('ax-cred:') ? v : '[redacted]';
  })(),
  // Allowlisted parent vars echoed for the spread-precedence test.
  HOME: process.env.HOME ?? null,
  FOO: process.env.FOO ?? null,
  // Skill-discovery env (I-P0-3): per-session HOME + CLAUDE_CONFIG_DIR.
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
  // Git hardening + the fixed author/committer identity for the agent's own
  // git work (with GIT_CONFIG_GLOBAL=/dev/null, git has no identity of its
  // own). Mirrors the k8s side's gitParanoidEnv. Echoed here so
  // open-session.test.ts can assert the spawned child saw them.
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM ?? null,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? null,
  GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT ?? null,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? null,
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? null,
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? null,
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? null,
  GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT ?? null,
  GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0 ?? null,
  GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0 ?? null,
  // TASK-14: skill git-credential wiring stamps a `url.<base>.insteadOf`
  // rewrite at the next free GIT_CONFIG index (1, after safe.directory at 0).
  // Echoed so the git-credentials regression test can assert the placeholder
  // reached the child env.
  GIT_CONFIG_KEY_1: process.env.GIT_CONFIG_KEY_1 ?? null,
  GIT_CONFIG_VALUE_1: process.env.GIT_CONFIG_VALUE_1 ?? null,
};
process.stdout.write(JSON.stringify(env) + '\n');

// ---------------------------------------------------------------------------
// Skill-discovery probe — emits a second JSON line capturing what an SDK
// boot inside this child WOULD see when it walks `$CLAUDE_CONFIG_DIR/skills/`
// (the `'user'` setting source). Best-effort: any field that can't be
// resolved is `null`, with an `error` string for the test to surface.
// ---------------------------------------------------------------------------
async function safe(fn) {
  try {
    return { value: await fn(), error: null };
  } catch (err) {
    return { value: null, error: err && err.code ? err.code : String(err) };
  }
}

(async () => {
  const ccd = process.env.CLAUDE_CONFIG_DIR ?? null;

  const probe = {
    canaryReadFile: ccd
      ? await safe(() =>
          fs.readFile(path.join(ccd, 'skills', 'canary-skill', 'SKILL.md'), 'utf-8'),
        )
      : { value: null, error: 'no-CLAUDE_CONFIG_DIR' },
    installedSkillsDir: ccd
      ? await safe(async () => {
          const st = await fs.stat(path.join(ccd, 'skills'));
          return { isDirectory: st.isDirectory() };
        })
      : { value: null, error: 'no-CLAUDE_CONFIG_DIR' },
  };
  process.stdout.write(JSON.stringify(probe) + '\n');
})();

// Hold the process open until killed. NO unref() — we want the interval to
// keep the Node event loop alive so the test can send SIGTERM deterministically
// and see `signal: 'SIGTERM'` reported on the 'close' event (default handler
// terminates with the signal, which is what the host observes).
setInterval(() => {}, 1_000);

