import type { ReactNode } from 'react';
import { NoticeView } from '../internal/NoticeView.js';

export type NoticeTone = 'info' | 'warning' | 'danger' | 'success';

export interface NoticeProps {
  tone: NoticeTone;
  title?: string;
  children?: ReactNode;
  action?: { label: string; onClick: () => void; busy?: boolean };
  onDismiss?: () => void;
  // false: no live role, for a notice whose content changes often (a countdown) or is announced elsewhere. Default true.
  announce?: boolean;
}

// Only a failure interrupts (alert); warnings, information and confirmations wait their turn (status),
// so a warning beside a field being typed in never cuts into every keystroke.
const ROLE: Record<NoticeTone, 'alert' | 'status'> = {
  info: 'status',
  warning: 'status',
  danger: 'alert',
  success: 'status',
};

export function Notice({ announce = true, ...props }: NoticeProps) {
  return <NoticeView {...props} {...(announce ? { role: ROLE[props.tone] } : {})} />;
}
