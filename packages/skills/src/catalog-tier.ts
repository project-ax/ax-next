/**
 * Supply-chain risk tier for a catalog skill (design §3).
 *
 *  - 'registry' — declares npm/pypi packages (npx/uvx/pip download at runtime)
 *  - 'bounded'  — fixed/reviewed egress: http MCP, an allowlisted host, or a key
 *  - 'inert'    — instruction-only
 *
 * TASK-100 — a skill manifest no longer declares any capabilities (reach lives
 * only on the connectors a skill references), so a skill is ALWAYS instruction-
 * only: its tier is `'inert'` by construction. The supply-chain risk now lives
 * on the CONNECTOR (packages / hosts / MCP / credentials are its fields); a
 * connector-level tier is a future refinement. `classifyTier()` is kept (no
 * args, constant) so the catalog tier badge has one source of truth and the
 * call sites read unchanged.
 */
export type SkillTier = 'inert' | 'bounded' | 'registry';

export function classifyTier(): SkillTier {
  return 'inert';
}
