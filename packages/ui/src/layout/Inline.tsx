import type { ReactNode } from 'react';
import type { SpaceToken } from '../foundation/tokens.js';
import { cx } from '../internal/cx.js';
import { GAP } from '../internal/maps.js';

type InlineAlign = 'start' | 'center' | 'end' | 'baseline';
type Justify = 'start' | 'between' | 'end';

export interface InlineProps {
  gap?: SpaceToken;
  align?: InlineAlign;
  justify?: Justify;
  wrap?: boolean;
  id?: string;
  children?: ReactNode;
}

const ALIGN: Record<InlineAlign, string> = {
  start: 'ax-items-start',
  center: 'ax-items-center',
  end: 'ax-items-end',
  baseline: 'ax-items-baseline',
};

const JUSTIFY: Record<Justify, string> = {
  start: 'ax-justify-start',
  between: 'ax-justify-between',
  end: 'ax-justify-end',
};

export function Inline({ gap = 'sm', align = 'center', justify = 'start', wrap, id, children }: InlineProps) {
  return (
    <div id={id} className={cx('ax-flex ax-flex-row', GAP[gap], ALIGN[align], JUSTIFY[justify], wrap && 'ax-flex-wrap')}>
      {children}
    </div>
  );
}
