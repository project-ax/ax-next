/**
 * The frame around a capability clause — design §4.3.2.
 *
 * THE SHAPE IS THE POINT. `frameCapability` takes `{ verdict, capability }` and
 * returns PARTS. It cannot be handed a pre-framed sentence, and it never reads
 * the verdict back out of the clause. That makes "an author cannot write an
 * `allow` phrase that reads like a `deny`" true at the type level rather than by
 * convention: the only thing that decides whether a row says *Can* or *Cannot*
 * is the verdict the policy record actually enforces.
 *
 * The class of bug this closes is small and nasty: somebody edits a clause for
 * clarity — "never delete anything" reads better than "delete anything" — and it
 * now contradicts the verdict it is filed under. `@ax/tool-policy`'s
 * capability-lint rejects verdict words on the way in; this closes the other
 * end, where a renderer could have decided to trust the prose.
 *
 * Pure, and deliberately free of React: it is the one piece of this surface a
 * second renderer (a future Slack card, a plain-text digest) would need, and a
 * frame that only exists inside a JSX file is a frame that gets re-invented.
 */
import type { CapabilityEffect, CapabilityVerdict } from './workspace-types';

/**
 * Which mark a row wears. A NAME, not a glyph and not a colour — the renderer
 * owns both, and a module that returned "✓" would be deciding typography from
 * inside a security claim.
 */
export type FrameIcon = 'allow' | 'hold' | 'deny';

export interface CapabilityFrame {
  icon: FrameIcon;
  /** "Can" / "Cannot". Never part of the authored clause. */
  prefix: string;
  /** The authored clause, verbatim. */
  clause: string;
  /** The trailing qualifier, or `null` when the frame has none. */
  suffix: string | null;
}

/** The verdict half of a frame — everything except the clause. */
export type VerdictFrame = Omit<CapabilityFrame, 'clause'>;

/**
 * The whole table, and there is nothing else. Adding a verdict means adding a
 * row here, which is the review moment we want.
 */
const FRAMES: Record<CapabilityVerdict, VerdictFrame> = {
  allow: { icon: 'allow', prefix: 'Can', suffix: 'on its own' },
  hold: { icon: 'hold', prefix: 'Can', suffix: 'asks you first' },
  deny: { icon: 'deny', prefix: 'Cannot', suffix: null },
};

/**
 * The same table for a rule whose verdict applies to SOME calls and not others
 * — one carrying a `when` predicate over the call's arguments (TASK-267).
 *
 * It is a second table rather than a suffix somebody appends at the call site,
 * for the reason the first one exists: the qualifier is part of the claim, and
 * a claim assembled by whoever happens to be rendering is a claim that can be
 * assembled wrong. Every verdict has an entry, including `deny`, which
 * otherwise has no suffix at all — "Cannot X" with nothing after it reads as
 * *never*, and a conditional deny is not never.
 *
 * The qualifier says only that the rule is conditional, never on WHAT. The
 * condition is a key out of the tool's own argument schema; turning
 * `{ recursive: true }` into English would be us writing the tool vendor's
 * words in our voice, and this surface keeps those apart everywhere else.
 */
const CONDITIONAL_FRAMES: Record<CapabilityVerdict, VerdictFrame> = {
  allow: { icon: 'allow', prefix: 'Can', suffix: 'on its own, in some cases' },
  hold: { icon: 'hold', prefix: 'Can', suffix: 'asks you first, in some cases' },
  deny: { icon: 'deny', prefix: 'Cannot', suffix: 'in some cases' },
};

/**
 * The frame for a verdict, with no clause attached — the mechanical rows' half.
 *
 * `conditional` is a required argument, not an optional one. A catalog row is
 * never conditional and would pass `false` either way; the row this exists for
 * is a DESCRIBED row that lost its clause to the fence and demoted, and that
 * one can be. An optional parameter is a parameter a call site forgets, and
 * forgetting it here silently upgrades a sometimes-claim into an always-claim.
 */
export function verdictFrame(
  verdict: CapabilityVerdict,
  conditional: boolean,
): VerdictFrame {
  return { ...(conditional ? CONDITIONAL_FRAMES : FRAMES)[verdict] };
}

/**
 * Frame one authored capability clause.
 *
 * Takes an object, never a string, so there is no call site that could pass a
 * sentence somebody already framed. `capability` is copied through untouched:
 * this function does not read it, test it, or rewrite it.
 */
export function frameCapability(row: {
  verdict: CapabilityVerdict;
  capability: string;
  conditional: boolean;
}): CapabilityFrame {
  return { ...verdictFrame(row.verdict, row.conditional), clause: row.capability };
}

/**
 * Reading order for the three groups: allow, then hold, then deny.
 *
 * The allows are the risky facts and get top billing; the denies are
 * reassurance and belong at the bottom. `@ax/tool-policy` already emits its own
 * rows in this order — this is the renderer's copy of the same rule, because
 * the rail merges rows from several producers and the merged list has to be
 * ordered by something other than which hook answered first.
 */
export const VERDICT_ORDER: readonly CapabilityVerdict[] = ['allow', 'hold', 'deny'];

/** Stable, verdict-first sort. Equal verdicts keep the order they arrived in. */
export function byVerdict<T extends { verdict: CapabilityVerdict }>(rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        VERDICT_ORDER.indexOf(a.row.verdict) - VERDICT_ORDER.indexOf(b.row.verdict) ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}

/**
 * The disclosure for a declared `effect` — TASK-329, the follow-up to
 * TASK-263 that added the field to `PolicyRule` and deliberately did not
 * render it.
 *
 * This is AUTHORED copy, and it lives here for the same reason the verdict
 * frames above do: a claim assembled by whoever happens to be rendering is a
 * claim that can be assembled wrong, and this is the one piece a second
 * renderer (a Slack card, a plain-text digest) would need without also
 * needing to re-derive the wording from the type's doc comment. Pulling it
 * into `bits.tsx` would mean the next renderer either imports React to get at
 * plain strings or reinvents them, and reinvention is exactly how `spends`
 * and `outward` would drift back together.
 *
 * `spends` and `outward` get DIFFERENTLY WORDED entries on purpose.
 * TASK-263 split `ToolEffect` into two members precisely because the risks
 * are not the same one — a metered spend is not the same fact as a third
 * party seeing (or being unable to undo) something the agent did — and a
 * renderer that collapsed them into one generic "has an effect" chip would
 * throw away the distinction the type exists to preserve. So there is no
 * shared template string with an effect-name slot; there are two separately
 * authored entries, and adding a third member of `CapabilityEffect` is a
 * compile error here (see the `Record` below), not a silent fallback.
 *
 * The `spends` copy is deliberately careful about WHO PAYS: it says the
 * deployment's operator is billed, and it explicitly says we cannot name an
 * amount from here. Saying "you are billed" would be a guess — the reader
 * viewing the rail is not necessarily the account holder — and naming a price
 * would be a number this surface does not have and cannot make up.
 *
 * Neither entry claims irreversibility. `irreversible` is a separate field on
 * the approval surface with its own UI (the undo window on approvals);
 * saying "can't be undone" here as well would duplicate that claim and, the
 * day the two disagree, contradict it. This disclosure's only job is the
 * effect, not the reversibility of it.
 */
export interface EffectDisclosure {
  /** The badge's visible words. Short, scannable. */
  label: string;
  /** The standalone clause for assistive tech — the badge out of context is ambiguous. */
  srLabel: string;
  /** The "why", behind the affordance. */
  detail: string;
}

/**
 * The whole table, and there is nothing else — same discipline as `FRAMES`
 * above. `Record<CapabilityEffect, EffectDisclosure>` means a third member
 * added to the union without a corresponding row here fails to compile,
 * which is the review moment we want rather than a member that silently
 * renders as `undefined`.
 */
const EFFECT_DISCLOSURES: Record<CapabilityEffect, EffectDisclosure> = {
  spends: {
    label: 'Costs money',
    srLabel: 'Costs money — every use makes a paid request.',
    detail:
      "Every time the agent does this, it makes a paid request on this AX deployment's account — so it costs money on each use, not just the first. Whoever set up this deployment pays the bill; we can't tell you the amount from here.",
  },
  outward: {
    label: 'Affects the outside world',
    srLabel: 'Affects the outside world.',
    detail:
      'This does something out in the world beyond AX — like sending a message, posting where others can see it, or making a payment. Other people see the result, not just the agent.',
  },
};

/**
 * The disclosure for a declared effect. Returns a shallow copy, like
 * `verdictFrame` does, so a caller mutating the result cannot corrupt the
 * shared table for the next row.
 */
export function effectDisclosure(effect: CapabilityEffect): EffectDisclosure {
  return { ...EFFECT_DISCLOSURES[effect] };
}
