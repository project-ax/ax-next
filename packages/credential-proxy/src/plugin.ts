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
 *  4. Register the three service hooks (rotate-session is a Task 10
 *     stub that throws — registering it now keeps the manifest honest
 *     and lets dependent plugins fail fast at boot if they wired up
 *     the wrong hook name).
 *
 * Shutdown: stop the listener (this also closes any active sockets and
 * unlinks the Unix socket file when applicable).
 *
 * The `credentials:get` shape used here is the CURRENT @ax/credentials
 * one — `{ id } → { value }` — NOT the design's eventual
 * `({ ref, userId }) → currentValue`. Phase 1b reshapes; the env-name →
 * placeholder mapping in this plugin doesn't change either way.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { PluginError, type AgentContext, type Plugin } from '@ax/core';
import { startProxyListener, type ProxyListener, type SessionConfig } from './listener.js';
import { CredentialPlaceholderMap, SharedCredentialRegistry } from './registry.js';
import { getOrCreateCA } from './ca.js';

const PLUGIN_NAME = '@ax/credential-proxy';

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

      // 3. Start the listener (no-op `onAudit` for now — Task 11 swaps to bus.fire).
      listener = await startProxyListener({
        listen: config.listen,
        registry,
        sessions,
        ca,
        onAudit: () => { /* Task 11 wires bus.fire('event.http-egress', ...) */ },
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

          // Resolve every credential ref via credentials:get (current shape).
          const map = new CredentialPlaceholderMap();
          for (const [envName, { ref }] of Object.entries(input.credentials)) {
            const got = await bus.call<{ id: string }, { value: string }>(
              'credentials:get',
              ctx,
              { id: ref },
            );
            map.register(envName, got.value);
          }

          // Register the placeholder map with the shared registry so the
          // MITM substitution path can find it.
          registry.register(input.sessionId, map);

          // Persist the session config — the listener iterates this on every
          // request to gate egress, run SSRF checks, and decide MITM-vs-bypass.
          const sessionConfig: SessionConfig = {
            allowlist: new Set(input.allowlist),
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

          return {
            proxyEndpoint: endpointString,
            caCertPem,
            envMap: map.toEnvMap(),
          };
        },
      );

      // 4b. proxy:rotate-session — Task 10 implements. Stub throws so any
      //     premature dependency fails loud rather than silently no-op-ing.
      bus.registerService(
        'proxy:rotate-session',
        PLUGIN_NAME,
        async () => {
          throw new PluginError({
            code: 'not-implemented',
            plugin: PLUGIN_NAME,
            message: 'proxy:rotate-session is not yet implemented (Task 10)',
          });
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
