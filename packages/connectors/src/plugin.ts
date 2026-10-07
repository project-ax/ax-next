import {
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
import { TOOL_PERMISSIONS_RESET_FAILED } from '@ax/core/error-codes';
import { type Kysely } from 'kysely';
import {
  runConnectorsMigration,
  type ConnectorDatabase,
} from './migrations.js';
import {
  deriveCredentialPlan,
  requiresSharedKeyConsent,
} from './credential-plan.js';
import {
  createConnectorStore,
  DESCRIPTION_MAX,
  USAGE_NOTE_MAX,
  validateCapabilities,
  validateConnectorId,
  validateKeyMode,
  validateName,
  validateOptionalText,
  validateSlotName,
  validateVisibility,
  type ConnectorStore,
} from './store.js';
import {
  createAuthoredConnectorsStore,
  type AuthoredConnectorsStore,
} from './authored-store.js';
import {
  registerAdminConnectorRoutes,
  registerUserConnectorRoutes,
} from './admin-routes.js';
import { authorizeAgentAccountRead, authorizeGlobalAccountRead } from './credential-authz.js';
import { listEffectiveConnectors } from './effective-connectors.js';
import { requireUserId } from './input-guards.js';
import { assertOwnClientSecretRefs } from './oauth-client-secret-ref.js';
import { purgeConnectorState } from './purge.js';
import { sweepStdioConnectors } from './stdio-sweep.js';
import { deriveToolNamespaces, diffToolNamespaces } from './tool-namespace.js';
import {
  type ResetToolNamespacesInputLike,
  type SetCeilingSourcesInputLike,
  type SetCeilingSourcesOutputLike,
} from './tool-permissions.js';
import { ceilingSourcesFor, type CeilingSourceEntry } from './ceiling-sources.js';
import {
  ActivateAuthoredOutputSchema,
  AuthorizeAgentOutputSchema,
  AuthorizeGlobalOutputSchema,
  ClearAuthoredOutputSchema,
  DeleteOutputSchema,
  GetOutputSchema,
  InstallAuthoredOutputSchema,
  ListAuthoredOutputSchema,
  ListAuthoredPendingOutputSchema,
  ClearLegacyDefaultOutputSchema,
  ListEffectiveOutputSchema,
  ListLegacyDefaultsOutputSchema,
  ListOutputSchema,
  ResolveOutputSchema,
  ToolLabelsOutputSchema,
  UpsertOutputSchema,
  type ToolLabelsInput,
  type ToolLabelsOutput,
  type ActivateAuthoredInput,
  type ActivateAuthoredOutput,
  type AuthorizeAgentInput,
  type AuthorizeAgentOutput,
  type AuthorizeGlobalInput,
  type AuthorizeGlobalOutput,
  type AuthoredConnectorSlot,
  type Capabilities,
  type ClearAuthoredInput,
  type ClearAuthoredOutput,
  type Connector,
  type ConnectorToolNamespacesChangedEvent,
  type DeleteInput,
  type DeleteOutput,
  type GetInput,
  type GetOutput,
  type InstallAuthoredInput,
  type InstallAuthoredOutput,
  type ListAuthoredInput,
  type ListAuthoredOutput,
  type ListAuthoredPendingInput,
  type ListAuthoredPendingOutput,
  type ClearLegacyDefaultInput,
  type ClearLegacyDefaultOutput,
  type ListEffectiveInput,
  type ListEffectiveOutput,
  type ListInput,
  type ListLegacyDefaultsInput,
  type ListLegacyDefaultsOutput,
  type ListOutput,
  type McpServerSpec,
  type ResolveInput,
  type ResolveOutput,
  type UpsertInput,
  type UpsertOutput,
} from './types.js';

const PLUGIN_NAME = '@ax/connectors';

// ---------------------------------------------------------------------------
// @ax/connectors plugin
//
// Registers the five `connectors:*` service hooks. The connector is the
// first-class ACCESS object (design "Connectors as a first-class concept") —
// `{ id, name, description, usageNote, keyMode, visibility } + Capabilities`,
// backed by its own `connectors_v1_*` table (Invariant I4 — one source of
// truth).
//
// HALF-WIRED WINDOW (open by design, sanctioned by the design's Phase 1):
//   The connector STORE exists, but nothing routes through it yet — the skill
//   `capabilities` block stays authoritative until the authoring + orchestrator
//   phases land. This is NOT a half-wired plugin in the I3 sense: the plugin is
//   fully registered + tested + reachable (the k8s preset loads it and
//   preset.test.ts asserts it). Only the *consumer* lands in later phases.
//
// Manifest decisions:
//   - `calls: ['database:get-instance']` — hard. The plugin runs its own
//     migration on init and can't function without a postgres instance. (This
//     is why it is wired into the k8s preset ONLY — the local CLI registers no
//     `database:get-instance` provider; see card Clarifications.)
//   - No `agents:resolve` gate on the `connectors:*` hooks: connectors are
//     owner-scoped by `owner_user_id` (the hook input carries the `userId`).
//   - `agents:resolve` IS called — undeclared, `bus.hasService`-guarded — by
//     the agent-scope credential gate (TASK-788, credential-authz.ts) to read
//     the agent's attachments. Declaring it (calls OR optionalCalls) would
//     close a plugin call-graph cycle: @ax/agents declares `connectors:resolve`
//     as an optionalCall, and bootstrap refuses any preset loading both.
// ---------------------------------------------------------------------------

/**
 * Plugin config.
 *
 * - `mountAdminRoutes` — when true, register the `/admin/connectors[/:id]` REST
 *   routes that bridge the `connectors:*` hooks for the channel-web connector
 *   registry UI (TASK-98). Off by default so the bus surface can load without an
 *   http-server (the CLI / sandbox-side contexts). The k8s preset turns it on.
 *
 * Typed as an object (not `Record<string, never>` anymore) so the field is
 * additive without changing the factory signature.
 */
export interface ConnectorsConfig {
  mountAdminRoutes?: boolean;
}

export function createConnectorsPlugin(config: ConnectorsConfig = {}): Plugin {
  let db: Kysely<ConnectorDatabase> | undefined;
  let _store: ConnectorStore | undefined;
  let _authored: AuthoredConnectorsStore | undefined;
  const mountAdminRoutes = config.mountAdminRoutes === true;
  const unregisterRoutes: Array<() => void> = [];

  // The `calls` list is built once at construction so the manifest is stable and
  // matches what init actually uses. The admin-route bridge calls
  // `http:register-route` + `auth:require-user` only when mounted; the connector
  // Test probe (TASK-108) additionally reads credential METADATA via
  // `credentials:list` (presence-only — never `credentials:get`, never a value).
  const calls: string[] = ['database:get-instance'];
  if (mountAdminRoutes) {
    calls.push('http:register-route', 'auth:require-user', 'credentials:list');
  }

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'connectors:list',
        // TASK-739 — the ONE implementation of an agent's effective connector
        // set (attachments ∪ legacy-owned, minus exclusions). The orchestrator
        // folds it; the agent connector list UI shows it.
        // (TASK-808: there is no workspace-default source any more.)
        'connectors:list-effective',
        'connectors:get',
        'connectors:upsert',
        'connectors:delete',
        'connectors:resolve',
        // TASK-744 — toolNamespace → connector display name, for the surfaces
        // that would otherwise print `mcp.c<hex>.<tool>` at a person.
        'connectors:tool-labels',
        // TASK-94 — agent-authored connector drafts + the approval gate's
        // activate/clear. install-authored persists a PENDING draft (zero
        // reach); the orchestrator fires ONE approval card; activate-authored
        // flips it active on a human grant; clear-authored is the reject path.
        'connectors:install-authored',
        'connectors:list-authored',
        // The user's PENDING drafts across all their agents — the Settings
        // "Proposed by your assistant" fallback read (a draft proposed mid-turn
        // is approvable outside chat, so a missed card isn't a dead end).
        'connectors:list-authored-pending',
        'connectors:activate-authored',
        'connectors:clear-authored',
        // TASK-808 — TRANSITIONAL. "Set default" is retired; these two let
        // @ax/agents convert each row that still carries the flag into explicit
        // per-agent attachments at boot, then clear it. Host-internal: no HTTP /
        // IPC surface. Delete with the column once every database has converted.
        'connectors:list-legacy-defaults',
        'connectors:clear-legacy-default',
        // TASK-697 — the read-authorization seam @ax/credentials consults before
        // it lets an `account:` ref fall through to the GLOBAL (company-wide)
        // scope. Registered under the credentials namespace on purpose (same
        // precedent as @ax/mcp-oauth's `credentials:resolve:mcp-oauth`): the seam
        // belongs to the vault, this plugin only supplies the answer because it
        // owns the ref -> connector -> keyMode mapping. See credential-authz.ts.
        'credentials:authorize-global:account',
        // TASK-711 — the agent-scope twin: may this user read the credential
        // stored ON an agent for an `account:` ref (and so, may a team-agent
        // sign-in be stored there)? TASK-788: a read also needs the connector
        // on the agent (asks the undeclared `agents:resolve`, see above).
        // See credential-authz.ts.
        'credentials:authorize-agent:account',
      ],
      // database:get-instance is hard — we run our own migration on init.
      calls,
      // credentials:delete is a SOFT dep: deleting a connector purges its stored
      // key(s) so a secret never lingers with no UI home. A preset without
      // @ax/credentials still deletes the connector — it just can't purge the key.
      optionalCalls: [
        {
          hook: 'credentials:delete',
          degradation:
            'the connector is deleted but its stored key is left in the vault (no @ax/credentials provider to purge it)',
        },
        {
          hook: 'credentials:purge-account',
          degradation:
            "the connector is deleted but agents' sign-ins for it are left in the vault (a later connector with the same id could read them)",
        },
        // TASK-737 — the connector editor's per-tool permissions routes. The
        // values live in @ax/tool-policy: without it the routes answer 503
        // (the editor says it can't load them).
        //
        // The tool LIST comes from `connectors:describe-tools` (@ax/mcp-client),
        // which is deliberately NOT declared here, neither in `calls` nor in
        // `optionalCalls`: @ax/mcp-client already calls `connectors:resolve`,
        // so a declared edge back would close a plugin call-graph cycle
        // (connectors -> mcp-client -> connectors) and bootstrap would refuse
        // every preset that loads both. It is `bus.hasService`-guarded at call
        // time (same precedent as `credentials:authorize-global:account`);
        // without it the route answers `status: 'unknown'` and the saved
        // defaults alone.
        {
          hook: 'tool-policy:get-connector-defaults',
          degradation:
            'the connector editor cannot show per-tool permissions (the route answers 503)',
        },
        {
          hook: 'tool-policy:set-connector-defaults',
          degradation:
            'the connector editor cannot save per-tool permissions (the route answers 503)',
        },
        // TASK-758 — an edit that points a kept-name server at a new endpoint
        // resets that server's stored per-tool choices FIRST and is refused if
        // the reset throws. Absent, there are no stored choices to carry over.
        {
          hook: 'tool-policy:reset-tool-namespaces',
          degradation:
            'an endpoint change saves without a reset; with no per-tool-permission provider there are no stored choices for it to carry over',
        },
        // TASK-809 — this plugin owns each server's auth type, so it tells
        // tool-policy which ceiling applies per tool namespace: OAuth servers
        // get none (people choose per agent), API-key / no-auth servers keep
        // the admin ceiling. Called around every connector write and once at
        // boot (reconcile). See `syncCeilingSources`.
        {
          hook: 'tool-policy:set-ceiling-sources',
          degradation:
            'no per-tool-permission provider is loaded, so there is no admin ceiling to switch on or off; connectors save normally',
        },
        {
          hook: 'auth:get-user',
          degradation:
            'workspace-keyed (company) connector credentials are never authorized for reading, because the connector owner cannot be proven to be an admin; personal keys are unaffected (fail closed)',
        },
      ],
      // TASK-718 — `@ax/agents` fires `agents:deleted` after the agent row is
      // gone. `connectors_v1_authored` has no FK to it, so this plugin deletes
      // its own drafts keyed on the agent.
      subscribes: ['agents:deleted'],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });
      const { db: shared } = await bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance',
        initCtx,
        {},
      );
      db = shared as Kysely<ConnectorDatabase>;
      await runConnectorsMigration(db);
      // stdio MCP servers were removed (2026-10-04). Sweep stored ones BEFORE any
      // service is registered: the narrowed schema refuses them, and one such
      // row would make every list over its owner throw.
      await sweepStdioConnectors(db, bus, initCtx);
      const localStore = createConnectorStore(db);
      _store = localStore;
      const localAuthored = createAuthoredConnectorsStore(db);
      _authored = localAuthored;

      bus.registerService<ListInput, ListOutput>(
        'connectors:list',
        PLUGIN_NAME,
        async (_ctx, input) => listConnectors(localStore, input),
        { returns: ListOutputSchema },
      );

      bus.registerService<ListLegacyDefaultsInput, ListLegacyDefaultsOutput>(
        'connectors:list-legacy-defaults',
        PLUGIN_NAME,
        async () => ({ connectors: await localStore.listLegacyDefaults() }),
        { returns: ListLegacyDefaultsOutputSchema },
      );

      bus.registerService<ClearLegacyDefaultInput, ClearLegacyDefaultOutput>(
        'connectors:clear-legacy-default',
        PLUGIN_NAME,
        async (_ctx, input) => clearLegacyDefault(localStore, input),
        { returns: ClearLegacyDefaultOutputSchema },
      );

      bus.registerService<ListEffectiveInput, ListEffectiveOutput>(
        'connectors:list-effective',
        PLUGIN_NAME,
        async (_ctx, input) => listEffectiveConnectors(localStore, input),
        { returns: ListEffectiveOutputSchema },
      );

      bus.registerService<GetInput, GetOutput>(
        'connectors:get',
        PLUGIN_NAME,
        async (_ctx, input) => getConnector(localStore, input),
        { returns: GetOutputSchema },
      );

      bus.registerService<UpsertInput, UpsertOutput>(
        'connectors:upsert',
        PLUGIN_NAME,
        async (ctx, input) => upsertConnector(localStore, bus, ctx, input),
        { returns: UpsertOutputSchema },
      );

      bus.registerService<DeleteInput, DeleteOutput>(
        'connectors:delete',
        PLUGIN_NAME,
        async (ctx, input) => deleteConnector(localStore, bus, ctx, input),
        { returns: DeleteOutputSchema },
      );

      bus.registerService<ResolveInput, ResolveOutput>(
        'connectors:resolve',
        PLUGIN_NAME,
        async (_ctx, input) => resolveConnector(localStore, input),
        { returns: ResolveOutputSchema },
      );

      bus.registerService<ToolLabelsInput, ToolLabelsOutput>(
        'connectors:tool-labels',
        PLUGIN_NAME,
        async (ctx, input) => toolLabels(localStore, bus, ctx, input),
        { returns: ToolLabelsOutputSchema },
      );

      bus.registerService<InstallAuthoredInput, InstallAuthoredOutput>(
        'connectors:install-authored',
        PLUGIN_NAME,
        // The live registry store is passed alongside the authored-draft store so
        // the handler can dedup a re-propose against an already-active connector
        // (TASK-114) — both stores are this plugin's, so no cross-plugin import.
        // bus+ctx are threaded so a fresh PENDING write fires `connectors:proposed`
        // (the orchestrator surfaces the approval card at proposal time).
        async (ctx, input) =>
          installAuthoredConnector(localAuthored, localStore, bus, ctx, input),
        { returns: InstallAuthoredOutputSchema },
      );

      bus.registerService<ListAuthoredInput, ListAuthoredOutput>(
        'connectors:list-authored',
        PLUGIN_NAME,
        async (_ctx, input) => listAuthoredConnectors(localAuthored, input),
        { returns: ListAuthoredOutputSchema },
      );

      bus.registerService<ListAuthoredPendingInput, ListAuthoredPendingOutput>(
        'connectors:list-authored-pending',
        PLUGIN_NAME,
        // The registry store is passed so the handler can drop any pending draft
        // whose id is already an active registry connector for this owner (a
        // belt-and-suspenders against showing an already-connected service on the
        // "Proposed" shelf). Both stores are this plugin's — no cross-plugin import.
        async (_ctx, input) =>
          listAuthoredPendingForUser(localAuthored, localStore, input),
        { returns: ListAuthoredPendingOutputSchema },
      );

      bus.registerService<ActivateAuthoredInput, ActivateAuthoredOutput>(
        'connectors:activate-authored',
        PLUGIN_NAME,
        async (_ctx, input) => activateAuthoredConnector(localAuthored, input),
        { returns: ActivateAuthoredOutputSchema },
      );

      bus.registerService<ClearAuthoredInput, ClearAuthoredOutput>(
        'connectors:clear-authored',
        PLUGIN_NAME,
        async (_ctx, input) => clearAuthoredConnector(localAuthored, input),
        { returns: ClearAuthoredOutputSchema },
      );

      bus.registerService<AuthorizeGlobalInput, AuthorizeGlobalOutput>(
        'credentials:authorize-global:account',
        PLUGIN_NAME,
        async (ctx, input) => authorizeGlobalAccountRead(localStore, bus, ctx, input),
        { returns: AuthorizeGlobalOutputSchema },
      );

      bus.registerService<AuthorizeAgentInput, AuthorizeAgentOutput>(
        'credentials:authorize-agent:account',
        PLUGIN_NAME,
        async (ctx, input) => authorizeAgentAccountRead(localStore, bus, ctx, input),
        { returns: AuthorizeAgentOutputSchema },
      );

      // TASK-98 — the connector registry's HTTP bridge. Mounted only when the
      // host configures it (the k8s preset) and an http-server is present. The
      // routes delegate straight back to the `connectors:*` hooks above.
      //
      // TASK-129 — the user-authoring bridge (`/settings/connectors`) mounts on
      // the SAME http-server gate. It's the locked-down sibling of the admin
      // registry routes (forces private, rejects admin-only fields, catalog/
      // shared read-only) — both delegate to the same `connectors:*` hooks.
      if (mountAdminRoutes) {
        const adminUnregisters = await registerAdminConnectorRoutes(bus, initCtx);
        unregisterRoutes.push(...adminUnregisters);
        const userUnregisters = await registerUserConnectorRoutes(bus, initCtx);
        unregisterRoutes.push(...userUnregisters);
      }

      // TASK-718 — a deleted agent's authored connector drafts must go with it.
      // Fired AFTER the agent row is gone; payload is `{ agentId, ownerId,
      // ownerType }` and only `agentId` is needed (a team agent has drafts for
      // several owners, so the purge keys on the agent alone). K10: a subscriber
      // must never propagate — log and swallow. A failure leaves the drafts in
      // place and a re-delivered event retries cleanly.
      bus.subscribe<{ agentId?: unknown } | null>(
        'agents:deleted',
        PLUGIN_NAME,
        async (ctx, payload) => {
          const agentId = payload?.agentId;
          if (typeof agentId !== 'string' || agentId.length === 0) {
            ctx.logger.warn('connectors_purge_invalid_agents_deleted_payload', {
              agentIdType: typeof agentId,
            });
            return undefined;
          }
          try {
            const { removed } = await localAuthored.deleteAllForAgent(agentId);
            ctx.logger.info('connectors_purged_for_deleted_agent', { agentId, removed });
          } catch (err) {
            ctx.logger.error('connectors_purge_for_deleted_agent_failed', {
              agentId,
              err: err instanceof Error ? err.message : String(err),
            });
          }
          return undefined;
        },
      );

      // TASK-809 — boot reconcile. Awaited so a fresh boot has converged
      // before the first turn, but it never fails init (see the function).
      await reconcileCeilingSources(localStore, bus, initCtx);
    },

    async shutdown() {
      // Tear down the admin routes first so a re-init (tests) doesn't trip
      // duplicate-route.
      for (const unregister of unregisterRoutes.splice(0)) {
        try {
          unregister();
        } catch {
          // best-effort — a route already gone is fine.
        }
      }
      // The shared db handle is owned by @ax/database-postgres; don't close it
      // here. Drop our references so a re-init doesn't read a stale store.
      db = undefined;
      _store = undefined;
      _authored = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Hook handlers.
// ---------------------------------------------------------------------------

async function listConnectors(
  store: ConnectorStore,
  input: ListInput,
): Promise<ListOutput> {
  const userId = requireUserId(input.userId, 'connectors:list');
  const connectors = await store.listForUser(userId);
  return { connectors };
}

/**
 * TASK-808 — the retired default flag's one write: clear it once its attachments
 * exist. Both identity fields are validated at the boundary; the owner id is an
 * opaque non-empty string (it names a row, it does not authenticate anyone).
 */
async function clearLegacyDefault(
  store: ConnectorStore,
  input: ClearLegacyDefaultInput,
): Promise<ClearLegacyDefaultOutput> {
  const hookName = 'connectors:clear-legacy-default';
  const ownerUserId = requireUserId(input.ownerUserId, hookName, 'ownerUserId');
  const connectorId = validateConnectorId(input.connectorId);
  return { cleared: await store.clearLegacyDefault(ownerUserId, connectorId) };
}

/** `connectors:inventory-tool-titles`' own per-call id cap (@ax/mcp-client). */
const TOOL_TITLES_BATCH_MAX = 500;

async function toolLabels(
  store: ConnectorStore,
  bus: HookBus,
  ctx: AgentContext,
  input: ToolLabelsInput,
): Promise<ToolLabelsOutput> {
  const userId = requireUserId(input.userId, 'connectors:tool-labels');
  const available = await store.listAvailable(userId);
  const connectors: ToolLabelsOutput['connectors'] = [];
  for (const { connector, ownerUserId } of available) {
    // Same derivation as `connectors:resolve` (ROW owner, not the caller), so
    // a namespace seen in a transcript or on a held call maps back here.
    for (const entry of deriveToolNamespaces(ownerUserId, connector)) {
      connectors.push({
        toolNamespace: entry.toolNamespace,
        connectorId: connector.id,
        name: connector.name,
      });
    }
  }
  if (connectors.length === 0) return { connectors };

  // TASK-753 — fold in the server's own tool titles from the inventory cache.
  // The inventory read caps one batch at 500 ids; past that, the rest are
  // named by their humanized tool names rather than failing every title.
  const titles = await cachedToolTitles(bus, ctx, userId, [
    ...new Set(connectors.map((c) => c.connectorId)),
  ].slice(0, TOOL_TITLES_BATCH_MAX));
  for (const c of connectors) {
    // A title is only ever attached under the namespace its toolKey names AND
    // the connector it was cached for, so a row cannot relabel another
    // connector's tool.
    const prefix = `mcp.${c.toolNamespace}.`;
    const tools: Array<{ name: string; title: string }> = [];
    for (const t of titles) {
      if (t.connectorId !== c.connectorId || !t.toolKey.startsWith(prefix)) continue;
      const name = t.toolKey.slice(prefix.length);
      if (name.length > 0) tools.push({ name, title: t.title });
    }
    if (tools.length > 0) c.tools = tools;
  }
  return { connectors };
}

/**
 * `connectors:inventory-tool-titles` (@ax/mcp-client), cache-only. Not
 * declared in the manifest — @ax/mcp-client already calls
 * `connectors:resolve`, so a declared edge back would close a plugin
 * call-graph cycle (same reason as `connectors:describe-tools`; see the
 * manifest). `hasService`-guarded, and a failed read costs the titles, never
 * the labels: callers fall back to the humanized tool name.
 */
async function cachedToolTitles(
  bus: HookBus,
  ctx: AgentContext,
  userId: string,
  connectorIds: string[],
): Promise<Array<{ connectorId: string; toolKey: string; title: string }>> {
  const hook = 'connectors:inventory-tool-titles';
  if (!bus.hasService(hook)) return [];
  try {
    const out = await bus.call<
      { userId: string; connectorIds: string[] },
      { titles?: unknown }
    >(hook, ctx, { userId, connectorIds });
    if (!Array.isArray(out?.titles)) return [];
    return (out.titles as unknown[]).flatMap((raw) => {
      const t = raw as { connectorId?: unknown; toolKey?: unknown; title?: unknown } | null;
      return t !== null &&
        typeof t === 'object' &&
        typeof t.connectorId === 'string' &&
        typeof t.toolKey === 'string' &&
        typeof t.title === 'string'
        ? [{ connectorId: t.connectorId, toolKey: t.toolKey, title: t.title }]
        : [];
    });
  } catch (err) {
    ctx.logger.warn('connectors_tool_titles_read_failed', {
      err: err instanceof Error ? err : new Error(String(err)),
    });
    return [];
  }
}

async function getConnector(
  store: ConnectorStore,
  input: GetInput,
): Promise<GetOutput> {
  const hookName = 'connectors:get';
  const userId = requireUserId(input.userId, hookName);
  const connectorId = validateConnectorId(input.connectorId);
  const available = await store.getAvailableById(userId, connectorId);
  if (available === null) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName,
      message: `connector '${connectorId}' not found`,
    });
  }
  return { connector: available.connector, ownerUserId: available.ownerUserId };
}

async function upsertConnector(
  store: ConnectorStore,
  bus: HookBus,
  ctx: AgentContext,
  input: UpsertInput,
): Promise<UpsertOutput> {
  const hookName = 'connectors:upsert';
  const userId = requireUserId(input.userId, hookName);
  // Validate every field at the boundary so a malformed value surfaces as a
  // structured invalid-payload error rather than a raw pg CHECK violation. The
  // `capabilities` spec is parsed against the canonical schema (untrusted —
  // stored opaque, never interpreted).
  const connectorId = validateConnectorId(input.connectorId);
  const name = validateName(input.name);
  const description = validateOptionalText(
    input.description,
    'description',
    DESCRIPTION_MAX,
  );
  const usageNote = validateOptionalText(
    input.usageNote,
    'usageNote',
    USAGE_NOTE_MAX,
  );
  const keyMode = validateKeyMode(input.keyMode);
  const visibility = validateVisibility(input.visibility);
  const capabilities = validateCapabilities(input.capabilities);
  // TASK-712 — an OAuth slot's clientSecretRef may name only this connector's own
  // account key. Checked on WRITE only (the read schema must keep parsing a legacy
  // row so its owner can open and fix it); @ax/mcp-oauth re-checks at `begin`.
  assertOwnClientSecretRefs(connectorId, capabilities);
  // TASK-752 — read the live row's servers BEFORE the write, so a rename can be
  // told apart from an add (the namespace is a hash of the server name).
  const prior = await store.getByIdNotDeleted(userId, connectorId);
  // TASK-827 — who supplies the key is fixed for a live connector. A switch
  // would leave the old mode's key behind (orphaned), and a personal key left
  // behind would SHADOW the shared one: credentials:get walks
  // user -> agent -> global. Refused before anything is written; a delete
  // purges the keys, so a deleted id may come back in the other mode.
  if (prior !== null && prior.keyMode !== keyMode) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message:
        'keyMode can’t change on an existing connector: create a new connector instead',
    });
  }
  if (prior !== null) {
    await resetMovedEndpoints(bus, ctx, userId, connectorId, prior, capabilities, hookName);
  }
  // TASK-809 — the ceiling source of each server, from the NEW capabilities
  // (namespaces derive from the row owner, which is `userId` here).
  //
  // Ordering: `connector` entries go BEFORE the write and refuse the edit if
  // they fail; `agent` entries go AFTER the write (and after the namespace
  // event) and only warn if they fail. Every failure lands on the CAPPED side:
  //   - pre-write fails → nothing saved, the old row and its ceiling stand;
  //   - pre-write lands, write fails → a server re-capped that may not need
  //     it yet (at worst Ask first), never an un-capped one;
  //   - post-write fails → the OAuth server keeps its PRIOR ceiling until the
  //     next save or boot reconcile: Ask first where no admin default exists,
  //     but an old admin default (Allow included, e.g. after an API-key → OAuth
  //     switch) still applies until then — never looser than before the save.
  // Sending `agent` before a commit that then fails would un-cap a server that
  // is still API-key in the stored row — the one outcome that grants reach.
  const sources = ceilingSourcesFor(userId, { id: connectorId, capabilities });
  const capped = sources.filter((e) => e.source === 'connector');
  const uncapped = sources.filter((e) => e.source === 'agent');
  try {
    await syncCeilingSources(bus, ctx, connectorId, capped);
  } catch (err) {
    ctx.logger.error('connectors_ceiling_sources_failed', {
      connectorId,
      phase: 'before-write',
      err: err instanceof Error ? err.message : String(err),
    });
    throw new PluginError({
      code: TOOL_PERMISSIONS_RESET_FAILED,
      plugin: PLUGIN_NAME,
      hookName,
      message:
        'couldn\'t update the tool permissions of this connector\'s servers, so the edit was not saved',
      cause: err,
    });
  }
  const { connector, created } = await store.upsert({
    userId,
    connectorId,
    name,
    description,
    usageNote,
    keyMode,
    visibility,
    capabilities,
    requireUniqueId: input.requireUniqueId === true,
  });
  if (prior !== null) {
    await announceNamespaceChange(bus, ctx, userId, connectorId, prior, connector);
  }
  try {
    await syncCeilingSources(bus, ctx, connectorId, uncapped);
  } catch (err) {
    // The edit is committed; the OAuth server keeps its PRIOR ceiling until
    // the next save or boot reconcile — Ask first for a tool with no admin
    // default, but an admin default set while the server was API-key (Allow
    // included) stays live until then. Never looser than before this save.
    ctx.logger.warn('connectors_ceiling_sources_failed', {
      connectorId,
      phase: 'after-write',
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return { connector, created };
}

const SET_CEILING_SOURCES_HOOK = 'tool-policy:set-ceiling-sources';

/**
 * TASK-809 — tell tool-policy which ceiling applies to these namespaces.
 * No-op for an empty list or when no provider is loaded (then there is no
 * admin ceiling to switch). Throws whatever the provider throws.
 */
async function syncCeilingSources(
  bus: HookBus,
  ctx: AgentContext,
  connectorId: string,
  namespaces: CeilingSourceEntry[],
): Promise<void> {
  if (namespaces.length === 0 || !bus.hasService(SET_CEILING_SOURCES_HOOK)) return;
  await bus.call<SetCeilingSourcesInputLike, SetCeilingSourcesOutputLike>(
    SET_CEILING_SOURCES_HOOK,
    ctx,
    { connectorId, namespaces },
  );
}

/**
 * TASK-809 — at boot, re-send every live connector's ceiling sources (all of
 * them, both kinds). Idempotent; this is what purges stale admin defaults on
 * OAuth connectors written before the split, and heals a post-write call that
 * failed. Per-connector failures are logged and skipped; it never throws, so a
 * bad row or a down verdict store can't stop the host from booting.
 */
async function reconcileCeilingSources(
  store: ConnectorStore,
  bus: HookBus,
  ctx: AgentContext,
): Promise<void> {
  if (!bus.hasService(SET_CEILING_SOURCES_HOOK)) return;
  let rows: Awaited<ReturnType<ConnectorStore['listAllLive']>>;
  try {
    rows = await store.listAllLive((connectorId, err) => {
      ctx.logger.warn('connectors_ceiling_sources_reconcile_skipped_row', {
        connectorId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  } catch (err) {
    ctx.logger.warn('connectors_ceiling_sources_reconcile_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  for (const row of rows) {
    const sources = ceilingSourcesFor(row.ownerUserId, {
      id: row.connectorId,
      capabilities: row.capabilities,
    });
    try {
      await syncCeilingSources(bus, ctx, row.connectorId, sources);
    } catch (err) {
      ctx.logger.warn('connectors_ceiling_sources_failed', {
        connectorId: row.connectorId,
        phase: 'boot-reconcile',
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** The hook that must succeed before an endpoint change commits (TASK-758). */
const RESET_TOOL_NAMESPACES_HOOK = 'tool-policy:reset-tool-namespaces';

/**
 * TASK-758 — a server that keeps its name but now points at a different
 * endpoint keeps its tool namespace, so whatever Allow / Ask first / Deny
 * choices are stored under it would apply to a service nobody chose them for.
 * Reset them BEFORE the edit commits, and refuse the edit if the reset fails:
 * the old endpoint stays in place (its choices were made for it), the editor
 * hears why, and Save tries the whole thing again.
 *
 * Why not the `connectors:tool-namespaces-changed` event alone: `HookBus.fire`
 * isolates subscriber failures — a throw is logged and the chain goes on — so
 * the firer cannot tell a reset that landed from one that did not. A service
 * call can. The post-commit event still fires (it carries renames and removed
 * servers, and repeats this reset for anything written in between); this is
 * the part that has to be all-or-nothing.
 *
 * Fail direction: a reset that lands and then an upsert that fails leaves the
 * OLD endpoint at Ask first — choices lost, nothing granted. With no
 * per-tool-permission provider loaded there are no stored choices to carry
 * over, so there is nothing to reset.
 */
async function resetMovedEndpoints(
  bus: HookBus,
  ctx: AgentContext,
  userId: string,
  connectorId: string,
  before: Connector,
  afterCapabilities: Capabilities,
  hookName: string,
): Promise<void> {
  const liveNames = new Set(afterCapabilities.mcpServers.map((s) => s.name));
  // `removed` holds both vanished servers and kept-name endpoint changes; only
  // the second kind still has callers, so only it must be gated. A vanished
  // server's namespace is left to the best-effort post-commit purge.
  const moved = diffToolNamespaces(
    userId,
    connectorId,
    before.capabilities.mcpServers,
    afterCapabilities.mcpServers,
  ).removed.filter((e) => liveNames.has(e.server));
  if (moved.length === 0 || !bus.hasService(RESET_TOOL_NAMESPACES_HOOK)) return;
  try {
    await bus.call<ResetToolNamespacesInputLike, unknown>(RESET_TOOL_NAMESPACES_HOOK, ctx, {
      toolNamespaces: moved.map((e) => e.toolNamespace),
    });
  } catch (err) {
    ctx.logger.error('connectors_endpoint_tool_permissions_reset_failed', {
      connectorId,
      servers: moved.map((e) => e.server),
      err: err instanceof Error ? err.message : String(err),
    });
    throw new PluginError({
      code: TOOL_PERMISSIONS_RESET_FAILED,
      plugin: PLUGIN_NAME,
      hookName,
      message:
        'couldn\'t reset the tool permissions of a server whose address changed, so the edit was not saved',
      cause: err,
    });
  }
}

/**
 * Tell subscribers which tool namespaces an edit moved (TASK-752), so per-tool
 * state keyed on them (admin defaults, agent choices — `@ax/tool-policy`)
 * follows a renamed server and goes with a removed one instead of being
 * orphaned — and is dropped for a server that kept its name but now points at
 * a different endpoint (TASK-755), so no verdict carries over to a service
 * nobody chose it for. `userId` is the row owner (the upsert is keyed on it),
 * so these are the namespaces `connectors:resolve` handed out. Best-effort like
 * `connectors:deleted`: the edit is committed, and a failed fire must not undo
 * it. For a rename or a removal the cost of a miss is orphaned rows under a
 * namespace nothing calls, which grant nothing. For an ENDPOINT change a miss
 * here would leave the old verdicts applying to the new address, which is why
 * that reset is not left to this event: `resetMovedEndpoints` runs it BEFORE
 * the write and refuses the edit if it fails (TASK-758). The repeat here only
 * catches a choice written between that reset and the commit.
 */
async function announceNamespaceChange(
  bus: HookBus,
  ctx: AgentContext,
  userId: string,
  connectorId: string,
  before: Connector,
  after: Connector,
): Promise<void> {
  const change = diffToolNamespaces(
    userId,
    connectorId,
    before.capabilities.mcpServers,
    after.capabilities.mcpServers,
  );
  if (change.renamed.length === 0 && change.removed.length === 0) return;
  const event: ConnectorToolNamespacesChangedEvent = { connectorId, ...change };
  try {
    await bus.fire('connectors:tool-namespaces-changed', ctx, event);
  } catch (err) {
    ctx.logger.warn('connectors_tool_namespaces_changed_event_failed', {
      connectorId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Exported for tests only (a store seam the hook path cannot reach). */
export async function deleteConnector(
  store: Pick<ConnectorStore, 'getByIdNotDeleted' | 'softDelete' | 'hasLiveSharedById'>,
  bus: HookBus,
  ctx: AgentContext,
  input: DeleteInput,
): Promise<DeleteOutput> {
  const hookName = 'connectors:delete';
  const userId = requireUserId(input.userId, hookName);
  const connectorId = validateConnectorId(input.connectorId);
  // Load BEFORE soft-delete so we can derive the credential plan — getByIdNotDeleted
  // returns null once the row is tombstoned.
  const connector = await store.getByIdNotDeleted(userId, connectorId);
  const deleted = await store.softDelete(userId, connectorId);
  // Reclaim the connector's keys and announce the removal (purge.ts) — only when
  // a LIVE row was actually removed here. A delete of an absent / already-deleted
  // connector (or one that lost a race to a concurrent delete) purges and
  // announces nothing.
  if (deleted && connector !== null) {
    // Agent sign-ins are keyed `account:<id>` with no owner: wipe them only for
    // an authorized (admin) delete of a SHARED connector AND when no other live
    // shared connector with this id survives to read them. Checked AFTER the
    // soft-delete. The row is already gone, so a failing check must not reject
    // the delete (a retry would find nothing to purge): log it and keep the
    // rows — unknown means "maybe a survivor".
    let survivor = true;
    let survivorCheckFailed = false;
    if (connector.visibility === 'shared' && input.purgeGlobal === true) {
      try {
        survivor = await store.hasLiveSharedById(connectorId);
      } catch (err) {
        survivorCheckFailed = true;
        ctx.logger.warn('connectors_delete_survivor_check_failed', {
          connectorId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await purgeConnectorState(bus, ctx, userId, connector, {
      purgeGlobal: input.purgeGlobal === true,
      purgeAgentSignIns: input.purgeGlobal === true && !survivor,
      agentSignInsSkipReason:
        input.purgeGlobal !== true
          ? 'not-authorized'
          : survivorCheckFailed
            ? 'survivor-check-failed'
            : 'same-id-survives',
    });
  }

  return { deleted };
}

async function resolveConnector(
  store: ConnectorStore,
  input: ResolveInput,
): Promise<ResolveOutput> {
  const hookName = 'connectors:resolve';
  const userId = requireUserId(input.userId, hookName);
  const connectorId = validateConnectorId(input.connectorId);
  const available = await store.getAvailableById(userId, connectorId);
  if (available === null) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName,
      message: `connector '${connectorId}' not found`,
    });
  }
  const { connector, ownerUserId } = available;
  // The mechanism-agnostic spec descriptor the future router routes on — id +
  // keyMode + the opaque capabilities fill. Deliberately NOT the management
  // metadata (name/description): the resolve surface can evolve (union shared +
  // catalog) without widening the management read. `usageNote` IS carried,
  // though — it's the model-facing "how to use me" text the orchestrator folds
  // into the connector's SKILL.md body, and resolve is the only path that
  // reaches it for owner-owned / per-agent-attached connectors. Omitting it
  // silently stripped every such connector's instructions (the agent saw only
  // the generic "...MCP servers wired..." fallback).
  //
  // TASK-96 — reach-by-attachment: the derived credentialPlan maps the
  // connector's keyMode to the credential SCOPE each slot's key attaches to
  // (`personal` → `user` per-user vault, `workspace` → `global` company key) and
  // the deterministic `account:<service>` ref. requiresSharedKeyConsent gates the
  // "act as you" consent moment (workspace mode or a shared connector). Reach
  // derives PURELY from this scope — no visibility flag on the credential itself.
  // The plan is also what the vault consults to decide who may READ a `global`
  // key (TASK-697, credential-authz.ts): only an admin's workspace-keyed connector.
  //
  // ZERO-REACH (TASK-94): resolve reads ONLY the LIVE connectors table. A
  // pending authored draft lives in `connectors_v1_authored` and is therefore
  // never returned here — an unapproved authored connector grants no reach.
  return {
    id: connector.id,
    keyMode: connector.keyMode,
    usageNote: connector.usageNote,
    capabilities: connector.capabilities,
    credentialPlan: deriveCredentialPlan(connector),
    requiresSharedKeyConsent: requiresSharedKeyConsent(connector),
    // TASK-734 — keyed by the ROW owner (`ownerUserId`), NOT the
    // requesting `userId`: a shared connector resolved by a non-owner must
    // yield the same namespace the owner gets, or one connector would present
    // several tool names (and several permission toolKeys).
    toolNamespaces: deriveToolNamespaces(ownerUserId, connector),
  };
}

// ---------------------------------------------------------------------------
// Authored-connector draft handlers (TASK-94). These mirror the authored-skill
// flow: install persists a PENDING draft; the orchestrator fires ONE approval
// card from the proposal; on a human grant the orchestrator writes
// connector-subject approved-caps rows (the TASK-93 wall) + calls activate.
// ---------------------------------------------------------------------------

function requireScope(
  input: { ownerUserId: unknown; agentId: unknown },
  hookName: string,
): { ownerUserId: string; agentId: string } {
  const ownerUserId = requireField(input.ownerUserId, 'ownerUserId', hookName);
  const agentId = requireField(input.agentId, 'agentId', hookName);
  return { ownerUserId, agentId };
}

function requireField(value: unknown, field: string, hookName: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `${field} must be a non-empty string`,
    });
  }
  return value;
}

/**
 * Assemble + validate a canonical {@link Capabilities} proposal from the flat
 * authored-install args. Slot NAMES are re-checked against SLOT_RE at the
 * boundary (defense-in-depth on untrusted model output); the whole assembled
 * spec is then parsed against the canonical schema (the same don't-trust-input
 * posture the store uses on upsert/read).
 */
function assembleProposal(input: InstallAuthoredInput): Capabilities {
  const hosts = Array.isArray(input.hosts) ? input.hosts : [];
  const rawSlots: AuthoredConnectorSlot[] = Array.isArray(input.slots)
    ? input.slots
    : [];
  const credentials = rawSlots.map((s) => ({
    slot: validateSlotName(s?.slot),
    kind: 'api-key' as const,
    ...(typeof s?.description === 'string' ? { description: s.description } : {}),
    // No share-by-service `account` tag — each connector owns its own key, keyed
    // by the connector id. Any `account` on untrusted authored input is dropped.
  }));
  const mcpServers: McpServerSpec[] = Array.isArray(input.mcpServers)
    ? input.mcpServers
    : [];
  const packages = {
    npm: Array.isArray(input.packages?.npm) ? input.packages!.npm : [],
    pypi: Array.isArray(input.packages?.pypi) ? input.packages!.pypi : [],
  };
  // validateCapabilities re-parses the whole assembled spec against the
  // canonical schema — a malformed host / mcpServer surfaces as invalid-payload.
  return validateCapabilities({
    allowedHosts: hosts,
    credentials,
    mcpServers,
    packages,
  });
}

async function installAuthoredConnector(
  store: AuthoredConnectorsStore,
  registry: ConnectorStore,
  bus: HookBus,
  ctx: AgentContext,
  input: InstallAuthoredInput,
): Promise<InstallAuthoredOutput> {
  const hookName = 'connectors:install-authored';
  const { ownerUserId, agentId } = requireScope(input, hookName);
  const connectorId = validateConnectorId(input.connectorId);
  const name = validateName(input.name);
  const usageNote = validateOptionalText(
    input.usageNote,
    'usageNote',
    USAGE_NOTE_MAX,
  );
  const keyMode = validateKeyMode(input.keyMode);

  // TASK-114 — re-propose dedup. TASK-113 made approval PROMOTE the authored
  // draft into the LIVE registry (`connectors_v1_connectors`). A warm-turn
  // re-propose of an already-approved connector would otherwise reset the draft
  // back to `pending` and re-fire the orchestrator's upfront approval card every
  // turn (the card path keys off a pending draft). If an equivalent connector is
  // already active in the owner's registry, the install is a NO-OP: we write
  // nothing and report `active` so the model learns it already works.
  //
  // Equivalence rule (simplest-correct, per the card's scoping note): an active
  // (not-deleted) registry connector OWNED BY THE SAME USER with the SAME id.
  // Pure id match — not a capability-fill comparison. The check is owner-scoped
  // (getByIdNotDeleted filters on owner), so it never dedups against a different
  // user's connector. SECURITY: this only short-circuits when an ALREADY-APPROVED
  // (human-gated) connector exists — it can never let a re-propose escalate or
  // bypass approval, and grants zero new reach (it writes nothing).
  const alreadyActive = await registry.getByIdNotDeleted(ownerUserId, connectorId);
  if (alreadyActive !== null) {
    return { connectorId, status: 'active' };
  }

  const proposal = assembleProposal(input);
  await store.upsert({
    ownerUserId,
    agentId,
    connectorId,
    name,
    usageNote,
    keyMode,
    proposal,
  });

  // Notify subscribers that a PENDING draft was just written so the
  // chat-orchestrator can fire the approval card at proposal time (mid-turn) —
  // the user sees it on the current turn rather than only at the start of their
  // NEXT message. Storage-agnostic ids only; no capability/secret rides this
  // event (the orchestrator re-resolves the draft via connectors:list-authored).
  // Best-effort: the bus isolates subscriber throws, but a fire failure must not
  // fail the install — the draft is persisted, and the turn-start card path
  // remains a backstop. NOT fired on the alreadyActive no-op above (no new draft).
  try {
    await bus.fire('connectors:proposed', ctx, {
      ownerUserId,
      agentId,
      connectorId,
      status: 'pending',
    });
  } catch (err) {
    ctx.logger.warn('connectors_proposed_fire_failed', {
      connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { connectorId, status: 'pending' };
}

async function listAuthoredConnectors(
  store: AuthoredConnectorsStore,
  input: ListAuthoredInput,
): Promise<ListAuthoredOutput> {
  const { ownerUserId, agentId } = requireScope(input, 'connectors:list-authored');
  const drafts = await store.list(ownerUserId, agentId);
  return {
    drafts: drafts.map((d) => ({
      connectorId: d.connectorId,
      name: d.name,
      usageNote: d.usageNote,
      keyMode: d.keyMode,
      status: d.status,
      proposal: d.proposal,
    })),
  };
}

async function listAuthoredPendingForUser(
  store: AuthoredConnectorsStore,
  registry: ConnectorStore,
  input: ListAuthoredPendingInput,
): Promise<ListAuthoredPendingOutput> {
  const userId = requireUserId(input.userId, 'connectors:list-authored-pending');
  const pending = await store.listPendingForUser(userId);
  // Drop any pending draft whose id is already an active (not-deleted) registry
  // connector for THIS owner — it's already connectable on the normal shelves,
  // so it shouldn't also appear as "proposed". (Normally impossible: approval
  // flips the draft to `active` AND the TASK-114 dedup blocks a re-propose for an
  // already-registered id. Cheap defense against any drift.)
  const drafts: ListAuthoredPendingOutput['drafts'] = [];
  for (const d of pending) {
    const live = await registry.getByIdNotDeleted(userId, d.connectorId);
    if (live !== null) continue;
    drafts.push({
      connectorId: d.connectorId,
      agentId: d.agentId,
      name: d.name,
      usageNote: d.usageNote,
      keyMode: d.keyMode,
      status: d.status,
      proposal: d.proposal,
    });
  }
  return { drafts };
}

async function activateAuthoredConnector(
  store: AuthoredConnectorsStore,
  input: ActivateAuthoredInput,
): Promise<ActivateAuthoredOutput> {
  const { ownerUserId, agentId } = requireScope(
    input,
    'connectors:activate-authored',
  );
  const connectorId = validateConnectorId(input.connectorId);
  return store.activate({ ownerUserId, agentId, connectorId });
}

async function clearAuthoredConnector(
  store: AuthoredConnectorsStore,
  input: ClearAuthoredInput,
): Promise<ClearAuthoredOutput> {
  const { ownerUserId, agentId } = requireScope(
    input,
    'connectors:clear-authored',
  );
  const connectorId = validateConnectorId(input.connectorId);
  return store.clear({ ownerUserId, agentId, connectorId });
}
