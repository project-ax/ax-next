import type { ReactNode } from 'react';

export interface RoleCardProps {
  /** Short uppercase role tag (e.g., 'fast', 'runner'). Mono. */
  pill: string;
  title: string;
  caption: string;
  /** The interactive content — typically a select/combobox. */
  children: ReactNode;
}

export function RoleCard({ pill, title, caption, children }: RoleCardProps) {
  return (
    <div className="p-5 border border-rule-soft rounded-xl bg-card flex flex-col gap-3 transition-colors hover:border-border">
      <div className="flex items-start gap-3.5">
        <span className="shrink-0 font-mono text-[10.5px] tracking-[0.1em] uppercase text-muted-foreground bg-muted border border-rule-soft px-2 py-1 rounded leading-tight">
          {pill}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-medium tracking-[-0.01em] mb-0.5">
            {title}
          </div>
          <div className="text-[13px] leading-[1.5] text-muted-foreground">
            {caption}
          </div>
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}
