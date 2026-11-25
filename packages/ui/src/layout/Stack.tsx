import type { ReactNode } from 'react';
import type { SpaceToken } from '../foundation/tokens.js';
import { cx } from '../internal/cx.js';
import { GAP } from '../internal/maps.js';

type Align = 'start' | 'center' | 'end' | 'stretch';

export interface StackProps {
  gap?: SpaceToken;
  align?: Align;
  id?: string;
  children?: ReactNode;
}

const ALIGN: Record<Align, string> = {
  start: 'ax-items-start',
  center: 'ax-items-center',
  end: 'ax-items-end',
  stretch: 'ax-items-stretch',
};

export function Stack({ gap = 'md', align = 'stretch', id, children }: StackProps) {
  return (
    <div id={id} className={cx('ax-flex ax-flex-col', GAP[gap], ALIGN[align])}>
      {children}
    </div>
  );
}
