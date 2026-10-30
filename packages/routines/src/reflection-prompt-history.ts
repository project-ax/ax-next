/**
 * Frozen — migration input only, never sent to a model. The 2026-09-27 seed
 * (TASK-611), byte for byte: it told the agent to keep
 * `.ax/skill-reflection/last-run.json`. Migration version 21 rewrites a catalog
 * row only while its prompt equals this text. Never edit it.
 *
 * (Copied mechanically from the previous `SKILL_REFLECTION_PROMPT` source, not
 * retyped. The genuine-v14 fixture test in `dual-method-migration.test.ts`
 * proves it equals what deployments hold.)
 */

/** `spec_hash` of a catalog row still carrying the untouched 2026-09-27 seed. */
export const SKILL_REFLECTION_MARKER_SEED_HASH = 'seed-2026-09-27';

/** The 2026-09-27 seed prompt. See the file doc: frozen, never edit. */
export const SKILL_REFLECTION_MARKER_PROMPT = `You are running an autonomous self-improvement reflection on your own past work. Nobody is waiting on this; it is a background pass.

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
