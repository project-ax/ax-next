/**
 * Credential placeholder management for MITM proxy credential injection.
 *
 * Generates opaque placeholder tokens that are injected into sandbox env vars
 * in place of real credentials. The web proxy uses this map to replace
 * placeholders with real values in intercepted HTTPS traffic.
 *
 * Placeholder format: ax-cred:<hex-random>
 * Designed to be unlikely to collide with legitimate content.
 *
 * BINDING (TASK-687). A placeholder is not a bearer token for "any allowlisted
 * host": every one is registered with the set of hosts its real value may be
 * sent to, and it is substituted ONLY on egress to one of them, and ONLY for the
 * session that owns it. The session allowlist answers "where may this session
 * reach"; the binding answers "where may THIS credential go" — a host the user
 * added to their own allowlist (proxy:add-host, a private connector) is
 * reachable but never receives an operator-paid key. There is deliberately no
 * API that substitutes without a host: an unbound placeholder is inert.
 */

import { randomBytes } from 'node:crypto';
import type { Replacer } from './request-framer.js';

/**
 * Canonical form of a host for binding comparison. Exact-match semantics
 * (mirrors the listener's allowlist): ASCII-case-folded and trimmed, nothing
 * else — no wildcards, no port, no trailing-dot folding. A host that cannot be
 * matched exactly simply never matches, which fails toward "placeholder
 * forwarded verbatim", never toward an over-broad substitution.
 *
 * The fold is ASCII-only ON PURPOSE. `String.prototype.toLowerCase` applies
 * Unicode case mapping, under which a non-ASCII look-alike collapses onto an
 * ASCII letter (U+212A KELVIN SIGN lowercases to `k`), so a hostname spelled
 * with one could be made to equal a bound host it is not. Hostnames are ASCII
 * (LDH) by the time they reach the proxy; anything else must not match.
 */
function normalizeHost(host: string): string {
  return host.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** A replacer that substitutes nothing. Returned when there is nothing to bind. */
const NOOP_REPLACER: Replacer = Object.freeze({
  replaceAll: (input: string): string => input,
  replaceAllBuffer: (input: Buffer): Buffer => input,
});

export class CredentialPlaceholderMap {
  /** placeholder → real value */
  private readonly placeholderToReal = new Map<string, string>();
  /** placeholder → hosts the real value may be sent to (normalized) */
  private readonly placeholderToHosts = new Map<string, ReadonlySet<string>>();
  /** env var name → placeholder */
  private readonly nameToPlaceholder = new Map<string, string>();

  /**
   * Register a credential and return its placeholder token.
   * If the same name is registered twice, the previous mapping is replaced.
   *
   * `allowedHosts` is REQUIRED and is the only place a credential's reach is
   * decided: the placeholder is substituted on egress to exactly these hosts
   * (exact match, case-insensitive) and nowhere else. An empty list is legal and
   * means "never substitute" — the placeholder still goes into the sandbox env
   * (so the process has something to read) but stays inert on the wire.
   */
  register(envName: string, realValue: string, allowedHosts: readonly string[]): string {
    // Remove old mapping if re-registering
    const oldPh = this.nameToPlaceholder.get(envName);
    if (oldPh) {
      this.placeholderToReal.delete(oldPh);
      this.placeholderToHosts.delete(oldPh);
    }

    const placeholder = `ax-cred:${randomBytes(16).toString('hex')}`;
    const hosts = new Set<string>();
    for (const h of allowedHosts) {
      const n = normalizeHost(h);
      if (n.length > 0) hosts.add(n);
    }
    this.placeholderToReal.set(placeholder, realValue);
    this.placeholderToHosts.set(placeholder, hosts);
    this.nameToPlaceholder.set(envName, placeholder);
    return placeholder;
  }

  /**
   * Update the real value for an already-registered envName WITHOUT minting
   * a new placeholder. The sandbox's env still carries the original
   * `ax-cred:<hex>`; the proxy now substitutes the new value at request
   * time. This is the contract that makes proxy:rotate-session safe for a
   * running sandbox — a fresh placeholder would break running SDKs that
   * have already read the env (Phase 3 I11).
   *
   * The host binding is untouched: rotation refreshes the VALUE, it can never
   * widen where that value may be sent.
   *
   * Returns the existing placeholder, or `undefined` if envName was never
   * registered.
   */
  updateValue(envName: string, realValue: string): string | undefined {
    const placeholder = this.nameToPlaceholder.get(envName);
    if (placeholder === undefined) return undefined;
    this.placeholderToReal.set(placeholder, realValue);
    return placeholder;
  }

  /** Check if a string contains any registered placeholders. */
  hasPlaceholders(input: string): boolean {
    for (const ph of this.placeholderToReal.keys()) {
      if (input.includes(ph)) return true;
    }
    return false;
  }

  /**
   * A replacer that substitutes ONLY the placeholders bound to `host`. Every
   * other placeholder — including ones registered in this same map — is left
   * byte-for-byte as written, so a credential aimed at the wrong host reaches it
   * as an inert fake token.
   *
   * `host` must be the destination the proxy actually connects to (the CONNECT
   * target it authenticated, allowlist-checked and resolved), never a name the
   * client wrote inside the tunnel.
   *
   * The eligible set and the values are read at CALL time, so a rotation
   * (`updateValue`) is seen by a tunnel that is already open, exactly as before.
   *
   * Like the whole-map replacers this replaced, `replaceAllBuffer` returns its
   * INPUT (same reference) when nothing was substituted — the framer's
   * `injected` signal is that identity. Assumes UTF-8 content (HTTP headers);
   * placeholders are ASCII so binary payloads pass through unchanged.
   */
  forHost(host: string): Replacer {
    const h = normalizeHost(host);
    const eligible = (): string[] => {
      const out: string[] = [];
      for (const [ph, hosts] of this.placeholderToHosts) {
        if (hosts.has(h)) out.push(ph);
      }
      return out;
    };
    const replaceAll = (input: string): string => {
      let result = input;
      for (const ph of eligible()) {
        const real = this.placeholderToReal.get(ph);
        if (real === undefined) continue;
        // Vault writes also serve env credentials, which can be multiline.
        // At HTTP substitution, control bytes must never become wire framing.
        if (result.includes(ph) && /[\x00-\x1f\x7f]/.test(real)) {
          throw new Error('Credential cannot be used in an HTTP request');
        }
        // split+join for global replacement (no regex special chars concern)
        result = result.split(ph).join(real);
      }
      return result;
    };
    return {
      replaceAll,
      replaceAllBuffer: (input: Buffer): Buffer => {
        const str = input.toString('utf-8');
        if (!eligible().some((ph) => str.includes(ph))) return input;
        return Buffer.from(replaceAll(str));
      },
    };
  }

  /** Return env var name → placeholder map for sandbox injection. */
  toEnvMap(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, ph] of this.nameToPlaceholder) {
      result[name] = ph;
    }
    return result;
  }
}

/**
 * Per-session CredentialPlaceholderMaps, keyed by the SAME session key the
 * listener's `sessions` Map uses. A shared proxy (k8s) serves many sessions, so
 * substitution is always resolved through ONE session: the one whose proxy token
 * authenticated the request (TASK-158) — see `replacerFor`.
 *
 * Placeholders are globally unique (ax-cred:<random>), but uniqueness is not
 * authorization: session B presenting session A's placeholder (say, one that
 * leaked into a shared transcript) must not get A's value. There is no
 * cross-session substitution API.
 */
export class SharedCredentialRegistry {
  private readonly sessions = new Map<string, CredentialPlaceholderMap>();

  /** Register a session's credential map. Called at sandbox launch. */
  register(sessionId: string, map: CredentialPlaceholderMap): void {
    this.sessions.set(sessionId, map);
  }

  /** Deregister a session's credential map. Called at session cleanup. */
  deregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Look up a session's existing credential map. proxy:rotate-session uses
   * this to update values on the same map (preserving placeholders) rather
   * than minting a fresh map (which would invalidate the sandbox's env).
   */
  get(sessionId: string): CredentialPlaceholderMap | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * The substitution surface for ONE tunnel: the authenticated caller's own
   * placeholders that are bound to `host`. Returns a LIVE view — the session's
   * map is looked up on every call, so a `deregister` (session closed) or a
   * re-`register` (session re-opened) takes effect on tunnels that are already
   * open: a closed session's keep-alive connection stops substituting the moment
   * its map is gone. A session with no registered map (or no placeholder bound
   * to `host`) gets a replacer that changes nothing.
   */
  replacerFor(sessionId: string, host: string): Replacer {
    const view = (): Replacer => this.sessions.get(sessionId)?.forHost(host) ?? NOOP_REPLACER;
    return {
      replaceAll: (input) => view().replaceAll(input),
      replaceAllBuffer: (input) => view().replaceAllBuffer(input),
    };
  }
}
