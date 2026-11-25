import type { ReactNode } from 'react';
import type { SpaceToken } from '../foundation/tokens.js';
import { cx } from '../internal/cx.js';
import { GAP } from '../internal/maps.js';

export type GridColumns = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface GridProps {
  columns: GridColumns | { base: GridColumns; md?: GridColumns; lg?: GridColumns };
  gap?: SpaceToken;
  id?: string;
  children?: ReactNode;
}

const BASE: Record<GridColumns, string> = {
  1: 'ax-grid-cols-1',
  2: 'ax-grid-cols-2',
  3: 'ax-grid-cols-3',
  4: 'ax-grid-cols-4',
  5: 'ax-grid-cols-5',
  6: 'ax-grid-cols-6',
  7: 'ax-grid-cols-7',
};
const MD: Record<GridColumns, string> = {
  1: 'md:ax-grid-cols-1',
  2: 'md:ax-grid-cols-2',
  3: 'md:ax-grid-cols-3',
  4: 'md:ax-grid-cols-4',
  5: 'md:ax-grid-cols-5',
  6: 'md:ax-grid-cols-6',
  7: 'md:ax-grid-cols-7',
};
const LG: Record<GridColumns, string> = {
  1: 'lg:ax-grid-cols-1',
  2: 'lg:ax-grid-cols-2',
  3: 'lg:ax-grid-cols-3',
  4: 'lg:ax-grid-cols-4',
  5: 'lg:ax-grid-cols-5',
  6: 'lg:ax-grid-cols-6',
  7: 'lg:ax-grid-cols-7',
};

export function Grid({ columns, gap = 'md', id, children }: GridProps) {
  const c = typeof columns === 'number' ? { base: columns } : columns;
  const md = 'md' in c ? c.md : undefined;
  const lg = 'lg' in c ? c.lg : undefined;
  return (
    <div id={id} className={cx('ax-grid', GAP[gap], BASE[c.base], md && MD[md], lg && LG[lg])}>
      {children}
    </div>
  );
}
