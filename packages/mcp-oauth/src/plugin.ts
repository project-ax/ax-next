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
import { readAgentSignIns, type SignInIdentity } from './sign-ins.js';
import { DEFAULT_CLIENT_NAME, oauthClientName } from './client-name.js';

const PLUGIN_NAME = '@ax/mcp-oauth';

// ---------------------------------------------------------------------------
// @ax/mcp-oauth plugin factory.
//
// Wires the package's three runtime surfaces together:
//   1. The per-plugin migration (mcp_oauth_v1_pending, plus mcp_oauth_v1_clients
//      as a read-only legacy fallback), run on init against the shared postgres
//      instance (Invariant I4 — this plugin owns those tables; nothing else
//      reaches into them).
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
  /** Where the callback redirects on success/error. Default '/oauth/connected'. */
  connectorReturnPath?: string;
  /** Pending-authorization TTL. Default 10 min. */
  pendingTtlMs?: number;
  /** Test seam — inject fakes for the external OAuth calls so a canary can exercise
   *  the real plugin wiring (resolver registration, store, credentials integration,
   *  route registration) without real network/SSRF. Production leaves this undefined. */
  testOverrides?: {
    refresh?: ResolverDeps['refresh'];
    discover?: typeof import('./oauth-flow.js').discover;
    discoverHosts?: typeof import('./host-discovery.js').discoverOAuthHosts;
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
 * `mcp-oauth:status-batch` (TASK-741). Boundary review: `{userId, connectorIds}`
 * → `{needsReconnect: connectorIds}` names no storage or transport; an alternate
 * impl (a vault that tracks credential health itself, or one that records the
 * provider's revocation webhook) answers the same shape.
 */
export interface StatusBatchInput {
  userId: string;
  /**
   * TASK-756 — the agent the caller is looking at. When given, a rejected
   * sign-in that agent's members SHARE (a team agent's token) counts too.
   * The caller must already have resolved this agent for `userId`.
   */
  agentId?: string;
  connectorIds: string[];
}
export interface StatusBatchOutput {
  /** The subset of `connectorIds` whose sign-in was rejected and not yet renewed. */
  needsReconnect: string[];
  /**
   * TASK-756 — the subset of `needsReconnect` where the rejected sign-in is the
   * agent's shared one, not the caller's own. A connector whose OWN sign-in is
   * also rejected is not listed here: the caller's own sign-in is the one their
   * use of it reaches first, so it is theirs to fix.
   */
  shared: string[];
  /**
   * Slice 4 — which account the agent signed in as, per connector: keyed by
   * each requested connector id that has a sign-in stored ON `agentId`. A
   * sign-in from before slice 4 recorded nothing, so it is keyed with every
   * field `null`. `{}` without an `agentId`, or when the vault can't be read.
   *
   * Boundary review: `account` / `signedInBy` / `signedInAt` name no storage
   * or provider; an alternate impl (a vault that records identity itself)
   * answers the same shape. `account` is UNTRUSTED provider text, sanitized
   * here and for display only — never an access decision.
   */
  signIns: Record<string, SignInIdentity>;
}
const StatusBatchInputSchema = z
  .object({
    userId: z.string().min(1).max(256),
    agentId: z.string().min(1).max(256).optional(),
    connectorIds: z.array(z.string().min(1).max(128)).max(500),
  })
  .strict();
const StatusBatchOutputSchema = z.object({
  needsReconnect: z.array(z.string()),
  shared: z.array(z.string()),
  signIns: z.record(
    z.object({
      account: z.string().nullable(),
      signedInBy: z.string().nullable(),
      signedInAt: z.string().nullable(),
    }),
  ),
}) as unknown as z.ZodType<StatusBatchOutput>;

/**
 * `mcp-oauth:remove-shared-sign-in` (TASK-858). Removes an AGENT's own
 * sign-in to one connector — the agent-scope token row and the agent's
 * "sign-in expired" marker. Since slice 3 every agent's sign-in is the
 * agent's (a personal agent's as much as a team agent's), so this is no
 * longer team-only: the host calls it when a connector is removed from any
 * agent, after the caller's permission was checked there. Boundary review:
 * `{agentId, connectorId}` → `{removed: true}` names no storage or transport;
 * an alternate impl (a vault that tracks sign-in health itself) answers the
 * same shape, and no payload field is backend-specific.
 *
 * It is a hook of its own — not a bare `credentials:delete` from the caller —
 * because this plugin writes that row AND owns the agent's "sign-in expired"
 * marker: deleting the row alone would leave the marker behind, and the rail
 * would go on saying the sign-in expired for a sign-in that no longer exists.
 * A hook that only CLEARED the marker would be worse: a capability to re-trust a
 * rejected, unexpired token (TASK-817). Delete-then-clear is bundled so that
 * cannot be asked for.
 *
 * Never touches a user-scope row or marker: a person's own sign-in is theirs.
 */
export interface RemoveSharedSignInInput {
  agentId: string;
  connectorId: string;
}
export interface RemoveSharedSignInOutput {
  removed: true;
}
const RemoveSharedSignInInputSchema = z
  .object({
    agentId: z.string().min(1).max(256),
    // A connector-id slug — the same shape the resolver's `account:<id>` match
    // accepts. This hook builds the ref itself, so a `:` here would aim its
    // `credentials:delete` at some other ref (e.g. the OAuth client secret).
    connectorId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9_-]*$/),
  })
  .strict();
const RemoveSharedSignInOutputSchema = z.object({
  removed: z.literal(true),
}) as unknown as z.ZodType<RemoveSharedSignInOutput>;

/**
 * `mcp-oauth:remove-personal-sign-in`. A person's OWN sign-in to one
 * connector goes — the user-scope token row and that person's "sign-in
 * expired" marker.
 *
 * NO PRODUCTION CALLER since slice 3: the host's `signOutIfUnused` (its only
 * caller) was deleted when sign-ins moved onto agents, and Remove now deletes
 * the agent's own sign-in (`mcp-oauth:remove-shared-sign-in`). It stays
 * registered only until slice 5 flips lookup off user-scope rows and purges
 * them, which retires this hook with them.
 *
 * Boundary review: `{userId, connectorId}` → `{removed: true}` names no
 * storage or transport; an alternate impl (a vault that tracks sign-in
 * health itself) answers the same shape. A hook of its own for the same
 * reason as the team one: the row and the marker are this plugin's, and
 * delete-then-clear is bundled so a bare marker-clear can't be asked for.
 *
 * Never touches an agent-scope row or marker: an agent's sign-in is the
 * agent's (that one is `mcp-oauth:remove-shared-sign-in`).
 */
export interface RemovePersonalSignInInput {
  userId: string;
  connectorId: string;
}
export interface RemovePersonalSignInOutput {
  removed: true;
}
const RemovePersonalSignInInputSchema = z
  .object({
    userId: z.string().min(1).max(256),
    // Same slug rule as the team hook: this hook builds the ref itself.
    connectorId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9_-]*$/),
  })
  .strict();
const RemovePersonalSignInOutputSchema = z.object({
  removed: z.literal(true),
}) as unknown as z.ZodType<RemovePersonalSignInOutput>;

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
  // `credentials:resolve:mcp-oauth` is registered ALWAYS — harmless when
  // @ax/credentials isn't loaded. `mcp-oauth:status-batch` (TASK-741) answers
  // from this plugin's own table, so it is registered ALWAYS too.
  const registers: string[] = ['credentials:resolve:mcp-oauth', 'mcp-oauth:status-batch'];
  if (mountRoutes) {
    calls.push(
      'http:register-route',
      'auth:require-user',
      'connectors:get',
      'agents:resolve',
      'credentials:get',
      'credentials:set',
      // TASK-858 — `mcp-oauth:remove-shared-sign-in` deletes the row the
      // callback wrote, so it exists only where the routes (and so the vault
      // they write to) are mounted.
      'credentials:delete',
      // An Add's callback attaches the connector once its sign-in is stored
      // (and deletes the token again if the attach fails). No cycle: nothing
      // @ax/agents calls reaches this plugin.
      'agents:attach-connector',
    );
    registers.push('mcp-oauth:remove-shared-sign-in', 'mcp-oauth:remove-personal-sign-in');
  }

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers,
      calls,
      optionalCalls: [
        {
          // Slice 4 — `mcp-oauth:status-batch` (registered ALWAYS) reads the
          // sign-in identity from the vault's envelope metadata. A list read:
          // it never resolves or refreshes a token.
          hook: 'credentials:list',
          degradation: 'connector rows never say which account the agent signed in as',
        },
        // The routes name AX on third-party consent screens after the operator's
        // branding when a branding plugin is loaded.
        ...(mountRoutes
          ? [
              {
                hook: 'branding:get',
                degradation: 'OAuth client name falls back to "AX"',
              },
              {
                // TASK-711 — provided by @ax/connectors.
                hook: 'credentials:authorize-agent:account',
                degradation: 'nobody may start a connector sign-in for any agent',
              },
              {
                // TASK-798 / TASK-813 — provided by @ax/agents.
                hook: 'agents:can-set-shared-credential',
                degradation: 'nobody may start a sign-in on a team agent',
              },
            ]
          : []),
      ],
      // TASK-718: `@ax/agents` fires this after the agent row is gone; an
      // in-flight handshake for it can never complete. Subscribed whether or
      // not the routes are mounted — the pending table exists either way.
      subscribes: ['agents:deleted', 'connectors:deleted'],
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

      // TASK-718 — a deleted agent's in-flight OAuth handshakes (and its reconnect
      // markers) must go with it.
      // Payload (declared locally, no cross-plugin import): `{ agentId, ownerId,
      // ownerType }`; only `agentId` matters, and it is keyed on ALONE because a
      // team agent's connect can be started by several people. Tokens live in the
      // credentials store and are purged there, not here. K10: a subscriber must
      // never throw — a failed purge is logged loudly and swallowed.
      bus.subscribe<unknown>('agents:deleted', PLUGIN_NAME, async (ctx, payload) => {
        const agentId = (payload as { agentId?: unknown } | null | undefined)?.agentId;
        if (typeof agentId !== 'string' || agentId.length === 0) {
          ctx.logger.warn('mcp_oauth_purge_for_deleted_agent_skipped', {
            reason: 'agents:deleted payload has no non-empty string agentId',
          });
          return undefined;
        }
        try {
          const { deleted, markers } = await store.deleteAllForAgent(agentId);
          ctx.logger.info('mcp_oauth_purged_for_deleted_agent', { agentId, deleted, markers });
        } catch (err) {
          ctx.logger.error('mcp_oauth_purge_for_deleted_agent_failed', { agentId, err });
        }
        return undefined;
      });

      // Slice 2b — a deleted connector's reconnect markers (people's and agents')
      // go with it, and (slice 4) so does its identity-scope skip flag.
      // Payload (declared locally, no cross-plugin import):
      // `{ connectorId, toolNamespaces, idStillLive }`. Act ONLY on an explicit
      // `idStillLive === false`: true, missing or non-boolean means a live
      // connector of some owner still carries the id, so its markers stay.
      // K10: never throw.
      bus.subscribe<unknown>('connectors:deleted', PLUGIN_NAME, async (ctx, payload) => {
        const p = payload as { connectorId?: unknown; idStillLive?: unknown } | null | undefined;
        const connectorId = p?.connectorId;
        if (typeof connectorId !== 'string' || connectorId.length === 0) {
          ctx.logger.warn('mcp_oauth_marker_purge_for_deleted_connector_skipped', {
            reason: 'connectors:deleted payload has no non-empty string connectorId',
          });
          return undefined;
        }
        if (p?.idStillLive !== false) return undefined;
        try {
          const { user, agent, identityScope } = await store.deleteMarkersForConnector(connectorId);
          ctx.logger.info('mcp_oauth_markers_purged_for_deleted_connector', {
            connectorId,
            user,
            agent,
            identityScope,
          });
        } catch (err) {
          ctx.logger.error('mcp_oauth_marker_purge_for_deleted_connector_failed', {
            connectorId,
            err,
          });
        }
        return undefined;
      });

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
        // TASK-741 — the stored "sign-in expired" marker. A failed write is
        // logged and swallowed: the resolve's own answer must never change
        // because the rail's bookkeeping could not be written.
        marker: {
          mark: async (owner, connectorId) => {
            try {
              await store.markNeedsReconnect(owner, connectorId);
            } catch (err) {
              initCtx.logger.warn('mcp_oauth_needs_reconnect_mark_failed', {
                connectorId,
                name: err instanceof Error ? err.name : 'unknown',
              });
            }
          },
          clear: async (owner, connectorId) => {
            try {
              await store.clearNeedsReconnect(owner, connectorId);
            } catch (err) {
              initCtx.logger.warn('mcp_oauth_needs_reconnect_clear_failed', {
                connectorId,
                name: err instanceof Error ? err.name : 'unknown',
              });
            }
          },
          // TASK-817 — a marked sign-in's unexpired token is not trusted. A
          // failed read is logged and counts as unmarked (today's behaviour).
          isMarked: async (owner, connectorId) => {
            try {
              return await store.hasNeedsReconnect(owner, connectorId);
            } catch (err) {
              initCtx.logger.warn('mcp_oauth_needs_reconnect_read_failed', {
                connectorId,
                name: err instanceof Error ? err.name : 'unknown',
              });
              return false;
            }
          },
        },
      });

      bus.registerService<McpOAuthResolveInput, McpOAuthResolveOutput>(
        'credentials:resolve:mcp-oauth',
        PLUGIN_NAME,
        async (_ctx, input) => resolver(input),
        { returns: ResolveOutputSchema },
      );

      // TASK-741 — which of these connectors need the caller to sign in again.
      // Reads the marker table ONLY: it never resolves, refreshes or even reads
      // a token, so a page of rows costs one indexed query, not N probes. The
      // caller (the connectors rail) has already decided which connectors this
      // user may see; the answer is keyed on `userId`, so it can only ever say
      // something about that user's own sign-ins.
      bus.registerService<StatusBatchInput, StatusBatchOutput>(
        'mcp-oauth:status-batch',
        PLUGIN_NAME,
        async (ctx, raw) => {
          const parsed = StatusBatchInputSchema.safeParse(raw);
          if (!parsed.success) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              hookName: 'mcp-oauth:status-batch',
              message: 'invalid status-batch input',
            });
          }
          const { userId, agentId, connectorIds } = parsed.data;
          const [{ personal, shared }, signIns] = await Promise.all([
            store.listNeedsReconnect(userId, agentId, connectorIds),
            // Slice 4 — who the agent signed in as. Agent sign-ins only (every
            // sign-in is the agent's since slice 3), so no agent → nothing.
            // Fail-soft: a vault fault leaves the health answer standing.
            agentId === undefined
              ? Promise.resolve({})
              : readAgentSignIns({ bus, ctx, logger: ctx.logger, agentId, connectorIds }),
          ]);
          const own = new Set(personal);
          const sharedOnly = shared.filter((id) => !own.has(id));
          return { needsReconnect: [...personal, ...sharedOnly], shared: sharedOnly, signIns };
        },
        { returns: StatusBatchOutputSchema },
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
        // TASK-858 — remove a team agent's shared sign-in. The ORDER is the point:
        // delete the vault row FIRST, then clear the agent's marker. Clearing first
        // would, if the delete then failed, leave a marked-but-unexpired token with
        // no marker: the resolver would trust it again (TASK-817) after the caller
        // was told the removal failed. A failed delete therefore propagates and
        // leaves the marker exactly as it was.
        //
        // `credentials:delete` of an absent row is not an error (the vault
        // overwrites it with a tombstone), so removing twice is a quiet success.
        // Scope is fixed to `agent`: this hook can never reach a person's own row.
        bus.registerService<RemoveSharedSignInInput, RemoveSharedSignInOutput>(
          'mcp-oauth:remove-shared-sign-in',
          PLUGIN_NAME,
          async (ctx, raw) => {
            const parsed = RemoveSharedSignInInputSchema.safeParse(raw);
            if (!parsed.success) {
              throw new PluginError({
                code: 'invalid-payload',
                plugin: PLUGIN_NAME,
                hookName: 'mcp-oauth:remove-shared-sign-in',
                message: 'invalid remove-shared-sign-in input',
              });
            }
            const { agentId, connectorId } = parsed.data;
            await bus.call<
              { scope: 'agent'; ownerId: string; ref: string },
              void
            >('credentials:delete', ctx, {
              scope: 'agent',
              ownerId: agentId,
              ref: `account:${connectorId}`,
            });
            // Best-effort, like the callback's own clear: the sign-in is already
            // gone, and a stale marker only costs the wrong wording on the rail.
            try {
              await store.clearNeedsReconnect({ kind: 'agent', agentId }, connectorId);
            } catch (err) {
              ctx.logger.warn('mcp_oauth_needs_reconnect_clear_failed', {
                connectorId,
                name: err instanceof Error ? err.name : 'unknown',
              });
            }
            return { removed: true };
          },
          { returns: RemoveSharedSignInOutputSchema },
        );

        bus.registerService<RemovePersonalSignInInput, RemovePersonalSignInOutput>(
          'mcp-oauth:remove-personal-sign-in',
          PLUGIN_NAME,
          async (ctx, raw) => {
            const parsed = RemovePersonalSignInInputSchema.safeParse(raw);
            if (!parsed.success) {
              throw new PluginError({
                code: 'invalid-payload',
                plugin: PLUGIN_NAME,
                hookName: 'mcp-oauth:remove-personal-sign-in',
                message: 'invalid remove-personal-sign-in input',
              });
            }
            const { userId, connectorId } = parsed.data;
            await bus.call<
              { scope: 'user'; ownerId: string; ref: string },
              void
            >('credentials:delete', ctx, {
              scope: 'user',
              ownerId: userId,
              ref: `account:${connectorId}`,
            });
            try {
              await store.clearNeedsReconnect({ kind: 'user', userId }, connectorId);
            } catch (err) {
              ctx.logger.warn('mcp_oauth_needs_reconnect_clear_failed', {
                connectorId,
                name: err instanceof Error ? err.name : 'unknown',
              });
            }
            return { removed: true };
          },
          { returns: RemovePersonalSignInOutputSchema },
        );

        const unregs = await registerMcpOAuthRoutes(bus, initCtx, {
          bus,
          store,
          // Test seam: a canary may inject fakes for the SSRF-guarded external
          // calls so begin/callback run without a live auth server. Each falls
          // through to the real oauth-flow function when unset (production).
          flow: {
            ...(config.testOverrides?.discoverHosts ? { discoverHosts: config.testOverrides.discoverHosts } : {}),
            discover: config.testOverrides?.discover ?? discover,
            ensureClient: config.testOverrides?.ensureClient ?? ensureClient,
            buildAuthorization: config.testOverrides?.buildAuthorization ?? buildAuthorization,
            redeemCode: config.testOverrides?.redeemCode ?? redeemCode,
          },
          config: {
            publicOrigin: config.publicOrigin,
            connectorReturnPath: config.connectorReturnPath ?? '/oauth/connected',
          },
          // 256-bit CSPRNG state — server-generated, single-use, TTL'd, CSRF-bound.
          genState: () => randomBytes(32).toString('hex'),
          now: () => Date.now(),
          pendingTtlMs: config.pendingTtlMs ?? 10 * 60_000,
          clientName: async () => {
            if (!bus.hasService('branding:get')) return DEFAULT_CLIENT_NAME;
            try {
              const { name } = await bus.call<
                Record<string, never>,
                { name: string | null }
              >('branding:get', initCtx, {});
              return oauthClientName(name);
            } catch (err) {
              // A branding read failure must never block a sign-in.
              initCtx.logger.warn('mcp_oauth_branding_unavailable', {
                name: err instanceof Error ? err.name : 'unknown',
              });
              return DEFAULT_CLIENT_NAME;
            }
          },
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
