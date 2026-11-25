import { useContext, type ReactNode } from 'react';
import { cx } from '../internal/cx.js';
import { HeadingLevelContext } from '../internal/heading-level.js';

export type HeadingRole = 'display' | 'title' | 'heading' | 'subheading';

export interface HeadingProps {
  role?: HeadingRole;
  id?: string;
  children?: ReactNode;
}

const ROLE: Record<HeadingRole, string> = {
  display: 'ax-text-display',
  title: 'ax-text-title',
  heading: 'ax-text-heading',
  subheading: 'ax-text-subheading',
};

const TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

export function Heading({ role, id, children }: HeadingProps) {
  const level = Math.min(6, Math.max(1, Math.trunc(useContext(HeadingLevelContext))));
  const Tag = TAGS[level - 1]!;
  const resolved: HeadingRole = role ?? (level === 1 ? 'title' : level === 2 ? 'heading' : 'subheading');
  return (
    <Tag id={id} className={cx('ax-m-none ax-text-fg', ROLE[resolved])}>
      {children}
    </Tag>
  );
}
