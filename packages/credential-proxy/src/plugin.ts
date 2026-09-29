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
import { randomBytes } from 'node:crypto';
import { PluginError, makeAgentContext, type AgentContext, type Plugin } from '@ax/core';
import {
  startProxyListener,
  type ProxyListener,
  type ProxyAuditEntry,
  type SessionConfig,
} from './listener.js';
import { CredentialPlaceholderMap, SharedCredentialRegistry } from './registry.js';
import { getOrCreateCA } from './ca.js';
import { SessionEgressBlockBuffer } from './egress-block-buffer.js';
import {
  ProviderMeterHub,
  type UsageLedgerPort,
  type UsageRecordPayload,
  type UsageVerdict,
} from './provider-meter.js';

const PLUGIN_NAME = '@ax/credential-proxy';

/**
 * Exact-match allowlist hostname validator (TASK-37). Mirrors the listener's
 * exact-match egress gate — no wildcards, no ports, no schemes, lowercase
 * only. Capability minimized: a host added to a session's allowlist must be a
 * single concrete hostname the listener can compare with `===`.
 */
const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

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
 *   enumerated reasons (vocabulary normalized from the listener's internal
 *   `blocked` string). `'proxy-auth'` (TASK-158) means the caller could not
 *   be authenticated: its request carried no valid per-session proxy token.
 * - `sessionId`/`userId` are empty strings ONLY when authentication failed
 *   (`blockedReason: 'proxy-auth'`) — that request never had an owner. Every
 *   other event, blocked or not, is attributed to the session whose token
 *   the caller presented.
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
  blockedReason?:
    | 'allowlist'
    | 'private-ip'
    | 'canary'
    | 'tls-error'
    | 'request-body-too-large'
    | 'proxy-auth';
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
 * - `domain_denied: …`        → `'allowlist'`  (allowlist miss)
 * - `Blocked: …` (BlockedIPError) → `'private-ip'`
 * - `canary_detected`         → `'canary'`
 * - `tls_error: …`            → `'tls-error'`
 * - `request_body_too_large`  → `'request-body-too-large'` (TASK-24 — a local
 *   proxy DoS guard, NOT a remote/policy block, but audit/security subscribers
 *   should still see it as a policy-blocked egress rather than an undefined
 *   reason on a bare 413).
 * - `proxy_auth_required`     → `'proxy-auth'` (TASK-158 — the caller's
 *   `Proxy-Authorization` token was missing, malformed or unknown; the request
 *   was refused with a 407 before any allowlist/DNS work).
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
  if (blocked === 'request_body_too_large') return 'request-body-too-large';
  if (blocked === 'proxy_auth_required') return 'proxy-auth';
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
  /**
   * Cluster-reachable endpoint `proxy:open-session` advertises to callers in
   * TCP mode (TASK-149). The listener binds `0.0.0.0:<port>` inside the host
   * pod, but a runner in ANOTHER pod reaches the proxy over a k8s Service —
   * so the bind address (`tcp://0.0.0.0:<port>` / `tcp://127.0.0.1:<port>`)
   * isn't dialable cross-pod. When set, open-session returns THIS value as
   * `proxyEndpoint` instead of the bind address. Must be a `tcp://host:port`
   * URL (the orchestrator's `endpointToProxyConfig` rewrites it to
   * `http://host:port` for HTTPS_PROXY).
   *
   * Analogous to `@ax/sandbox-k8s` `hostIpcUrl`. Ignored for `unix` listen
   * (the socket path IS the cross-pod address via the shared hostPath dir).
   * Unset = advertise the bind address verbatim (today's behavior — correct
   * for subprocess sandbox and same-host loopback).
   */
  advertisedEndpoint?: string;
  caDir?: string;
  /**
   * Max bytes the plain-HTTP forward path buffers for a single request body
   * before returning 413 (TASK-24 — DoS guard so one large upload can't OOM
   * the host). Defaults to the listener's 16 MiB. Operator-tunable.
   */
  maxHttpRequestBodyBytes?: number;
}

// ── Hook payload types (Phase 1a — Task 11 may revise audit shape) ────

interface OpenSessionInput {
  sessionId: string;
  userId: string;
  agentId: string;
  /** Hostnames this session is allowed to reach (exact match). */
  allowlist: string[];
  /**
   * envName → { ref to credentials store, kind hint for downstream policy,
   * hosts this credential may be sent to }.
   *
   * `allowedHosts` (TASK-687) is the credential's BINDING: its placeholder is
   * substituted only on egress to one of these hostnames (exact match,
   * case-insensitive), and only for this session. It is independent of
   * `allowlist` — a host being reachable does not make it a valid destination
   * for any credential. Absent or empty ⟹ the placeholder is registered (the
   * sandbox env still gets it) but is NEVER substituted. The caller must derive
   * it from a trusted source (the provider table, an operator-curated agent row,
   * a connector's declared hosts) — never from anything the model or the user
   * typed for this session.
   *
   * `metered` (TASK-715) marks the operator's MODEL-PROVIDER key. The operator
   * pays for whatever it spends, and code in the sandbox can drive it as freely
   * as the runner can, so on the credential's `allowedHosts` the proxy (a) splices
   * it only into requests matching `metered.requests` (`"METHOD /path"`; anything
   * else on that host goes out with the placeholder inert), (b) asks the usage
   * ledger before each one and refuses with a 429 once the user is over their
   * limit, and (c) reads the usage out of each response and records it. Same
   * trust rule as `allowedHosts`: the caller derives it from code (the provider
   * table), never from anything the model or the user typed.
   */
  credentials: Record<
    string,
    { ref: string; kind: string; allowedHosts?: string[]; metered?: { requests: string[] } }
  >;
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
  /**
   * Per-session proxy token (TASK-52 minted it; TASK-158 made it the
   * AUTHENTICATION credential). The sandbox carries it as
   * `Proxy-Authorization: Basic ax:<token>`; the listener resolves it to this
   * session and gates every request on THIS session's allowlist, so a runner
   * can only reach what its own session was granted. A request without it is
   * refused (407). See SessionConfig.proxyToken.
   */
  proxyAuthToken: string;
}

interface CloseSessionInput {
  sessionId: string;
}

interface AddHostInput {
  /** Opaque session token whose live allowlist to widen. */
  sessionId: string;
  /** Exact-match hostname to allow (HOST_RE-validated). */
  host: string;
}

interface AddHostOutput {
  /** True if the host was added; false for an unknown/closed session. */
  added: boolean;
  /** The session's agentId — present iff added. Authoritative grant key for TASK-44. */
  agentId?: string;
}

interface RotateSessionInput {
  sessionId: string;
}

interface RotateSessionOutput {
  /** Fresh envName → placeholder map. Old placeholders no longer match. */
  envMap: Record<string, string>;
}

/**
 * `proxy:drain-session-egress-blocks` — return AND clear the hosts the CALLER'S
 * session was allowlist-blocked on since the last drain. The runner drains this
 * at PostToolUse to inject an actionable remediation note into the agent's
 * context (the agent's own `npx`/curl saw only a cryptic `statusCode=403`).
 *
 * SECURITY: the session is taken from `ctx.sessionId`, NOT from a request field
 * — same posture as `session:get-config`. Over the IPC wire ctx.sessionId is
 * bearer-token-bound, so an agent can only drain its OWN session; a drained
 * host is a destination it already chose to reach (no information gain). The
 * request body is therefore EMPTY by design.
 */
type DrainEgressBlocksInput = Record<string, never>;

interface DrainEgressBlocksOutput {
  /** Hostnames this session was allowlist-blocked on (deduped, capped). */
  hosts: string[];
}

/** envName → original credential ref (so rotate can re-resolve). */
type SessionCredentialRefs = Record<string, { ref: string; kind: string }>;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Validate a credential's `allowedHosts` binding. Absent is legal (⟹ unbound,
 * never substituted); anything present must be an array of strings. A malformed
 * binding throws rather than being coerced: guessing what a broken payload meant
 * is how a credential ends up bound somewhere nobody chose. Entries are matched
 * exactly (case-insensitively) by the registry, so nothing is rewritten here.
 */
function parseAllowedHosts(envName: string, raw: unknown): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((h) => typeof h !== 'string')) {
    throw new PluginError({
      code: 'invalid-credential-hosts',
      plugin: PLUGIN_NAME,
      message: `credential '${envName}': allowedHosts must be an array of hostnames`,
    });
  }
  return raw as string[];
}

/** `"GET|POST /path"`, with `*` allowed only as a final `/*` segment. */
const METERED_REQUEST_RE = /^(GET|POST) \/[A-Za-z0-9._\-/*]*$/;

/**
 * Validate a credential's `metered` marker. Absent is legal (not metered);
 * anything present must be `{ requests: string[] }` of well-formed
 * `"METHOD /path"` entries. Malformed throws, like a malformed binding: guessing
 * what a broken payload meant is how a key ends up spendable somewhere nobody
 * chose. An EMPTY list is legal and means "the key is never spliced".
 */
function parseMeteredRequests(envName: string, raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const requests = (raw as { requests?: unknown } | null)?.requests;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray(requests) ||
    requests.some(
      (r) =>
        typeof r !== 'string' || !METERED_REQUEST_RE.test(r) || r.replace(/\/\*$/, '').includes('*'),
    )
  ) {
    throw new PluginError({
      code: 'invalid-credential-metering',
      plugin: PLUGIN_NAME,
      message: `credential '${envName}': metered must be { requests: ["METHOD /path", ...] }`,
    });
  }
  return requests as string[];
}

/**
 * Anything that is not EXACTLY `{ blocked: false }` blocks. The usage ledger is
 * in-process and trusted, but this is a money control: a malformed answer must
 * never read as "go ahead".
 */
function asUsageVerdict(v: unknown): UsageVerdict {
  if (typeof v === 'object' && v !== null) {
    const o = v as { blocked?: unknown; reason?: unknown };
    if (o.blocked === false) return { blocked: false };
    if (o.blocked === true && typeof o.reason === 'string') return { blocked: true, reason: o.reason };
  }
  return { blocked: true, reason: 'usage-check-unavailable' };
}

function buildEndpointString(
  listen: CredentialProxyConfig['listen'],
  listener: ProxyListener,
  advertisedEndpoint: string | undefined,
): string {
  if (listen.kind === 'unix') {
    return `unix://${listen.path}`;
  }
  // TASK-149: in TCP mode prefer the operator-supplied advertised endpoint
  // (the cluster Service URL) over the bind address — a runner in another pod
  // can't dial 0.0.0.0/127.0.0.1. The endpoint must be a `tcp://host:port` URL
  // (the orchestrator's endpointToProxyConfig parses the scheme).
  if (advertisedEndpoint !== undefined && advertisedEndpoint.length > 0) {
    return advertisedEndpoint;
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

  // TASK-715: the per-user provider meter cache, and the per-session "this
  // session's meter is over" callbacks. Private state; the listener only ever
  // sees the ProviderMeter object on a SessionConfig.
  let meterHub: ProviderMeterHub | undefined;
  const sessionMeterClosers = new Map<string, () => void>();

  // Per-session accumulator of allowlist-blocked hosts (agent-visible egress
  // note). onAudit records into it; proxy:drain-session-egress-blocks drains it;
  // close-session forgets the session. Lives on the plugin instance — it's
  // private state the listener never reads.
  const egressBlocks = new SessionEgressBlockBuffer();

  const caDir = config.caDir ?? join(homedir(), '.ax', 'proxy-ca');

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'proxy:open-session',
        'proxy:rotate-session',
        'proxy:close-session',
        'proxy:add-host',
        'proxy:drain-session-egress-blocks',
      ],
      calls: ['credentials:get'],
      optionalCalls: [
        {
          hook: 'usage:provider-status',
          degradation:
            "Model calls made from inside a sandbox are not limited: a user's spend limit and the suspend switch apply to the agent's turns only.",
        },
        {
          hook: 'usage:provider-record',
          degradation:
            "Model calls made from inside a sandbox are not counted against the user's usage; only the agent's own reported turns are.",
        },
      ],
      subscribes: [],
    },

    async init({ bus }) {
      // The per-user cache between the byte path and the usage ledger (TASK-715).
      // `@ax/usage-limits` may finish loading after this plugin, so the ledger is
      // looked up when a session opens, not now; absent means model calls made from
      // a sandbox are not counted or limited (the endpoint allowlist still applies).
      const ledgerPort: UsageLedgerPort = {
        status: async (ctx) =>
          asUsageVerdict(
            await bus.call<Record<string, never>, unknown>('usage:provider-status', ctx, {}),
          ),
        record: async (ctx, payload: UsageRecordPayload) =>
          asUsageVerdict(await bus.call<UsageRecordPayload, unknown>('usage:provider-record', ctx, payload)),
      };
      meterHub = new ProviderMeterHub({
        ledger: () =>
          bus.hasService('usage:provider-status') && bus.hasService('usage:provider-record')
            ? ledgerPort
            : undefined,
        log: (event, data) => {
          makeAgentContext({ sessionId: '', agentId: PLUGIN_NAME, userId: '' }).logger.warn(event, data);
        },
      });

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

        // Accumulate ALLOWLIST blocks for the agent-visible egress note. Only
        // allowlist misses — `private-ip` / `canary` are security blocks we must
        // NOT coach the agent around. Skipped when unattributed (empty sessionId:
        // no proxy token resolved → no session to surface it to). `host` is the
        // agent's own attempted destination (parsed from the blocked request).
        if (blockedReason === 'allowlist') {
          egressBlocks.record(payload.sessionId, host);
        }

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
        ...(config.maxHttpRequestBodyBytes !== undefined
          ? { maxHttpRequestBodyBytes: config.maxHttpRequestBodyBytes }
          : {}),
      });
      endpointString = buildEndpointString(
        config.listen,
        listener,
        config.advertisedEndpoint,
      );

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
          //
          // Each placeholder is registered with the hosts its credential is
          // bound to (TASK-687). Validate the binding BEFORE resolving any
          // secret, so a malformed payload fails without touching the vault.
          const map = new CredentialPlaceholderMap();
          const bindings = new Map<string, readonly string[]>();
          // TASK-715: the metered credentials' allowed requests, validated up
          // front for the same reason (a broken payload fails before any secret
          // is read).
          const meteredRequests = new Map<string, readonly string[]>();
          for (const [envName, cred] of Object.entries(input.credentials)) {
            bindings.set(envName, parseAllowedHosts(envName, cred.allowedHosts));
            const requests = parseMeteredRequests(envName, cred.metered);
            if (requests !== undefined) meteredRequests.set(envName, requests);
          }
          for (const [envName, { ref }] of Object.entries(input.credentials)) {
            const allowedHosts = bindings.get(envName) ?? [];
            if (allowedHosts.length === 0) {
              // Default-deny made visible: an unbound credential is inert on the
              // wire, which a caller that forgot the field would otherwise only
              // discover as an upstream 401. Env NAME only — never a value.
              ctx.logger.warn('credential_unbound', { envName });
            }
            const value = await bus.call<
              { ref: string; userId: string },
              string
            >('credentials:get', ctx, { ref, userId: input.userId });
            map.register(envName, value, allowedHosts);
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
          // Mint a per-session proxy token (TASK-52). 16 random bytes →
          // 32 hex chars. It rides into the sandbox as Proxy-Authorization
          // Basic userinfo and is how the listener AUTHENTICATES the caller
          // (TASK-158): the request is gated on this session's allowlist and
          // allowedIPs, and attributed to this session. It is the only thing
          // that makes a runner's requests reach its own session's policy, so
          // it is a bearer credential — fresh per open, never reused, dropped
          // with the session on close.
          const proxyToken = randomBytes(16).toString('hex');

          const sessionConfig: SessionConfig = {
            allowlist: new Set(input.allowlist),
            sessionId: input.sessionId,
            userId: input.userId,
            agentId: input.agentId,
            classification: classifyCredentials(input.credentials),
            proxyToken,
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

          // TASK-715: meter the operator's model-provider key. The hosts are the
          // metered credentials' own bindings and the requests are theirs, so a
          // tunnel to that host splices the key only into a model call, asks the
          // usage ledger first, and reports what each call used. Attached BEFORE
          // the session becomes reachable (sessions.set below), so there is no
          // window in which the key can be spent unmetered.
          sessionMeterClosers.get(input.sessionId)?.(); // a re-open ends the old meter
          sessionMeterClosers.delete(input.sessionId);
          if (meteredRequests.size > 0 && meterHub !== undefined) {
            const hosts = new Set<string>();
            const requests = new Set<string>();
            for (const [envName, reqs] of meteredRequests) {
              for (const h of bindings.get(envName) ?? []) hosts.add(h);
              for (const r of reqs) requests.add(r);
            }
            const { meter, close } = await meterHub.forSession({
              sessionId: input.sessionId,
              userId: input.userId,
              agentId: input.agentId,
              hosts: [...hosts],
              requests: [...requests],
            });
            sessionConfig.providerMeter = meter;
            sessionMeterClosers.set(input.sessionId, close);
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
            proxyAuthToken: proxyToken,
          };
        },
      );

      // 4b. proxy:rotate-session — re-resolve every credential ref via
      //     credentials:get and update the EXISTING session map's values
      //     in place. The placeholder tokens are unchanged (Phase 3 I11) —
      //     a fresh placeholder would invalidate the running sandbox's env,
      //     since the SDK already read it at startup and won't re-read.
      //     Future requests substitute the refreshed value under the same
      //     `ax-cred:<hex>` token; substitution stays seamless.
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
          const existingMap = registry.get(sessionId);
          if (!refs || !sess || !existingMap) {
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
          // userId is pulled from the session config (set at open time), NOT
          // from ctx — rotation happens for the same session whose owner is
          // already pinned. Using ctx.userId here would let a caller from a
          // different user-context resolve someone else's credentials.
          const userId = sess.userId;
          for (const [envName, { ref }] of Object.entries(refs)) {
            const value = await bus.call<
              { ref: string; userId: string },
              string
            >('credentials:get', ctx, { ref, userId });
            const placeholder = existingMap.updateValue(envName, value);
            if (placeholder === undefined) {
              // Should be impossible — open-session registered every envName
              // in `refs`. If it ever happens, surface clearly rather than
              // silently leaving stale values in the substitution table.
              throw new PluginError({
                code: 'placeholder-not-registered',
                plugin: PLUGIN_NAME,
                message: `rotate-session: '${envName}' was never registered for session ${sessionId}`,
              });
            }
          }
          return { envMap: existingMap.toEnvMap() };
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
          egressBlocks.forget(sessionId);
          // TASK-715: end the session's meter, so a tunnel that outlives the
          // session stops being admitted.
          sessionMeterClosers.get(sessionId)?.();
          sessionMeterClosers.delete(sessionId);
          return {};
        },
      );

      // 4d. proxy:add-host — widen a LIVE session's allowlist (TASK-37, the
      //     reactive egress wall). The widened host lands on the session's
      //     own `allowlist` Set, which the listener reads BY REFERENCE on
      //     every request — so the next egress to that host passes the gate
      //     with NO re-spawn.
      //
      //     HOST-INTERNAL ONLY — deliberately NOT an IPC action. The IPC
      //     dispatcher is a fixed runner→host table and any IPC action is
      //     callable by the UNTRUSTED runner; exposing this over IPC would let
      //     the agent widen its own egress allowlist and defeat the entire
      //     reactive wall (invariant #5; design §10 — human in the loop on
      //     every security decision). The only caller is the authenticated
      //     owner's browser via a CSRF-gated channel-web route. Ownership is
      //     re-validated here against SessionConfig.userId — the proxy owns
      //     the session→owner fact (one source of truth, I4), so a forged
      //     sessionId can never widen another user's session. Capability
      //     minimized: a single host to a single session, never blanket egress.
      bus.registerService<AddHostInput, AddHostOutput>(
        'proxy:add-host',
        PLUGIN_NAME,
        async (ctx: AgentContext, { sessionId, host }) => {
          if (!sessions) {
            throw new PluginError({
              code: 'not-initialized',
              plugin: PLUGIN_NAME,
              message: 'credential-proxy plugin handler invoked before init completed',
            });
          }
          // Validate the host BEFORE the ownership lookup — a malformed host is
          // a 400 regardless of who asked, and we never want to leak whether a
          // session exists via a different error on bad input.
          if (typeof host !== 'string' || !HOST_RE.test(host)) {
            throw new PluginError({
              code: 'invalid-host',
              plugin: PLUGIN_NAME,
              message: `invalid host: ${String(host)}`,
            });
          }
          const sess = sessions.get(sessionId);
          // Unknown/closed session — graceful no-op (the session's egress is
          // already gone; widening a dead allowlist is harmless and the route
          // surfaces it as a benign result, not an error).
          if (sess === undefined) return { added: false };
          // Ownership: only the session's own user may widen its egress.
          if (sess.userId === undefined || sess.userId !== ctx.userId) {
            throw new PluginError({
              code: 'forbidden',
              plugin: PLUGIN_NAME,
              message: 'caller is not the session owner',
            });
          }
          sess.allowlist.add(host);
          // Return the session's agentId (the authoritative grant key for
          // TASK-44) only when present — omit the key rather than emit an
          // explicit `undefined` (exactOptionalPropertyTypes).
          return sess.agentId !== undefined
            ? { added: true, agentId: sess.agentId }
            : { added: true };
        },
      );

      // 4e. proxy:drain-session-egress-blocks — return + clear the hosts the
      //     CALLER'S session was allowlist-blocked on. The runner drains this at
      //     PostToolUse to inject a remediation note into the agent's context.
      //
      //     Unlike proxy:add-host (which IS host-internal-only because it WIDENS
      //     egress), this is safe to expose to the untrusted runner over IPC: it
      //     mutates nothing but its own per-session buffer and returns hostnames
      //     the agent ALREADY tried to reach — zero egress change, zero info
      //     gain, no other session reachable (the session is ctx.sessionId,
      //     bearer-bound by the IPC server; the wire request body is empty).
      bus.registerService<DrainEgressBlocksInput, DrainEgressBlocksOutput>(
        'proxy:drain-session-egress-blocks',
        PLUGIN_NAME,
        async (ctx: AgentContext) => {
          // sessionId from ctx (NOT a request field) — see the type's security
          // note. An empty/absent ctx.sessionId drains nothing (returns []).
          const sessionId = ctx.sessionId ?? '';
          return { hosts: egressBlocks.drain(sessionId) };
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
