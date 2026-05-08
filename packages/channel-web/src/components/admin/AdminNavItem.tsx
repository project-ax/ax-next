import type { ComponentType, SVGProps } from 'react';
import { cn } from '@/lib/utils';

export interface AdminNavItemProps {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  active?: boolean;
  onClick: () => void;
}

export function AdminNavItem({ icon: Icon, label, active, onClick }: AdminNavItemProps) {
  return (
    <button
      type="button"
      data-active={active || undefined}
      onClick={onClick}
      className={cn(
        'group relative flex items-center gap-2.5 w-full px-2.5 py-2 rounded-sm text-[13px] cursor-pointer transition-colors',
        active
          ? 'bg-muted text-foreground before:content-[""] before:absolute before:left-0 before:top-2.5 before:bottom-2.5 before:w-0.5 before:bg-primary before:rounded-full'
          : 'text-foreground/75 hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon
        className={cn(
          'w-3.5 h-3.5 shrink-0 transition-colors',
          active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground/75',
        )}
      />
      <span>{label}</span>
    </button>
  );
}
