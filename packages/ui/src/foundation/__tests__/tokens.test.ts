import { describe, expect, it, expectTypeOf } from 'vitest';
import {
  accent,
  action,
  bg,
  brand,
  fg,
  line,
  status,
  text,
  type BgToken,
  type ElevationToken,
  type FgToken,
  type MotionToken,
  type RadiusToken,
  type SpaceToken,
  type StatusTone,
  type TextRole,
  type WidthToken,
} from '../tokens.js';

const groups = { bg, fg, accent, action, line, brand };
const triplet = /^\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/;

describe('tokens', () => {
  it('every color group has the same keys in light and dark', () => {
    for (const g of Object.values(groups)) {
      expect(Object.keys(g.light)).toEqual(Object.keys(g.dark));
    }
    for (const g of Object.values(status)) {
      expect(Object.keys(g.light)).toEqual(Object.keys(g.dark));
    }
  });

  it('colors are bare HSL triplets', () => {
    const all = [...Object.values(groups), ...Object.values(status)];
    for (const g of all) {
      for (const v of [...Object.values(g.light), ...Object.values(g.dark)]) {
        expect(v).toMatch(triplet);
      }
    }
  });

  it("token unions are exactly the spec's names", () => {
    expectTypeOf<SpaceToken>().toEqualTypeOf<'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'section'>();
    expectTypeOf<TextRole>().toEqualTypeOf<
      'display' | 'title' | 'heading' | 'subheading' | 'body' | 'body-strong' | 'meta' | 'caption' | 'code'
    >();
    expectTypeOf<StatusTone>().toEqualTypeOf<'neutral' | 'info' | 'success' | 'warning' | 'danger'>();
    expectTypeOf<RadiusToken>().toEqualTypeOf<'none' | 'sm' | 'md' | 'lg' | 'full'>();
    expectTypeOf<ElevationToken>().toEqualTypeOf<'flat' | 'raised' | 'overlay'>();
    expectTypeOf<MotionToken>().toEqualTypeOf<'instant' | 'fast' | 'base'>();
    expectTypeOf<WidthToken>().toEqualTypeOf<'narrow' | 'form' | 'content' | 'wide'>();
    expectTypeOf<BgToken>().toEqualTypeOf<'canvas' | 'surface' | 'surface-raised' | 'overlay' | 'muted'>();
    expectTypeOf<FgToken>().toEqualTypeOf<'default' | 'muted' | 'subtle' | 'inverse' | 'link'>();
  });

  it('starting values match channel-web', () => {
    expect(bg.light.surface).toBe('220.00 42.86% 98.63%');
    expect(fg.dark.muted).toBe('219.00 11.90% 67.06%');
    expect(text.body.size).toBe('15px');
  });
});
