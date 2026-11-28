import type { ReactNode } from 'react';
import { InsetContext, useNestingGuard } from '../internal/nesting.js';

export interface InsetBlockProps {
  children: ReactNode;
  label?: string;
}

const NESTED = 'InsetBlock: inset blocks do not nest — one level only (§6.3 rule 10).';

// Quoted or preview content: muted, rounded, one level. Allowed inside a Card.
export function InsetBlock({ children, label }: InsetBlockProps) {
  useNestingGuard(InsetContext, NESTED);
  const className = 'ax-box-border ax-bg-muted ax-rounded-md ax-p-md ax-text-fg ax-font-sans ax-break-words';
  const body = <InsetContext.Provider value={true}>{children}</InsetContext.Provider>;
  return label ? (
    <section aria-label={label} className={className}>
      {body}
    </section>
  ) : (
    <div className={className}>{body}</div>
  );
}
