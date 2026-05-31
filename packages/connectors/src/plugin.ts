import { makeAgentContext, PluginError, type Plugin } from '@ax/core';
import { type Kysely } from 'kysely';
import {
  runConnectorsMigration,
  type ConnectorDatabase,
} from './migrations.js';
import {
  createConnectorStore,
  DESCRIPTION_MAX,
  USAGE_NOTE_MAX,
  validateCapabilities,
  validateConnectorId,
  validateKeyMode,
  validateName,
  validateOptionalText,
  validateVisibility,
  type ConnectorStore,
} from './store.js';
import {
  DeleteOutputSchema,
  GetOutputSchema,
  ListOutputSchema,
  ResolveOutputSchema,
  UpsertOutputSchema,
  type DeleteInput,
  type DeleteOutput,
  type GetInput,
  type GetOutput,
  type ListInput,
  type ListOutput,
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

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'connectors:list',
        'connectors:get',
        'connectors:upsert',
        'connectors:delete',
        'connectors:resolve',
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

      bus.registerService<ListInput, ListOutput>(
        'connectors:list',
        PLUGIN_NAME,
        async (_ctx, input) => listConnectors(localStore, input),
        { returns: ListOutputSchema },
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
    },

    async shutdown() {
      // The shared db handle is owned by @ax/database-postgres; don't close it
      // here. Drop our references so a re-init doesn't read a stale store.
      db = undefined;
      _store = undefined;
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
  const { connector, created } = await store.upsert({
    userId,
    connectorId,
    name,
    description,
    usageNote,
    keyMode,
    visibility,
    capabilities,
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
  // metadata (name/description/visibility): the resolve surface can evolve
  // (union shared + catalog) without widening the management read.
  return {
    id: connector.id,
    keyMode: connector.keyMode,
    capabilities: connector.capabilities,
  };
}
