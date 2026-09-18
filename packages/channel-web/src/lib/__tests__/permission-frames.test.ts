/**
 * The frame comes from the verdict, full stop.
 *
 * This is a small module carrying a large property: an author cannot write an
 * `allow` phrase that reads like a `deny`. `@ax/tool-policy`'s capability-lint
 * enforces that on the way IN; these tests enforce that the renderer would not
 * have believed the clause even if one got through.
 */
import { describe, expect, it } from 'vitest';
import {
  VERDICT_ORDER,
  byVerdict,
  disclosedEffects,
  effectDisclosure,
  frameCapability,
  verdictFrame,
} from '../permission-frames';
import type { CapabilityEffect } from '../workspace-types';

describe('frameCapability', () => {
  it('frames allow', () => {
    expect(
      frameCapability({ verdict: 'allow', capability: 'reply to scheduling requests', conditional: false }),
    ).toEqual({
      icon: 'allow',
      prefix: 'Can',
      clause: 'reply to scheduling requests',
      suffix: 'on its own',
    });
  });

  it('frames hold', () => {
    expect(
      frameCapability({ verdict: 'hold', capability: 'write to a customer', conditional: false }),
    ).toMatchObject({ prefix: 'Can', suffix: 'asks you first' });
  });

  it('frames deny with no suffix', () => {
    expect(
      frameCapability({ verdict: 'deny', capability: 'delete anything', conditional: false }),
    ).toMatchObject({ prefix: 'Cannot', suffix: null });
  });

  it('never reads the verdict out of the clause', () => {
    // The frame comes from the verdict, full stop. A clause that smuggled one
    // in was already rejected by the capability lint; this asserts the renderer
    // does not consult it either.
    expect(
      frameCapability({ verdict: 'allow', capability: 'never delete anything', conditional: false }).prefix,
    ).toBe('Can');
    expect(
      frameCapability({ verdict: 'deny', capability: 'always be allowed to send mail', conditional: false }),
    ).toMatchObject({ prefix: 'Cannot', suffix: null });
  });

  it('copies the clause through untouched — it does not rewrite anybody’s words', () => {
    const clause = '  reply   to scheduling requests  ';
    expect(frameCapability({ verdict: 'allow', capability: clause, conditional: false }).clause).toBe(clause);
  });

  it('hands back a fresh object, so a renderer cannot edit the shared table', () => {
    const first = frameCapability({ verdict: 'allow', capability: 'a', conditional: false });
    first.prefix = 'Cannot';
    expect(frameCapability({ verdict: 'allow', capability: 'b', conditional: false }).prefix).toBe('Can');
  });
});

describe('frameCapability — conditional (TASK-267)', () => {
  /*
    A rule that only fires when an argument takes a particular value makes a
    DIFFERENT claim from one that always fires, and the difference is the whole
    reason this row exists. "Can delete a folder — asks you first" says every
    such call stops for you. If the rule's predicate is over `recursive: true`,
    the calls where it is false do not stop for anybody, and a reader who has
    been told otherwise has been told something we do not enforce.

    The qualifier is on the SUFFIX, next to the verdict it qualifies, and it
    comes out of the same table — a renderer cannot forget to add it, and a
    clause cannot smuggle one in.
  */
  it('qualifies a conditional hold rather than asserting it always asks', () => {
    expect(
      frameCapability({
        verdict: 'hold',
        capability: 'delete a folder and everything in it',
        conditional: true,
      }),
    ).toMatchObject({ prefix: 'Can', suffix: 'asks you first, in some cases' });
  });

  it('qualifies a conditional allow', () => {
    expect(
      frameCapability({ verdict: 'allow', capability: 'search the web', conditional: true }),
    ).toMatchObject({ prefix: 'Can', suffix: 'on its own, in some cases' });
  });

  it('gives a conditional deny the suffix it otherwise has none of', () => {
    // "Cannot X" with no qualifier reads as never, and a conditional deny is
    // not never. The unconditional deny keeps its bare frame.
    expect(
      frameCapability({ verdict: 'deny', capability: 'delete anything', conditional: true }),
    ).toMatchObject({ prefix: 'Cannot', suffix: 'in some cases' });
  });

  it('leaves an unconditional row exactly as it was', () => {
    expect(
      frameCapability({ verdict: 'hold', capability: 'write to a customer', conditional: false }),
    ).toMatchObject({ suffix: 'asks you first' });
  });
});

describe('verdictFrame', () => {
  it('gives the mechanical rows the same frame, with no clause', () => {
    expect(verdictFrame('hold', false)).toEqual({
      icon: 'hold',
      prefix: 'Can',
      suffix: 'asks you first',
    });
    expect(Object.keys(verdictFrame('allow', false))).not.toContain('clause');
  });

  it('carries the qualifier for a described row that demoted to mechanical', () => {
    // `toWirePermission` demotes a described row whose clause fences away to
    // nothing. It keeps its verdict and it keeps its conditionality — the
    // clause is what was lost, not the rule.
    expect(verdictFrame('hold', true).suffix).toBe('asks you first, in some cases');
  });
});

describe('byVerdict', () => {
  it('orders allow, then hold, then deny — allows are the risky facts', () => {
    expect(VERDICT_ORDER).toEqual(['allow', 'hold', 'deny']);
    const rows = [
      { verdict: 'deny' as const, id: 'd1' },
      { verdict: 'allow' as const, id: 'a1' },
      { verdict: 'hold' as const, id: 'h1' },
      { verdict: 'allow' as const, id: 'a2' },
    ];
    expect(byVerdict(rows).map((r) => r.id)).toEqual(['a1', 'a2', 'h1', 'd1']);
  });

  it('is stable inside a group — reading order is not an accident of the sort', () => {
    const rows = [
      { verdict: 'allow' as const, id: 'first' },
      { verdict: 'allow' as const, id: 'second' },
      { verdict: 'allow' as const, id: 'third' },
    ];
    expect(byVerdict(rows).map((r) => r.id)).toEqual(['first', 'second', 'third']);
  });

  it('does not mutate the caller’s array', () => {
    const rows = [{ verdict: 'deny' as const }, { verdict: 'allow' as const }];
    byVerdict(rows);
    expect(rows[0]?.verdict).toBe('deny');
  });
});

describe('effectDisclosure (TASK-329)', () => {
  it('returns non-empty copy for spends', () => {
    const d = effectDisclosure('spends');
    expect(d.label).toBeTruthy();
    expect(d.srLabel).toBeTruthy();
    expect(d.detail).toBeTruthy();
  });

  it('returns non-empty copy for outward', () => {
    const d = effectDisclosure('outward');
    expect(d.label).toBeTruthy();
    expect(d.srLabel).toBeTruthy();
    expect(d.detail).toBeTruthy();
  });

  it('never shares wording between the two effects — TASK-263 split them on purpose', () => {
    // A generic "has an effect" chip would collapse these back into one
    // string. This reddens the moment somebody templates the two entries
    // instead of authoring them separately.
    const spends = effectDisclosure('spends');
    const outward = effectDisclosure('outward');
    expect(spends.label).not.toBe(outward.label);
    expect(spends.srLabel).not.toBe(outward.srLabel);
    expect(spends.detail).not.toBe(outward.detail);
  });

  it('hands back a fresh object, so a renderer cannot edit the shared table', () => {
    const first = effectDisclosure('spends');
    first.label = 'mutated';
    expect(effectDisclosure('spends').label).toBe('Costs money');
  });

  it('discloses on allow and hold, and never on deny', () => {
    // The rule lives beside the copy rather than at the render site so a
    // second renderer takes it along with `effectDisclosure` — without it,
    // a faithful renderer prints "Cannot pay an invoice — Costs money".
    // Raised in review as a nit; this is the test that pins it here.
    expect(disclosedEffects('allow', ['spends'])).toEqual(['spends']);
    expect(disclosedEffects('hold', ['outward'])).toEqual(['outward']);
    expect(disclosedEffects('hold', ['spends'])).toEqual(['spends']);
    // `deny` suppresses whatever the rule declared — the call does not happen.
    expect(disclosedEffects('deny', ['spends'])).toEqual([]);
    expect(disclosedEffects('deny', ['outward'])).toEqual([]);
    expect(disclosedEffects('deny', ['spends', 'outward'])).toEqual([]);
    // Unclassified is nothing to say, at every verdict.
    expect(disclosedEffects('allow', [])).toEqual([]);
    expect(disclosedEffects('hold', [])).toEqual([]);
    expect(disclosedEffects('deny', [])).toEqual([]);
  });

  it('keeps EVERY member of a two-effect row, in the declared order (TASK-330)', () => {
    // `web.extract` declares both. A row that disclosed only the first would
    // understate its reach, which is the one direction design H4 forbids, and
    // the order is the rule's — the renderer draws them in it.
    expect(disclosedEffects('hold', ['spends', 'outward'])).toEqual([
      'spends',
      'outward',
    ]);
    expect(disclosedEffects('hold', ['outward', 'spends'])).toEqual([
      'outward',
      'spends',
    ]);
  });

  it('hands back a fresh array, so a renderer cannot edit the wire row', () => {
    const effects: CapabilityEffect[] = ['spends', 'outward'];
    const out = disclosedEffects('hold', effects);
    out.pop();
    expect(effects).toEqual(['spends', 'outward']);
  });

  /*
    RE-SCOPED IN TASK-384, and the reason is written down because the rule it
    replaces was load-bearing and looked right.

    The old guard asserted that NEITHER detail may say the action cannot be
    undone, on the premise that `PolicyRule.irreversible` already owns that
    claim and a second copy of it would contradict the first the day they
    disagreed. The premise is false, because the two are not one claim:

      - `irreversible` is about THE APPROVAL CONTROL — whether AW-5 defers the
        call after you say yes so the undo window has something to stop.
      - the `outward` disclosure is about THE CALL'S CONSEQUENCE once it has
        actually run, which AX does not control at all.

    `web.extract` is the live proof they differ without contradicting:
    `irreversible` unset (AW-5 replays it at once, no grace period) and the
    fetch still cannot be un-made, because the URL's owner has seen it.

    So the boundary moved rather than vanished. The effect copy may describe
    the CONSEQUENCE, and `outward` must — `CapabilityEffect` defines it as a
    disjunction and copy narrower than the type understates reach, which is the
    one direction design H4 forbids. What it still may not do is describe the
    CONTROL: the undo window, the grace period, whether you can stop this after
    approving. That is `irreversible`'s claim, it is rendered by
    `decision-copy.ts` on the approval surface, and that IS where two copies
    could genuinely disagree.
  */
  it('the outward copy covers BOTH disjuncts of the type, not just visibility', () => {
    // `CapabilityEffect.outward` is "a third party sees it OR it cannot be
    // taken back". Copy spelling out only the first half tells a person
    // approving an irreversible action less than they agreed to.
    const outward = effectDisclosure('outward');
    expect(outward.detail).toMatch(/\bsee\b|\bsees\b|\bseen\b/i);
    expect(outward.detail).toMatch(/undo|undone|take it back|reverse/i);
    expect(outward.srLabel).toMatch(/undo|undone|take it back|reverse/i);
  });

  it('the spends copy still says nothing about reversibility — money is its whole subject', () => {
    // A metered call is not withdrawable and not outward. The entry that
    // exists to name the cost must not start hinting at either, or `spends`
    // and `outward` drift back into one generic "has an effect" string.
    const spends = effectDisclosure('spends');
    expect(spends.detail).not.toMatch(/undo|undone|take it back|permanent|reverse/i);
    expect(spends.srLabel).not.toMatch(/undo|undone|take it back|permanent|reverse/i);
  });

  it('neither entry claims anything about the undo WINDOW — that is `irreversible`', () => {
    // The consequence is ours to describe; the control is not. A disclosure
    // promising a grace period would contradict `decision-copy.ts` the moment
    // a rule left `irreversible` unset, which is every rule shipping today.
    const control = /undo window|grace period|\d+ seconds|ten seconds|stop it before|cancel it|change your mind/i;

    // The named-mechanism list above is not enough on its own, and this is the
    // one place the re-scope is weaker than the single regex it replaced.
    // Test 1 now REQUIRES the word "undo" on the outward copy, so a future edit
    // to "you can still take it back" would satisfy test 1, skip test 2 (wrong
    // effect) and miss every phrase in `control` — shipping an affirmative
    // grace-period promise this surface cannot keep. So the SHAPE is denied as
    // well as the vocabulary: a modal of ABILITY governing a reversal verb.
    //
    // CLAUSE-BOUNDED, and that bound is load-bearing rather than tidy. The
    // obvious `[^.]*` between the two halves reaches across punctuation and
    // reds the correct copy on "Two things **can** follow: … may not be
    // possible to **undo**" — two unrelated clauses, no promise made. Stopping
    // at `.,;:—` keeps the modal and the verb inside one clause, which is the
    // only place one can actually govern the other.
    const promise =
      /\b(can|could|able to|still|chance to|moment to|time to|opportunity to)\b[^.,;:—]{0,24}\b(undo|undone|take it back|reverse|reversed|stop)\b/i;

    // `promise` is scoped to a VERB shape, so the same promise phrased as a
    // NOUN walks straight past it — "You have a window to undo this", "There
    // is a way to undo it", "A brief period lets you undo". Each names an
    // affordance this surface cannot promise, each satisfies test 1's "contains
    // undo", and none is a modal of ability. Closed rather than merely
    // recorded: a noun of OPPORTUNITY reaching a reversal verb, same clause
    // bound and for the same reason.
    const affordance =
      /\b(window|way|means|option|period|opportunity|chance|moment)\b[^.,;:—]{0,24}\b(undo|undone|take it back|reverse|reversed|stop)\b/i;

    // ARM EVERY PATTERN BEFORE TRUSTING ANY OF THEM. A denylist that matches
    // nothing passes every string, including the one it exists to stop, and
    // this board has twice shipped a mechanism that was armed-but-never-firing.
    // Each phrase below must be caught by at least one of the three.
    for (const hazard of [
      'You can still take it back.',
      'You have a moment to undo this after approving.',
      'There is a chance to stop it.',
      'You are able to reverse this.',
      'You have a window to undo this.',
      'There is a way to undo it.',
      'A brief period lets you undo.',
      'You get a ten seconds head start.',
    ]) {
      expect(
        control.test(hazard) || promise.test(hazard) || affordance.test(hazard),
      ).toBe(true);
    }

    for (const effect of ['spends', 'outward'] as const) {
      const d = effectDisclosure(effect);
      for (const field of [d.detail, d.srLabel, d.label]) {
        expect(field).not.toMatch(control);
        expect(field).not.toMatch(promise);
        expect(field).not.toMatch(affordance);
      }
    }
  });
});
