import type { ComponentType, SVGProps } from 'react';
import { cn } from '@/lib/utils';
import { SidebarRow } from '../SidebarRow';

export interface AdminNavItemProps {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  active?: boolean;
  onClick: () => void;
}

export function AdminNavItem({ icon: Icon, label, active, onClick }: AdminNavItemProps) {
  return (
    <SidebarRow active={active} onClick={onClick}>
      <Icon
        className={cn(
          'w-3.5 h-3.5 shrink-0 transition-colors',
          active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground/75',
        )}
      />
      <span>{label}</span>
    </SidebarRow>
  );
}
