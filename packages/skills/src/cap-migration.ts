/**
 * Legacy skill-capability strip (originally the TASK-100 cap→connector data
 * migration).
 *
 * Why this exists. During the half-wired window (TASK-91…TASK-111) a skill
 * declared its reach inline as a `capabilities:` block. TASK-100 removed that
 * block from the manifest schema (the parser hard-rejects it), so any stored
 * skill row whose `manifest_yaml` still carries one would fail to parse. This
 * pass rewrites each such manifest without the block so every stored skill is
 * schema-valid.
 *
 * It NO LONGER creates connectors. Only admins define connectors, so the old
 * "lift the block into a private connector owned by the skill owner" step is
 * gone. A skill that relied on its legacy reach loses it (the product owner
 * accepted that); each such row logs `skills_cap_migration_reach_dropped` with
 * ids only (never host/slot/secret values). Existing `connectors:` references
 * in the manifest are kept untouched.
 *
 * Idempotent + re-runnable. A skill whose manifest has NO `capabilities:` key is
 * skipped (already migrated, or never had caps). Never wedges boot.
 */
import { load as yamlLoad } from 'js-yaml';
import type { Kysely } from 'kysely';
import type { AgentContext } from '@ax/core';
import { buildSkillManifestYaml } from '@ax/skills-parser';
import type { SkillsDatabase } from './migrations.js';

// Shape of the legacy `capabilities:` block, extracted from the stored YAML only
// to tell whether it carried any reach (for the dropped-reach log line).
interface LegacyCapabilities {
  allowedHosts: string[];
  credentials: Array<{ slot: string; kind: 'api-key'; description?: string; account?: string }>;
  mcpServers: Array<Record<string, unknown>>;
  packages: { npm: string[]; pypi: string[] };
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
 * Rewrite ONE stored manifest YAML: parse the raw YAML and drop the legacy
 * `capabilities` block, keeping any existing `connectors:` references as-is.
 * Returns null when the manifest carries NO capabilities block (nothing to
 * migrate — already cap-free). `hadReach` says whether the dropped block
 * declared any reach.
 *
 * The rewritten manifest is built with buildSkillManifestYaml so it round-trips
 * through the (cap-free) parser. The skill name/description/version are read from
 * the raw doc (not the parser, which would reject the legacy block).
 */
export function rewriteManifestDroppingCaps(
  manifestYaml: string,
): { manifestYaml: string; hadReach: boolean } | null {
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
  const connectors = Array.isArray(obj['connectors'])
    ? (obj['connectors'] as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];

  const rewritten = buildSkillManifestYaml({ id, description, version, connectors });
  return { manifestYaml: rewritten, hadReach: hasReach(caps) };
}

interface SkillRowLite {
  skill_id: string;
  manifest_yaml: string;
  owner_user_id?: string;
}

/**
 * Run the legacy-capability strip over both skill tables. Best-effort + non-
 * fatal: a per-row failure is logged and skipped (one bad row never wedges boot
 * or blocks the rest). Creates NO connectors. Returns a small summary for
 * logging/tests.
 */
export async function migrateSkillCapabilitiesToConnectors(
  db: Kysely<SkillsDatabase>,
  ctx: AgentContext,
): Promise<{ migrated: number; skipped: number }> {
  let migrated = 0;
  let skipped = 0;

  async function migrateRow(
    table: 'skills_v1_skills' | 'skills_v1_user_skills',
    row: SkillRowLite,
    ownerUserId: string,
  ): Promise<void> {
    const result = rewriteManifestDroppingCaps(row.manifest_yaml);
    if (result === null) {
      skipped++;
      return;
    }
    if (result.hadReach) {
      ctx.logger.warn('skills_cap_migration_reach_dropped', {
        skillId: row.skill_id,
        ownerUserId,
      });
    }
    // The body lives in a separate column, so we only touch manifest_yaml.
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
        .where('owner_user_id', '=', ownerUserId)
        .where('skill_id', '=', row.skill_id)
        .execute();
    }
    migrated++;
  }

  // Global skills — attributed to the workspace 'system' user in the log.
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

  // User-scoped skills — attributed to the skill's owner.
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

  if (migrated > 0) {
    ctx.logger.info?.('skill_cap_migration_complete', { migrated, skipped });
  }
  return { migrated, skipped };
}
