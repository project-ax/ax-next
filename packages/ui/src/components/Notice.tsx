import { CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../internal/cx.js';
import { Button } from './Button.js';
import { IconButton } from './IconButton.js';

export type NoticeTone = 'info' | 'warning' | 'danger' | 'success';

export interface NoticeProps {
  tone: NoticeTone;
  title?: string;
  children?: ReactNode;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
}

const TONE: Record<NoticeTone, string> = {
  info: 'ax-bg-status-info-soft ax-text-status-info',
  warning: 'ax-bg-status-warning-soft ax-text-status-warning',
  danger: 'ax-bg-status-danger-soft ax-text-status-danger',
  success: 'ax-bg-status-success-soft ax-text-status-success',
};

const ICON: Record<NoticeTone, LucideIcon> = {
  info: Info,
  warning: TriangleAlert,
  danger: CircleAlert,
  success: CircleCheck,
};

// Problems interrupt (alert); information and confirmations wait their turn (status).
const ROLE: Record<NoticeTone, 'alert' | 'status'> = {
  info: 'status',
  warning: 'alert',
  danger: 'alert',
  success: 'status',
};

export function Notice({ tone, title, children, action, onDismiss }: NoticeProps) {
  const Icon = ICON[tone];
  return (
    <div role={ROLE[tone]} className={cx('ax-flex ax-items-start ax-gap-md ax-rounded-md ax-p-md', TONE[tone])}>
      <Icon aria-hidden="true" className="ax-h-lg ax-w-lg ax-shrink-0 ax-mt-xs" />
      <div className="ax-flex ax-min-w-none ax-flex-1 ax-flex-col ax-items-start ax-gap-sm">
        {title ? <p className="ax-m-none ax-break-words ax-text-body-strong ax-font-sans">{title}</p> : null}
        {children ? <p className="ax-m-none ax-break-words ax-text-meta ax-font-sans">{children}</p> : null}
        {action ? (
          <Button intent="secondary" size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        ) : null}
      </div>
      {onDismiss ? <IconButton label="Dismiss" icon={X} intent="quiet" size="sm" onClick={onDismiss} /> : null}
    </div>
  );
}
