// ---------------------------------------------------------------------------
// Provider construction + the in-process proxy fetch.
//
// This is the only place in the aisdk runner that builds a `LanguageModel`, and
// the only place that touches a credential. Two jobs, both security-shaped:
//
//   1. EXPLICIT CREDENTIAL INJECTION. `createAnthropic()` defaults `apiKey` to
//      `process.env.ANTHROPIC_API_KEY` when the option is omitted. That default
//      is exactly the provider-side auth discovery the design forbids
//      (docs/plans/2026-08-18-provider-agnostic-runner-design.md §6: "No
//      provider SDK may perform its own auth discovery"). We always pass
//      `apiKey` explicitly, from the `anthropicEnv` map `setupProxy()` handed
//      us, and we assert its `ax-cred:<32-hex>` placeholder shape first. That
//      assertion is defense in depth — `setupProxy()` makes the same check on
//      the way IN — but a real `sk-ant-…` key reaching this process is a
//      capability leak, not a convenience, so both ends check and a format
//      change has to update both.
//
//   2. AN IN-PROCESS PROXY DISPATCHER. This is new, and it is the thing that
//      makes the aisdk runner different from the claude-sdk one. That runner
//      makes its model call in a CHILD process, so `HTTPS_PROXY` in the child's
//      env is enough. We call the model IN-PROCESS via `fetch`, and Node's
//      global `fetch` ignores `HTTPS_PROXY` entirely. In bridge mode (k8s)
//      `setupProxy()` happens to install a global undici `ProxyAgent`, so we
//      would survive by accident; in DIRECT mode (`AX_PROXY_ENDPOINT`, the
//      subprocess sandbox) it installs nothing, and the model call would go
//      straight to api.anthropic.com carrying a placeholder key that nobody
//      substitutes. So we build our own dispatcher here, from the same
//      `anthropicEnv` — never from `process.env` — and never depend on a global.
//
// On the MITM: the credential-proxy terminates TLS and presents its own leaf
// for api.anthropic.com, so the dispatcher has to trust the proxy's root CA
// explicitly via `requestTls.ca`. `NODE_EXTRA_CA_CERTS` is read by Node once at
// process start, and the PEM may be written AFTER that (the runner shell writes
// it from env in some sandboxes), so relying on the process-level trust store
// is not enough — we read the PEM ourselves.
//
// Extension point: `PROVIDERS` below is a map keyed by provider name with
// exactly one entry today. Adding OpenRouter (PR 4) or Vertex (PR 5) is a new
// entry plus its credential env var — not a refactor of this file. We use a
// plain map rather than `ai`'s `createProviderRegistry` because we need
// `parseModelRef` anyway (the registry's own `NoSuchProviderError` says nothing
// about which PR ships the missing provider, and it splits the ref a second
// time), and because the per-provider credential env var has to live somewhere
// the registry has no slot for.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { parseModelRef } from '@ax/core';

/**
 * The credential-proxy registry's placeholder shape
 * (`packages/credential-proxy/src/registry.ts`). Deliberately duplicated from
 * `proxy-startup.ts` rather than exported across the package boundary: the
 * point of a defense-in-depth check is that it is an INDEPENDENT check. If the
 * format ever changes, both copies fail loudly instead of one silently
 * inheriting the other's mistake.
 */
const PLACEHOLDER_RE = /^ax-cred:[0-9a-f]{32}$/;

/**
 * Pinned rather than left to the SDK's default, which resolves
 * `ANTHROPIC_BASE_URL` from `process.env`. Nothing legitimate sets that var in
 * the sandbox, and if something did, the placeholder credential would be sent
 * to whatever host it named — a small but free hole to close. PR 4/5 providers
 * that genuinely need a configurable base URL should take it from their
 * registry entry, not from ambient env.
 */
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

interface ProviderEntry {
  /**
   * Key in `anthropicEnv` holding this provider's `ax-cred:<32-hex>`
   * placeholder. Anthropic's is `ANTHROPIC_API_KEY`; OpenRouter's will be
   * `OPENROUTER_API_KEY` (the credential mechanism is keyed by env name, not by
   * vendor — see design §6).
   */
  credentialEnvVar: string;
  /** Builds a model for the already-parsed, provider-prefix-stripped id. */
  create(opts: { apiKey: string; fetchImpl: typeof fetch | undefined }): (
    modelId: string,
  ) => LanguageModel;
}

const PROVIDERS: Record<string, ProviderEntry> = {
  anthropic: {
    credentialEnvVar: 'ANTHROPIC_API_KEY',
    create: ({ apiKey, fetchImpl }) => {
      const provider = createAnthropic({
        // Explicit, always. See the header comment — omitting this is the
        // auth-discovery bug, not a shortcut.
        apiKey,
        baseURL: ANTHROPIC_BASE_URL,
        // `exactOptionalPropertyTypes` — `{ fetch: undefined }` is not the same
        // as an absent key, and the SDK branches on absence.
        ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
      });
      return (modelId) => provider(modelId);
    },
  },
};

/**
 * The PRs that add the providers we do not support yet. Named in the boot error
 * so an operator who set `agents.model` to an OpenRouter ref learns when it will
 * work instead of just that it does not.
 */
const PROVIDER_ROADMAP = 'PR 4 (OpenRouter) / PR 5 (Vertex) of the runner sequence';

/**
 * Read the credential-proxy's MITM root CA PEM, if the sandbox delivered one.
 *
 * Missing or unreadable is NOT fatal: CA delivery differs per sandbox (hostPath
 * mount vs. written from env at boot vs. already in the pod's trust store), and
 * the pod may well trust the proxy without our help. We log to stderr and let
 * the TLS handshake be the thing that fails, loudly, if the CA really was
 * needed — that failure names the actual problem, whereas throwing here would
 * kill a runner that would have worked fine.
 */
export function readProxyCaPem(
  anthropicEnv: Record<string, string>,
): string | undefined {
  const caPath = anthropicEnv.NODE_EXTRA_CA_CERTS ?? anthropicEnv.SSL_CERT_FILE;
  if (caPath === undefined || caPath.length === 0) return undefined;
  try {
    return fs.readFileSync(caPath, 'utf8');
  } catch (err) {
    console.error(
      `[aisdk-runner] could not read proxy CA at ${caPath}: ${String(err)} — ` +
        `continuing with the process trust store (the TLS handshake will say ` +
        `so if this was the CA we needed)`,
    );
    return undefined;
  }
}

/**
 * Build the `fetch` the provider uses: routes every model request through the
 * session credential-proxy and trusts the proxy's MITM CA.
 *
 * Returns `undefined` when no proxy is configured (unit tests, local dev). The
 * caller then simply omits `fetch` and the SDK uses the platform default.
 *
 * A malformed proxy URL throws rather than degrading to a direct call: silently
 * bypassing the egress-control proxy is the one failure mode we must never have
 * (it would also send the placeholder key upstream unsubstituted, which fails
 * anyway — just much later and with a confusing message).
 */
export function createProxyFetch(
  anthropicEnv: Record<string, string>,
): typeof fetch | undefined {
  // Both are set to the same value by `setupProxy`; HTTPS first because every
  // model endpoint we speak to is https.
  const rawProxy = anthropicEnv.HTTPS_PROXY ?? anthropicEnv.HTTP_PROXY;
  if (rawProxy === undefined || rawProxy.length === 0) return undefined;

  let url: URL;
  try {
    url = new URL(rawProxy);
  } catch {
    throw new Error(
      `agent-aisdk-runner: HTTPS_PROXY is not a valid URL (got: ${rawProxy}). ` +
        `Refusing to fall back to a direct connection — that would bypass the ` +
        `credential proxy and send the ax-cred placeholder upstream.`,
    );
  }

  // `setupProxy` embeds the per-session proxy token as Basic userinfo
  // (`http://ax:<token>@host:port`) so every off-the-shelf client that reads
  // HTTP(S)_PROXY sends `Proxy-Authorization` automatically. undici's
  // ProxyAgent has its own userinfo handling, but bridge-mode in
  // `proxy-startup.ts` deliberately does not rely on it — it strips the
  // userinfo and passes `token` explicitly. Mirror that exactly: one behaviour
  // to reason about across both dispatchers.
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  const uri = url.toString().replace(/\/$/, '');

  const ca = readProxyCaPem(anthropicEnv);
  const dispatcher = new ProxyAgent({
    uri,
    ...(password.length > 0
      ? {
          token: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        }
      : {}),
    // `requestTls` is the TLS config for the tunnelled connection to the
    // ORIGIN — which, through a MITM proxy, is the proxy's own leaf cert. This
    // is the knob that makes the handshake succeed; `proxyTls` would be for
    // an https proxy endpoint, which ours is not.
    ...(ca !== undefined ? { requestTls: { ca } } : {}),
  });

  // We deliberately use undici's OWN `fetch`, not Node's global one, so the
  // dispatcher and the fetch implementation come from the same copy of undici.
  // Handing a v6 ProxyAgent to the runtime's bundled (different-major) fetch
  // means one major's client driving the other major's stream handler — the
  // same class of cross-copy breakage `.claude/memory/mistakes.md` records for
  // undici. Same copy, no ambiguity.
  //
  // The cast: undici types its own `RequestInfo`/`Response` classes, which are
  // structurally the same objects Node exposes globally but are nominally
  // distinct types. The AI SDK only ever passes a URL string plus
  // `{ method, headers, body, signal }` and only ever reads `status`,
  // `headers.get()` and `body` (a web `ReadableStream` in both), so the shapes
  // genuinely match at runtime. Narrowed to the boundary rather than typing the
  // whole function `any`.
  const proxyFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    undiciFetch(input as string, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    });
  return proxyFetch as unknown as typeof fetch;
}

export interface ResolveModelOptions {
  /** `agentConfig.model` — a `provider/model-id` ref. */
  modelRef: string;
  /** `ProxyStartup.anthropicEnv` from `setupProxy()`. */
  anthropicEnv: Record<string, string>;
  /**
   * Override for the fetch the provider uses. Defaults to
   * `createProxyFetch(anthropicEnv)`. Exists so tests can capture what would go
   * on the wire without a network; production callers omit it.
   */
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Parse + validate the model ref and return a `LanguageModel` ready for
 * `ToolLoopAgent`.
 *
 * Throws at boot — never at the first token — when the ref names a provider
 * this runner cannot drive yet. The prefix is never silently dropped and there
 * is no "no slash means Anthropic" fallback: an agent explicitly configured for
 * grok must not quietly get Claude (design §6).
 */
export function resolveModel(opts: ResolveModelOptions): LanguageModel {
  const { modelRef, anthropicEnv } = opts;
  // Throws `PluginError({ code: 'invalid-payload' })` on anything that is not
  // `provider/model-id`, which includes a bare `claude-sonnet-4-6`.
  const { provider, modelId } = parseModelRef(modelRef);

  const entry = PROVIDERS[provider];
  if (entry === undefined) {
    throw new Error(
      `agent-aisdk-runner: agentConfig.model "${modelRef}" targets provider ` +
        `"${provider}", but this runner ships Anthropic support only today. ` +
        `Multi-provider support arrives in ${PROVIDER_ROADMAP}. Set the agent's ` +
        `model to an "anthropic/<model-id>" ref, or select a runner that ` +
        `supports "${provider}".`,
    );
  }

  const apiKey = anthropicEnv[entry.credentialEnvVar];
  if (typeof apiKey !== 'string' || !PLACEHOLDER_RE.test(apiKey)) {
    throw new Error(
      `agent-aisdk-runner: ${entry.credentialEnvVar} must be the ` +
        `ax-cred:<32-hex> placeholder minted by proxy:open-session ` +
        `(got ${apiKey === undefined || apiKey.length === 0 ? 'nothing' : 'a value of another shape'}). ` +
        `A real provider key reaching the sandbox is a capability leak, not a ` +
        `convenience — the credential proxy substitutes the real value ` +
        `mid-flight and this process must never hold it.`,
    );
  }

  const fetchImpl =
    opts.fetchImpl !== undefined ? opts.fetchImpl : createProxyFetch(anthropicEnv);
  return entry.create({ apiKey, fetchImpl })(modelId);
}
