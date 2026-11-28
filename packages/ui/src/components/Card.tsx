import type { ReactNode } from 'react';
import { cx } from '../internal/cx.js';
import { CardContext, useNestingGuard } from '../internal/nesting.js';

export interface CardProps {
  children: ReactNode;
  flush?: boolean;
  label?: string;
}

const NESTED = 'Card: cards do not nest — use InsetBlock for quoted or preview content (§6.3 rule 10).';

// One look: raised surface, panel radius, panel elevation. flush drops the padding so a List can run edge to edge
// (overflow-hidden then clips the rows to the rounded corners).
export function Card({ children, flush, label }: CardProps) {
  useNestingGuard(CardContext, NESTED);
  const className = cx(
    'ax-box-border ax-bg-surface-raised ax-rounded-lg ax-shadow-raised ax-text-fg ax-font-sans',
    flush ? 'ax-overflow-hidden' : 'ax-p-lg',
  );
  const body = <CardContext.Provider value={true}>{children}</CardContext.Provider>;
  return label ? (
    <section aria-label={label} className={className}>
      {body}
    </section>
  ) : (
    <div className={className}>{body}</div>
  );
}
