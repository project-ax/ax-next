import type { ReactNode } from 'react';
import { cx } from '../internal/cx.js';

export type TextRoleName = 'body' | 'body-strong' | 'meta' | 'caption' | 'code';

export interface TextProps {
  role?: TextRoleName;
  inline?: boolean;
  truncate?: boolean;
  id?: string;
  children?: ReactNode;
}

const ROLE: Record<TextRoleName, string> = {
  body: 'ax-text-body ax-text-fg ax-font-sans',
  'body-strong': 'ax-text-body-strong ax-text-fg ax-font-sans',
  meta: 'ax-text-meta ax-text-fg-muted ax-font-sans',
  // fg-muted, not fg-subtle: subtle is under 4.5:1 on light surfaces, too faint for 12px text (ruling R7).
  caption: 'ax-text-caption ax-text-fg-muted ax-font-sans',
  code: 'ax-text-code ax-text-fg ax-font-mono',
};

export function Text({ role = 'body', inline, truncate, id, children }: TextProps) {
  const className = cx('ax-m-none', ROLE[role], role === 'code' && !inline && 'ax-block', truncate && 'ax-truncate');
  if (role === 'code') {
    return (
      <code id={id} className={className}>
        {children}
      </code>
    );
  }
  return inline ? (
    <span id={id} className={className}>
      {children}
    </span>
  ) : (
    <p id={id} className={className}>
      {children}
    </p>
  );
}
