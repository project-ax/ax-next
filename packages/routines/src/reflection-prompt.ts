/**
 * The skill-reflection meta-prompt (TASK-178, skill-crystallization PR-C).
 *
 * This is the substantive new IP of the skill-crystallization feature: the
 * instruction body the `skill-reflection` default routine runs the agent
 * against, in a hidden per-fire reflection turn, inside the agent's own
 * sandbox. It borrows Hermes' genuinely good skill-authoring parts (prefer
 * patch over create; an explicit anti-pattern list) and deliberately inverts
 * one (Hermes nudges the model to always do *something*; we make a no-op the
 * correct, common default and gate any crystallization on cited recurrence).
 *
 * The prompt is INSTRUCTION-ONLY by design — it tells the agent to author
 * instruction-only skills via the existing `skill_propose` tool, never to
 * declare connectors to force an auto-active landing. It does not, itself,
 * grant or widen any capability: it is text the model reads. The capability
 * fence is enforced host-side at `skills:propose` (origin + scan gate), not
 * in this prompt.
 *
 * The contract this prompt establishes — relied on by the seed (C2), the
 * routine machinery (silence_token), and downstream walks/TASK-179:
 *   - Short-circuit marker: `.ax/skill-reflection/last-run.json` records the
 *     memory state last seen; an unchanged memory → an immediate REFLECTION_DONE.
 *   - Recurrence gate: a procedure must appear in ≥2 DISTINCT past conversations
 *     before it may be crystallized (the structural inversion of Hermes). The
 *     recurrence signal is read STRAIGHT FROM consolidated memory — each
 *     `memory/docs/<category>/<slug>.md` page's `source_conversations`
 *     frontmatter is the set of distinct conversation ids merged into it, so
 *     `source_conversations.length >= 2` means the procedure recurred across ≥2
 *     conversations. This deliberately does NOT grep `.claude/projects/`
 *     transcripts: TASK-67 gitignores transcripts out of `/agent`, and TASK-187
 *     moved the signal to consolidated memory (materialized by @ax/memory-strata's
 *     consolidator) so no transcript-read surface is needed.
 *   - Hard limits: ≤3 author/patch ops per pass; an explicit anti-pattern list
 *     of what NOT to crystallize.
 *   - Silence token: the turn ends with exactly `REFLECTION_DONE`, which the
 *     routine's `silence_token` keys off so a no-op pass is recorded silenced
 *     (not surfaced to the user).
 *
 * Keep the literal `REFLECTION_DONE` token and the `.ax/skill-reflection/last-run.json`
 * marker path in sync with the seed in `migrations.ts` (silence_token) and the
 * crystallization canary in `@ax/skills` (prompt-guard assertions).
 */
export const SKILL_REFLECTION_PROMPT = `You are running an autonomous self-improvement reflection on your own past work. Nobody is waiting on this; it is a background pass.

Your job: graduate procedures you have PROVEN repeatedly into durable skills, and fix skills you've found wrong. A pass that changes nothing is the correct, common outcome — do NOT invent work.

## Step 1 — Short-circuit
Read \`.ax/skill-reflection/last-run.json\` if it exists. If your consolidated memory (\`memory/system/recent.md\`) has not changed since the commit/timestamp recorded there, you are done: reply with exactly REFLECTION_DONE and stop. Otherwise continue, and at the end write the current memory state back to that marker.

## Step 2 — Find recurring procedures
Your consolidated memory (\`memory/system/recent.md\` and \`memory/docs/\`) already represents reinforced, surviving learnings — start there. For any procedure it implies, CONFIRM it actually recurred: it must appear in at least 2 DISTINCT past conversations.

Read this directly from the consolidated memory — do NOT grep transcripts. Each \`memory/docs/<category>/<slug>.md\` page carries a \`source_conversations\` field in its YAML frontmatter: the list of DISTINCT conversation ids whose observations were merged into that page. That list IS the recurrence evidence. A procedure is grounded in 2 DISTINCT past conversations only when the doc backing it has \`source_conversations\` with **2 or more entries**. If the relevant doc's \`source_conversations\` has fewer than 2 entries (or the field is absent), the procedure recurred in at most one conversation — it is NOT ready to be a skill, so leave it.

## Step 3 — Crystallize (prefer patch over create)
In order of preference:
1. If an existing skill of yours covers this procedure but is wrong/incomplete, PATCH it.
2. If an existing skill is close, add to it.
3. Only if nothing covers it, CREATE a new skill.
Author/patch the skill, then call the \`skill_propose\` tool to propose it. Keep skills INSTRUCTION-ONLY: do not declare connectors/capabilities. If a procedure genuinely cannot work without a connector, you may declare it — it will go to the user for approval rather than activating — but prefer instruction-only.

## Hard limits
- At most 3 author/patch operations this pass. Pick the highest-value ones.
- Do NOT crystallize: environment-dependent failures, one-off/transient errors, negative claims about a tool ("X doesn't work"), or specifics of a single session. These are memory's job, not a skill's.

## Step 4 — Finish
Update \`.ax/skill-reflection/last-run.json\`, then reply with exactly REFLECTION_DONE.`;
