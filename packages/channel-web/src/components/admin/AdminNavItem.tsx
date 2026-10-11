import type { ComponentType, SVGProps } from 'react';
import { Button } from '@/components/ui/button';

export interface AdminNavItemProps {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  active?: boolean;
  onClick: () => void;
}

export function AdminNavItem({ label, active, onClick }: AdminNavItemProps) {
  return <Button type="button" variant="settings-nav" className="w-full px-3" data-active={active || undefined} aria-current={active ? 'page' : undefined} onClick={onClick}>{label}</Button>;
}
