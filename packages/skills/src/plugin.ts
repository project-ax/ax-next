import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
import type { Kysely } from 'kysely';
import { checkForUpdates } from './check-updates.js';
import { createBundleStore } from './bundle-store.js';
import { validateBundleFiles } from './bundle-files.js';
import { classifyTier } from './catalog-tier.js';
import { parseSkillManifest } from './manifest.js';
import { runSkillsMigration, type SkillsDatabase } from './migrations.js';
import { createSkillsStore } from './store.js';
import { createUserSkillsStore } from './user-store.js';
import { createUserAttachmentsStore } from './user-attachments-store.js';
import { createCatalogRequestsStore } from './catalog-requests-store.js';
import { createSkillsQuarantineStore } from './quarantine-store.js';
import { validateAttachmentBindings } from './attachment-validation.js';
import { mergeUserWins, compareById } from './_merge.js';
import { registerAdminSkillsRoutes } from './admin-routes.js';
import { registerSettingsSkillsRoutes } from './settings-routes.js';
import { registerCatalogRoutes } from './catalog-routes.js';
import {
  SkillsCheckForUpdatesOutputSchema,
  SkillsDeleteOutputSchema,
  SkillsGetOutputSchema,
  SkillsListDefaultsOutputSchema,
  SkillsListOutputSchema,
  SkillsResolveOutputSchema,
  SkillsUpsertOutputSchema,
  SkillsAttachForUserOutputSchema,
  SkillsListUserAttachmentsOutputSchema,
  SkillsDetachForUserOutputSchema,
  SkillsSearchCatalogOutputSchema,
  CatalogSubmitOutputSchema,
  CatalogListRequestsOutputSchema,
  CatalogAdmitOutputSchema,
  SkillsQuarantineSetOutputSchema,
  SkillsQuarantineClearOutputSchema,
  SkillsQuarantineGetOutputSchema,
  SkillsQuarantineListOutputSchema,
} from './types.js';
import type {
  SkillsCheckForUpdatesInput,
  SkillsCheckForUpdatesOutput,
  SkillsDeleteInput,
  SkillsDeleteOutput,
  SkillsGetInput,
  SkillsGetOutput,
  SkillsListDefaultsInput,
  SkillsListDefaultsOutput,
  SkillsListInput,
  SkillsListOutput,
  SkillsResolveInput,
  SkillsResolveOutput,
  SkillsUpsertInput,
  SkillsUpsertOutput,
  SkillsAttachForUserInput,
  SkillsAttachForUserOutput,
  SkillsListUserAttachmentsInput,
  SkillsListUserAttachmentsOutput,
  SkillsDetachForUserInput,
  SkillsDetachForUserOutput,
  SkillsSearchCatalogInput,
  SkillsSearchCatalogOutput,
  CatalogSubmitInput,
  CatalogSubmitOutput,
  CatalogListRequestsInput,
  CatalogListRequestsOutput,
  CatalogAdmitInput,
  CatalogAdmitOutput,
  SkillsQuarantineSetInput,
  SkillsQuarantineSetOutput,
  SkillsQuarantineClearInput,
  SkillsQuarantineClearOutput,
  SkillsQuarantineGetInput,
  SkillsQuarantineGetOutput,
  SkillsQuarantineListInput,
  SkillsQuarantineListOutput,
} from './types.js';

const PLUGIN_NAME = '@ax/skills';

// ---------------------------------------------------------------------------
// requireOwner — narrow `ownerUserId?: string` to a definite string for the
// user-scope paths, throwing the canonical missing-owner PluginError otherwise.
// Collapses the repeated throw + non-null-assertion across list/get/upsert/delete.
// ---------------------------------------------------------------------------
function requireOwner(ownerUserId: string | undefined): string {
  if (!ownerUserId) {
    throw new PluginError({
      code: 'missing-owner',
      plugin: PLUGIN_NAME,
      message: 'scope=user requires ownerUserId',
    });
  }
  return ownerUserId;
}

// ---------------------------------------------------------------------------
// @ax/skills plugin
//
// Registers the five `skills:*` service hooks backed by skills_v1_skills,
// plus the five /admin/skills* HTTP routes.
//
// Manifest decisions:
//   - `calls: ['database:get-instance', 'http:register-route', 'auth:require-user']`
//     are the hard deps. We DO NOT declare `agents:any-attached-to-skill`
//     because it may not be present in stripped presets. The delete path
//     checks via `bus.hasService` and degrades gracefully when @ax/agents
//     isn't loaded. Similarly, `credentials:list` / `credentials:delete`
//     are soft deps — guarded via `bus.hasService` inside purgeSkillCredentials
//     so stripped presets that omit @ax/credentials don't wedge skill operations.
//     They are NOT listed in `calls:` because that would make them hard deps
//     and break bootstrap when the credentials plugin is absent.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Credential purge helper
//
// Called by skills:delete (all slots) and skills:upsert (removed slots only).
// Fetches all credentials rows and filters by ref prefix locally — fine for
// v1 (small N). Wrapped in try/catch at call sites so a credential hiccup
// never wedges a skill operation.
// ---------------------------------------------------------------------------
interface CredentialRow {
  scope: 'global' | 'user' | 'agent';
  ownerId: string | null;
  ref: string;
}

async function purgeSkillCredentials(
  bus: HookBus,
  ctx: AgentContext,
  skillId: string,
  slots: string[],
): Promise<void> {
  if (slots.length === 0) return;
  if (!bus.hasService('credentials:list') || !bus.hasService('credentials:delete')) return;

  const refsToDelete = new Set(slots.map((s) => `skill:${skillId}:${s}`));
  const { credentials } = await bus.call<
    Record<string, never>,
    { credentials: CredentialRow[] }
  >('credentials:list', ctx, {});

  for (const c of credentials) {
    if (!refsToDelete.has(c.ref)) continue;
    // Per-row try/catch: one failed delete must not abort the rest. The caller
    // wraps the whole purge in its own try/catch for the list-phase errors.
    try {
      await bus.call<CredentialRow, void>('credentials:delete', ctx, {
        scope: c.scope,
        ownerId: c.ownerId,
        ref: c.ref,
      });
    } catch (err) {
      ctx.logger.warn('skills_purge_credential_delete_failed', {
        ref: c.ref,
        scope: c.scope,
        ownerId: c.ownerId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export interface SkillsPluginConfig {
  /**
   * Content-addressed bundle byte-store location. `repoRoot` hosts a bare git
   * repo at `<repoRoot>/bundles.git`. Capabilities scoped to this dir only.
   * OPTIONAL: when omitted the plugin uses an EPHEMERAL temp dir (and warns) —
   * fine for tests, but production MUST wire a durable path (Task 6) or the
   * catalog's extra-file bytes are lost on restart. Today every deployed skill
   * has no extra files (the write path is half-wired until P5), so the
   * ephemeral fallback is non-fatal until then.
   */
  bundleStore?: { repoRoot: string };
}

export function createSkillsPlugin(config: SkillsPluginConfig = {}): Plugin {
  let db: Kysely<SkillsDatabase> | undefined;
  let _busRef: HookBus | undefined;
  const routeUnregisters: Array<() => void> = [];

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'skills:list',
        'skills:get',
        'skills:upsert',
        'skills:delete',
        'skills:resolve',
        'skills:list-defaults',
        'skills:check-for-updates',
        'skills:attach-for-user',
        'skills:list-user-attachments',
        'skills:detach-for-user',
        'skills:search-catalog',
        'catalog:submit',
        'catalog:list-requests',
        'catalog:admit',
        'skills:quarantine-set',
        'skills:quarantine-clear',
        'skills:quarantine-get',
        'skills:quarantine-list',
      ],
      calls: ['database:get-instance', 'http:register-route', 'auth:require-user'],
      subscribes: [],
    },

    async init({ bus }) {
      _busRef = bus;
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
      db = shared as Kysely<SkillsDatabase>;
      await runSkillsMigration(db);

      // Construct the content-addressed bundle byte-store ONCE and inject the
      // SAME instance into both stores so identical bytes dedup across scopes.
      let repoRoot = config.bundleStore?.repoRoot;
      if (repoRoot === undefined) {
        repoRoot = mkdtempSync(join(tmpdir(), 'ax-skills-bundles-'));
        initCtx.logger.warn('skills_bundle_store_ephemeral', {
          repoRoot,
          note: 'no AX_SKILLS_BUNDLE_ROOT configured — bundle bytes are not durable across restarts',
        });
      }
      const bundleStore = createBundleStore(repoRoot);
      const store = createSkillsStore(db, bundleStore);
      const userStore = createUserSkillsStore(db, bundleStore);
      const attachmentsStore = createUserAttachmentsStore(db);
      // Reuse the shared content-addressed bundle store (TASK-40) so a share
      // snapshot dedups against the source skill's own tree and admit re-derives
      // the SAME tree SHA when it registers the bundle in the global catalog.
      const catalogRequestsStore = createCatalogRequestsStore(db, bundleStore);
      const quarantineStore = createSkillsQuarantineStore(db);

      bus.registerService<SkillsListInput, SkillsListOutput>(
        'skills:list',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const scope = input.scope ?? 'all';
          // Validate: scope=user requires ownerUserId.
          if (scope === 'user') requireOwner(input.ownerUserId);
          const { ownerUserId } = input;

          const includeGlobal = scope === 'global' || scope === 'all';
          const includeUser = (scope === 'user' || scope === 'all') && !!ownerUserId;

          const globalSkills = includeGlobal ? await store.list() : [];
          const userSkills = includeUser ? await userStore.list(ownerUserId!) : [];

          // User-wins on id collision; sort by id ascending for stable output.
          const merged = mergeUserWins(globalSkills, userSkills);
          const skills = [...merged.values()].sort(compareById);

          return { skills };
        },
        { returns: SkillsListOutputSchema },
      );

      bus.registerService<SkillsGetInput, SkillsGetOutput>(
        'skills:get',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const { skillId, ownerUserId } = input;
          const scope = input.scope ?? (ownerUserId ? 'all' : 'global');

          if (scope === 'user') {
            const owner = requireOwner(ownerUserId);
            const found = await userStore.get(owner, skillId);
            if (!found) {
              throw new PluginError({
                code: 'skill-not-found',
                plugin: PLUGIN_NAME,
                message: `skill '${skillId}' does not exist`,
              });
            }
            return found;
          }

          if (scope === 'global') {
            const found = await store.get(skillId);
            if (!found) {
              throw new PluginError({
                code: 'skill-not-found',
                plugin: PLUGIN_NAME,
                message: `skill '${skillId}' does not exist`,
              });
            }
            return found;
          }

          // scope === 'all' with ownerUserId: user-wins strategy (single-id
          // form of mergeUserWins — try user first, fall back to global).
          if (ownerUserId) {
            const userFound = await userStore.get(ownerUserId, skillId);
            if (userFound) return userFound;
          }
          const globalFound = await store.get(skillId);
          if (!globalFound) {
            throw new PluginError({
              code: 'skill-not-found',
              plugin: PLUGIN_NAME,
              message: `skill '${skillId}' does not exist`,
            });
          }
          return globalFound;
        },
        { returns: SkillsGetOutputSchema },
      );

      bus.registerService<SkillsUpsertInput, SkillsUpsertOutput>(
        'skills:upsert',
        PLUGIN_NAME,
        async (ctx, input) => {
          if (typeof input.manifestYaml !== 'string') {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'manifestYaml must be a string',
            });
          }
          if (typeof input.bodyMd !== 'string') {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'bodyMd must be a string',
            });
          }
          const parsed = parseSkillManifest(input.manifestYaml);
          if (!parsed.ok) {
            throw new PluginError({
              code: parsed.code,
              plugin: PLUGIN_NAME,
              message: parsed.message,
            });
          }
          // I-S2: default-attached skills are instruction-only in v1. Credential
          // slots imply per-agent bindings, which "everyone gets this" cannot
          // supply. Loud rejection at the host so the admin sees the cause.
          // Applies to BOTH global and user scopes.
          if (
            input.defaultAttached === true &&
            parsed.value.capabilities.credentials.length > 0
          ) {
            throw new PluginError({
              code: 'default-attached-requires-no-credentials',
              plugin: PLUGIN_NAME,
              message: `skill '${parsed.value.id}' declares credential slots; default-attached skills must be instruction-only`,
            });
          }

          // JIT Phase 1a — validate the optional bundle extra files (path
          // safety + veto list + caps) BEFORE any write, but ONLY when the
          // caller provided `files`. `undefined` means "leave the current file
          // set unchanged" (the existing metadata-only admin/settings/refresh
          // routes send no `files`; treating that as an empty set would
          // silently wipe a multi-file bundle on a body edit — the §6D
          // data-loss bug). The validator throws a plain Error; re-wrap as a
          // PluginError so the host surfaces a typed code while preserving the
          // (test-asserted) message. This is the host-side gate; the wire
          // schema + both runner materializers re-validate independently
          // (validateMcpEntry defense-in-depth).
          const files = input.files;
          if (files !== undefined) {
            try {
              validateBundleFiles(files);
            } catch (err) {
              throw new PluginError({
                code: 'invalid-bundle-file',
                plugin: PLUGIN_NAME,
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
          // Spread `files` into the store call ONLY when provided — under
          // exactOptionalPropertyTypes an explicit `files: undefined` is not
          // assignable to the optional `files?` field, and (more importantly)
          // the store treats "key absent" as "leave files unchanged".
          const filesPatch = files !== undefined ? { files } : {};

          const scope = input.scope ?? 'global';

          if (scope === 'user') {
            const ownerUserId = requireOwner(input.ownerUserId);
            const skillId = parsed.value.id;
            const r = await userStore.upsert({
              ownerUserId,
              id: skillId,
              description: parsed.value.description,
              manifestYaml: input.manifestYaml,
              bodyMd: input.bodyMd,
              version: parsed.value.version,
              defaultAttached: input.defaultAttached ?? false,
              sourceUrl: parsed.value.sourceUrl ?? null,
              ...filesPatch,
            });
            // NOTE: credential purge is intentionally SKIPPED for user-scoped skills.
            // The `skill:<id>:<slot>` ref scheme is global-namespaced. Running purge
            // here for a user upsert could delete the same-id GLOBAL skill's credential
            // rows — a cross-scope deletion bug. User-scoped skill credential lifecycle
            // is deferred until the ref scheme gains scope awareness.
            return { skillId, created: r.created };
          }

          // scope === 'global' — existing path UNCHANGED (incl. credential purge).

          // Capture the previous slot list so we can purge credentials for
          // any slots that are removed by this manifest edit.
          //
          // KNOWN LIMITATION: `previous` is read outside any transaction. If
          // two concurrent upserts race, the second may read a `previous` that
          // reflects the first's changes rather than the pre-upsert state, and
          // may therefore skip purging some now-removed slots. The concurrency
          // window is small and the purge is already best-effort (a missed
          // purge leaves orphan credential rows but doesn't cause data loss or
          // incorrect behavior). Fixing this properly requires a store-layer
          // atomic read/compare/upsert primitive that doesn't yet exist.
          // Revisit when the store gains transactional support.
          const skillId = parsed.value.id;
          const previous = await store.get(skillId);
          const oldSlots = previous?.capabilities.credentials.map((c) => c.slot) ?? [];
          const newSlots = parsed.value.capabilities.credentials.map((c) => c.slot);

          const r = await store.upsert({
            id: skillId,
            description: parsed.value.description,
            manifestYaml: input.manifestYaml,
            bodyMd: input.bodyMd,
            version: parsed.value.version,
            defaultAttached: input.defaultAttached ?? false,
            // sourceUrl: undefined and null both clear the column on update;
            // an actual string persists. Threaded straight from the parsed
            // manifest so the column is the source of truth, kept in sync
            // with the manifest_yaml on every upsert.
            sourceUrl: parsed.value.sourceUrl ?? null,
            ...filesPatch,
          });

          // Purge credentials for slots that no longer exist in the manifest.
          const removedSlots = oldSlots.filter((s) => !newSlots.includes(s));
          try {
            await purgeSkillCredentials(bus, ctx, skillId, removedSlots);
          } catch (err) {
            ctx.logger.warn('skills_credential_purge_failed', {
              skillId,
              err: err instanceof Error ? err.message : String(err),
            });
          }

          return { skillId, created: r.created };
        },
        { returns: SkillsUpsertOutputSchema },
      );

      bus.registerService<SkillsDeleteInput, SkillsDeleteOutput>(
        'skills:delete',
        PLUGIN_NAME,
        async (ctx, input) => {
          const scope = input.scope ?? 'global';

          if (scope === 'user') {
            const ownerUserId = requireOwner(input.ownerUserId);
            // NOTE: the `agents:any-attached-to-skill` in-use guard is
            // INTENTIONALLY skipped for user-scope deletes. Attachments match
            // purely on skillId and carry NO scope/owner, so a same-id GLOBAL
            // skill being attached to some agent would otherwise produce a
            // cross-scope false-positive denial (alice couldn't delete her
            // private `github` because someone's agent has the global one).
            // Skipping is safe: the orchestrator already drops deleted-still-
            // attached skills silently (orchestrator.ts "deleted-skill-still-
            // attached — drop silently"). Scoping the agents hook would require
            // adding scope to attachments — out of scope for Phase D.
            await userStore.delete(ownerUserId, input.skillId);
            // NOTE: credential purge is intentionally SKIPPED for user-scoped skills.
            // The `skill:<id>:<slot>` ref scheme is global-namespaced. Running purge
            // here could delete the same-id GLOBAL skill's credential rows — a
            // cross-scope deletion bug. User-scoped skill credential lifecycle
            // is deferred until the ref scheme gains scope awareness.
            return {};
          }

          // scope === 'global' — existing path UNCHANGED (incl. credential purge).

          // I-P1-6: refuse delete when any agent has the skill attached.
          // Global-only because attachments carry no scope (see the user-scope
          // branch above for the cross-scope false-positive this avoids).
          // Structural hasService check so this plugin doesn't form a hard dep
          // on @ax/agents — useful for stripped presets.
          if (bus.hasService('agents:any-attached-to-skill')) {
            const { attached } = await bus.call<
              { skillId: string },
              { attached: boolean }
            >('agents:any-attached-to-skill', ctx, { skillId: input.skillId });
            if (attached) {
              throw new PluginError({
                code: 'skill-in-use',
                plugin: PLUGIN_NAME,
                message: `skill '${input.skillId}' is attached to one or more agents — detach first`,
              });
            }
          }

          // Read the skill's credential slots BEFORE deletion (we need
          // the capability list). Then delete the row first — if store.delete
          // throws, no purge has run yet and the caller can retry cleanly.
          // After a successful row deletion the purge is best-effort: a
          // failure is logged but does not surface as an error.
          //
          // Note: agents:delete keeps the opposite order (purge-first) because
          // an orphaned agent-scope credential row can never be cleaned up once
          // the agent row is gone. Skills credentials are keyed by skillId and
          // slot only, so they can always be cleaned up by re-running the
          // purge — making delete-first safe here.
          const existing = await store.get(input.skillId);
          const slots = existing?.capabilities.credentials.map((c) => c.slot) ?? [];

          await store.delete(input.skillId);

          // Best-effort purge — skill row is already gone at this point.
          if (slots.length > 0) {
            try {
              await purgeSkillCredentials(bus, ctx, input.skillId, slots);
            } catch (err) {
              ctx.logger.warn('skills_credential_purge_failed', {
                skillId: input.skillId,
                err: err instanceof Error ? err.message : String(err),
              });
            }
          }
          return {};
        },
        { returns: SkillsDeleteOutputSchema },
      );

      bus.registerService<SkillsResolveInput, SkillsResolveOutput>(
        'skills:resolve',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const globalResolved = await store.resolve(input.skillIds);

          if (!input.ownerUserId) {
            return { skills: globalResolved };
          }

          const userResolved = await userStore.resolve(input.ownerUserId, input.skillIds);

          // User-wins on id collision; replay input order, drop unknowns.
          const byId = mergeUserWins(globalResolved, userResolved);
          const skills: typeof globalResolved = [];
          for (const id of input.skillIds) {
            const s = byId.get(id);
            if (s !== undefined) skills.push(s);
          }

          return { skills };
        },
        { returns: SkillsResolveOutputSchema },
      );

      bus.registerService<SkillsListDefaultsInput, SkillsListDefaultsOutput>(
        'skills:list-defaults',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const globalDefaults = await store.getDefaults();

          if (!input.ownerUserId) {
            return { skills: globalDefaults };
          }

          const userDefaults = await userStore.getDefaults(input.ownerUserId);

          // User-wins on id collision; sort by id ascending (matches
          // store.getDefaults stable order).
          const byId = mergeUserWins(globalDefaults, userDefaults);
          const skills = [...byId.values()].sort(compareById);

          return { skills };
        },
        { returns: SkillsListDefaultsOutputSchema },
      );

      bus.registerService<SkillsCheckForUpdatesInput, SkillsCheckForUpdatesOutput>(
        'skills:check-for-updates',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const detail = await store.get(input.skillId);
          if (detail === null) {
            throw new PluginError({
              code: 'skill-not-found',
              plugin: PLUGIN_NAME,
              message: `skill '${input.skillId}' does not exist`,
            });
          }
          // .bind(globalThis) — calling globalThis.fetch unbound triggers
          // "Illegal invocation" in some node versions.
          return checkForUpdates(detail, { fetch: globalThis.fetch.bind(globalThis) });
        },
        { returns: SkillsCheckForUpdatesOutputSchema },
      );

      // -----------------------------------------------------------------------
      // Per-user skill attachment (TASK-33). Self-serve layer ABOVE the admin-
      // managed agent-global attachments owned by @ax/agents. These hooks take
      // NO `actor` — capability is minimized to validation + storage. The
      // (host-side, authenticated) caller supplies `userId`. There is no
      // agent-reachable caller in this slice (half-wired write path); TASK-36
      // wires the post-approval host-side caller, which runs only after the
      // user has authenticated and approved the bundled card.
      // -----------------------------------------------------------------------
      bus.registerService<SkillsAttachForUserInput, SkillsAttachForUserOutput>(
        'skills:attach-for-user',
        PLUGIN_NAME,
        async (_ctx, input) => {
          // Resolve the skill (user-scoped content wins over global of the same
          // id — same precedence as skills:resolve) to read its declared slots.
          const resolved =
            (await userStore.resolve(input.userId, [input.skillId]))[0] ??
            (await store.resolve([input.skillId]))[0];
          if (resolved === undefined) {
            throw new PluginError({
              code: 'skill-not-found',
              plugin: PLUGIN_NAME,
              message: `skill '${input.skillId}' is not installed`,
            });
          }

          const check = validateAttachmentBindings(
            resolved.capabilities.credentials.map((c) => c.slot),
            input.credentialBindings,
          );
          if (!check.ok) {
            throw new PluginError({
              code: check.code,
              plugin: PLUGIN_NAME,
              message: check.message,
            });
          }

          const { created } = await attachmentsStore.upsert({
            ownerUserId: input.userId,
            agentId: input.agentId,
            skillId: input.skillId,
            credentialBindings: input.credentialBindings,
          });
          return { created };
        },
        { returns: SkillsAttachForUserOutputSchema },
      );

      bus.registerService<SkillsListUserAttachmentsInput, SkillsListUserAttachmentsOutput>(
        'skills:list-user-attachments',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const attachments = await attachmentsStore.listForUserAgent(
            input.userId,
            input.agentId,
          );
          return { attachments };
        },
        { returns: SkillsListUserAttachmentsOutputSchema },
      );

      // -----------------------------------------------------------------------
      // skills:detach-for-user (TASK-42) — the out-of-band twin of
      // skills:attach-for-user (the Settings "Connections" revoke; design P6).
      // Host-internal, NOT an IPC action — same posture as attach: the untrusted
      // runner must never detach a user's skills. The (authenticated) caller
      // supplies userId; the delete is keyed to the full (userId, agentId,
      // skillId) compound key, so a user can only ever remove their own row.
      // Idempotent: removed:false when the row was already absent.
      // -----------------------------------------------------------------------
      bus.registerService<SkillsDetachForUserInput, SkillsDetachForUserOutput>(
        'skills:detach-for-user',
        PLUGIN_NAME,
        async (_ctx, input) => {
          return attachmentsStore.delete(input.userId, input.agentId, input.skillId);
        },
        { returns: SkillsDetachForUserOutputSchema },
      );

      // -----------------------------------------------------------------------
      // skills:search-catalog (TASK-34) — read-only intent→candidate matcher
      // backing the model-facing skill broker (JIT surfacing spine, design
      // §11.1). The untrusted `intent` is matched IN MEMORY over the global
      // catalog (store.list()) so it never reaches SQL — a SQL-injection-shaped
      // string is just a no-match. `tier` is DERIVED from declared capabilities
      // (classifyTier — one source of truth, no stored column); `hosts`/`slots`
      // are already public in the manifest.
      // -----------------------------------------------------------------------
      bus.registerService<SkillsSearchCatalogInput, SkillsSearchCatalogOutput>(
        'skills:search-catalog',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const intent = typeof input.intent === 'string' ? input.intent.trim().toLowerCase() : '';
          const rawLimit = typeof input.limit === 'number' ? Math.floor(input.limit) : 10;
          const limit = Math.max(1, Math.min(50, rawLimit));
          if (intent.length === 0) return { skills: [] };

          const tokens = intent.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
          if (tokens.length === 0) return { skills: [] };

          const catalog = await store.list(); // global catalog: SkillSummary[]
          const scored = catalog
            .map((s) => {
              const hay = `${s.id} ${s.description}`.toLowerCase();
              const score = tokens.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
              return { s, score };
            })
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id))
            .slice(0, limit);

          return {
            skills: scored.map(({ s }) => ({
              id: s.id,
              description: s.description,
              tier: classifyTier(s.capabilities),
              hosts: s.capabilities.allowedHosts,
              slots: s.capabilities.credentials.map((c) => c.slot),
            })),
          };
        },
        { returns: SkillsSearchCatalogOutputSchema },
      );

      // -----------------------------------------------------------------------
      // catalog:submit (TASK-41) — file an admit-to-catalog request. Two kinds:
      //   share      — the requester promotes their OWN user-scoped skill; we
      //                snapshot its bundle (manifest/body verbatim + extra files)
      //                so admit ships exactly the reviewed bytes (no drift).
      //   cold-start — a bundle-less "a user needed X" wishlist item.
      // requestedByUserId is host-supplied (the authenticated caller); a share
      // can only reference the requester's own skill (sourceOwner == requester).
      // Dedup: one pending request per skill_id (store + partial unique index).
      // -----------------------------------------------------------------------
      bus.registerService<CatalogSubmitInput, CatalogSubmitOutput>(
        'catalog:submit',
        PLUGIN_NAME,
        async (_ctx, input) => {
          if (input.kind === 'share') {
            const detail = await userStore.get(input.requestedByUserId, input.skillId);
            if (detail === null) {
              throw new PluginError({
                code: 'skill-not-found',
                plugin: PLUGIN_NAME,
                message: `user '${input.requestedByUserId}' has no skill '${input.skillId}' to share`,
              });
            }
            const { request, created } = await catalogRequestsStore.submitShare({
              skillId: input.skillId,
              requestedByUserId: input.requestedByUserId,
              description: input.description ?? detail.description,
              manifestYaml: detail.manifestYaml,
              bodyMd: detail.bodyMd,
              files: detail.files,
            });
            return { requestId: request.requestId, created, status: request.status };
          }
          // cold-start
          const { request, created } = await catalogRequestsStore.submitColdStart({
            skillId: input.skillId,
            requestedByUserId: input.requestedByUserId,
            description: input.description,
          });
          return { requestId: request.requestId, created, status: request.status };
        },
        { returns: CatalogSubmitOutputSchema },
      );

      // -----------------------------------------------------------------------
      // catalog:list-requests (TASK-41) — the admin review feed. Defaults to
      // pending. A share request reconstructs its snapshot files (storage-
      // agnostic files[] — the tree SHA stays internal). Read-only.
      // -----------------------------------------------------------------------
      bus.registerService<CatalogListRequestsInput, CatalogListRequestsOutput>(
        'catalog:list-requests',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const status = input.status ?? 'pending';
          if (status !== 'pending' && status !== 'all') {
            // Decided-status filters are a TASK-45 refinement; MVP serves
            // pending (the actionable queue) + all.
            const requests = (await catalogRequestsStore.listPending()).filter(
              (r) => r.status === status,
            );
            return { requests };
          }
          // 'pending' and 'all' both serve the actionable pending set today;
          // decided-request history is a TASK-45 refinement (YAGNI now). The
          // `status` field exists on the input so the hook surface is stable.
          return { requests: await catalogRequestsStore.listPending() };
        },
        { returns: CatalogListRequestsOutputSchema },
      );

      // -----------------------------------------------------------------------
      // catalog:admit (TASK-41) — the supply-chain gate (decision #3: catalog
      // admission IS the approval). On 'admit' of a SHARE request: re-validate
      // the snapshot (parseSkillManifest + validateBundleFiles — defense-in-
      // depth, the bytes go org-wide), store.upsert it to the GLOBAL catalog
      // (content-addressing re-derives the same tree SHA → "register the tree
      // SHA"), then RETIRE the author's editable working copy via the user
      // store (§6D — the integrity backbone: user-wins precedence must not keep
      // serving forkable bytes). On 'reject': close the request. Cold-start
      // requests are not promotable (no bundle) — the admin authors via the
      // existing admin flow and rejects/closes the wishlist item.
      // -----------------------------------------------------------------------
      bus.registerService<CatalogAdmitInput, CatalogAdmitOutput>(
        'catalog:admit',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const request = await catalogRequestsStore.get(input.requestId);
          if (request === null) {
            throw new PluginError({
              code: 'request-not-found',
              plugin: PLUGIN_NAME,
              message: `catalog request '${input.requestId}' does not exist`,
            });
          }
          if (request.status !== 'pending') {
            throw new PluginError({
              code: 'request-already-decided',
              plugin: PLUGIN_NAME,
              message: `catalog request '${input.requestId}' is already ${request.status}`,
            });
          }

          if (input.decision === 'reject') {
            await catalogRequestsStore.markDecided(
              input.requestId,
              'rejected',
              input.decidedByUserId,
            );
            return { admitted: false };
          }

          // decision === 'admit'
          if (
            request.kind !== 'share' ||
            request.manifestYaml === null ||
            request.bodyMd === null
          ) {
            throw new PluginError({
              code: 'cold-start-not-promotable',
              plugin: PLUGIN_NAME,
              message: `request '${input.requestId}' is a cold-start with no bundle to promote — author the skill, then reject`,
            });
          }

          // Defense-in-depth re-validation of the snapshot before it goes
          // org-wide (the snapshot was validated at submit; re-check here).
          const parsed = parseSkillManifest(request.manifestYaml);
          if (!parsed.ok) {
            throw new PluginError({
              code: parsed.code,
              plugin: PLUGIN_NAME,
              message: parsed.message,
            });
          }
          try {
            validateBundleFiles(request.files);
          } catch (err) {
            throw new PluginError({
              code: 'invalid-bundle-file',
              plugin: PLUGIN_NAME,
              message: err instanceof Error ? err.message : String(err),
            });
          }

          // Promote into the GLOBAL catalog (idempotent by id → natural dedup).
          // store.upsert (TASK-40) re-derives the same content-addressed
          // bundle_tree_sha as the reviewed snapshot.
          await store.upsert({
            id: parsed.value.id,
            description: parsed.value.description,
            manifestYaml: request.manifestYaml,
            bodyMd: request.bodyMd,
            version: parsed.value.version,
            defaultAttached: false,
            sourceUrl: parsed.value.sourceUrl ?? null,
            files: request.files,
          });

          // Retire the author's editable working copy (§6D hard requirement).
          // The author's per-(user,agent) attachment (keyed by skillId, no
          // scope) transparently re-resolves to the now-global skill, so they
          // keep the capability — now sourced from the vetted catalog.
          if (request.sourceOwnerUserId !== null) {
            await userStore.delete(request.sourceOwnerUserId, parsed.value.id);
          }

          await catalogRequestsStore.markDecided(
            input.requestId,
            'admitted',
            input.decidedByUserId,
          );
          return { skillId: parsed.value.id, admitted: true };
        },
        { returns: CatalogAdmitOutputSchema },
      );

      bus.registerService<SkillsQuarantineSetInput, SkillsQuarantineSetOutput>(
        'skills:quarantine-set',
        PLUGIN_NAME,
        async (_ctx, input) => {
          await quarantineStore.set(input);
          return {};
        },
        { returns: SkillsQuarantineSetOutputSchema },
      );
      bus.registerService<SkillsQuarantineClearInput, SkillsQuarantineClearOutput>(
        'skills:quarantine-clear',
        PLUGIN_NAME,
        async (_ctx, input) => quarantineStore.clear(input),
        { returns: SkillsQuarantineClearOutputSchema },
      );
      bus.registerService<SkillsQuarantineGetInput, SkillsQuarantineGetOutput>(
        'skills:quarantine-get',
        PLUGIN_NAME,
        async (_ctx, input) => quarantineStore.get(input),
        { returns: SkillsQuarantineGetOutputSchema },
      );
      bus.registerService<SkillsQuarantineListInput, SkillsQuarantineListOutput>(
        'skills:quarantine-list',
        PLUGIN_NAME,
        async (_ctx, input) => ({ items: await quarantineStore.list(input) }),
        { returns: SkillsQuarantineListOutputSchema },
      );

      // Register admin + settings HTTP routes. Both batches are pushed into
      // the same routeUnregisters array inside one atomic try/catch: if any
      // registration fails after earlier ones succeeded, all earlier ones are
      // unwound before rethrowing (bootstrap marks the plugin failed and won't
      // call shutdown, so the unwind must happen here).
      try {
        const adminUnregisters = await registerAdminSkillsRoutes(bus, initCtx, store);
        routeUnregisters.push(...adminUnregisters);
        const settingsUnregisters = await registerSettingsSkillsRoutes(bus, initCtx);
        routeUnregisters.push(...settingsUnregisters);
        const catalogUnregisters = await registerCatalogRoutes(bus, initCtx);
        routeUnregisters.push(...catalogUnregisters);
      } catch (err) {
        while (routeUnregisters.length > 0) {
          const fn = routeUnregisters.pop();
          try {
            fn?.();
          } catch {
            // best-effort unwind
          }
        }
        throw err;
      }
    },

    async shutdown() {
      // Drop routes before clearing references so a re-init doesn't trip
      // duplicate-route on the http-server.
      while (routeUnregisters.length > 0) {
        const fn = routeUnregisters.pop();
        try {
          fn?.();
        } catch {
          // best-effort
        }
      }
      _busRef = undefined;
      // The shared db handle is owned by @ax/database-postgres; don't close
      // it here. Just drop our reference so a re-init doesn't read a stale store.
      db = undefined;
    },
  };
}
