import {
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
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
import {
  ActivateAuthoredOutputSchema,
  ClearAuthoredOutputSchema,
  DeleteOutputSchema,
  GetOutputSchema,
  InstallAuthoredOutputSchema,
  ListAuthoredOutputSchema,
  ListAuthoredPendingOutputSchema,
  ListDefaultsOutputSchema,
  ListOutputSchema,
  ResolveOutputSchema,
  UpsertOutputSchema,
  type ActivateAuthoredInput,
  type ActivateAuthoredOutput,
  type AuthoredConnectorSlot,
  type Capabilities,
  type ClearAuthoredInput,
  type ClearAuthoredOutput,
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
  type ListDefaultsInput,
  type ListDefaultsOutput,
  type ListInput,
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
//   - No `agents:resolve` gate (yet): connectors are owner-scoped by
//     `owner_user_id` (ctx-independent ownership in this foundation slice — the
//     hook input carries the `userId`). The agent-attachment ACL lands with the
//     orchestrator-union phase, not here.
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
        'connectors:list-defaults',
        'connectors:get',
        'connectors:upsert',
        'connectors:delete',
        'connectors:resolve',
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
      ],
      subscribes: [],
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

      bus.registerService<ListDefaultsInput, ListDefaultsOutput>(
        'connectors:list-defaults',
        PLUGIN_NAME,
        async (_ctx, input) => listDefaultConnectors(localStore, input),
        { returns: ListDefaultsOutputSchema },
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
        async (_ctx, input) => upsertConnector(localStore, input),
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

function requireUserId(value: unknown, hookName: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: 'userId must be a non-empty string',
    });
  }
  return value;
}

async function listConnectors(
  store: ConnectorStore,
  input: ListInput,
): Promise<ListOutput> {
  const userId = requireUserId(input.userId, 'connectors:list');
  const connectors = await store.listForUser(userId);
  return { connectors };
}

async function listDefaultConnectors(
  store: ConnectorStore,
  input: ListDefaultsInput,
): Promise<ListDefaultsOutput> {
  // userId is OPTIONAL on the input (the routing surface may evolve to a
  // per-user overlay, mirroring skills:list-defaults' ownerUserId). In this
  // slice an absent userId yields no defaults — defaults are owner-scoped, so
  // there's nothing to list without an owner.
  if (input.userId === undefined) return { connectors: [] };
  const userId = requireUserId(input.userId, 'connectors:list-defaults');
  const connectors = await store.listDefaults(userId);
  return { connectors };
}

async function getConnector(
  store: ConnectorStore,
  input: GetInput,
): Promise<GetOutput> {
  const hookName = 'connectors:get';
  const userId = requireUserId(input.userId, hookName);
  const connectorId = validateConnectorId(input.connectorId);
  const connector = await store.getByIdNotDeleted(userId, connectorId);
  if (connector === null) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName,
      message: `connector '${connectorId}' not found`,
    });
  }
  return { connector };
}

async function upsertConnector(
  store: ConnectorStore,
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
  // defaultAttached is an optional boolean — validate the type at the boundary
  // (an arbitrary truthy value must not slip into the DB). Absent ⟹ undefined,
  // which the store reads as "preserve existing on update / false on insert".
  if (
    input.defaultAttached !== undefined &&
    typeof input.defaultAttached !== 'boolean'
  ) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: 'defaultAttached must be a boolean if provided',
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
    ...(input.defaultAttached !== undefined
      ? { defaultAttached: input.defaultAttached }
      : {}),
  });
  return { connector, created };
}

async function deleteConnector(
  store: ConnectorStore,
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

  // Purge the connector's OWN stored key(s) so a secret never lingers with no UI
  // home. Soft-dep: only attempted when credentials:delete is present (a preset
  // without @ax/credentials still deletes the connector). The purge targets ONLY
  // the deleted connector's derived refs, at the scope it declares.
  //
  // SECURITY (invariant #5): a per-user ref (scope:'user', ownerId:userId) is
  // unambiguously the deleting caller's own — always safe to purge. A GLOBAL ref
  // (scope:'global', shared company key, owner-independent) is purged ONLY when
  // the caller is authorized (input.purgeGlobal — routes pass actor.isAdmin).
  // Gating the PURGE here, not just the HTTP create route, closes EVERY path to
  // a non-admin global-credential wipe (incl. the authored-connector approve
  // path, which promotes a draft straight through connectors:upsert). Each
  // failure is logged + swallowed so a credential hiccup never wedges the delete.
  if (connector !== null && bus.hasService('credentials:delete')) {
    const purgeGlobal = input.purgeGlobal === true;
    for (const entry of deriveCredentialPlan(connector)) {
      if (entry.scope === 'global' && !purgeGlobal) {
        // Unauthorized to purge a shared/company key — leave it intact. (An admin
        // delete passes purgeGlobal:true; a non-admin's never does.)
        ctx.logger.info('connectors_delete_skipped_global_purge', {
          connectorId,
          ref: entry.ref,
        });
        continue;
      }
      const ownerId = entry.scope === 'user' ? userId : null;
      try {
        await bus.call('credentials:delete', ctx, {
          scope: entry.scope,
          ownerId,
          ref: entry.ref,
        });
      } catch (err) {
        ctx.logger.warn('connectors_delete_credential_purge_failed', {
          connectorId,
          ref: entry.ref,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
  const connector = await store.getByIdNotDeleted(userId, connectorId);
  if (connector === null) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName,
      message: `connector '${connectorId}' not found`,
    });
  }
  // The mechanism-agnostic spec descriptor the future router routes on — id +
  // keyMode + the opaque capabilities fill. Deliberately NOT the management
  // metadata (name/description): the resolve surface can evolve (union shared +
  // catalog) without widening the management read.
  //
  // TASK-96 — reach-by-attachment: the derived credentialPlan maps the
  // connector's keyMode to the credential SCOPE each slot's key attaches to
  // (`personal` → `user` per-user vault, `workspace` → `global` company key) and
  // the deterministic `account:<service>` ref. requiresSharedKeyConsent gates the
  // "act as you" consent moment (workspace mode or a shared connector). Reach
  // derives PURELY from this scope — no visibility flag on the credential itself.
  //
  // ZERO-REACH (TASK-94): resolve reads ONLY the LIVE connectors table. A
  // pending authored draft lives in `connectors_v1_authored` and is therefore
  // never returned here — an unapproved authored connector grants no reach.
  return {
    id: connector.id,
    keyMode: connector.keyMode,
    capabilities: connector.capabilities,
    credentialPlan: deriveCredentialPlan(connector),
    requiresSharedKeyConsent: requiresSharedKeyConsent(connector),
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
