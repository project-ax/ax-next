import type { ReactNode } from 'react';
import { NoticeView } from '../internal/NoticeView.js';

export type NoticeTone = 'info' | 'warning' | 'danger' | 'success';

export interface NoticeProps {
  tone: NoticeTone;
  title?: string;
  children?: ReactNode;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
}

// Problems interrupt (alert); information and confirmations wait their turn (status).
const ROLE: Record<NoticeTone, 'alert' | 'status'> = {
  info: 'status',
  warning: 'alert',
  danger: 'alert',
  success: 'status',
};

export function Notice(props: NoticeProps) {
  return <NoticeView {...props} role={ROLE[props.tone]} />;
}
