// A held call, as the HUMAN sees it.
//
// On this runner the model's context and the person's transcript are two
// different stores: the model reads the SDK's own jsonl, the person reads the
// display event log we publish at `event.turn-end`. A hold is one of the few
// events where those two audiences need genuinely different sentences, and
// because the stores are separate we can give each what it needs without
// degrading the other. This module is the human half.

/**
 * The line a person sees where a held call's result would be.
 *
 * This is the HUMAN's copy. The MODEL's copy is the hold note `@ax/decisions`
 * wrote, which the SDK has already put in the jsonl — it is longer, it is
 * instructive ("do not retry, do not look for another way"), and it is
 * deliberately DIFFERENT prose for a different reader. We do not touch it.
 *
 * The sentence was written against the house dialect in
 * `packages/channel-web/src/components/workspace/decision-copy.ts`: no
 * contractions, the agent is "it" and the person is "you". "Nothing has
 * happened yet." is verbatim that file's `DECISION_STALE_LEAD`, and "choose"
 * is its neutral verb — neutral between approving and dismissing, because this
 * line sits under a question nobody has answered yet and must not lean on
 * either answer.
 *
 * It names NOTHING on purpose:
 *
 *   - no decision id. A `dec_…` is a token the reader has never seen and can
 *     do nothing with; `@ax/decisions` drops it from the note at source for the
 *     same reason.
 *   - no tool name. The SDK's wire name (`mcp__ax-host-tools__…`) is not a
 *     thing a person asked for, and the display layer owns that rename.
 *   - no claim about WHERE the approval can be answered. A sentence that says
 *     "above" is a promise about a layout this side cannot keep — the same
 *     rule every authored line in `packages/decisions/src/templates.ts`
 *     follows. (It used to cite that file's `RETRACTED_RECEIPT` by name; that
 *     constant is gone — TASK-279 made an undone decision simply have no
 *     receipt — but the rule it illustrated is unchanged.)
 *
 * Dialect owner: `decision-copy.ts`. This is a deliberate local twin, not an
 * import — plugins never import each other (CLAUDE.md invariant 2), and a
 * runner that reached into a web package for a string would be a worse bug
 * than a duplicated sentence. If the dialect there changes, change it here.
 */
export const HELD_TOOL_RESULT_TEXT =
  'Waiting for you to choose. Nothing has happened yet, and nothing will until you do.';

// The per-turn hold record (`HeldCallRegistry` / `createHeldCallRegistry`)
// lives in `@ax/agent-runner-core` since TASK-270 so both runners share one
// (invariant 2 forbids the aisdk runner importing it from here). This module
// keeps only the human sentence, which is runner-specific: here the display
// log is a different store from the model's jsonl, so the person can get
// their own line without degrading the model.
