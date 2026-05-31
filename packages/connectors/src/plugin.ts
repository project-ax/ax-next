import { makeAgentContext, PluginError, type Plugin } from '@ax/core';
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
  ActivateAuthoredOutputSchema,
  ClearAuthoredOutputSchema,
  DeleteOutputSchema,
  GetOutputSchema,
  InstallAuthoredOutputSchema,
  ListAuthoredOutputSchema,
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
 * Plugin config. No knobs today (the foundation slice needs none); typed as an
 * open record so a future field is additive without changing the factory
 * signature. (A bare empty interface trips `@typescript-eslint/no-empty-object-type`.)
 */
export type ConnectorsConfig = Record<string, never>;

export function createConnectorsPlugin(_config: ConnectorsConfig = {}): Plugin {
  let db: Kysely<ConnectorDatabase> | undefined;
  let _store: ConnectorStore | undefined;
  let _authored: AuthoredConnectorsStore | undefined;

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
        'connectors:activate-authored',
        'connectors:clear-authored',
      ],
      // database:get-instance is hard — we run our own migration on init.
      calls: ['database:get-instance'],
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
        async (_ctx, input) => deleteConnector(localStore, input),
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
        async (_ctx, input) => installAuthoredConnector(localAuthored, input),
        { returns: InstallAuthoredOutputSchema },
      );

      bus.registerService<ListAuthoredInput, ListAuthoredOutput>(
        'connectors:list-authored',
        PLUGIN_NAME,
        async (_ctx, input) => listAuthoredConnectors(localAuthored, input),
        { returns: ListAuthoredOutputSchema },
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
    },

    async shutdown() {
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
  input: DeleteInput,
): Promise<DeleteOutput> {
  const hookName = 'connectors:delete';
  const userId = requireUserId(input.userId, hookName);
  const connectorId = validateConnectorId(input.connectorId);
  const deleted = await store.softDelete(userId, connectorId);
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
    ...(typeof s?.account === 'string' ? { account: s.account } : {}),
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
