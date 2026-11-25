import type { LucideIcon } from 'lucide-react';
import { Button } from './Button.js';
import { Text } from './Text.js';

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ title, description, icon: Icon, action }: EmptyStateProps) {
  return (
    <div className="ax-flex ax-flex-col ax-items-center ax-gap-md ax-p-xl ax-text-center">
      {Icon ? <Icon aria-hidden="true" className="ax-h-xl ax-w-xl ax-text-fg-muted" /> : null}
      {/* Not a heading: its level depends on where it sits, which only a section context can know. */}
      <Text role="body-strong">{title}</Text>
      {description ? <Text role="meta">{description}</Text> : null}
      {action ? (
        <Button intent="secondary" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
