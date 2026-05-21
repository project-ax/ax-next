import {
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
import type { Kysely } from 'kysely';
import { checkForUpdates } from './check-updates.js';
import { parseSkillManifest } from './manifest.js';
import { runSkillsMigration, type SkillsDatabase } from './migrations.js';
import { createSkillsStore } from './store.js';
import { createUserSkillsStore } from './user-store.js';
import { mergeUserWins, compareById } from './_merge.js';
import { registerAdminSkillsRoutes } from './admin-routes.js';
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

export function createSkillsPlugin(): Plugin {
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
      const store = createSkillsStore(db);
      const userStore = createUserSkillsStore(db);

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
      );

      // Register admin HTTP routes. Atomic try/catch unwind: if any route
      // registration fails after earlier ones succeeded, unwind the earlier
      // ones before rethrowing (bootstrap marks the plugin failed and won't
      // call shutdown, so the unwind must happen here).
      try {
        const unregisters = await registerAdminSkillsRoutes(bus, initCtx);
        routeUnregisters.push(...unregisters);
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
