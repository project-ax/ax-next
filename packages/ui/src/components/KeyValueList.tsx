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

// A <dl> of label/value pairs. Each pair is wrapped in a div (valid inside dl). Long values wrap instead of overflowing.
export function KeyValueList({ items, layout = 'rows' }: KeyValueListProps) {
  return (
    <dl className="ax-m-none ax-font-sans">
      {items.map((item, i) => (
        <div key={i} className={cx(ROW[layout], i > 0 && 'ax-border-t ax-border-line-soft')}>
          <dt className="ax-m-none ax-shrink-0 ax-text-meta ax-text-fg-muted">{item.label}</dt>
          <dd className={cx('ax-m-none ax-text-body ax-text-fg', VALUE[layout])}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
