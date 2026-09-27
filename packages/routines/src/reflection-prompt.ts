/**
 * The skill-reflection meta-prompt (TASK-178, skill-crystallization PR-C;
 * rewritten for facts memory in TASK-611).
 *
 * This is the substantive IP of the skill-crystallization feature: the
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
 * The contract this prompt establishes — relied on by the seed (migrations.ts),
 * the routine machinery (silence_token), and the crystallization canary:
 *   - Short-circuit marker: `.ax/skill-reflection/last-run.json` records the
 *     date of the last pass; when `memory_recall` shows no evidence dated after
 *     it, the pass ends immediately with REFLECTION_DONE.
 *   - Recurrence gate: a procedure must appear in ≥2 DISTINCT past conversations
 *     before it may be crystallized (the structural inversion of Hermes). The
 *     signal is the `memory_recall` tool's per-answer conversation numbers
 *     (TASK-611): each evidence row carries `#n`, and two rows with the same
 *     number in one answer came from the same conversation. The numbers are
 *     not ids and are only comparable within ONE answer, which is why the gate
 *     says "in the same answer". This replaces Strata's `source_conversations`
 *     frontmatter (deleted with Strata in TASK-608). It still does NOT read
 *     transcripts: TASK-67 keeps them out of `/agent`, and naming them at all
 *     cued the model to go looking (TASK-188).
 *   - Hard limits: ≤3 author/patch ops per pass; an explicit anti-pattern list
 *     of what NOT to crystallize.
 *   - Silence token: the turn ends with exactly `REFLECTION_DONE`, which the
 *     routine's `silence_token` keys off so a no-op pass is recorded silenced
 *     (not surfaced to the user).
 *
 * ⚠ Changing this text does NOT reach an existing deployment by itself: the
 * seed is copied once (`ON CONFLICT DO NOTHING`). `migrations.ts` swaps the
 * prompt on rows still carrying an untouched older seed, keyed on
 * `SKILL_REFLECTION_SEED_HASH` — bump that constant, and extend the swap, when
 * you change the prompt again.
 *
 * Keep the literal `REFLECTION_DONE` token and the `.ax/skill-reflection/last-run.json`
 * marker path in sync with the seed in `migrations.ts` (silence_token) and the
 * crystallization canary in `@ax/skills` (prompt-guard assertions).
 */
/**
 * The seeded skill-reflection default routine's name (== its
 * `default_routine_id`).
 */
export const SKILL_REFLECTION_ROUTINE_NAME = 'skill-reflection';

/**
 * `spec_hash` of the seeded row carrying the CURRENT {@link SKILL_REFLECTION_PROMPT}.
 * An operator's own upsert replaces `spec_hash` with a real hash, so a
 * `seed-…` value means "still exactly what we seeded".
 */
export const SKILL_REFLECTION_SEED_HASH = 'seed-2026-09-27';

/** The seed hash of the Strata-era prompt (TASK-178), replaced by TASK-611. */
export const SKILL_REFLECTION_STRATA_SEED_HASH = 'seed-2026-06-08';

export const SKILL_REFLECTION_PROMPT = `You are running an autonomous self-improvement reflection on your own past work. Nobody is waiting on this; it is a background pass.

Your job: graduate procedures you have PROVEN repeatedly into durable skills, and fix skills you've found wrong. A pass that changes nothing is the correct, common outcome — do NOT invent work.

## Step 1 — Short-circuit
Read \`.ax/skill-reflection/last-run.json\` if it exists; it records the date of your last pass. Call the \`memory_recall\` tool with a query such as "procedures, workflows and step-by-step ways of doing things". If no evidence row is dated after the recorded date, you are done: reply with exactly REFLECTION_DONE and stop. Otherwise continue.

## Step 2 — Find recurring procedures
Use \`memory_recall\` to look for procedures: repeated ways of doing a task, and the corrections that shaped them. Search with a few focused queries, one per candidate procedure. For each candidate, CONFIRM it actually recurred: it must appear in at least 2 DISTINCT past conversations.

The recurrence evidence is the Conv column of the \`memory_recall\` evidence table. Every row recorded in a conversation carries a number such as #1 or #2; two rows with the same number in one answer came from the same conversation, and the line "Distinct conversations in this evidence" counts them. The numbers are only comparable within ONE answer, so judge each candidate from a single recall. A procedure is grounded in 2 DISTINCT past conversations only when the rows that actually describe it carry **2 or more different conversation numbers in the same answer**. Rows marked "-" were saved outside a conversation and do not count. Rows about these reflection passes, or about skills you created or proposed, do not count either. If the rows describing a procedure carry only one conversation number, it recurred in at most one conversation — it is NOT ready to be a skill, so leave it.

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
Write today's date to \`.ax/skill-reflection/last-run.json\`, then reply with exactly REFLECTION_DONE.`;
