import {
  makeAgentContext,
  PluginError,
  type HookBus,
  type Plugin,
} from '@ax/core';
import type { Kysely } from 'kysely';
import { checkForUpdates } from './check-updates.js';
import { createBlobBundleStore } from './blob-bundle-store.js';
import { validateBundleFiles } from './bundle-files.js';
import { classifyTier } from './catalog-tier.js';
import { parseSkillManifest } from './manifest.js';
import { runSkillsMigration, type SkillsDatabase } from './migrations.js';
import { migrateSkillCapabilitiesToConnectors } from './cap-migration.js';
import { createSkillsStore } from './store.js';
import { createUserSkillsStore } from './user-store.js';
import { createUserAttachmentsStore } from './user-attachments-store.js';
import { createCatalogRequestsStore } from './catalog-requests-store.js';
import { createSkillsQuarantineStore } from './quarantine-store.js';
import { createApprovedCapsStore, type ApprovedCapSubject } from './approved-caps-store.js';
import { createAuthoredSkillsStore } from './authored-store.js';
import { classifyProposal } from './propose-gate.js';
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
  SkillsApprovedCapsListOutputSchema,
  SkillsApprovedCapsSetOutputSchema,
  SkillsApprovedCapsRevokeOutputSchema,
  SkillsProposeOutputSchema,
  SkillsListAuthoredOutputSchema,
  SkillsAuthoredActivateOutputSchema,
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
  SkillsApprovedCapsListInput,
  SkillsApprovedCapsListOutput,
  SkillsApprovedCapsSetInput,
  SkillsApprovedCapsSetOutput,
  SkillsApprovedCapsRevokeInput,
  SkillsApprovedCapsRevokeOutput,
  SkillsProposeInput,
  SkillsProposeOutput,
  SkillsListAuthoredInput,
  SkillsListAuthoredOutput,
  SkillsScanInput,
  SkillsScanOutput,
  SkillsProposedEvent,
  AuthoredSkillProjection,
  SkillsAuthoredActivateInput,
  SkillsAuthoredActivateOutput,
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
// resolveApprovedCapSubject — TASK-93. The approved-caps wall attributes a grant
// to exactly one of {skill, connector}. The wire input carries both as optional
// fields; enforce exactly-one here so neither a caller nor the store can persist
// an ambiguous (both-set) or unattributed (neither-set) grant. An empty-string
// id counts as absent (it's the store's reserved sentinel for "no subject").
// ---------------------------------------------------------------------------
function resolveApprovedCapSubject(input: {
  skillId?: string;
  connectorId?: string;
}): ApprovedCapSubject {
  const hasSkill = !!input.skillId;
  const hasConnector = !!input.connectorId;
  if (hasSkill === hasConnector) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message:
        'approved-caps: exactly one of skillId or connectorId is required (a grant is attributed to one subject)',
    });
  }
  return hasConnector ? { connectorId: input.connectorId! } : { skillId: input.skillId! };
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
//     (delete-path in-use guard) or `agents:list-for-user` (TASK-85, the
//     /settings/skills/authored aggregation) because @ax/agents already declares
//     `optionalCalls: skills:list-authored` — declaring the reverse edge here
//     (even as optionalCalls) would form a skills↔agents call-graph CYCLE that
//     boot's cycle detection rejects. Both are `bus.hasService`-guarded and
//     degrade gracefully (no in-use check / no authored listing) when @ax/agents
//     is absent. (TASK-100 removed the `credentials:list` / `credentials:delete`
//     soft-dep usage — a skill no longer owns credential rows to purge.)
// ---------------------------------------------------------------------------

// TASK-100 — the skill credential-purge helper was removed: a skill manifest no
// longer declares credential slots (its reach is the connectors it references),
// so a skill upsert/delete never owns `skill:<id>:<slot>` credential rows to
// purge. A connector's credential lifecycle is owned by @ax/connectors /
// @ax/credentials, not the skill store.

// SkillsPluginConfig is intentionally empty: the bundle byte-store is now the
// shared content-addressed `blob:*` store (out-of-git Part D2 — the TASK-40
// git-tree backing and its `bundleStore.repoRoot` are retired). Durability,
// dedup, and the GC story all come from the blob store; nothing here to
// configure. Kept as a named type so existing `createSkillsPlugin(config.skills)`
// call sites and the preset's `config.skills` slot stay type-stable.
export type SkillsPluginConfig = Record<string, never>;

export function createSkillsPlugin(_config: SkillsPluginConfig = {}): Plugin {
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
        'skills:approved-caps-list',
        'skills:approved-caps-set',
        'skills:approved-caps-revoke',
        // TASK-74 (out-of-git Part D): the skill_propose chokepoint + the
        // authored-skill projection read that re-backs agents:resolve-authored-
        // skills onto DB rows (replacing the .ax/draft-skills workspace scan).
        'skills:propose',
        'skills:list-authored',
        // TASK-76 (§D3): flip a pending authored skill → active once a human
        // approves its caps (called by the orchestrator's authored-grant flow).
        'skills:authored-activate',
      ],
      calls: [
        'database:get-instance',
        'http:register-route',
        'auth:require-user',
        // out-of-git Part D2: skill bundle EXTRA files are stored as one
        // content-addressed object in the shared blob store (retires the
        // TASK-40 git-tree backing). Hard deps → init-ordering edges so the
        // blob backend (@ax/blob-store-fs|s3) is up before we read/write a
        // bundle. The chat path is single-file SKILL.md only, so bundles ride
        // these only for multi-file catalog/authored skills.
        'blob:put',
        'blob:get',
      ],
      optionalCalls: [
        {
          // TASK-100 — the cap→connector data migration (run at init) lifts each
          // legacy skill `capabilities:` block into a connector via this hook.
          // Optional (init-ordering edge so @ax/connectors is up first); when the
          // connectors plugin is absent the migration still STRIPS the cap block
          // so the manifest stays schema-valid (the skill loses that reach until
          // a connector is created). No call-graph cycle: connectors never calls
          // skills.
          hook: 'connectors:upsert',
          degradation:
            'the TASK-100 cap→connector migration strips the legacy capability block but cannot create the connector (no connectors store) — the skill loses that reach until a connector is authored',
        },
      ],
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

      // TASK-100 — split any stored skill's legacy `capabilities:` block into a
      // connector (via the connectors:upsert HOOK — invariant #4) and rewrite the
      // skill to reference it. Idempotent + re-runnable; greenfield typically
      // migrates zero rows. Best-effort: a failure logs + never wedges boot (so a
      // connector hiccup can't block the skills store coming up).
      try {
        await migrateSkillCapabilitiesToConnectors(db, bus, initCtx);
      } catch (err) {
        initCtx.logger.warn('skill_cap_migration_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Construct the content-addressed bundle byte-store ONCE and inject the
      // SAME instance into every store so identical bytes dedup across scopes.
      // Now blob-backed (out-of-git Part D2): bundle EXTRA files are written as
      // one object via blob:put and read via blob:get — durability, dedup, and
      // GC all come from the shared blob store. The store-owned initCtx is the
      // correct ctx because blob:* is purely content-addressed (no ownership
      // scope), so it carries only the logger.
      const bundleStore = createBlobBundleStore(bus, initCtx);
      const store = createSkillsStore(db, bundleStore);
      const userStore = createUserSkillsStore(db, bundleStore);
      const attachmentsStore = createUserAttachmentsStore(db);
      // Reuse the shared content-addressed bundle store so a share snapshot
      // dedups against the source skill's own bundle and admit re-derives the
      // SAME sha when it registers the bundle in the global catalog.
      const catalogRequestsStore = createCatalogRequestsStore(db, bundleStore);
      const quarantineStore = createSkillsQuarantineStore(db);
      const approvedCapsStore = createApprovedCapsStore(db);
      // TASK-74 — authored-skills store (the .ax/draft-skills replacement).
      // Shares the SAME content-addressed bundle store so an authored bundle's
      // extra files dedup against any other skill's identical bytes.
      const authoredStore = createAuthoredSkillsStore(db, bundleStore);

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
          // I-S2 (TASK-100): default-attached skills are instruction-only — but a
          // skill manifest can no longer declare credential slots at ALL (reach
          // lives only on the connectors it references), so the old "default-on
          // skill must not carry credentials" reject is now trivially satisfied
          // and has been removed. A connector's reach-by-attachment is its own
          // gated path; a default-attached skill simply names connectors.

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

          // scope === 'global'.
          //
          // TASK-100 — a skill manifest no longer declares credential slots, so
          // there is nothing to purge on a manifest edit (the old
          // remove-slots → purgeSkillCredentials dance is gone). A skill's reach
          // is its connectors; a connector's credential lifecycle is owned by
          // @ax/connectors / @ax/credentials, not the skill upsert.
          const skillId = parsed.value.id;

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

          // TASK-100 — a skill no longer declares credential slots (its reach is
          // its connectors), so deleting a skill never leaves orphan skill-keyed
          // credential rows: the old read-slots → delete → purgeSkillCredentials
          // dance is gone. A connector's credentials are owned + cleaned up by
          // @ax/connectors / @ax/credentials, independent of the skill row.
          await store.delete(input.skillId);
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
          // id — same precedence as skills:resolve) to confirm it exists.
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

          // TASK-100 — a skill declares NO credential slots (its reach is the
          // connectors it references), so the attachment must carry no bindings.
          // Validate against an EMPTY declared-slot set: any supplied binding is a
          // `binding-orphan` (a skill has nothing to bind to). The attachment row
          // still records WHICH skill is attached; credential reach is the
          // connector's, gated by the connector approval flow.
          const check = validateAttachmentBindings([], input.credentialBindings);
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
      // string is just a no-match. TASK-100 — a skill declares no capabilities,
      // so `tier` is always 'inert' and `hosts`/`slots` are empty (a skill's
      // reach is the connectors it references; the broker surfaces those
      // separately via the connector approval card).
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
              tier: classifyTier(),
              hosts: [],
              slots: [],
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

      bus.registerService<SkillsApprovedCapsListInput, SkillsApprovedCapsListOutput>(
        'skills:approved-caps-list',
        PLUGIN_NAME,
        async (_ctx, input) => {
          // TASK-93: the grant subject is exactly one of {skill, connector}.
          const subject = resolveApprovedCapSubject(input);
          return {
            capabilities: await approvedCapsStore.list({
              ownerUserId: input.ownerUserId,
              agentId: input.agentId,
              ...subject,
            }),
          };
        },
        { returns: SkillsApprovedCapsListOutputSchema },
      );
      bus.registerService<SkillsApprovedCapsSetInput, SkillsApprovedCapsSetOutput>(
        'skills:approved-caps-set',
        PLUGIN_NAME,
        async (_ctx, input) => {
          // FIX 3 (defense-in-depth): MCP approval is deferred — no caller
          // should write an mcp approval row yet. Reject at the store layer so
          // even a future caller that forgets the caller-side exclusion can't
          // silently persist a partially-implemented MCP grant.
          if (input.kind === 'mcp') {
            throw new PluginError({
              code: 'not-supported',
              plugin: PLUGIN_NAME,
              message: "approved-caps-set: kind 'mcp' is not yet supported",
            });
          }
          const subject = resolveApprovedCapSubject(input);
          return approvedCapsStore.set({
            ownerUserId: input.ownerUserId,
            agentId: input.agentId,
            kind: input.kind,
            value: input.value,
            ...(input.detail !== undefined ? { detail: input.detail } : {}),
            ...subject,
          });
        },
        { returns: SkillsApprovedCapsSetOutputSchema },
      );
      bus.registerService<SkillsApprovedCapsRevokeInput, SkillsApprovedCapsRevokeOutput>(
        'skills:approved-caps-revoke',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const subject = resolveApprovedCapSubject(input);
          return approvedCapsStore.clear({
            ownerUserId: input.ownerUserId,
            agentId: input.agentId,
            kind: input.kind,
            value: input.value,
            ...subject,
          });
        },
        { returns: SkillsApprovedCapsRevokeOutputSchema },
      );

      // -----------------------------------------------------------------------
      // skills:propose (TASK-74, out-of-git Part D / §D1–D3) — the SINGLE write
      // chokepoint for agent-authored skills. The runner ships a structurally-
      // validated bundle over the skill.propose IPC action; the host handler
      // calls this hook. We:
      //   1. re-validate structurally (parseSkillManifest + validateBundleFiles
      //      — defense-in-depth at the trust boundary; the untrusted bundle is
      //      re-checked at every hop, the validateMcpEntry pattern);
      //   2. fire the skills:scan veto/scan hook (the validator-skill veto's new
      //      home — accept-but-annotate; a missing scanner degrades to 'clean');
      //   3. run the hybrid materialization gate (classifyProposal): clean +
      //      authored + zero-cap → active; any cap / non-authored → pending; scan
      //      hit → quarantined;
      //   4. write ONE skills_v1_authored row (origin/status/scan_verdict);
      //   5. fire skills:proposed (notify) so the orchestrator re-spawns the
      //      proposing session next turn (a freshly-active skill is only visible
      //      at the next spawn — design §D6).
      // Quarantine/structural-reject reasons are returned to the agent so it can
      // tell the user what to fix.
      // -----------------------------------------------------------------------
      bus.registerService<SkillsProposeInput, SkillsProposeOutput>(
        'skills:propose',
        PLUGIN_NAME,
        async (ctx, input) => {
          // 1. Structural re-validation (the host never trusts the runner's
          // claim that the bundle is well-formed).
          const parsed = parseSkillManifest(input.manifestYaml);
          if (!parsed.ok) {
            throw new PluginError({
              code: parsed.code,
              plugin: PLUGIN_NAME,
              message: parsed.message,
            });
          }
          try {
            validateBundleFiles(input.files);
          } catch (err) {
            throw new PluginError({
              code: 'invalid-bundle-file',
              plugin: PLUGIN_NAME,
              message: err instanceof Error ? err.message : String(err),
            });
          }
          const skillId = parsed.value.id;

          // TASK-100 — a skill manifest declares NO capabilities (reach lives
          // only on the connectors a skill references). So there is no capability
          // proposal to classify on: the gate now keys only on origin + scan. We
          // still re-parse the manifest host-side (above) as the structural
          // source of truth and ignore the wire `capabilityProposal` hint.

          // 2. Safety scan (the validator-skill veto, now at the propose
          // chokepoint). A missing scanner degrades to 'clean' — the regex
          // floor is the scanner's own concern; absent it, we don't block.
          let scanClean = true;
          let scanVerdict: string | null = null;
          if (bus.hasService('skills:scan')) {
            try {
              const r = await bus.call<SkillsScanInput, SkillsScanOutput>(
                'skills:scan',
                ctx,
                {
                  skillId,
                  manifestYaml: input.manifestYaml,
                  bodyMd: input.bodyMd,
                  files: input.files,
                },
              );
              if (r.verdict === 'hit') {
                scanClean = false;
                scanVerdict = r.reason ?? 'flagged by the skill safety scan';
              }
            } catch (err) {
              // A scanner OUTAGE degrades to 'clean' (scanClean stays true) — the
              // scan never blocks authoring (the validator's own posture: the scan
              // is accept-but-annotate, not the security boundary; capability
              // approval is). The residual risk is bounded: the free path is
              // already restricted to zero-cap + authored instruction text, the
              // exact case the lazy redesign accepted "best-effort scan only" for
              // (design §D3); anything with reach is `pending` regardless, gated on
              // human approval. Logged so an outage is observable.
              ctx.logger.warn('skills_scan_failed', {
                skillId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // 3. Materialization gate (origin + scan only — a skill has no caps).
          const status = classifyProposal({
            origin: input.origin,
            scanClean,
          });

          // 4. Persist ONE row (last-write-wins per draft).
          await authoredStore.upsert({
            ownerUserId: input.ownerUserId,
            agentId: input.agentId,
            skillId,
            description: parsed.value.description,
            manifestYaml: input.manifestYaml,
            bodyMd: input.bodyMd,
            origin: input.origin,
            status,
            scanVerdict,
            files: input.files,
          });

          // 5. Notify so the orchestrator re-spawns next turn. Fire-and-forget;
          // a missing subscriber is fine (the next manual turn re-spawns anyway).
          await bus.fire('skills:proposed', ctx, {
            ownerUserId: input.ownerUserId,
            agentId: input.agentId,
            skillId,
            status,
          } satisfies SkillsProposedEvent);

          const reason =
            status === 'quarantined' && scanVerdict !== null ? scanVerdict : undefined;
          return reason !== undefined ? { skillId, status, reason } : { skillId, status };
        },
        { returns: SkillsProposeOutputSchema },
      );

      // -----------------------------------------------------------------------
      // skills:list-authored (TASK-74) — the DB read that re-backs
      // agents:resolve-authored-skills (replacing the .ax/draft-skills workspace
      // scan). Returns the agent's authored skills in projection shape (manifest
      // /body/files + gate status + scan reason). The agents-side projection
      // OMITS quarantined rows and intersects the proposal with approved caps.
      // -----------------------------------------------------------------------
      bus.registerService<SkillsListAuthoredInput, SkillsListAuthoredOutput>(
        'skills:list-authored',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const rows = await authoredStore.list(input.ownerUserId, input.agentId);
          const skills: AuthoredSkillProjection[] = rows.map((r) => ({
            skillId: r.skillId,
            description: r.description,
            manifestYaml: r.manifestYaml,
            bodyMd: r.bodyMd,
            files: r.files,
            status: r.status,
            ...(r.scanVerdict !== null ? { reason: r.scanVerdict } : {}),
          }));
          return { skills };
        },
        { returns: SkillsListAuthoredOutputSchema },
      );

      // -----------------------------------------------------------------------
      // skills:authored-activate (TASK-76, §D3) — flip a pending authored skill
      // to `active` once a human approves its caps. The orchestrator's
      // authored-grant flow calls this AFTER writing the approved-caps rows, so
      // the next spawn's projection includes the now-active skill (its body
      // bytes project + caps inject). Status-guarded in the store: only a
      // `pending` row flips (a quarantined row is never un-quarantined; an
      // already-active row no-ops). Idempotent — a duplicate approval flips zero.
      // -----------------------------------------------------------------------
      bus.registerService<SkillsAuthoredActivateInput, SkillsAuthoredActivateOutput>(
        'skills:authored-activate',
        PLUGIN_NAME,
        async (_ctx, input) =>
          authoredStore.activate({
            ownerUserId: input.ownerUserId,
            agentId: input.agentId,
            skillId: input.skillId,
          }),
        { returns: SkillsAuthoredActivateOutputSchema },
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
