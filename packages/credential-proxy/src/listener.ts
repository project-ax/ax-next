/**
 * HTTP / HTTPS forward proxy listener for sandboxed agents.
 *
 * Ported from v1 ~/dev/ai/ax/src/host/web-proxy.ts (HTTP forwarding from
 * lines 158-349, CONNECT handler from 353-493, handleMITMConnect from
 * 497-620, server setup from 622-655).
 *
 * Cuts from v1:
 * - `urlRewrites` block dropped — out of scope for v2.
 * - `onApprove` callback dropped — the per-session allowlist is the
 *   only egress gate (I2 from the Phase 1a plan).
 * - `domainDecisions` cache dropped — only ever cached `onApprove`
 *   results, which no longer exist.
 * - Canary-on-HTTP-body skipped — only the MITM path scans canary,
 *   since HTTP forwarding is rare for LLM/MCP traffic and never
 *   carries credential placeholders.
 * - `onAudit` is the listener's only audit-emission seam. The plugin
 *   wires one that maps each `ProxyAuditEntry` to the public
 *   `event.http-egress` payload and fires it on the bus (Task 11).
 * - Dynamic `import('./proxy-ca.js')` for `generateDomainCert` inlined
 *   to a static import — the v1 lazy load existed only to avoid pulling
 *   node-forge into non-MITM proxy modes that no longer exist in v2.
 *
 * Security:
 * - `resolveAndCheck` is called with the request's hostname; the
 *   returned IP is then used for the actual upstream connection so a
 *   second DNS resolution can't return a different (private) IP. See
 *   the SECURITY docstring on `resolveAndCheck`.
 * - Caller authentication + allowlist check (TASK-158): every request must
 *   carry the per-session `Proxy-Authorization: Basic ax:<token>` the sandbox
 *   was given at `proxy:open-session`. The token resolves to exactly ONE
 *   registered session (`authenticateCaller`), and a host is allowed iff THAT
 *   session's own `allowlist` contains it. A missing, malformed or unknown
 *   token is denied (407) before anything else is parsed. There is NO
 *   OR-across-sessions fallback: one shared proxy serves many users, and
 *   session A's allowlisted host must never be reachable by session B.
 * - MITM is the default for HTTPS. The minted leaf cert chains to the
 *   CA passed via `ProxyListenerOptions.ca`; sandboxed clients trust
 *   that CA via the bridge's env-var injection. `bypassMITM` is the
 *   per-host opt-out for cert-pinning clients.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { existsSync, unlinkSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { resolveAndCheck, BlockedIPError, type Resolver } from './private-ip.js';
import { parseConnectTarget } from './connect-target.js';
import type { SharedCredentialRegistry } from './registry.js';
import { generateDomainCert, type CAKeyPair } from './ca.js';
import { RequestFramer, findCanaryHit } from './request-framer.js';
import { MeteredTunnel } from './metered-tunnel.js';
import type { ProviderMeter } from './provider-usage.js';

// ── Types ────────────────────────────────────────────────────────────

/**
 * One session's egress policy. Multiple sessions can share a listener, but
 * each request is gated ONLY on the policy of the session its proxy token
 * identifies (TASK-158) — sessions never see each other's allowlist,
 * `allowedIPs` or `bypassMITM`.
 */
export interface SessionConfig {
  /** Hostnames this session is allowed to reach (exact match). */
  allowlist: Set<string>;
  /** IPs exempt from the private-range block. Test-only escape hatch. */
  allowedIPs?: Set<string>;
  /**
   * Hostnames whose CONNECT requests should bypass MITM and pass through
   * as a raw TLS tunnel. Used as the per-session opt-out for cert-pinning
   * hosts (e.g. some CLIs that ship a pinned trust store).
   *
   * Minting a cert for a pinned host would break the client; failing closed
   * (raw tunnel, no credential injection) is the right call for a host THIS
   * session declared.
   *
   * Scope (TASK-158): applies to THIS session's own connections only; another
   * session's bypass never changes how this session's traffic is inspected.
   * It used to be "any-bypass-wins" across every registered session, which
   * let one session's config silently downgrade another session's inspection
   * (no credential substitution, no canary scan) on a shared proxy.
   */
  bypassMITM?: Set<string>;
  /**
   * Optional canary token. When MITM is active and any decrypted request
   * chunk contains this byte sequence, the proxy aborts with 403 and
   * audits `blocked: 'canary_detected'`. A chunk matches if ANY registered
   * session's token is present (deliberately NOT narrowed to the caller: a
   * canary that belongs to another session turning up in this session's
   * egress is itself a leak worth blocking, and over-blocking is the safe
   * direction). Used to detect prompt-injection attacks that try to
   * exfiltrate a canary string the model was told not to leak.
   */
  canaryToken?: string;
  /**
   * Stable session identifier. The plugin sets this on open-session so
   * audit emissions can carry it through to `event.http-egress`. Optional
   * for back-compat with tests that build SessionConfig directly without
   * going through the plugin.
   */
  sessionId?: string;
  /**
   * The user this session was opened for. The plugin sets this on
   * open-session; the listener attaches it to audit entries so subscribers
   * can attribute traffic. Optional for the same back-compat reason as
   * `sessionId`.
   */
  userId?: string;
  /**
   * The agent this session was opened for. The plugin sets it on open-session;
   * proxy:add-host returns it so a host-side caller can persist a per-(user,
   * agent) "always-allow" grant (TASK-44) without trusting a browser-supplied
   * agentId. Optional for back-compat with SessionConfigs tests build directly.
   */
  agentId?: string;
  /**
   * Coarse traffic class derived from the session's credential kinds.
   * Computed once at open-session time (cheap; kinds don't change for the
   * life of a session) and stamped onto every audit entry the listener
   * emits for this session.
   *
   * - `'llm'`: any credential's kind is an LLM kind (`'api-key'` today,
   *   future `'anthropic-oauth'` etc).
   * - `'mcp'`: Phase 3 will exercise this for `'mcp-*'` kinds.
   * - `'other'`: everything else (no credentials, or only non-LLM/non-MCP).
   *
   * Optional for back-compat — listener-internal SessionConfig built by
   * tests that don't go through the plugin won't have it set, and the
   * plugin's onAudit callback defaults to `'other'` if missing.
   */
  classification?: 'llm' | 'mcp' | 'other';
  /**
   * The operator's model-provider key is spent through this session, so its
   * traffic is counted and limited (TASK-715). Set by the plugin only when
   * `proxy:open-session` marked a credential `metered`; absent for every other
   * session (and in tests that build a SessionConfig directly), which then
   * behaves exactly as before. A tunnel to one of `providerMeter.hosts` splices
   * the credential only into the meter's allowed requests, asks the meter's gate
   * before each one, and reads the usage out of the responses.
   */
  providerMeter?: ProviderMeter;
  /**
   * Per-session proxy token (TASK-52 minted it for attribution; TASK-158 made
   * it the AUTHENTICATION credential). Clients send it as
   * `Proxy-Authorization: Basic ax:<token>`; the listener resolves token →
   * session (see `authenticateCaller`) and gates the request on THAT session's
   * policy. It is a bearer credential for this session's egress reach: 128
   * random bits, 32 lowercase hex chars, minted by `proxy:open-session`,
   * compared in constant time, and dead the moment the session closes.
   *
   * REQUIRED: a session without a token can never authenticate, so it could
   * never egress. The type makes that unrepresentable rather than a quiet
   * runtime dead end.
   */
  proxyToken: string;
}

/**
 * In-process audit entry the listener hands to its `onAudit` callback.
 * Shape is intentionally listener-internal — the plugin maps it to the
 * public `event.http-egress` payload (renaming fields, parsing the URL
 * into host/path, translating `blocked` → `blockedReason`).
 *
 * The `blocked` field uses the listener's own vocabulary
 * (`'canary_detected'`, `'tls_error: …'`, `'Blocked: …'` from
 * BlockedIPError, `'domain_denied: <host>'`, `'proxy_auth_required'`,
 * `'invalid_target'`); the plugin translates to the bus's `'allowlist' |
 * 'private-ip' | 'canary' | 'tls-error' | 'proxy-auth'` enumeration.
 */
export interface ProxyAuditEntry {
  action: 'proxy_request';
  method: string;
  url: string;
  status: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  blocked?: string;
  /** True iff MITM substitution actually replaced bytes on this connection. */
  credentialInjected?: boolean;
  /**
   * Set whenever the caller authenticated as a registered session (every
   * success case, plus allowlist-miss / canary / tls-error / private-IP
   * blocks — the caller is known even when the destination is denied).
   * Unset only when authentication itself failed (`blocked:
   * 'proxy_auth_required'`): a request with a missing, malformed or unknown
   * proxy token has no owner to attribute it to.
   */
  sessionId?: string;
  /** Same lifecycle as `sessionId`; copied from the matching session. */
  userId?: string;
  /** Same lifecycle as `sessionId`; copied from the matching session. */
  classification?: 'llm' | 'mcp' | 'other';
}

export interface ProxyListenerOptions {
  /** Where to listen. TCP on a host:port, or a Unix socket path. */
  listen: { kind: 'tcp'; host?: string; port?: number } | { kind: 'unix'; path: string };
  /** Shared credential registry — touched on the MITM path (Task 8). */
  registry: SharedCredentialRegistry;
  /** Per-session configs. Phase 1a: passed in; Task 9: per-process map. */
  sessions: Map<string, SessionConfig>;
  /**
   * Root CA used to mint per-domain leaf certs on the MITM path. Required —
   * MITM is the default for HTTPS, and we can't terminate TLS without one.
   * Tests pass a CA minted in tmpdir; production uses `getOrCreateCA(dir)`.
   */
  ca: CAKeyPair;
  /**
   * Optional audit sink — defaults to no-op. The plugin provides one that
   * maps `ProxyAuditEntry` → `event.http-egress` and fires on the bus.
   * Tests may pass a sync function that just collects entries.
   */
  onAudit?: (entry: ProxyAuditEntry) => void;
  /** Optional DNS resolver override — for tests. Default: dns.promises.lookup. */
  resolver?: Resolver;
  /**
   * Max bytes the plain-HTTP forward path buffers for a single request body
   * before returning 413. The HTTP path reads the whole body into memory to
   * re-forward via fetch; without a cap one large upload OOMs a memory-tight
   * host (TASK-24). Default 16 MiB — generous for any legitimate API request
   * body. Large *downloads* (responses) are streamed, not buffered, and the
   * MITM path is backpressure-bounded, so this only governs plain-HTTP uploads.
   */
  maxHttpRequestBodyBytes?: number;
  /**
   * How long any MITM tunnel may be silent in both directions before
   * it is torn down and its outstanding requests settled. Defaults to 15 minutes,
   * longer than a model provider's own request timeout; tests shorten it.
   */
  meteredTunnelIdleMs?: number;
  /**
   * How long a CONNECT tunnel may spend waiting for its upstream connection
   * before the proxy gives up and tears both sides down. On a bypassMITM raw
   * tunnel that is the TCP connect (the client is answered 502); on the MITM
   * path it is the TCP connect PLUS the upstream TLS handshake (the client has
   * already been told 200, so it sees the tunnel close; the audit row is a
   * 502). Defaults to 30 seconds — far longer than any healthy handshake, far
   * shorter than the OS's own SYN-retry timeout (~2 minutes on Linux) or the
   * 15-minute tunnel idle timeout. Applies only until the upstream is
   * connected; an open tunnel is never timed out by it. Tests shorten it.
   */
  upstreamConnectTimeoutMs?: number;
}

export interface ProxyListener {
  /** TCP port (0 when listening on a Unix socket). */
  port: number;
  /** Full address — TCP port number or Unix socket path string. */
  address: string | number;
  stop(): void;
}

// ── Deny messages ────────────────────────────────────────────────────

/**
 * The actionable body returned when a request is denied because its host is not
 * in the CALLING session's allowlist. Shared by the HTTP-forward and
 * HTTPS-CONNECT deny paths so the two can't drift — a binary-download CLI fails
 * over CONNECT, an API call over HTTP, and both deserve the same guidance
 * (TASK-25).
 *
 * The second sentence calls out the prebuilt-binary case specifically: many
 * npm CLIs (esbuild / swc / biome / @schpet/linear-cli, …) are a thin wrapper
 * that downloads a platform binary from a GitHub release — `github.com` →
 * `release-assets.githubusercontent.com` — and those hosts are NOT
 * auto-allowlisted by `capabilities.packages.npm`. The author has to declare
 * them in the skill's `allowedHosts`. See
 * docs/plans/2026-05-22-credentialed-cli-tools-and-git-auth-design.md.
 *
 * `hostname` is caller-controlled (the request target), so it goes in the
 * BODY only — never a header — and the CONNECT/HTTP callers stamp a
 * Content-Length from the byte length. Node's HTTP parser already rejects
 * CR/LF in the request target before either handler runs, so a hostname can't
 * forge a header here regardless.
 */
function allowlistMissBody(hostname: string): string {
  return (
    `Egress to ${hostname} was blocked: it is not in this session's allowlist. ` +
    `To fix, install a skill that declares this domain in its allowedHosts, ` +
    `or ask an admin to approve it. ` +
    `(Heads-up: some CLIs download a prebuilt binary from a GitHub release — ` +
    `those need github.com AND release-assets.githubusercontent.com in allowedHosts.)`
  );
}

/**
 * How long a metered tunnel may be silent, in both directions, before it is
 * torn down (and its outstanding requests settled). A provider answers or gives
 * up well inside this; it exists only for a peer that disappears without a word.
 */
const METERED_TUNNEL_IDLE_MS = 15 * 60_000;

/**
 * How long a CONNECT tunnel waits for its upstream connection — the bypassMITM
 * raw tunnel's TCP connect (TASK-786) and the MITM path's TCP connect + TLS
 * handshake (TASK-823). Without it, an allowlisted host that black-holes SYNs
 * holds the client and the upstream socket until the OS gives up (raw tunnel)
 * or the 15-minute idle timeout fires (MITM).
 */
const UPSTREAM_CONNECT_TIMEOUT_MS = 30_000;

/**
 * The response a metered tunnel gives when it refuses a request (TASK-715): a
 * complete HTTP/1.1 message in the error shape both model APIs' SDKs parse
 * (`{ "type": "error", "error": { "type", "message" } }`), so the person or agent
 * on the other end reads the sentence instead of a bare status. A 429 carries
 * `Retry-After` and is retried by both SDKs, which is what lets a transient
 * refusal (the usage check hiccupped, a burst of calls) heal itself. The message
 * is written by the host; the JSON encoder is what keeps it from breaking out of
 * the body.
 */
function refusalResponse(status: number, message: string): string {
  const errorType =
    status === 429 ? 'rate_limit_error' : status === 400 ? 'invalid_request_error' : 'api_error';
  const body = JSON.stringify({ type: 'error', error: { type: errorType, message } });
  const reasonPhrase =
    status === 429 ? 'Too Many Requests' : status === 400 ? 'Bad Request' : 'Forbidden';
  return (
    `HTTP/1.1 ${status} ${reasonPhrase}\r\n` +
    `Content-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    (status === 429 ? `Retry-After: 5\r\n` : '') +
    `Connection: close\r\n` +
    `\r\n` +
    body
  );
}

/**
 * Body of the 407 returned when the caller could not be authenticated. Fixed
 * text — it echoes nothing from the request (no hostname, no header value), and
 * it says nothing about which sessions or hosts exist.
 */
const PROXY_AUTH_REQUIRED_BODY =
  'Egress was blocked: this proxy only serves sandboxed agent sessions, and this ' +
  'request did not carry a valid session credential (Proxy-Authorization).';

/**
 * Body of the CONNECT `400` for a target that is not strict authority-form
 * `host:port` (`blocked: 'invalid_target'`, see connect-target.ts). A bare
 * status line left the agent with "the proxy said no" and nothing to fix
 * (TASK-875). FIXED text on purpose: the target is untrusted — the agent wrote
 * the CONNECT line — so none of it is echoed back; the audit row keeps the
 * target for whoever needs to see exactly what was sent.
 */
const INVALID_CONNECT_TARGET_BODY =
  'Egress was blocked: the CONNECT target was not in a form this proxy accepts. ' +
  'It must be host:port, where host is a hostname, an IPv4 address, or an IPv6 ' +
  'address in [brackets], and port is a number from 1 to 65535 ' +
  '(for example: api.example.com:443).';

/**
 * RFC 9110 §15.5.8: a 407 MUST carry Proxy-Authenticate. Advertising Basic is
 * accurate (it is what the runner sends) and lets a client that negotiates
 * credentials on a 407 retry with them, instead of failing outright.
 */
const PROXY_AUTHENTICATE = 'Basic realm="ax-egress"';

// ── Caller authentication ────────────────────────────────────────────

// TASK-52: the per-session proxy token format, re-asserted at this trust
// boundary (defense in depth — the runner validates independently; no shared
// helper crosses the plugin boundary, per I2).
const PROXY_TOKEN_RE = /^[0-9a-f]{32}$/;

/**
 * Parse a `Proxy-Authorization: Basic base64("ax:<token>")` header into the
 * 32-hex token, or undefined. Anything that is not exactly that shape — no
 * header, another scheme, no `:`, a token that is not 32 lowercase hex —
 * yields undefined, and the caller is then DENIED (see authenticateCaller).
 * The username half is ignored: the token is the secret.
 *
 * RFC 9110 §11.1: the auth scheme name is case-insensitive.
 */
function parseProxyToken(headerValue: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof raw !== 'string') return undefined;
  const m = /^basic +(\S+)$/i.exec(raw);
  if (m === null) return undefined;
  const decoded = Buffer.from(m[1] as string, 'base64').toString('utf-8');
  const sep = decoded.indexOf(':');
  if (sep === -1) return undefined;
  const token = decoded.slice(sep + 1);
  return PROXY_TOKEN_RE.test(token) ? token : undefined;
}

/**
 * The result of authenticating a caller: the session's config AND the key it is
 * registered under in the shared `sessions` Map. The key is what the credential
 * registry is keyed by too (the plugin registers both under the same session
 * id), so credential substitution is scoped through it (TASK-687) rather than
 * through `SessionConfig.sessionId`, which is optional.
 */
interface AuthenticatedCaller {
  sessionKey: string;
  session: SessionConfig;
}

/**
 * AUTHENTICATE the caller (TASK-158): resolve the request's proxy token to the
 * one registered session that owns it. `undefined` — a missing, malformed or
 * unknown token — means the request MUST be denied; there is deliberately no
 * "fall back to the union of everyone's allowlist" path, because that fallback
 * is exactly the cross-session reach this function exists to remove.
 *
 * Every registered session's token is compared with `timingSafeEqual` and the
 * scan does not stop at a match, so response time does not reveal how much of a
 * guessed token was right or where in the session map its owner sits. (Both
 * sides are 32 hex chars, so the lengths match; a session whose configured
 * token is a different length is skipped, never compared.) Linear scan: the
 * per-process session count is small.
 */
function authenticateCaller(
  proxyAuthHeader: string | string[] | undefined,
  sessions: Map<string, SessionConfig>,
): AuthenticatedCaller | undefined {
  const token = parseProxyToken(proxyAuthHeader);
  if (token === undefined) return undefined;
  const presented = Buffer.from(token, 'utf8');
  let owner: AuthenticatedCaller | undefined;
  for (const [sessionKey, session] of sessions) {
    const expected = Buffer.from(String(session.proxyToken), 'utf8');
    if (expected.length !== presented.length) continue;
    if (timingSafeEqual(expected, presented) && owner === undefined) {
      owner = { sessionKey, session };
    }
  }
  return owner;
}

/** Collect all canary tokens declared across sessions, deduped + non-empty. */
function collectCanaryTokens(sessions: Map<string, SessionConfig>): string[] {
  const tokens = new Set<string>();
  for (const session of sessions.values()) {
    if (session.canaryToken) tokens.add(session.canaryToken);
  }
  return [...tokens];
}

/** Minimal pausable source the backpressure pump needs. */
export interface PausableSource {
  pause(): void;
  resume(): void;
}
/** Minimal writable sink the backpressure pump needs. */
export interface BackpressureSink {
  /** Returns false when the internal buffer is full (Node stream contract). */
  write(chunk: Buffer): boolean;
  once(event: 'drain', listener: () => void): void;
}

/**
 * Write `chunk` to `dest`, applying backpressure: when `dest.write` returns
 * false (its buffer is full), pause `src` until `dest` emits `'drain'`, then
 * resume. This bounds the host's per-connection memory to the sink's
 * highWaterMark instead of letting a slow consumer accumulate an unbounded
 * write queue — the multi-MB-download OOM vector (TASK-24). Both MITM pumps
 * (download upstream→client, and the framed client→upstream write) route
 * through this so neither can balloon host memory on a slow peer.
 */
export function writeWithBackpressure(
  src: PausableSource,
  dest: BackpressureSink,
  chunk: Buffer,
): void {
  if (chunk.length === 0) return;
  const ok = dest.write(chunk);
  if (!ok) {
    src.pause();
    dest.once('drain', () => src.resume());
  }
}

/** Minimal readable surface the capped-body reader needs (a subset of
 *  IncomingMessage), so it's unit-testable with a fake. */
export interface CappedBodySource {
  readonly destroyed: boolean;
  readonly readableEnded: boolean;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end' | 'aborted' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export interface CappedBodyResult {
  body: Buffer;
  /** True iff the body exceeded `maxBytes` (caller should 413). */
  oversized: boolean;
  bodyBytes: number;
  /** True iff the client hung up before a clean 'end' (caller should bail). */
  aborted: boolean;
}

/**
 * Read a request body into memory, CAPPED at `maxBytes` (TASK-24). Over the cap
 * it stops accumulating but keeps draining to 'end' (no destroy — destroying
 * the readable can reset the socket before a 413 lands). The returned promise
 * settles on EVERY terminal outcome: 'end' (complete), 'error' (stream error),
 * 'close'/'aborted' without 'end' (client hung up), AND the already-terminated
 * case checked up front (the request can close while the caller was awaiting a
 * prior async step — slow DNS — so the terminal event fired before these
 * listeners attached and EventEmitter won't replay it; without this guard the
 * handler hangs forever — Codex).
 */
export function readCappedBody(
  req: CappedBodySource,
  maxBytes: number,
): Promise<CappedBodyResult> {
  return new Promise<CappedBodyResult>((resolve, reject) => {
    const collected: Buffer[] = [];
    let total = 0;
    let over = false;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    // Already-terminated guard (see doc): `destroyed` after abort/close,
    // `readableEnded` after a clean 'end' already passed.
    if (req.destroyed || req.readableEnded) {
      finish(() => resolve({ body: Buffer.alloc(0), oversized: false, bodyBytes: 0, aborted: true }));
      return;
    }
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        if (!over) {
          over = true;
          collected.length = 0; // stop buffering; keep draining to 'end'
        }
        return;
      }
      collected.push(chunk);
    });
    req.on('end', () =>
      finish(() => resolve({ body: Buffer.concat(collected), oversized: over, bodyBytes: total, aborted: false })),
    );
    req.on('error', (err) => finish(() => reject(err)));
    const onAbort = (): void =>
      finish(() => {
        collected.length = 0;
        resolve({ body: Buffer.alloc(0), oversized: over, bodyBytes: total, aborted: true });
      });
    req.on('aborted', onAbort);
    req.on('close', onAbort);
  });
}

// ── Listener ─────────────────────────────────────────────────────────

/** Default cap on a single plain-HTTP forwarded request body: 16 MiB. Over
 *  this we 413 rather than let one upload OOM the host (TASK-24). */
const DEFAULT_MAX_HTTP_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

export async function startProxyListener(opts: ProxyListenerOptions): Promise<ProxyListener> {
  const { listen, sessions, onAudit, resolver, registry, ca } = opts;
  const maxHttpRequestBodyBytes =
    opts.maxHttpRequestBodyBytes ?? DEFAULT_MAX_HTTP_REQUEST_BODY_BYTES;
  const meteredTunnelIdleMs = opts.meteredTunnelIdleMs ?? METERED_TUNNEL_IDLE_MS;
  const upstreamConnectTimeoutMs = opts.upstreamConnectTimeoutMs ?? UPSTREAM_CONNECT_TIMEOUT_MS;
  const activeSockets = new Set<net.Socket>();

  function audit(entry: ProxyAuditEntry): void {
    onAudit?.(entry);
  }

  /**
   * Copy the session-stamping fields (`sessionId`, `userId`, `classification`)
   * off `session` onto an audit entry. No-op if `session` is undefined
   * (only the authentication-failure entry has no session to stamp).
   *
   * `exactOptionalPropertyTypes` means we only set keys when defined;
   * setting `key: undefined` is a type error.
   */
  function stampSession(
    entry: ProxyAuditEntry,
    session: SessionConfig | undefined,
  ): ProxyAuditEntry {
    if (!session) return entry;
    if (session.sessionId !== undefined) entry.sessionId = session.sessionId;
    if (session.userId !== undefined) entry.userId = session.userId;
    if (session.classification !== undefined) entry.classification = session.classification;
    return entry;
  }

  // ── HTTP request forwarding ──

  async function handleHTTPRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    let requestBytes = 0;
    let responseBytes = 0;

    // AUTHENTICATE FIRST (TASK-158), before the target URL is even parsed: the
    // per-session proxy token identifies the ONE session whose policy governs
    // this request. Missing, malformed or unknown → 407, nothing else runs. A
    // keep-alive connection is re-checked per request (each carries its own
    // Proxy-Authorization); nothing about a connection is trusted.
    const caller = authenticateCaller(req.headers['proxy-authorization'], sessions);
    if (caller === undefined) {
      audit({
        action: 'proxy_request',
        method,
        url,
        status: 407,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: Date.now() - startTime,
        blocked: 'proxy_auth_required',
      });
      res.writeHead(407, {
        'Content-Type': 'text/plain',
        'Proxy-Authenticate': PROXY_AUTHENTICATE,
        Connection: 'close',
      });
      res.end(PROXY_AUTH_REQUIRED_BODY);
      return;
    }
    const callerSession = caller.session;

    try {
      // The bridge forwards the absolute URL in `req.url` (HTTP-proxy convention).
      // Fall back to constructing one from the Host header so direct curl-style
      // fetches against the listener also work.
      const targetUrl = url.startsWith('http://') || url.startsWith('https://')
        ? new URL(url)
        : new URL(url, `http://${req.headers.host ?? 'unknown'}`);

      // Strip IPv6 brackets if present
      const hostname =
        targetUrl.hostname.startsWith('[') && targetUrl.hostname.endsWith(']')
          ? targetUrl.hostname.slice(1, -1)
          : targetUrl.hostname;

      // Allowlist gate (I2): the hostname must be in the CALLER's own
      // allowlist — never another session's. The denial is attributed to the
      // caller (its token authenticated above).
      if (!callerSession.allowlist.has(hostname)) {
        audit(stampSession({
          action: 'proxy_request',
          method,
          url,
          status: 403,
          requestBytes: 0,
          responseBytes: 0,
          durationMs: Date.now() - startTime,
          blocked: `domain_denied: ${hostname}`,
        }, callerSession));
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end(allowlistMissBody(hostname));
        return;
      }

      // SSRF block (I3): resolve and verify against private CIDRs.
      // Use the returned IP for the upstream connection — DO NOT re-resolve
      // (DNS rebinding defense). See SECURITY note on resolveAndCheck. The
      // `allowedIPs` override is the CALLER's own, not some other session's.
      const resolvedIP = await resolveAndCheck(hostname, callerSession.allowedIPs, resolver);

      // Read request body, CAPPED so one large upload can't OOM the host
      // (TASK-24). Over the cap we 413 without forwarding; a client that hangs
      // up mid-upload (including DURING the resolveAndCheck await above) settles
      // as `aborted`. See readCappedBody.
      const { body, oversized, bodyBytes, aborted } = await readCappedBody(
        req,
        maxHttpRequestBodyBytes,
      );
      if (aborted) {
        // Client disconnected mid-upload — nothing to forward, nothing to
        // respond to (the socket is gone). Just release the handler.
        return;
      }
      if (oversized) {
        audit(stampSession({
          action: 'proxy_request',
          method,
          url,
          status: 413,
          requestBytes: bodyBytes,
          responseBytes: 0,
          durationMs: Date.now() - startTime,
          blocked: 'request_body_too_large',
        }, callerSession));
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('Request body exceeds the proxy limit.');
        return;
      }
      requestBytes = body.length;

      // Forward headers (strip hop-by-hop and encoding headers — fetch handles these).
      //
      // `proxy-authorization` is hop-by-hop (RFC 9110 §11.7.2: it applies to the
      // proxy alone) and, since TASK-158, it carries a live BEARER credential
      // for this session's egress reach. This leg goes to the upstream over
      // plain HTTP, so forwarding it would hand that credential to the
      // destination and to anything on the wire. Strip it (and its response-
      // side twin) here, exactly like the other proxy-* hop-by-hop headers.
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (
          !value ||
          key === 'host' ||
          key === 'connection' ||
          key === 'proxy-connection' ||
          key === 'proxy-authorization' ||
          key === 'proxy-authenticate' ||
          key === 'transfer-encoding' ||
          key === 'content-length'
        )
          continue;
        headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }
      // Preserve the original Host so the upstream sees vhost-correct routing.
      headers['host'] = targetUrl.host;

      // Build the upstream URL using the resolved IP (DNS rebinding defense).
      // For IPv6, re-bracket the literal so URL parsing accepts it.
      const ipForUrl = net.isIPv6(resolvedIP) ? `[${resolvedIP}]` : resolvedIP;
      const upstreamUrl = new URL(targetUrl.toString());
      upstreamUrl.hostname = ipForUrl;

      // Forward via fetch and stream response back.
      const response = await fetch(upstreamUrl.toString(), {
        method,
        headers,
        ...(body.length > 0 ? { body } : {}),
        redirect: 'manual',
      });

      const outHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        if (k !== 'transfer-encoding' && k !== 'content-encoding' && k !== 'content-length') {
          outHeaders[k] = v;
        }
      });
      res.writeHead(response.status, outHeaders);

      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            responseBytes += value.length;
            res.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      res.end();

      audit(stampSession({
        action: 'proxy_request',
        method,
        url,
        status: response.status,
        requestBytes,
        responseBytes,
        durationMs: Date.now() - startTime,
      }, callerSession));
    } catch (err) {
      // BlockedIPError → 403 (policy block); anything else → 502 (network/DNS).
      // Reviewer M3 from Task 5: use typed instanceof, not string match.
      const isBlocked = err instanceof BlockedIPError;
      const status = isBlocked ? 403 : 502;
      const message = isBlocked
        ? (err as BlockedIPError).message
        : `Proxy error: ${(err as Error).message}`;

      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'text/plain' });
      }
      res.end(message);

      // The caller authenticated before the try block, so every error here —
      // private-IP block, DNS/upstream failure, even a malformed target URL —
      // is attributable to it.
      const blockedEntry: ProxyAuditEntry = {
        action: 'proxy_request',
        method,
        url,
        status,
        requestBytes,
        responseBytes: 0,
        durationMs: Date.now() - startTime,
      };
      if (isBlocked) blockedEntry.blocked = message;
      audit(stampSession(blockedEntry, callerSession));
    }
  }

  // ── HTTPS CONNECT — MITM path (TLS terminate, substitute, canary scan) ──
  //
  // Ported from v1 ~/dev/ai/ax/src/host/web-proxy.ts:497-620 with adaptations:
  //  - `options.mitm.credentials` → the shared `SharedCredentialRegistry`
  //    already passed to the listener. Substitution is bound (TASK-687) on two
  //    axes, both fixed at the moment the tunnel is granted: WHO — only the
  //    authenticated caller's own placeholders (the CONNECT was gated on the
  //    caller's own allowlist, TASK-158, and its placeholders are looked up by
  //    the same session key); and WHERE — only placeholders whose credential is
  //    bound to this tunnel's destination host. A placeholder for any other
  //    host, or owned by any other session, is forwarded verbatim as an inert
  //    fake token. Being on the session allowlist is NOT enough: `proxy:add-host`
  //    and private connectors let a user allowlist a host they control, and that
  //    must never make an operator-paid key substitutable there.
  //  - `generateDomainCert` static-imported (no longer dynamic).
  //  - `canaryToken` aggregated across sessions (per-session field, not
  //    a single global option). A chunk matches if any session's token is in it.
  //  - `sessionId`/`userId`/`classification` are stamped via `stampSession`
  //    from the CALLING session (the one the proxy token authenticated). The
  //    plugin sets those fields at `proxy:open-session` time (Task 11).

  async function handleMITMConnect(
    clientSocket: net.Socket,
    hostname: string,
    port: number,
    resolvedIP: string,
    head: Buffer,
    startTime: number,
    target: string,
    callerSession: SessionConfig,
    callerSessionKey: string,
  ): Promise<void> {
    // The substitution surface for THIS tunnel (TASK-687): the authenticated
    // caller's placeholders bound to `hostname`. `hostname` is the CONNECT target
    // that passed the caller's allowlist gate, was resolved by resolveAndCheck,
    // and is the host `targetTls` below actually dials (by resolved IP, SNI =
    // hostname) — so it is the only destination these bytes can reach. It is
    // deliberately NOT read from the inner `Host` header or SNI the client wrote
    // inside the tunnel: a client that CONNECTs to a host it controls and writes
    // `Host: api.anthropic.com` still delivers to the host it controls. The view
    // is live (looked up per call), so closing the session stops substitution on
    // an already-open keep-alive tunnel.
    // Bytes that arrived in the SAME segment as the CONNECT (`head`) are refused.
    // A real client waits for the 200 below before it sends its ClientHello, so a
    // non-empty `head` is either a client that jumped the gun (already broken:
    // these bytes used to be written to the UPSTREAM socket, not to the TLS
    // terminator that should read them) or someone using it as a side door — they
    // were also run through the replacer and sent upstream around the request
    // framer, so a plaintext HTTP request written after the CONNECT reached the
    // provider with the real key spliced in, outside the endpoint allowlist, the
    // gate, the meter and the canary scan (TASK-715). Nothing here reads them.
    if (head.length > 0) {
      clientSocket.on('error', () => { /* client already gone */ });
      clientSocket.write(
        'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
      clientSocket.end();
      audit(stampSession({
        action: 'proxy_request',
        method: 'CONNECT',
        url: target,
        status: 400,
        requestBytes: head.length,
        responseBytes: 0,
        durationMs: Date.now() - startTime,
        blocked: 'unexpected_bytes_after_connect',
      }, callerSession));
      return;
    }

    const replacer = registry.replacerFor(callerSessionKey, hostname);
    const domainCert = generateDomainCert(hostname, ca);

    // A tunnel to a host the session's model-provider key is spent on is METERED
    // (TASK-715): the framer asks this tunnel about every request head, and the
    // upstream bytes are read for usage. `hostname` is the same authenticated,
    // resolved CONNECT target the binding above keys on.
    const meter = callerSession.providerMeter;
    const metered =
      meter !== undefined && meter.hosts.has(hostname.replace(/[A-Z]/g, (c) => c.toLowerCase()))
        ? new MeteredTunnel(meter)
        : undefined;

    // Tell the client the tunnel is established before kicking off TLS.
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // Suppress raw-socket errors so an abrupt client disconnect during the
    // TLS handshake doesn't crash with an unhandled 'error' — the TLS wrapper
    // cleanup paths handle teardown.
    clientSocket.on('error', () => { /* handled by TLS wrapper cleanup */ });

    // Terminate the client's TLS with our minted leaf cert.
    const clientTls = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: domainCert.key,
      cert: domainCert.cert,
    });

    // Connect to the upstream by RESOLVED IP (DNS rebinding defense), with
    // SNI = original hostname. Trust store = real roots PLUS our CA so test
    // upstreams signed by the same CA are accepted without disabling cert
    // verification. RFC 6066 forbids SNI for IP literals, so omit servername
    // when the hostname is an IP address (avoids a Node deprecation warning).
    const targetTls = tls.connect({
      host: resolvedIP,
      port,
      ca: [...tls.rootCertificates, ca.cert],
      ...(net.isIP(hostname) ? {} : { servername: hostname }),
    });

    activeSockets.add(clientTls);
    activeSockets.add(targetTls);

    // Track upstream TLS handshake failure separately so the cleanup audit
    // doesn't double-log a 200 over the actual 502.
    let tlsFailed = false;
    targetTls.on('error', (err) => {
      if (!tlsFailed) {
        tlsFailed = true;
        audit(stampSession({
          action: 'proxy_request',
          method: 'CONNECT',
          url: target,
          status: 502,
          requestBytes: head.length,
          responseBytes: 0,
          durationMs: Date.now() - startTime,
          blocked: `tls_error: ${err.message}`,
        }, callerSession));
      }
    });

    let requestBytes = 0;
    let responseBytes = 0;
    let credentialInjected = false;
    // Set once a metered tunnel's refusal has been audited, so the close that
    // follows it does not log a second, misleading 200 for the same tunnel.
    let refusalAudited = false;

    // canaryTokens are computed once per connection — sessions don't change
    // mid-tunnel under our model.
    const canaryTokens = collectCanaryTokens(sessions);

    // One framer per connection: it frames the decrypted client→upstream byte
    // stream into HTTP/1.1 requests so each request head's Basic-auth value can
    // be decoded → canary-scanned → placeholder-substituted → re-base64-encoded.
    // Only request HEADS are substituted (bodies are forwarded byte-exact — see
    // RequestFramer), through the host-bound `replacer` above. Re-encoding base64
    // cannot emit CR/LF, so a substituted value can't inject headers (I1/§4.5).
    const framer = new RequestFramer(replacer, canaryTokens, {
      // Oversized head → verbatim passthrough. Log the event only; never the
      // bytes (no-secret-logging, I7 / §4.5).
      onOversizedHead: () => { /* bounded-head fallback engaged — no value logged */ },
      // A metered tunnel consults the meter before every request head.
      ...(metered !== undefined ? { metered } : {}),
    });

    // A metered tunnel refused a request (over the limit, too many in flight, a
    // head it will not forward). Answer in the provider's own error shape so the
    // SDK on the other end shows the message and, for a 429, retries, then close.
    const refuseMetered = (denied: { status: number; reason: string; message: string }) => {
      refusalAudited = true;
      audit(stampSession({
        action: 'proxy_request',
        method: 'CONNECT',
        url: target,
        status: denied.status,
        requestBytes,
        responseBytes,
        durationMs: Date.now() - startTime,
        blocked: `provider_call_refused: ${denied.reason}`,
      }, callerSession));
      clientTls.write(refusalResponse(denied.status, denied.message));
      clientTls.end();
      targetTls.destroy();
    };

    // Shared canary-block path — used by both the raw-chunk scan (parity with
    // the pre-framer behavior) and the framer's decoded-Basic-blob hit. Emits
    // the SAME 403 audit + tears down the tunnel. Never logs the decoded value.
    const blockCanary = () => {
      // The 403 below is this tunnel's audit entry; the close it causes must not add a 200.
      refusalAudited = true;
      audit(stampSession({
        action: 'proxy_request',
        method: 'CONNECT',
        url: target,
        status: 403,
        requestBytes,
        responseBytes: 0,
        durationMs: Date.now() - startTime,
        blocked: 'canary_detected',
      }, callerSession));
      // Send a 403 over the TLS channel before tearing down.
      clientTls.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      clientTls.end();
      targetTls.destroy();
    };

    // client → (canary scan, then per-request Basic-auth transform) → upstream
    clientTls.on('data', (chunk: Buffer) => {
      requestBytes += chunk.length;

      // Raw-chunk canary scan first — catches a canary that appears verbatim in
      // any byte the model wrote (body, Bearer header, etc). The framer's decode
      // pass additionally catches one base64-buried in a Basic blob.
      if (findCanaryHit(chunk, canaryTokens)) {
        blockCanary();
        return;
      }

      const { out, canaryToken, injected, denied } = framer.process(chunk);
      if (canaryToken) {
        blockCanary();
        return;
      }
      // `injected` is true only when a placeholder was actually substituted —
      // not merely when the framer reframed buffered bytes.
      if (injected) credentialInjected = true;
      // The framer holds bytes until end-of-head, so `out` is legitimately empty
      // while a head is still buffering — only write when there's something.
      // Backpressure-aware: a slow upstream can't grow the host's write queue
      // unboundedly (TASK-24).
      if (out.length > 0) {
        writeWithBackpressure(clientTls, targetTls, out);
      }
      if (denied !== undefined) refuseMetered(denied);
    });

    // upstream → client (no substitution on response — placeholders should
    // never originate upstream). Backpressure-aware so a slow client (the
    // common case for a multi-MB download into a runner pod) can't pile the
    // response up in the host's socket buffer and OOM it (TASK-24).
    targetTls.on('data', (chunk: Buffer) => {
      responseBytes += chunk.length;
      writeWithBackpressure(targetTls, clientTls, chunk);
      // A metered tunnel READS the response for usage after forwarding it. The
      // tap is passive and swallows its own errors; it can never hold up or
      // alter what the client receives.
      metered?.onResponseBytes(chunk);
    });

    // Set once the upstream TLS handshake completes. The client was told 200
    // before the dial, so until then there is still no tunnel to the upstream,
    // and a client that hangs up first must not be audited as one (TASK-861 —
    // the bypass path's TASK-705 flag, for the MITM path).
    let established = false;

    // Cleanup once — first close/error wins, downstream events become no-ops.
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(connectTimer);
      activeSockets.delete(clientTls);
      activeSockets.delete(targetTls);
      clientTls.destroy();
      targetTls.destroy();
      // Settle whatever a metered tunnel still owes (an unanswered or truncated
      // request is charged as unmeasured, never as free).
      metered?.end();

      // No second row if a TLS handshake error already logged 502, or a
      // refusal already logged its own status.
      if (tlsFailed || refusalAudited) return;

      if (!established) {
        // The client gave up before the upstream connect + handshake finished.
        // Audit what really happened, in the bypass path's not-established
        // shape: a 502 with nothing back from the upstream and no `blocked`
        // reason (not a policy block). `requestBytes` is what the client sent
        // US; no `credentialInjected`, because nothing reached the upstream —
        // writes to a TLS socket are held until its handshake completes.
        audit(stampSession({
          action: 'proxy_request',
          method: 'CONNECT',
          url: target,
          status: 502,
          requestBytes,
          responseBytes: 0,
          durationMs: Date.now() - startTime,
        }, callerSession));
        return;
      }

      audit(stampSession({
        action: 'proxy_request',
        method: 'CONNECT',
        url: target,
        status: 200,
        requestBytes,
        responseBytes,
        durationMs: Date.now() - startTime,
        // Omit `credentialInjected` when false to satisfy
        // exactOptionalPropertyTypes — only present when substitution fired.
        ...(credentialInjected ? { credentialInjected: true as const } : {}),
      }, callerSession));
    };

    clientTls.on('close', cleanup);
    clientTls.on('error', cleanup);
    clientSocket.on('close', cleanup);
    targetTls.on('close', cleanup);
    targetTls.on('error', cleanup);

    // Every MITM tunnel needs an EOF and idle path. A TLSSocket wrapping
    // an HTTP server socket can emit end without close (half-open), leaving
    // the upstream and listener bookkeeping alive indefinitely. Forward FIN
    // so final response bytes can drain; destroy both sides on inactivity.
    //
    // Before the upstream handshake completes there is nothing to forward the
    // FIN to: ending a TCP-pending upstream emits nothing, so the exchange sat
    // out the connect timer and was audited as a connect timeout; ending one
    // mid-handshake made it fail with a `tls_error` the upstream never caused.
    // A client FIN there means it gave up — tear down (and audit the
    // not-established 502) now, as the bypass path does (TASK-786, TASK-872).
    clientTls.on('end', () => {
      if (!established) cleanup();
      else targetTls.end();
    });
    clientTls.setTimeout(meteredTunnelIdleMs, cleanup);
    targetTls.setTimeout(meteredTunnelIdleMs, cleanup);

    // Bound the upstream connect phase (TASK-823) — TCP connect AND the TLS
    // handshake — the way TASK-786 bounds the raw tunnel's. Without it a
    // black-holed allowlisted host (or one that accepts TCP and never answers
    // the ClientHello) holds both sides until the 15-minute idle timeout above.
    // Firing destroys the upstream with an error, which runs the existing
    // upstream-error path: one 502 `tls_error` audit row, then cleanup() tears
    // down both sides. 'secureConnect' and cleanup() both clear it, so it never
    // touches an established tunnel and never outlives this exchange.
    //
    // Armed LAST, after the dial and every handler: `tls.connect` can throw
    // synchronously (ERR_SOCKET_BAD_PORT was the known case — CONNECT
    // host:99999 — until TASK-862 refused bad ports at parse; the ordering stays
    // as defense in depth), and a timer armed before such a throw would fire
    // into bindings that were never initialized — an uncaught error on the host.
    // 'secureConnect' and cleanup() only ever run from socket events, which
    // Node never emits synchronously, so both see it assigned.
    targetTls.once('secureConnect', () => {
      established = true;
      clearTimeout(connectTimer);
    });
    const connectTimer = setTimeout(() => {
      targetTls.destroy(
        new Error(`upstream connect timed out after ${upstreamConnectTimeoutMs}ms`),
      );
    }, upstreamConnectTimeoutMs);
  }

  // ── HTTPS CONNECT — MITM (default) or raw TCP tunnel (bypassMITM hosts) ──
  //
  // Ported from v1 ~/dev/ai/ax/src/host/web-proxy.ts:353-493 (allowlist + DNS
  // gates) and 497-620 (handleMITMConnect). Cuts vs. v1:
  //  - urlRewrites block dropped (out of scope for v2).
  //  - onApprove dropped — the CALLING session's allowlist is the only egress
  //    gate (TASK-158: the caller is authenticated by its proxy token).
  //  - sessionId/userId/classification are stamped on audit entries via
  //    `stampSession` from the calling SessionConfig (Task 11).
  //  - bypassDomains field renamed to per-session bypassMITM, so cert-pinning
  //    hosts the CALLING session declared never get a minted cert. (Used to be
  //    aggregated "any-bypass-wins" across sessions; TASK-158 scoped it to the
  //    caller so one session cannot switch off another's inspection.)
  //
  // MITM is the default. If the hostname is NOT in the calling session's own
  // bypassMITM, traffic is intercepted with a dynamically-minted domain cert
  // and decrypted in-process for credential injection + canary scanning. Hosts
  // in bypassMITM fall through to the raw-tunnel path below (no inspection).

  async function handleCONNECT(
    req: IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    const startTime = Date.now();
    const target = req.url ?? '';
    let requestBytes = head.length;
    let responseBytes = 0;

    // AUTHENTICATE FIRST (TASK-158), before the CONNECT target is parsed or
    // resolved: the per-session proxy token on the CONNECT request identifies
    // the ONE session whose policy governs this tunnel. Missing, malformed or
    // unknown → 407, no DNS lookup, no upstream connection. (Bytes after the
    // CONNECT headers, `head`, are never read on this path.)
    const caller = authenticateCaller(req.headers['proxy-authorization'], sessions);
    if (caller === undefined) {
      clientSocket.write(
        `HTTP/1.1 407 Proxy Authentication Required\r\n` +
          `Proxy-Authenticate: ${PROXY_AUTHENTICATE}\r\n` +
          `Content-Type: text/plain\r\n` +
          `Content-Length: ${Buffer.byteLength(PROXY_AUTH_REQUIRED_BODY)}\r\n` +
          `Connection: close\r\n` +
          `\r\n` +
          PROXY_AUTH_REQUIRED_BODY,
      );
      clientSocket.end();
      audit({
        action: 'proxy_request',
        method: 'CONNECT',
        url: target,
        status: 407,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: Date.now() - startTime,
        blocked: 'proxy_auth_required',
      });
      return;
    }
    const callerSession = caller.session;

    // Parse the CONNECT target with the strict authority-form grammar
    // (`host:port` / `[v6]:port`, port required — see connect-target.ts). It
    // runs HERE, before the allowlist, DNS, or any `200 Connection Established`,
    // and covers both the MITM and bypass paths. TASK-862: an out-of-range port
    // used to reach the dial, where `tls.connect` / `net.connect` throws
    // ERR_SOCKET_BAD_PORT — on the MITM path AFTER the 200 was written. TASK-874:
    // `split(':')` read `host:443:x` as `host:443` and could not parse `[::1]:443`.
    const parsed = parseConnectTarget(target);

    if (parsed === undefined) {
      // TASK-875: say what was wrong and what form is expected. Fixed text —
      // the untrusted target is never reflected (it is only in the audit row).
      clientSocket.write(
        `HTTP/1.1 400 Bad Request\r\n` +
          `Content-Type: text/plain\r\n` +
          `Content-Length: ${Buffer.byteLength(INVALID_CONNECT_TARGET_BODY)}\r\n` +
          `Connection: close\r\n` +
          `\r\n` +
          INVALID_CONNECT_TARGET_BODY,
      );
      clientSocket.end();
      audit(stampSession({
        action: 'proxy_request',
        method: 'CONNECT',
        url: target,
        status: 400,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: Date.now() - startTime,
        blocked: 'invalid_target',
      }, callerSession));
      return;
    }
    const { hostname, port } = parsed;

    try {
      // Allowlist gate (I2): the hostname must be in the CALLER's own
      // allowlist — never another session's.
      if (!callerSession.allowlist.has(hostname)) {
        // Write an ACTIONABLE 403 (not a bare status line): a binary-download
        // CLI fails over CONNECT, and a body-less denial surfaces as an opaque
        // error to the agent and the user. Mirror the HTTP path's guidance via
        // the shared `allowlistMissBody` so the two can't drift (TASK-25). The
        // body carries the caller-controlled hostname; Content-Length is the
        // body's byte length, and the hostname is in the body (never a header).
        const body = allowlistMissBody(hostname);
        const bodyLen = Buffer.byteLength(body);
        clientSocket.write(
          `HTTP/1.1 403 Forbidden\r\n` +
            `Content-Type: text/plain\r\n` +
            `Content-Length: ${bodyLen}\r\n` +
            `Connection: close\r\n` +
            `\r\n` +
            body,
        );
        clientSocket.end();
        // Same shape as the HTTP allowlist-miss case — attributed to the
        // caller its token authenticated as.
        audit(stampSession({
          action: 'proxy_request',
          method: 'CONNECT',
          url: target,
          status: 403,
          requestBytes: 0,
          responseBytes: 0,
          durationMs: Date.now() - startTime,
          blocked: `domain_denied: ${hostname}`,
        }, callerSession));
        return;
      }

      // SSRF block (I3): resolve and verify against private CIDRs.
      // Use the returned IP for the upstream connection — DO NOT re-resolve
      // (DNS rebinding defense). See SECURITY note on resolveAndCheck. The
      // `allowedIPs` override is the CALLER's own, not some other session's.
      const resolvedIP = await resolveAndCheck(hostname, callerSession.allowedIPs, resolver);

      // MITM unless the CALLING session declared this host in its own
      // bypassMITM. Another session's bypass never changes how this session's
      // traffic is inspected.
      const shouldMitm = !callerSession.bypassMITM?.has(hostname);
      if (shouldMitm) {
        await handleMITMConnect(
          clientSocket,
          hostname,
          port,
          resolvedIP,
          head,
          startTime,
          target,
          callerSession,
          caller.sessionKey,
        );
        return;
      }

      // Set once the upstream connect succeeds and we have told the client
      // "200 Connection Established". Until then there is no tunnel, so the
      // cleanup audit must not claim one (TASK-705).
      let established = false;

      // Open the raw TCP tunnel against the resolved IP.
      const targetSocket = net.connect(port, resolvedIP, () => {
        clearTimeout(connectTimer);
        established = true;
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        activeSockets.add(targetSocket);

        // Byte counters wired BEFORE pipe() — pipe() subscribes its own
        // 'data' listener; setting ours first removes the ordering brittleness.
        targetSocket.on('data', (chunk: Buffer) => {
          responseBytes += chunk.length;
        });
        clientSocket.on('data', (chunk: Buffer) => {
          requestBytes += chunk.length;
        });

        // Flush any bytes the client sent before the upstream opened — MUST
        // happen before pipe() wires clientSocket → targetSocket, otherwise
        // a racing client chunk could land on the upstream ahead of `head`
        // and corrupt the TLS ClientHello.
        if (head.length > 0) {
          targetSocket.write(head);
        }

        // Pipe bidirectionally — neither side's bytes are inspected here.
        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);
      });

      // Cleanup once — first close/error wins, downstream events become no-ops.
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(connectTimer);
        activeSockets.delete(targetSocket);
        targetSocket.destroy();

        if (!established) {
          // The upstream connect failed (refused, unreachable, reset) — or the
          // client gave up first — before any tunnel existed. Answer the client
          // the way the catch path answers a DNS failure (a 502, then close),
          // rather than hanging up with no status line, and audit what really
          // happened: a 502 with no bytes moved. Not a policy block, so no
          // `blocked` reason — same shape as the catch path's network 502.
          if (clientSocket.writable) {
            clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          } else {
            clientSocket.destroy();
          }
          audit(stampSession({
            action: 'proxy_request',
            method: 'CONNECT',
            url: target,
            status: 502,
            requestBytes: 0,
            responseBytes: 0,
            durationMs: Date.now() - startTime,
          }, callerSession));
          return;
        }

        clientSocket.destroy();
        audit(stampSession({
          action: 'proxy_request',
          method: 'CONNECT',
          url: target,
          status: 200,
          requestBytes,
          responseBytes,
          durationMs: Date.now() - startTime,
        }, callerSession));
      };

      targetSocket.on('close', cleanup);
      targetSocket.on('error', cleanup);
      clientSocket.on('close', cleanup);
      clientSocket.on('error', cleanup);
      // The http server's sockets are half-open: a client FIN emits 'end' but
      // never 'close'. Before the tunnel exists, a client FIN means it gave
      // up, so tear down (and audit) now instead of waiting out the connect
      // timer below on a black-holed upstream. After establishment 'end' is a
      // legitimate half-close that pipe() forwards upstream — leave it alone.
      clientSocket.once('end', () => {
        if (!established) cleanup();
      });
      // Bound the connect phase itself (TASK-786): an allowlisted host that
      // black-holes SYNs would otherwise hold both sockets until the OS connect
      // timeout. Firing tears down through the same not-established branch of
      // cleanup() — 502 to the client, one 502 audit, upstream destroyed. The
      // connect callback and cleanup() both clear it, so it never touches an
      // established tunnel and never outlives this exchange.
      //
      // Armed LAST, after the dial and every handler: `net.connect` can throw
      // synchronously (ERR_SOCKET_BAD_PORT was the known case — CONNECT
      // host:99999 — until TASK-862 refused bad ports at parse; the ordering
      // stays as defense in depth), and a timer armed before such a throw would
      // fire into a `cleanup` that was never initialized — an uncaught
      // ReferenceError on the host. The connect callback and cleanup() only ever run from socket
      // events, which Node never emits synchronously, so both see it assigned.
      const connectTimer = setTimeout(() => {
        if (!established) cleanup();
      }, upstreamConnectTimeoutMs);
    } catch (err) {
      // BlockedIPError → 403 (policy block); anything else → 502 (network/DNS).
      // Reviewer M3 from Task 5: typed instanceof, not string match.
      const isBlocked = err instanceof BlockedIPError;
      const status = isBlocked ? 403 : 502;

      clientSocket.write(
        `HTTP/1.1 ${status} ${isBlocked ? 'Forbidden' : 'Bad Gateway'}\r\n\r\n`,
      );
      clientSocket.end();

      // The caller authenticated before the try block, so every error here —
      // private-IP block, DNS failure, a throw while setting up the tunnel — is
      // attributable to it.
      const blockedEntry: ProxyAuditEntry = {
        action: 'proxy_request',
        method: 'CONNECT',
        url: target,
        status,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: Date.now() - startTime,
      };
      if (isBlocked) blockedEntry.blocked = (err as BlockedIPError).message;
      audit(stampSession(blockedEntry, callerSession));
    }
  }

  // ── Server setup ──

  const server: Server = createServer(handleHTTPRequest);
  server.on('connect', handleCONNECT);

  server.on('connection', (socket) => {
    // Shutdown-race defense: attach a noop 'error' listener BEFORE the
    // socket can be destroyed by any code path. Node's EventEmitter throws
    // when 'error' is emitted with zero listeners; a kernel-level
    // ECONNRESET that races with `stopFn`'s `socket.destroy()` (or with an
    // in-flight handler awaiting before it attaches its own listener)
    // would otherwise crash the host. Subsequent listeners
    // (handleMITMConnect, handleCONNECT bypass path) stack on top — all
    // fire on emit, so this doesn't suppress real error handling, just
    // prevents the unhandled-error throw. PR #104 walk symptom: "Error:
    // read ECONNRESET at TCP.onStreamRead, Emitted 'error' event on
    // Socket instance" — the "Socket" (not TLSSocket) is exactly this
    // inbound socket.
    socket.on('error', () => { /* see comment above */ });
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });

  // Clean up stale Unix socket
  if (listen.kind === 'unix' && existsSync(listen.path)) {
    unlinkSync(listen.path);
  }

  const stopFn = () => {
    for (const s of activeSockets) {
      // Belt-and-suspenders: ensure an 'error' listener exists before
      // destroy. Inbound sockets already get one at server.on('connection');
      // clientTls / targetTls / targetSocket get theirs synchronously
      // after creation in the MITM and bypass-MITM paths. This catches
      // any future socket type that someone adds to activeSockets without
      // remembering to attach a listener first.
      s.on('error', () => { /* see server.on('connection') note above */ });
      s.destroy();
    }
    activeSockets.clear();
    server.close();
    if (listen.kind === 'unix') {
      try {
        unlinkSync(listen.path);
      } catch {
        /* ignore */
      }
    }
  };

  if (listen.kind === 'unix') {
    await new Promise<void>((resolve) => {
      server.listen(listen.path, () => resolve());
    });
    return { port: 0, address: listen.path, stop: stopFn };
  }

  // TCP mode
  const host = listen.host ?? '127.0.0.1';
  const port = listen.port ?? 0;
  const assignedPort = await new Promise<number>((resolve) => {
    server.listen(port, host, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
  return { port: assignedPort, address: assignedPort, stop: stopFn };
}
