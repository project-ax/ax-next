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
  frameCapability,
  verdictFrame,
} from '../permission-frames';

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
