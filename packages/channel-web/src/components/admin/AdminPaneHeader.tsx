import type { ReactNode } from 'react';

export interface AdminPaneHeaderProps {
  eyebrow: string;
  title: string;
  /** Optional right-aligned slot — typically a status badge or count. */
  badge?: ReactNode;
}

export function AdminPaneHeader({ eyebrow, title, badge }: AdminPaneHeaderProps) {
  return (
    <header className="flex items-center justify-between gap-4 px-8 pt-[18px] pb-4 border-b border-rule-soft">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[11px] tracking-[0.06em] uppercase text-muted-foreground font-medium">
          {eyebrow}
        </span>
        <span className="text-[19px] font-medium tracking-[-0.012em]">{title}</span>
      </div>
      {badge && <div className="flex items-center gap-3.5">{badge}</div>}
    </header>
  );
}
