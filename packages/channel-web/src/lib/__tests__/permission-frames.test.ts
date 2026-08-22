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
      frameCapability({ verdict: 'allow', capability: 'reply to scheduling requests' }),
    ).toEqual({
      icon: 'allow',
      prefix: 'Can',
      clause: 'reply to scheduling requests',
      suffix: 'on its own',
    });
  });

  it('frames hold', () => {
    expect(
      frameCapability({ verdict: 'hold', capability: 'write to a customer' }),
    ).toMatchObject({ prefix: 'Can', suffix: 'asks you first' });
  });

  it('frames deny with no suffix', () => {
    expect(
      frameCapability({ verdict: 'deny', capability: 'delete anything' }),
    ).toMatchObject({ prefix: 'Cannot', suffix: null });
  });

  it('never reads the verdict out of the clause', () => {
    // The frame comes from the verdict, full stop. A clause that smuggled one
    // in was already rejected by the capability lint; this asserts the renderer
    // does not consult it either.
    expect(
      frameCapability({ verdict: 'allow', capability: 'never delete anything' }).prefix,
    ).toBe('Can');
    expect(
      frameCapability({ verdict: 'deny', capability: 'always be allowed to send mail' }),
    ).toMatchObject({ prefix: 'Cannot', suffix: null });
  });

  it('copies the clause through untouched — it does not rewrite anybody’s words', () => {
    const clause = '  reply   to scheduling requests  ';
    expect(frameCapability({ verdict: 'allow', capability: clause }).clause).toBe(clause);
  });

  it('hands back a fresh object, so a renderer cannot edit the shared table', () => {
    const first = frameCapability({ verdict: 'allow', capability: 'a' });
    first.prefix = 'Cannot';
    expect(frameCapability({ verdict: 'allow', capability: 'b' }).prefix).toBe('Can');
  });
});

describe('verdictFrame', () => {
  it('gives the mechanical rows the same frame, with no clause', () => {
    expect(verdictFrame('hold')).toEqual({
      icon: 'hold',
      prefix: 'Can',
      suffix: 'asks you first',
    });
    expect(Object.keys(verdictFrame('allow'))).not.toContain('clause');
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
