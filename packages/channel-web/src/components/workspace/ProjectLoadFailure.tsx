/**
 * What a project page says when the project won't open. Its own module so the
 * project page and the project's files browser share it without importing
 * each other.
 */
import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { HTTP_SESSION_ENDED } from '@/lib/http';
import type { ReadOutcome } from '@/lib/read-register';
import { WorkspaceHeader } from './WorkspaceHeader';

const LOAD_COPY: Record<ReadOutcome, string> = {
  expired: HTTP_SESSION_ENDED,
  gone: 'We couldn’t open this project. It may have been deleted, or it isn’t shared with you.',
  failed: 'We couldn’t load this project just now. Nothing was lost.',
};

/**
 * A project that wouldn't open — gone, not shared, or a failed read. Shared
 * with the files browser so both say the same thing about the same fact.
 */
export function ProjectLoadFailure({
  error,
  leading,
  onRetry,
  onAllProjects,
}: {
  error: ReadOutcome;
  leading?: ReactNode;
  onRetry: () => void;
  onAllProjects: () => void;
}) {
  return (
    <>
      <WorkspaceHeader title="Project" leading={leading} />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4 px-6 pb-6">
          <Alert variant={error === 'failed' ? 'destructive' : 'default'}>
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span className="min-w-0">{LOAD_COPY[error]}</span>
              <span className="ml-auto flex gap-2">
                {error === 'failed' && (
                  <Button variant="secondary" size="sm" onClick={onRetry}>
                    Try again
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={onAllProjects}>
                  All projects
                </Button>
              </span>
            </AlertDescription>
          </Alert>
        </div>
      </div>
    </>
  );
}
