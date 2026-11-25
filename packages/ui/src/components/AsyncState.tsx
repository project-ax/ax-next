import type { ReactNode } from 'react';
import { Skeleton, type SkeletonShape } from '../internal/Skeleton.js';
import { EmptyState, type EmptyStateProps } from './EmptyState.js';
import { Notice } from './Notice.js';

export type { SkeletonShape };

export interface AsyncStateProps {
  status: 'loading' | 'error' | 'empty' | 'ready';
  skeleton: SkeletonShape;
  loadingLabel: string;
  error?: { message: string; onRetry?: () => void; tone?: 'danger' | 'info' };
  empty?: EmptyStateProps;
  children?: ReactNode;
}

export function AsyncState({ status, skeleton, loadingLabel, error, empty, children }: AsyncStateProps) {
  if (status === 'loading') {
    return (
      <div role="status" aria-busy="true">
        <span className="ax-sr-only">{loadingLabel}</span>
        <Skeleton shape={skeleton} />
      </div>
    );
  }
  if (status === 'error') {
    return (
      <Notice
        tone={error?.tone ?? 'danger'}
        {...(error?.onRetry ? { action: { label: 'Try again', onClick: error.onRetry } } : {})}
      >
        {error?.message ?? 'Something went wrong.'}
      </Notice>
    );
  }
  if (status === 'empty') {
    return empty ? <EmptyState {...empty} /> : null;
  }
  return <>{children}</>;
}
