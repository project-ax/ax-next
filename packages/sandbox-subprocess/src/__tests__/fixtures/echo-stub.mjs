#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Tiny runner stub for open-session tests.
//
// Writes its env to stdout as a single JSON line, then stays alive until
// killed (SIGTERM/SIGKILL) by the test. Task 11's real native runner replaces
// this; for now we just need a node process that stays up long enough to
// assert on its env and to let us exercise kill() / natural-exit paths.
//
// Extra env we dump beyond the four AX_* values — FOO — is used by the
// allowlist-leak test to prove non-allowlist parent env does NOT reach the
// child (it will render as null here).
// ---------------------------------------------------------------------------
const env = {
  AX_RUNNER_ENDPOINT: process.env.AX_RUNNER_ENDPOINT ?? null,
  AX_SESSION_ID: process.env.AX_SESSION_ID ?? null,
  AX_AUTH_TOKEN: process.env.AX_AUTH_TOKEN ?? null,
  AX_WORKSPACE_ROOT: process.env.AX_WORKSPACE_ROOT ?? null,
  AX_LLM_PROXY_URL: process.env.AX_LLM_PROXY_URL ?? null,
  // Phase 2 — credential-proxy env (set only when proxyConfig was passed
  // to sandbox:open-session; absent on the legacy llm-proxy path).
  AX_PROXY_ENDPOINT: process.env.AX_PROXY_ENDPOINT ?? null,
  AX_PROXY_UNIX_SOCKET: process.env.AX_PROXY_UNIX_SOCKET ?? null,
  HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
  HTTP_PROXY: process.env.HTTP_PROXY ?? null,
  NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS ?? null,
  SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? null,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
  FOO: process.env.FOO ?? null,
};
process.stdout.write(JSON.stringify(env) + '\n');

// Hold the process open until killed. NO unref() — we want the interval to
// keep the Node event loop alive so the test can send SIGTERM deterministically
// and see `signal: 'SIGTERM'` reported on the 'close' event (default handler
// terminates with the signal, which is what the host observes).
setInterval(() => {}, 1_000);

