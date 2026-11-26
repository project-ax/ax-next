import type { ReactNode } from 'react';
import { cx } from '../internal/cx.js';

export interface KeyValueListProps {
  items: ReadonlyArray<{ label: string; value: ReactNode }>;
  layout?: 'rows' | 'stacked';
}

const ROW: Record<NonNullable<KeyValueListProps['layout']>, string> = {
  rows: 'ax-flex ax-items-baseline ax-justify-between ax-gap-lg ax-py-sm',
  stacked: 'ax-flex ax-flex-col ax-gap-xs ax-py-sm',
};

const VALUE: Record<NonNullable<KeyValueListProps['layout']>, string> = {
  rows: 'ax-min-w-none ax-break-words ax-text-right',
  stacked: 'ax-min-w-none ax-break-words',
};

// The dt keeps its min-content (longest word) but wraps between words and shrinks; the dd may break anywhere.
// ax-border-0 first: preflight is off, so a style without a reset width would draw a 3px box on every side.
// A <dl> of label/value pairs. Each pair is wrapped in a div (valid inside dl). Long values wrap instead of overflowing.
export function KeyValueList({ items, layout = 'rows' }: KeyValueListProps) {
  return (
    <dl className="ax-m-none ax-font-sans">
      {items.map((item, i) => (
        <div key={i} className={cx(ROW[layout], i > 0 && 'ax-border-0 ax-border-t ax-border-solid ax-border-line-soft')}>
          <dt className="ax-m-none ax-break-words ax-text-meta ax-text-fg-muted">{item.label}</dt>
          <dd className={cx('ax-m-none ax-text-body ax-text-fg', VALUE[layout])}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
