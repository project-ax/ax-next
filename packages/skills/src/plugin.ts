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

      bus.registerService<SkillsListInput, SkillsListOutput>(
        'skills:list',
        PLUGIN_NAME,
        async () => ({ skills: await store.list() }),
      );

      bus.registerService<SkillsGetInput, SkillsGetOutput>(
        'skills:get',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const found = await store.get(input.skillId);
          if (!found) {
            throw new PluginError({
              code: 'skill-not-found',
              plugin: PLUGIN_NAME,
              message: `skill '${input.skillId}' does not exist`,
            });
          }
          return found;
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
          // I-P1-6: refuse delete when any agent has the skill attached.
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
        async (_ctx, input) => ({ skills: await store.resolve(input.skillIds) }),
      );

      bus.registerService<SkillsListDefaultsInput, SkillsListDefaultsOutput>(
        'skills:list-defaults',
        PLUGIN_NAME,
        async () => ({ skills: await store.getDefaults() }),
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
