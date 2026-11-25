import { describe, expectTypeOf, it } from 'vitest';
import { Plus } from 'lucide-react';
import { AsyncState, Button, Divider, EmptyState, Notice, Grid, Heading, IconButton, Inline, Stack, Text } from '../index.js';

describe('props', () => {
  it('forbid className/style/as and off-scale values', () => {
    type P<T extends (props: never) => unknown> = Parameters<T>[0];
    expectTypeOf<P<typeof Stack>>().not.toHaveProperty('className');
    const bad: P<typeof Stack>[] = [
      // @ts-expect-error className is not public
      { className: 'x' },
      // @ts-expect-error style is not public
      { style: {} },
      // @ts-expect-error as is not public
      { as: 'section' },
      // @ts-expect-error gap must be a token
      { gap: '4' },
    ];
    // @ts-expect-error className
    const i1: P<typeof Inline> = { className: 'x' };
    // @ts-expect-error style
    const i2: P<typeof Inline> = { style: {} };
    // @ts-expect-error as is not a prop
    const i3: P<typeof Inline> = { as: 'span' };
    // @ts-expect-error gap
    const i4: P<typeof Inline> = { gap: '4' };
    // @ts-expect-error className
    const g1: P<typeof Grid> = { columns: 1, className: 'x' };
    // @ts-expect-error style
    const g2: P<typeof Grid> = { columns: 1, style: {} };
    // @ts-expect-error as is not a prop
    const g3: P<typeof Grid> = { columns: 1, as: 'ul' };
    // @ts-expect-error gap
    const g4: P<typeof Grid> = { columns: 1, gap: '4' };
    // @ts-expect-error className
    const d1: P<typeof Divider> = { className: 'x' };
    // @ts-expect-error style
    const d2: P<typeof Divider> = { style: {} };
    // @ts-expect-error as is not a prop
    const d3: P<typeof Divider> = { as: 'div' };
    // @ts-expect-error className
    const t1: P<typeof Text> = { className: 'x' };
    // @ts-expect-error style
    const t2: P<typeof Text> = { style: {} };
    // @ts-expect-error as is not a prop
    const t3: P<typeof Text> = { as: 'h1' };
    // @ts-expect-error title is a Heading role
    const t4: P<typeof Text> = { role: 'title' };
    // @ts-expect-error className
    const h1: P<typeof Heading> = { className: 'x' };
    // @ts-expect-error style
    const h2: P<typeof Heading> = { style: {} };
    // @ts-expect-error as is not a prop
    const h3: P<typeof Heading> = { as: 'h1' };
    // @ts-expect-error className is not a prop
    const b1: P<typeof Button> = { children: 'x', className: 'x' };
    // @ts-expect-error style is not a prop
    const b2: P<typeof Button> = { children: 'x', style: {} };
    // @ts-expect-error danger is not a public intent
    const b3: P<typeof Button> = { children: 'x', intent: 'danger' };
    // @ts-expect-error className is not a prop
    const ib1: P<typeof IconButton> = { label: 'x', icon: Plus, className: 'x' };
    // @ts-expect-error label required
    const ib2: P<typeof IconButton> = { icon: Plus };
    // @ts-expect-error primary is not an IconButton intent
    const ib3: P<typeof IconButton> = { label: 'x', icon: Plus, intent: 'primary' };
    // @ts-expect-error className is not a prop
    const n1: P<typeof Notice> = { tone: 'info', className: 'x' };
    // @ts-expect-error error is not a tone (use danger)
    const n2: P<typeof Notice> = { tone: 'error' };
    // @ts-expect-error className is not a prop
    const e1: P<typeof EmptyState> = { title: 'x', className: 'x' };
    // @ts-expect-error className is not a prop
    const a1: P<typeof AsyncState> = { status: 'ready', skeleton: 'rows', loadingLabel: 'x', className: 'x' };
    // @ts-expect-error tone of an error is danger or info only
    const a2: P<typeof AsyncState> = { status: 'error', skeleton: 'rows', loadingLabel: 'x', error: { message: 'x', tone: 'warning' } };
    void [b1, b2, b3, ib1, ib2, ib3, n1, n2, e1, a1, a2];
    void [bad, i1, i2, i3, i4, g1, g2, g3, g4, d1, d2, d3, t1, t2, t3, t4, h1, h2, h3];
  });
});
