import { CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { Button } from '../components/Button.js';
import { IconButton } from '../components/IconButton.js';
import type { NoticeProps, NoticeTone } from '../components/Notice.js';
import { cx } from './cx.js';

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

export type NoticeViewProps = NoticeProps & { role?: 'alert' | 'status' };

// The Notice look without a built-in live-region role: Notice sets one per tone, Toast leaves it to its region.
export function NoticeView({ tone, title, children, action, onDismiss, role }: NoticeViewProps) {
  const Icon = ICON[tone];
  return (
    <div role={role} className={cx('ax-flex ax-items-start ax-gap-md ax-rounded-md ax-p-md', TONE[tone])}>
      <Icon aria-hidden="true" className="ax-h-lg ax-w-lg ax-shrink-0 ax-mt-xs" />
      <div className="ax-flex ax-min-w-none ax-flex-1 ax-flex-col ax-items-start ax-gap-sm">
        {title ? <p className="ax-m-none ax-break-words ax-text-body-strong ax-font-sans">{title}</p> : null}
        {children ? <div className="ax-m-none ax-break-words ax-text-meta ax-font-sans">{children}</div> : null}
        {action ? (
          <Button intent="secondary" size="sm" busy={action.busy ?? false} onClick={action.onClick}>
            {action.label}
          </Button>
        ) : null}
      </div>
      {onDismiss ? <IconButton label="Dismiss" icon={X} intent="quiet" size="sm" onClick={onDismiss} /> : null}
    </div>
  );
}
