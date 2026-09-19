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
// `.js`, even though this one is type-only and therefore erased at emit:
// this module is server-reachable, and the extension convention has to hold
// for the whole graph or it stops being checkable. See
// `src/__tests__/server-import-extensions.test.ts`.
import type { CapabilityEffect, CapabilityVerdict } from './workspace-types.js';

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
 * THE `outward` ENTRY NOW SAYS THE ACTION MAY NOT BE UNDOABLE, and the older
 * rule forbidding that was retired deliberately (TASK-384). It rested on the
 * premise that this and `PolicyRule.irreversible` are ONE claim said twice, so
 * that the day they disagreed one would contradict the other. They are two
 * claims about two different things:
 *
 *   - `irreversible` is about THE APPROVAL CONTROL — whether AW-5 holds the
 *     call back for a grace period after you say yes, so the undo button has
 *     something left to stop. It is a promise about what AX does.
 *   - This disclosure is about THE CALL'S CONSEQUENCE — what is true out in
 *     the world once the call has actually run. It is a statement about what
 *     AX cannot control.
 *
 * `web.extract` is the proof they can differ without either being wrong. It
 * declares `outward` and leaves `irreversible` unset, so AW-5 replays it
 * immediately — and the fetch still cannot be un-made, because the URL's owner
 * has already seen the request. "No grace period" and "cannot be taken back"
 * are both true of that one call. (Whether that rule SHOULD also set
 * `irreversible` is TASK-409, and deliberately not settled here — this card
 * changes description, never approval timing.)
 *
 * What the guard still forbids, and now forbids for a stated reason, is either
 * entry making a claim about THE CONTROL: the undo window, the grace period,
 * whether you can still stop this after approving. That is `irreversible`'s
 * claim, it is rendered on the approval surface by `decision-copy.ts`, and it
 * is the one place where a second copy really could contradict the first.
 *
 * The `spends` entry still says nothing about reversibility at all. Money is
 * its whole subject; a metered call is not withdrawable and not outward, and
 * the entry that exists to name the cost should not start hinting at either.
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
 *
 * READ THAT NARROWLY (TASK-408): the compiler pins this table to
 * `CapabilityEffect`, the LOCAL hand-copy — not to `@ax/tool-policy`'s
 * `ToolEffect`, which is what decides what actually arrives and which
 * invariant 2 keeps unimportable. A member added over there alone reaches a
 * row with no entry here, and `effectDisclosure` spreads `undefined` into an
 * empty object rather than throwing, so the badge renders blank. That gap is
 * covered by `__tests__/server/effect-mirror-drift.test.ts`, not by `tsc`.
 */
const EFFECT_DISCLOSURES: Record<CapabilityEffect, EffectDisclosure> = {
  spends: {
    label: 'Costs money',
    srLabel: 'Costs money — every use makes a paid request.',
    detail:
      "Every time the agent does this, it makes a paid request on this AX deployment's account — so it costs money on each use, not just the first. Whoever set up this deployment pays the bill; we can't tell you the amount from here.",
  },
  /*
    NOW AS WIDE AS THE TYPE (TASK-384). `CapabilityEffect`'s `outward` is a
    DISJUNCTION — "a third party sees the call **OR** it cannot be taken back"
    — and this detail used to spell out only the first half, so a reader facing
    an irreversible action nobody observes was told the narrower thing and
    under-estimated what they were approving. On a consent surface that is the
    dangerous direction: design H4 forbids understating reach, and copy
    narrower than the type it describes understates it.

    NOTHING ON THE ROW SAYS WHICH DISJUNCT APPLIES, and that is why the wording
    is "may … and may", not a choice between them. The rail row carries
    `effect: CapabilityEffect[]` and nothing else about reversibility — no
    per-row `irreversible`, by design (see the module comment above, and
    `EvaluateResult.effect` in `@ax/tool-policy`, which refuses to claim
    `irreversible` off a rule that did not answer). So the strongest TRUE thing
    this surface can say is that both halves are live and it cannot tell you
    which. Picking one for the reader would be guessing on a consent surface.

    THE ALTERNATIVE WAS NARROWING THE TYPE, and it was rejected on security
    grounds, not taste. `outward` is the member `lintRuleEffect` reads to
    FORBID `allow` (strictest member wins), and its own error text already
    names both disjuncts: "a call a third party sees, or that cannot be taken
    back, must be held or denied". Narrowing `outward` to third-party
    visibility alone would leave an irreversible-but-unobserved action with no
    member that forbids a quiet one-line `allow` — which is the exact failure
    the gate exists to stop. The copy moved to meet the type, not the reverse.
  */
  outward: {
    label: 'Affects the outside world',
    srLabel:
      'Affects the outside world — other people may see it, and it may not be possible to undo.',
    detail:
      "This does something out in the world beyond AX — like sending a message, posting where others can see it, or making a payment. Two things can follow: other people may see the result, and once it has run it may not be possible to undo. We can't tell you which from here, so treat it as both.",
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

/**
 * Which of a row's declared effects should be DISCLOSED to a reader — the
 * members to draw, in the order the rule declared them.
 *
 * This lives here, beside the copy, rather than as a condition at the render
 * site — and that placement is the whole point. The rule is part of the claim,
 * and this module is explicitly the piece a second renderer (a Slack card, a
 * plain-text digest) would take. A renderer holding `effectDisclosure` but not
 * this rule would faithfully print "Cannot pay an invoice — Costs money",
 * which is precisely the false positive the rule exists to prevent. The
 * suppression travelling with the words is what stops the next surface having
 * to re-derive it, or failing to.
 *
 * `deny` is the whole rule, and the argument is narrow. A `deny` row says
 * "Cannot X": the call does not happen, so there is no money spent and no
 * outward action taken, and there is nothing to disclose about either. Worse
 * than redundant, it is misleading — somebody scanning the rail for the rows
 * that spend their money reads a "Costs money" badge as reach the agent HAS,
 * which is backwards from what the row asserts.
 *
 * And it is safe in the one direction this surface cares about. Design H4 says
 * never to UNDERSTATE reach; a `deny` row already asserts ZERO reach, so
 * withholding a caveat about it cannot understate anything — there is no reach
 * left to understate. Note this is a RENDERING decision only: the wire row
 * still carries the rule's declared effects faithfully either way, so nothing
 * downstream loses the fact.
 *
 * IT TAKES THE WHOLE SET AND HANDS BACK A SET, which is a change of shape from
 * the single-member predicate this replaced, and the reason is worth recording
 * because the old comment argued hard for that one.
 *
 * `shouldDiscloseEffect(verdict, effect)` was a TYPE PREDICATE
 * (`effect is CapabilityEffect`) whose real job was the `effect !== null` half:
 * narrowing here meant the render site did not re-test nullability itself — a
 * second copy of half the rule, sitting where nothing tested it. TASK-330
 * removed the half being duplicated rather than the guard against duplicating
 * it: `PermissionRow.effect` is an ARRAY, its members are non-nullable by
 * construction, and "nothing declared" is `[]`. With the null branch gone, a
 * per-member boolean would have read its `effect` argument NOT AT ALL — a
 * function whose name promises it weighs the effect while deciding purely on
 * the verdict. Returning the filtered set instead keeps one honest job here
 * (which claims survive this verdict) and hands the caller exactly what it
 * draws, so the iteration and the suppression travel together to the next
 * renderer instead of only the second one making the trip.
 *
 * Returns a NEW array; the caller can sort or slice it without reaching back
 * into the wire row, same discipline as `verdictFrame`'s shallow copy.
 */
export function disclosedEffects(
  verdict: CapabilityVerdict,
  effects: readonly CapabilityEffect[],
): CapabilityEffect[] {
  return verdict === 'deny' ? [] : [...effects];
}
