import { describe, expectTypeOf, it } from 'vitest';
import { Plus } from 'lucide-react';
import { AsyncState, Avatar, Card, InsetBlock, KeyValueList, Button, ConfirmAction, Divider, EmptyState, Notice, StatusBadge, StatusMark, Grid, Heading, IconButton, Inline, Stack, Text, Timestamp } from '../index.js';

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
    const sm1: P<typeof StatusMark> = { tone: 'info', className: 'x' };
    // @ts-expect-error not a tone
    const sm2: P<typeof StatusMark> = { tone: 'error' };
    // @ts-expect-error className is not a prop
    const sb1: P<typeof StatusBadge> = { tone: 'info', children: 'x', className: 'x' };
    // @ts-expect-error not a tone
    const sb2: P<typeof StatusBadge> = { tone: 'ok', children: 'x' };
    // @ts-expect-error size is sm or md
    const sb3: P<typeof StatusBadge> = { tone: 'info', children: 'x', size: 'lg' };
    // @ts-expect-error className is not a prop
    const e1: P<typeof EmptyState> = { title: 'x', className: 'x' };
    // @ts-expect-error className is not a prop
    const a1: P<typeof AsyncState> = { status: 'ready', skeleton: 'rows', loadingLabel: 'x', className: 'x' };
    // @ts-expect-error tone of an error is danger or info only
    const a2: P<typeof AsyncState> = { status: 'error', skeleton: 'rows', loadingLabel: 'x', error: { message: 'x', tone: 'warning' } };
    // @ts-expect-error className is not a prop
    const av1: P<typeof Avatar> = { name: 'x', className: 'x' };
    // @ts-expect-error size is xs, sm, md or lg
    const av2: P<typeof Avatar> = { name: 'x', size: 'xl' };
    // @ts-expect-error name is required
    const av3: P<typeof Avatar> = {};
    // @ts-expect-error className is not a prop
    const kv1: P<typeof KeyValueList> = { items: [], className: 'x' };
    // @ts-expect-error layout is rows or stacked
    const kv2: P<typeof KeyValueList> = { items: [], layout: 'grid' };
    // @ts-expect-error className is not a prop
    const cd1: P<typeof Card> = { children: 'x', className: 'x' };
    // @ts-expect-error there is only one Card look, no variant
    const cd2: P<typeof Card> = { children: 'x', variant: 'settings' };
    // @ts-expect-error className is not a prop
    const ib4: P<typeof InsetBlock> = { children: 'x', className: 'x' };
    // @ts-expect-error style is not a prop
    const ib5: P<typeof InsetBlock> = { children: 'x', style: {} };
    const ts1: P<typeof Timestamp> = { value: 'x', format: 'clock' };
    // @ts-expect-error the old name: no `style` prop on Timestamp
    const ts2: P<typeof Timestamp> = { value: 'x', style: 'clock' };
    // @ts-expect-error format is relative | clock
    const ts3: P<typeof Timestamp> = { value: 'x', format: 'full' };
    const confirm = { title: 'x', confirmLabel: 'Remove', onConfirm: () => {} };
    // @ts-expect-error trigger and open together
    const c1: P<typeof ConfirmAction> = { ...confirm, trigger: { label: 'Remove' }, open: true, onOpenChange: () => {} };
    // @ts-expect-error confirmLabel is required
    const c2: P<typeof ConfirmAction> = { title: 'x', onConfirm: () => {}, trigger: { label: 'Remove' } };
    // @ts-expect-error className is not a prop
    const c3: P<typeof ConfirmAction> = { ...confirm, trigger: { label: 'Remove' }, className: 'x' };
    // @ts-expect-error danger is the default tone; the other is neutral, not primary
    const c4: P<typeof ConfirmAction> = { ...confirm, trigger: { label: 'Remove' }, tone: 'primary' };
    // @ts-expect-error controlled needs onOpenChange
    const c5: P<typeof ConfirmAction> = { ...confirm, open: true };
    // @ts-expect-error one of trigger or open is required
    const c6: P<typeof ConfirmAction> = { ...confirm };
    // @ts-expect-error primary is not a trigger intent
    const c7: P<typeof ConfirmAction> = { ...confirm, trigger: { label: 'Remove', intent: 'primary' } };
    const ok1: P<typeof ConfirmAction> = { ...confirm, trigger: { label: 'Remove', intent: 'quiet', size: 'sm', icon: Plus, iconOnly: true } };
    const ok2: P<typeof ConfirmAction> = { ...confirm, tone: 'neutral', open: false, onOpenChange: () => {} };
    void [ts1, ts2, ts3, av1, av2, av3, kv1, kv2, cd1, cd2, ib4, ib5, sm1, sm2, sb1, sb2, sb3, b1, b2, b3, ib1, ib2, ib3, n1, n2, e1, a1, a2, c1, c2, c3, c4, c5, c6, c7, ok1, ok2];
    void [bad, i1, i2, i3, i4, g1, g2, g3, g4, d1, d2, d3, t1, t2, t3, t4, h1, h2, h3];
  });
});
