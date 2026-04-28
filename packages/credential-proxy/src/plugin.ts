/**
 * @ax/credential-proxy — host-side egress + credential injection plugin.
 *
 * Boot sequence:
 *  1. Resolve config (defaults `caDir = ~/.ax/proxy-ca`).
 *  2. Get-or-create the MITM CA.
 *  3. Start the listener with an empty session-config Map. The plugin
 *     keeps a shared reference to that Map and mutates it directly as
 *     `proxy:open-session` / `proxy:close-session` fire — no setter
 *     methods on the listener (it already iterates `.values()`).
 *     Pass `onAudit` so each `ProxyAuditEntry` becomes an
 *     `event.http-egress` bus fire (Task 11).
 *  4. Register the three service hooks (open / rotate / close).
 *
 * `event.http-egress` payload shape lives in `HttpEgressEvent` below
 * (mirrors the architecture spec). Subscribers can throw — HookBus.fire
 * isolates throws + logs them; the proxy keeps running.
 *
 * Shutdown: stop the listener (this also closes any active sockets and
 * unlinks the Unix socket file when applicable).
 *
 * The `credentials:get` shape used here is the Phase 3 reshape:
 * `({ ref, userId }) → string`. The env-name → placeholder mapping
 * doesn't depend on the credentials API shape — this plugin only
 * needs to receive the resolved string per ref.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { PluginError, makeAgentContext, type AgentContext, type Plugin } from '@ax/core';
import {
  startProxyListener,
  type ProxyListener,
  type ProxyAuditEntry,
  type SessionConfig,
} from './listener.js';
import { CredentialPlaceholderMap, SharedCredentialRegistry } from './registry.js';
import { getOrCreateCA } from './ca.js';

const PLUGIN_NAME = '@ax/credential-proxy';

// ── event.http-egress payload shape (architecture spec) ───────────────

/**
 * Public event payload fired on every proxy request — success, block, or
 * upstream error. Subscribers (audit-log writers, billing, anomaly
 * detection, security observers) can key off any field, but the listener-
 * internal `ProxyAuditEntry` shape is NOT part of the contract.
 *
 * Field semantics:
 * - `host`/`path` are split from the request URL; for CONNECT (`host:port`)
 *   `path` is `'/'`.
 * - `credentialInjected` is `true` only when MITM substitution actually
 *   replaced bytes (HTTP forwarding never substitutes; bypassMITM never
 *   substitutes; MITM only sets it when a placeholder matched).
 * - `blockedReason` is omitted on success; on a block, it's one of the
 *   four enumerated reasons (vocabulary normalized from the listener's
 *   internal `blocked` string).
 * - `sessionId`/`userId` are empty strings when no session matched
 *   (allowlist miss — the request never had an owner).
 */
export interface HttpEgressEvent {
  sessionId: string;
  userId: string;
  method: string;
  host: string;
  path: string;
  status: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  credentialInjected: boolean;
  classification: 'llm' | 'mcp' | 'other';
  blockedReason?: 'allowlist' | 'private-ip' | 'canary' | 'tls-error';
  timestamp: number;
}

/**
 * Map a per-session credentials record to a coarse classification.
 *
 * - `'llm'`: any credential whose kind is an LLM kind. Phase 1a recognizes
 *   `'api-key'`; future kinds matching the `anthropic-*` pattern (e.g.
 *   `'anthropic-oauth'`) also count as LLM.
 * - `'mcp'`: any credential whose kind starts with `'mcp-'` (Phase 3 wires
 *   real MCP credential kinds; Phase 1a never returns this).
 * - `'other'`: empty credentials, or only kinds outside the above sets.
 *
 * Precedence: `'llm'` wins over `'mcp'` if both appear (rare in practice;
 * a session usually has one kind of traffic).
 */
function classifyCredentials(
  credentials: Record<string, { ref: string; kind: string }>,
): 'llm' | 'mcp' | 'other' {
  let hasLlm = false;
  let hasMcp = false;
  for (const { kind } of Object.values(credentials)) {
    if (kind === 'api-key' || kind.startsWith('anthropic-')) hasLlm = true;
    else if (kind.startsWith('mcp-')) hasMcp = true;
  }
  if (hasLlm) return 'llm';
  if (hasMcp) return 'mcp';
  return 'other';
}

/**
 * Translate the listener's internal `blocked` string vocabulary into the
 * bus event's `blockedReason` enum. Returns `undefined` if the audit entry
 * isn't a block (or carries an unrecognized reason — we don't fabricate).
 *
 * Vocabulary:
 * - `domain_denied: …`     → `'allowlist'`  (allowlist miss)
 * - `Blocked: …` (BlockedIPError) → `'private-ip'`
 * - `canary_detected`      → `'canary'`
 * - `tls_error: …`         → `'tls-error'`
 * - anything else (`invalid_target`, `Proxy error: …`) → undefined
 *   (these surface as a non-2xx `status` instead).
 */
function mapBlockedReason(
  blocked: string | undefined,
): HttpEgressEvent['blockedReason'] | undefined {
  if (blocked === undefined) return undefined;
  if (blocked.startsWith('domain_denied:')) return 'allowlist';
  if (blocked.startsWith('Blocked:')) return 'private-ip';
  if (blocked === 'canary_detected') return 'canary';
  if (blocked.startsWith('tls_error:')) return 'tls-error';
  return undefined;
}

/**
 * Parse an audit entry's `url` into `{ host, path }` for the bus event.
 *
 * Two URL shapes the listener hands us:
 * - HTTP forward: an absolute URL like `http://api.example.com/foo` (or
 *   the raw `req.url` path, if the bridge passed a relative form). The
 *   `URL` constructor handles both with a fallback base.
 * - CONNECT: a `host:port` target like `api.anthropic.com:443`. There's
 *   no path on a CONNECT — set `'/'` so subscribers always see a string.
 *
 * For CONNECT entries (`method === 'CONNECT'`) the URL parser would treat
 * `api.anthropic.com:443` as a protocol-relative URL and fail; we
 * special-case the split.
 */
function parseHostPath(method: string, url: string): { host: string; path: string } {
  if (method === 'CONNECT') {
    // CONNECT target is `host:port`. Split on the last `:` so IPv6 literals
    // like `[::1]:443` still work — though Phase 1a's bridge only emits
    // hostnames (no IPv6 brackets).
    const lastColon = url.lastIndexOf(':');
    const host = lastColon === -1 ? url : url.slice(0, lastColon);
    return { host, path: '/' };
  }
  try {
    const parsed = new URL(
      url.startsWith('http://') || url.startsWith('https://')
        ? url
        : `http://placeholder${url.startsWith('/') ? url : '/' + url}`,
    );
    // For the placeholder fallback, host is meaningless — return empty so
    // subscribers don't think it was a real hostname. (This branch is rare:
    // the HTTP forwarding path always builds an absolute URL before logging.)
    const host = parsed.hostname === 'placeholder' ? '' : parsed.hostname;
    return { host, path: parsed.pathname + parsed.search };
  } catch {
    return { host: '', path: url };
  }
}

export interface CredentialProxyConfig {
  listen: { kind: 'unix'; path: string } | { kind: 'tcp'; host?: string; port?: number };
  caDir?: string;
}

// ── Hook payload types (Phase 1a — Task 11 may revise audit shape) ────

interface OpenSessionInput {
  sessionId: string;
  userId: string;
  agentId: string;
  /** Hostnames this session is allowed to reach (exact match). */
  allowlist: string[];
  /** envName → { ref to credentials store, kind hint for downstream policy }. */
  credentials: Record<string, { ref: string; kind: string }>;
  /** Hostnames whose CONNECT bypasses MITM (cert-pinning escape hatch). */
  bypassMITM?: string[];
  /** Optional canary token; chunks containing it trip a 403. */
  canaryToken?: string;
  /** IPs exempt from the private-range block — test-only escape hatch. */
  allowedIPs?: string[];
}

interface OpenSessionOutput {
  /** Endpoint the bridge / sandbox bootstrap should point HTTP(S)_PROXY at. */
  proxyEndpoint: string;
  /** Root CA cert PEM the sandbox must trust to validate MITM leaf certs. */
  caCertPem: string;
  /** envName → opaque placeholder token (`ax-cred:<32-hex>`). */
  envMap: Record<string, string>;
}

interface CloseSessionInput {
  sessionId: string;
}

interface RotateSessionInput {
  sessionId: string;
}

interface RotateSessionOutput {
  /** Fresh envName → placeholder map. Old placeholders no longer match. */
  envMap: Record<string, string>;
}

/** envName → original credential ref (so rotate can re-resolve). */
type SessionCredentialRefs = Record<string, { ref: string; kind: string }>;

// ── Helpers ──────────────────────────────────────────────────────────

function buildEndpointString(
  listen: CredentialProxyConfig['listen'],
  listener: ProxyListener,
): string {
  if (listen.kind === 'unix') {
    return `unix://${listen.path}`;
  }
  const host = listen.host ?? '127.0.0.1';
  return `tcp://${host}:${listener.port}`;
}

// ── Plugin ───────────────────────────────────────────────────────────

export function createCredentialProxyPlugin(config: CredentialProxyConfig): Plugin {
  // Capture the listener and shared mutable state in closure — the plugin's
  // hook handlers and shutdown all need access. They're assigned during
  // init(); accessing before init() throws via the explicit `if (!ready)`
  // guards inside each handler (handlers can't fire until init completes
  // because they're registered there).
  let listener: ProxyListener | undefined;
  let sessions: Map<string, SessionConfig> | undefined;
  let registry: SharedCredentialRegistry | undefined;
  let caCertPem: string | undefined;
  let endpointString: string | undefined;
  // Per-session credential refs — populated on open, read on rotate, dropped
  // on close. Lives on the plugin instance (not on SessionConfig) because it's
  // private state used only for rotation; the listener never reads it.
  const sessionCredentialRefs = new Map<string, SessionCredentialRefs>();

  const caDir = config.caDir ?? join(homedir(), '.ax', 'proxy-ca');

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['proxy:open-session', 'proxy:rotate-session', 'proxy:close-session'],
      calls: ['credentials:get'],
      subscribes: [],
    },

    async init({ bus }) {
      // 1. Get/create the MITM CA.
      const ca = await getOrCreateCA(caDir);
      caCertPem = ca.cert;

      // 2. Build the per-process registry + session-config Map. Both are
      //    shared by reference with the listener, so future mutations
      //    flow through without setter methods.
      sessions = new Map<string, SessionConfig>();
      registry = new SharedCredentialRegistry();

      // 3. Start the listener with an `onAudit` that translates each
      //    listener-internal `ProxyAuditEntry` into the public
      //    `event.http-egress` payload and fires it on the bus.
      //
      //    The listener calls onAudit synchronously from inside HTTP/CONNECT
      //    handlers; we intentionally don't await `bus.fire` here. Subscriber
      //    failures are caught + logged inside HookBus.fire (the contract),
      //    so a misbehaving subscriber can't break the proxy. We swallow the
      //    returned promise rejection (which would only fire if `fire` itself
      //    throws — currently impossible) so an unhandled rejection can't
      //    take the process down.
      const onAudit = (entry: ProxyAuditEntry): void => {
        const { host, path } = parseHostPath(entry.method, entry.url);
        const blockedReason = mapBlockedReason(entry.blocked);
        const payload: HttpEgressEvent = {
          sessionId: entry.sessionId ?? '',
          userId: entry.userId ?? '',
          method: entry.method,
          host,
          path,
          status: entry.status,
          requestBytes: entry.requestBytes,
          responseBytes: entry.responseBytes,
          durationMs: entry.durationMs,
          credentialInjected: entry.credentialInjected ?? false,
          classification: entry.classification ?? 'other',
          timestamp: Date.now(),
        };
        if (blockedReason !== undefined) payload.blockedReason = blockedReason;

        // Build a synthetic AgentContext for the fire — the listener's data
        // events run far from the original request context. sessionId/userId
        // come from the matching session (or empty strings on allowlist miss).
        const fireCtx = makeAgentContext({
          sessionId: payload.sessionId,
          userId: payload.userId,
          agentId: '',
        });

        bus.fire('event.http-egress', fireCtx, payload).catch((err: unknown) => {
          // HookBus.fire isolates subscriber throws — this catch only fires
          // if HookBus itself throws, which it currently doesn't. Log to the
          // synthetic context's logger so the failure is visible without
          // crashing the proxy.
          fireCtx.logger.error('http_egress_fire_failed', {
            err: err instanceof Error ? err : new Error(String(err)),
          });
        });
      };

      listener = await startProxyListener({
        listen: config.listen,
        registry,
        sessions,
        ca,
        onAudit,
      });
      endpointString = buildEndpointString(config.listen, listener);

      // 4a. proxy:open-session — resolve credentials, register placeholders,
      //     persist session config, return endpoint + CA + envMap.
      bus.registerService<OpenSessionInput, OpenSessionOutput>(
        'proxy:open-session',
        PLUGIN_NAME,
        async (ctx: AgentContext, input) => {
          if (!sessions || !registry || !endpointString || !caCertPem) {
            // Should be unreachable — handler can't fire before init().
            throw new PluginError({
              code: 'not-initialized',
              plugin: PLUGIN_NAME,
              message: 'credential-proxy plugin handler invoked before init completed',
            });
          }

          // Resolve every credential ref via credentials:get (Phase 3 shape:
          // `({ ref, userId }) → string`).
          const map = new CredentialPlaceholderMap();
          for (const [envName, { ref }] of Object.entries(input.credentials)) {
            const value = await bus.call<
              { ref: string; userId: string },
              string
            >('credentials:get', ctx, { ref, userId: input.userId });
            map.register(envName, value);
          }

          // Register the placeholder map with the shared registry so the
          // MITM substitution path can find it.
          registry.register(input.sessionId, map);

          // Persist the session config — the listener iterates this on every
          // request to gate egress, run SSRF checks, and decide MITM-vs-bypass.
          //
          // Also stamp sessionId/userId/classification so the listener can
          // attribute audit entries to the right session for the
          // event.http-egress emission.
          const sessionConfig: SessionConfig = {
            allowlist: new Set(input.allowlist),
            sessionId: input.sessionId,
            userId: input.userId,
            classification: classifyCredentials(input.credentials),
          };
          if (input.allowedIPs && input.allowedIPs.length > 0) {
            sessionConfig.allowedIPs = new Set(input.allowedIPs);
          }
          if (input.bypassMITM && input.bypassMITM.length > 0) {
            sessionConfig.bypassMITM = new Set(input.bypassMITM);
          }
          if (input.canaryToken) {
            sessionConfig.canaryToken = input.canaryToken;
          }
          sessions.set(input.sessionId, sessionConfig);

          // Remember the credential refs so proxy:rotate-session can
          // re-resolve. Shallow-clone to insulate against caller mutation.
          const refsCopy: SessionCredentialRefs = {};
          for (const [envName, { ref, kind }] of Object.entries(input.credentials)) {
            refsCopy[envName] = { ref, kind };
          }
          sessionCredentialRefs.set(input.sessionId, refsCopy);

          return {
            proxyEndpoint: endpointString,
            caCertPem,
            envMap: map.toEnvMap(),
          };
        },
      );

      // 4b. proxy:rotate-session — re-resolve every credential ref via
      //     credentials:get and swap a fresh CredentialPlaceholderMap into
      //     the registry. The OLD map's placeholders die when its registry
      //     entry is overwritten (registry.register replaces the prior map
      //     for that sessionId), so any in-flight requests still using the
      //     old placeholder pass through as literal `ax-cred:<old>` — the
      //     upstream sees garbage, which is the desired fail-closed behavior.
      bus.registerService<RotateSessionInput, RotateSessionOutput>(
        'proxy:rotate-session',
        PLUGIN_NAME,
        async (ctx: AgentContext, { sessionId }) => {
          if (!registry || !sessions) {
            throw new PluginError({
              code: 'not-initialized',
              plugin: PLUGIN_NAME,
              message: 'credential-proxy plugin handler invoked before init completed',
            });
          }
          const refs = sessionCredentialRefs.get(sessionId);
          const sess = sessions.get(sessionId);
          if (!refs || !sess) {
            throw new PluginError({
              code: 'unknown-session',
              plugin: PLUGIN_NAME,
              message: `session ${sessionId} not open`,
            });
          }
          // SessionConfig.userId is optional in the listener's type, but
          // every code path that registers a SessionConfig in this plugin
          // sets it from the open-session input. Treat missing as a bug.
          if (sess.userId === undefined) {
            throw new PluginError({
              code: 'session-missing-user',
              plugin: PLUGIN_NAME,
              message: `session ${sessionId} has no userId — refusing to rotate`,
            });
          }
          // Build a fresh placeholder map. We deliberately do NOT mutate the
          // existing one — a brand-new map guarantees that the OLD map (held
          // only by the registry until we overwrite it) is dropped intact.
          //
          // userId is pulled from the session config (set at open time), NOT
          // from ctx — rotation happens for the same session whose owner is
          // already pinned. Using ctx.userId here would let a caller from a
          // different user-context resolve someone else's credentials.
          const userId = sess.userId;
          const map = new CredentialPlaceholderMap();
          for (const [envName, { ref }] of Object.entries(refs)) {
            const value = await bus.call<
              { ref: string; userId: string },
              string
            >('credentials:get', ctx, { ref, userId });
            map.register(envName, value);
          }
          // register() overwrites the existing entry for this sessionId,
          // dropping the old map — old placeholders no longer match.
          registry.register(sessionId, map);
          return { envMap: map.toEnvMap() };
        },
      );

      // 4c. proxy:close-session — deregister registry + drop session config.
      bus.registerService<CloseSessionInput, Record<string, never>>(
        'proxy:close-session',
        PLUGIN_NAME,
        async (_ctx, { sessionId }) => {
          if (!sessions || !registry) {
            throw new PluginError({
              code: 'not-initialized',
              plugin: PLUGIN_NAME,
              message: 'credential-proxy plugin handler invoked before init completed',
            });
          }
          registry.deregister(sessionId);
          sessions.delete(sessionId);
          sessionCredentialRefs.delete(sessionId);
          return {};
        },
      );
    },

    shutdown() {
      if (listener) {
        listener.stop();
        listener = undefined;
      }
    },
  };
}
