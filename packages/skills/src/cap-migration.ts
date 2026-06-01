/**
 * TASK-100 data migration — split each existing skill's legacy `capabilities`
 * block into a CONNECTOR and rewrite the skill to reference that connector.
 *
 * Why this exists. During the half-wired window (TASK-91…TASK-111) a skill
 * declared its reach inline as a `capabilities:` block. TASK-100 removes that
 * block from the manifest schema (the parser now hard-rejects it), so any stored
 * skill row whose `manifest_yaml` still carries one would fail to parse. This
 * migration lifts each such block out into a connector (named after the skill),
 * rewrites the skill's manifest to drop the block + reference the connector, and
 * updates the row — so every stored skill is schema-valid post-migration and its
 * reach survives via the connector path (the skill→connector bridge, TASK-111).
 *
 * Idempotent + re-runnable. A skill whose manifest has NO `capabilities:` key is
 * skipped (already migrated, or never had caps). Re-running upserts the same
 * connector id (the store keys by (owner, connectorId)) and leaves the already-
 * cap-free skill untouched. ax-next is greenfield (no production data), so this
 * typically migrates zero rows — but it must be correct for any seeded/dev rows.
 *
 * Invariant #4 — the connector write goes through the `connectors:upsert` HOOK,
 * never raw SQL into @ax/connectors' tables. hasService-gated: if @ax/connectors
 * is absent (e.g. the CLI canary preset), the cap block is still STRIPPED (the
 * manifest must be schema-valid regardless) and a warning is logged — the skill
 * loses that reach until a connector is created, but it never wedges boot.
 *
 * Standalone MCP-server rows: TASK-98 already collapsed the standalone MCP-
 * servers form INTO the connector registry (no `mcp_servers` table exists), so
 * there is nothing to migrate at the data layer for those.
 */
import { load as yamlLoad } from 'js-yaml';
import type { Kysely } from 'kysely';
import type { AgentContext, HookBus } from '@ax/core';
import { buildSkillManifestYaml } from '@ax/skills-parser';
import type { SkillsDatabase } from './migrations.js';

// Structural mirror of @ax/connectors' Capabilities (I2 — no @ax/connectors
// import; the inter-plugin contract is the hook, not a TS import). This is the
// SAME shape @ax/skills-parser exports as Capabilities; re-declared here as the
// shape we extract from the legacy YAML before handing it to connectors:upsert.
interface LegacyCapabilities {
  allowedHosts: string[];
  credentials: Array<{ slot: string; kind: 'api-key'; description?: string; account?: string }>;
  mcpServers: Array<Record<string, unknown>>;
  packages: { npm: string[]; pypi: string[] };
}

// connectors:upsert input (the subset we send). Structural mirror per I2.
interface ConnectorUpsertInput {
  userId: string;
  connectorId: string;
  name: string;
  description?: string;
  keyMode: 'personal' | 'workspace';
  visibility: 'private' | 'shared';
  capabilities: LegacyCapabilities;
}

// connectors:get input — used to check whether a connector already exists so the
// migration NEVER clobbers a pre-existing (e.g. admin-curated) connector of the
// same id. Structural mirror per I2.
interface ConnectorGetInput {
  userId: string;
  connectorId: string;
}

// A connector id derived from a skill id: the skill id already satisfies the
// connector slug grammar (`^[a-z0-9][a-z0-9_-]*$`, ≤128) — it is the manifest
// NAME_RE (`^[a-z][a-z0-9-]{0,63}$`), a strict subset — so we reuse it verbatim.
// Re-using the skill id keeps the migration idempotent (a re-run upserts the same
// connector id) and the reference obvious.
function connectorIdForSkill(skillId: string): string {
  return skillId;
}

// True iff the raw YAML object carries a (legacy) capability block worth
// migrating. A skill with no capabilities key (or an all-empty one) needs only
// a no-op strip, but we still rewrite to guarantee the parser accepts it.
function extractLegacyCapabilities(doc: Record<string, unknown>): LegacyCapabilities | null {
  const raw = doc['capabilities'];
  if (raw === undefined) return null;
  const caps = (raw !== null && typeof raw === 'object' && !Array.isArray(raw))
    ? (raw as Record<string, unknown>)
    : {};
  const allowedHosts = Array.isArray(caps['allowedHosts'])
    ? (caps['allowedHosts'] as unknown[]).filter((h): h is string => typeof h === 'string')
    : [];
  const credentials = Array.isArray(caps['credentials'])
    ? (caps['credentials'] as unknown[])
        .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
        .map((c) => ({
          slot: String(c['slot'] ?? ''),
          kind: 'api-key' as const,
          ...(typeof c['description'] === 'string' ? { description: c['description'] } : {}),
          ...(typeof c['account'] === 'string' ? { account: c['account'] } : {}),
        }))
    : [];
  const mcpServers = Array.isArray(caps['mcpServers'])
    ? (caps['mcpServers'] as unknown[]).filter(
        (m): m is Record<string, unknown> => m !== null && typeof m === 'object',
      )
    : [];
  const pkgsRaw = (caps['packages'] !== null && typeof caps['packages'] === 'object')
    ? (caps['packages'] as Record<string, unknown>)
    : {};
  const npm = Array.isArray(pkgsRaw['npm'])
    ? (pkgsRaw['npm'] as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  const pypi = Array.isArray(pkgsRaw['pypi'])
    ? (pkgsRaw['pypi'] as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  return { allowedHosts, credentials, mcpServers, packages: { npm, pypi } };
}

function hasReach(caps: LegacyCapabilities): boolean {
  return (
    caps.allowedHosts.length > 0 ||
    caps.credentials.length > 0 ||
    caps.mcpServers.length > 0 ||
    caps.packages.npm.length > 0 ||
    caps.packages.pypi.length > 0
  );
}

/**
 * Rewrite ONE stored manifest YAML: parse the raw YAML, drop the legacy
 * `capabilities` block, and (when the skill had real reach) add a `connectors:`
 * reference to the derived connector id (merged with any existing connectors,
 * deduped, order-preserving). Returns null when the manifest carries NO
 * capabilities block (nothing to migrate — already cap-free).
 *
 * The rewritten manifest is built with buildSkillManifestYaml so it round-trips
 * through the (cap-free) parser. The skill name/description/version are read from
 * the raw doc (not the parser, which would reject the legacy block).
 */
export function rewriteManifestDroppingCaps(
  manifestYaml: string,
): { manifestYaml: string; capabilities: LegacyCapabilities | null; connectorId: string | null } | null {
  let doc: unknown;
  try {
    doc = yamlLoad(manifestYaml);
  } catch {
    return null; // unparseable YAML — leave it (a separate concern; never crash boot)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const obj = doc as Record<string, unknown>;
  const caps = extractLegacyCapabilities(obj);
  if (caps === null) return null; // no capabilities key → already cap-free

  const id = typeof obj['name'] === 'string' ? (obj['name'] as string) : '';
  const description = typeof obj['description'] === 'string' ? (obj['description'] as string) : '';
  const version =
    typeof obj['version'] === 'number' && Number.isInteger(obj['version']) && obj['version'] >= 0
      ? (obj['version'] as number)
      : 0;
  const existingConnectors = Array.isArray(obj['connectors'])
    ? (obj['connectors'] as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];

  const connectorId = hasReach(caps) ? connectorIdForSkill(id) : null;
  const connectors = connectorId !== null && !existingConnectors.includes(connectorId)
    ? [...existingConnectors, connectorId]
    : existingConnectors;

  const rewritten = buildSkillManifestYaml({ id, description, version, connectors });
  return { manifestYaml: rewritten, capabilities: caps, connectorId };
}

interface SkillRowLite {
  skill_id: string;
  manifest_yaml: string;
  owner_user_id?: string;
}

/**
 * Run the cap→connector migration over both skill tables. Best-effort + non-
 * fatal: a per-row failure is logged and skipped (one bad row never wedges boot
 * or blocks the rest). Returns a small summary for logging/tests.
 */
export async function migrateSkillCapabilitiesToConnectors(
  db: Kysely<SkillsDatabase>,
  bus: HookBus,
  ctx: AgentContext,
): Promise<{ migrated: number; connectorsUpserted: number; skipped: number }> {
  let migrated = 0;
  let connectorsUpserted = 0;
  let skipped = 0;

  const canUpsert = bus.hasService('connectors:upsert');
  const canGet = bus.hasService('connectors:get');

  // True iff a LIVE connector with this id already exists for the owner — so the
  // migration must NOT clobber it (e.g. an admin-curated connector that happens to
  // share the skill's id). connectors:get throws `not-found` when absent.
  async function connectorExists(ownerUserId: string, connectorId: string): Promise<boolean> {
    if (!canGet) return false;
    try {
      await bus.call<ConnectorGetInput, unknown>('connectors:get', ctx, {
        userId: ownerUserId,
        connectorId,
      });
      return true;
    } catch {
      return false; // not-found (or any read error) → treat as absent; upsert below
    }
  }

  async function migrateRow(
    table: 'skills_v1_skills' | 'skills_v1_user_skills',
    row: SkillRowLite,
    ownerForConnector: string,
  ): Promise<void> {
    const result = rewriteManifestDroppingCaps(row.manifest_yaml);
    if (result === null) {
      skipped++;
      return;
    }
    // 1. Create the connector via the hook (invariant #4) when the skill had
    //    real reach. A reach-less skill just gets its empty cap block stripped.
    //    SAFETY: never clobber a pre-existing connector of the same id (e.g. an
    //    admin-curated one) — only create when absent. This also makes a re-run
    //    after a partial migration idempotent (the connector survives even if the
    //    skill row's rewrite failed last time).
    if (result.connectorId !== null && result.capabilities !== null && canUpsert) {
      if (await connectorExists(ownerForConnector, result.connectorId)) {
        ctx.logger.warn('skill_cap_migration_connector_exists_skipped', {
          skillId: row.skill_id,
          connectorId: result.connectorId,
        });
      } else {
        try {
          await bus.call<ConnectorUpsertInput, unknown>('connectors:upsert', ctx, {
            userId: ownerForConnector,
            connectorId: result.connectorId,
            name: row.skill_id,
            description: `Migrated from the "${row.skill_id}" skill's capabilities (TASK-100).`,
            // Personal/private is the safe default: a per-user JIT key, owner-only
            // reach. An admin can re-curate (workspace/shared, default-on) later.
            keyMode: 'personal',
            visibility: 'private',
            capabilities: result.capabilities,
          });
          connectorsUpserted++;
        } catch (err) {
          ctx.logger.warn('skill_cap_migration_connector_upsert_failed', {
            skillId: row.skill_id,
            error: err instanceof Error ? err.message : String(err),
          });
          // Fall through: still strip the cap block so the manifest stays valid.
        }
      }
    } else if (result.connectorId !== null && !canUpsert) {
      ctx.logger.warn('skill_cap_migration_no_connectors_plugin', {
        skillId: row.skill_id,
      });
    }
    // 2. Rewrite the skill row's manifest (cap block stripped). The body lives in
    //    a separate column, so we only touch manifest_yaml.
    if (table === 'skills_v1_skills') {
      await db
        .updateTable('skills_v1_skills')
        .set({ manifest_yaml: result.manifestYaml, updated_at: new Date() })
        .where('skill_id', '=', row.skill_id)
        .execute();
    } else {
      await db
        .updateTable('skills_v1_user_skills')
        .set({ manifest_yaml: result.manifestYaml, updated_at: new Date() })
        .where('owner_user_id', '=', ownerForConnector)
        .where('skill_id', '=', row.skill_id)
        .execute();
    }
    migrated++;
  }

  // Global skills — the connector is owned by the workspace 'system' user (the
  // same init identity the skills plugin uses; an admin re-curates ownership/
  // sharing later). A per-row failure is isolated.
  const globalRows = await db
    .selectFrom('skills_v1_skills')
    .select(['skill_id', 'manifest_yaml'])
    .execute();
  for (const r of globalRows as SkillRowLite[]) {
    try {
      await migrateRow('skills_v1_skills', r, 'system');
    } catch (err) {
      ctx.logger.warn('skill_cap_migration_row_failed', {
        scope: 'global',
        skillId: r.skill_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // User-scoped skills — the connector is owned by the skill's owner.
  const userRows = await db
    .selectFrom('skills_v1_user_skills')
    .select(['owner_user_id', 'skill_id', 'manifest_yaml'])
    .execute();
  for (const r of userRows as SkillRowLite[]) {
    try {
      await migrateRow('skills_v1_user_skills', r, r.owner_user_id ?? 'system');
    } catch (err) {
      ctx.logger.warn('skill_cap_migration_row_failed', {
        scope: 'user',
        skillId: r.skill_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (migrated > 0 || connectorsUpserted > 0) {
    ctx.logger.info?.('skill_cap_migration_complete', {
      migrated,
      connectorsUpserted,
      skipped,
    });
  }
  return { migrated, connectorsUpserted, skipped };
}
