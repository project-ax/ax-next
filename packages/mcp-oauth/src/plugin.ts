import { randomBytes } from 'node:crypto';
import { makeAgentContext, PluginError, type Plugin } from '@ax/core';
import type { Kysely } from 'kysely';
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';
import { runMcpOAuthMigration, type McpOAuthDatabase } from './migrations.js';
import { createMcpOAuthStore } from './store.js';
import {
  createMcpOAuthResolver,
  type McpOAuthResolveInput,
  type McpOAuthResolveOutput,
  type RefreshedTokens,
  type ResolverDeps,
} from './resolver.js';
import {
  buildAuthorization,
  discover,
  ensureClient,
  redeemCode,
  refresh,
} from './oauth-flow.js';
import { registerMcpOAuthRoutes } from './routes.js';

const PLUGIN_NAME = '@ax/mcp-oauth';

// ---------------------------------------------------------------------------
// @ax/mcp-oauth plugin factory.
//
// Wires the package's three runtime surfaces together:
//   1. The per-plugin migration (mcp_oauth_v1_clients + mcp_oauth_v1_pending),
//      run on init against the shared postgres instance (Invariant I4 — this
//      plugin owns those tables; nothing else reaches into them).
//   2. The `credentials:resolve:mcp-oauth` sub-service — a refresh-on-read
//      resolver that @ax/credentials dispatches to when a stored credential's
//      `kind` is `mcp-oauth`. Registered ALWAYS: registering the sub-service is
//      harmless even when @ax/credentials isn't loaded (nothing calls it then),
//      and it keeps the manifest stable regardless of preset.
//   3. (optional) the begin/callback OAuth HTTP routes — mounted only when the
//      host configures `mountRoutes` (the multi-tenant preset) AND an
//      http-server is present. Off by default so the bus surface loads in
//      CLI/sandbox contexts that have no @ax/http-server.
// ---------------------------------------------------------------------------

export interface McpOAuthPluginConfig {
  /** Mount the begin/callback HTTP routes. Off by default (CLI/sandbox contexts
   *  without @ax/http-server). The multi-tenant preset sets it true. */
  mountRoutes?: boolean;
  /** Public origin for the OAuth redirect_uri + connector-return redirect.
   *  Required when mountRoutes. */
  publicOrigin?: string;
  /** Where the callback redirects on success/error. Default '/settings/connectors'. */
  connectorReturnPath?: string;
  /** Pending-authorization TTL. Default 10 min. */
  pendingTtlMs?: number;
  /** Test seam — inject fakes for the external OAuth calls so a canary can exercise
   *  the real plugin wiring (resolver registration, store, credentials integration,
   *  route registration) without real network/SSRF. Production leaves this undefined. */
  testOverrides?: {
    refresh?: ResolverDeps['refresh'];
    discover?: typeof import('./oauth-flow.js').discover;
    ensureClient?: typeof import('./oauth-flow.js').ensureClient;
    buildAuthorization?: typeof import('./oauth-flow.js').buildAuthorization;
    redeemCode?: typeof import('./oauth-flow.js').redeemCode;
  };
}

/**
 * The resolver-output contract, re-declared locally (Invariant #2 — no
 * cross-plugin import; @ax/credentials validates the shape at the bus
 * boundary). Mirrors {@link McpOAuthResolveOutput}: a fresh access-token
 * `value`, plus an optional `refreshed` envelope the vault re-stores when the
 * resolver rotated the token.
 */
// Cast to `ZodType<McpOAuthResolveOutput>` (not direct assignment): zod's
// `.optional()` widens an absent property to `| undefined`, which won't prove
// directly assignable to the interface under `exactOptionalPropertyTypes`. The
// runtime validation is identical — this only reconciles the static shape.
const ResolveOutputSchema = z.object({
  value: z.string(),
  refreshed: z
    .object({
      payload: z.instanceof(Uint8Array),
      expiresAt: z.number().optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .optional(),
}) as unknown as z.ZodType<McpOAuthResolveOutput>;

/**
 * Build the minimal {@link AuthorizationServerMetadata} the SDK's refresh helper
 * needs, WITHOUT re-discovery — the token endpoint was discovered + stored at
 * connect time and rides in the token blob, so a refresh-on-read must not pay
 * (or trust) a fresh metadata fetch.
 *
 * The SDK's `refreshAuthorization` reads only `metadata.token_endpoint` (and
 * `metadata.issuer`, which it takes as the `authorizationServerUrl` positional
 * arg). It does NOT re-validate the object against `OAuthMetadataSchema` — that
 * parse happens only during discovery. So at runtime only `token_endpoint` and
 * `issuer` are load-bearing. We still fill the schema-REQUIRED fields
 * (`authorization_endpoint`, `response_types_supported`) so the value satisfies
 * the `AuthorizationServerMetadata` TYPE at compile time and would survive a
 * defensive re-parse: `issuer`/`authorization_endpoint` are set to the stored
 * auth-server URL, `token_endpoint` to the stored endpoint, and
 * `response_types_supported` to the universal `['code']`.
 */
function buildMinimalAsMetadata(
  authServerUrl: string,
  tokenEndpoint: string,
): AuthorizationServerMetadata {
  return {
    issuer: authServerUrl,
    authorization_endpoint: authServerUrl,
    token_endpoint: tokenEndpoint,
    response_types_supported: ['code'],
  };
}

export function createMcpOAuthPlugin(config: McpOAuthPluginConfig = {}): Plugin {
  const mountRoutes = config.mountRoutes === true;
  const unregisterRoutes: Array<() => void> = [];

  // Built once at construction so the manifest is stable and matches what init
  // actually uses. `database:get-instance` is HARD — the migration needs it.
  // When the routes are mounted they additionally call the connector/auth/
  // credentials hooks (mirrors how @ax/connectors conditionally extends `calls`).
  const calls: string[] = ['database:get-instance'];
  if (mountRoutes) {
    calls.push(
      'http:register-route',
      'auth:require-user',
      'connectors:get',
      'agents:resolve',
      'credentials:get',
      'credentials:set',
    );
  }

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      // Registered ALWAYS — harmless when @ax/credentials isn't loaded.
      registers: ['credentials:resolve:mcp-oauth'],
      calls,
      subscribes: [],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'init',
      });

      const { db: shared } = await bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance',
        initCtx,
        {},
      );
      const db = shared as Kysely<McpOAuthDatabase>;
      await runMcpOAuthMigration(db);
      const store = createMcpOAuthStore(db);

      // The refresh-on-read resolver. `refresh` is injected so the resolver unit
      // stays offline; here we wire it to oauth-flow.refresh, constructing the
      // minimal AS metadata from the blob's stored token endpoint (no re-discovery).
      // The test seam (`testOverrides.refresh`) lets a canary swap in a fake so the
      // real plugin wiring is exercised without a live token endpoint; production
      // leaves it undefined and falls through to the real refresh below.
      const realRefresh: ResolverDeps['refresh'] = async ({
        authServerUrl,
        tokenEndpoint,
        resource,
        refreshToken,
        client,
        allowedHosts,
      }): Promise<RefreshedTokens> => {
        const metadata = buildMinimalAsMetadata(authServerUrl, tokenEndpoint);
        const tokens = await refresh({
          metadata,
          client,
          refreshToken,
          resource,
          allowedHosts,
        });
        // Project the SDK's OAuthTokens onto the resolver's RefreshedTokens,
        // spreading each optional field only when present so none is set to an
        // explicit `undefined` (exactOptionalPropertyTypes).
        return {
          access_token: tokens.access_token,
          ...(tokens.refresh_token !== undefined
            ? { refresh_token: tokens.refresh_token }
            : {}),
          ...(tokens.expires_in !== undefined
            ? { expires_in: tokens.expires_in }
            : {}),
          ...(tokens.token_type !== undefined
            ? { token_type: tokens.token_type }
            : {}),
          ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
        };
      };

      const resolver = createMcpOAuthResolver({
        store: { getClient: (k) => store.getClient(k) },
        now: () => Date.now(),
        refresh: config.testOverrides?.refresh ?? realRefresh,
      });

      bus.registerService<McpOAuthResolveInput, McpOAuthResolveOutput>(
        'credentials:resolve:mcp-oauth',
        PLUGIN_NAME,
        async (_ctx, input) => resolver(input),
        { returns: ResolveOutputSchema },
      );

      if (mountRoutes) {
        if (!config.publicOrigin) {
          throw new PluginError({
            code: 'invalid-config',
            plugin: PLUGIN_NAME,
            message:
              'mcp-oauth: mountRoutes requires publicOrigin (the OAuth redirect_uri + connector-return redirect are derived from it)',
          });
        }
        const unregs = await registerMcpOAuthRoutes(bus, initCtx, {
          bus,
          store,
          // Test seam: a canary may inject fakes for the SSRF-guarded external
          // calls so begin/callback run without a live auth server. Each falls
          // through to the real oauth-flow function when unset (production).
          flow: {
            discover: config.testOverrides?.discover ?? discover,
            ensureClient: config.testOverrides?.ensureClient ?? ensureClient,
            buildAuthorization: config.testOverrides?.buildAuthorization ?? buildAuthorization,
            redeemCode: config.testOverrides?.redeemCode ?? redeemCode,
          },
          config: {
            publicOrigin: config.publicOrigin,
            connectorReturnPath: config.connectorReturnPath ?? '/settings/connectors',
          },
          // 256-bit CSPRNG state — server-generated, single-use, TTL'd, CSRF-bound.
          genState: () => randomBytes(32).toString('hex'),
          now: () => Date.now(),
          pendingTtlMs: config.pendingTtlMs ?? 10 * 60_000,
        });
        unregisterRoutes.push(...unregs);
      }
    },

    async shutdown() {
      // Tear down the routes so a re-init (tests) doesn't trip duplicate-route.
      // Best-effort — a route already gone is fine.
      for (const unregister of unregisterRoutes.splice(0)) {
        try {
          unregister();
        } catch {
          // already gone — ignore.
        }
      }
    },
  };
}
