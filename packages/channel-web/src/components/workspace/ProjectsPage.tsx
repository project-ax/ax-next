/**
 * `/workspace/projects` — every project this person can use, as a grid of
 * cards (W3a, W3 spec §4.8 frame 2): the name, the description's first line,
 * and "Updated 2h ago". With none yet, `Empty` offers "New project".
 *
 * Each card is a real link to the project's URL, so it opens in a new tab like
 * any other link; a plain click stays in the shell.
 */
import type { MouseEvent, ReactNode } from 'react';
import { FolderKanban, Plus } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { byRecent, firstLine } from '@/lib/workspace-projects';
import { isPlainClick, workspaceRoutePath } from '@/lib/workspace-route';
import { timeAgo } from '@/lib/workspace-time';
import type { ProjectSummary } from '@/wire/projects';
import { WorkspaceHeader } from './WorkspaceHeader';

/** A plain left click navigates in place; anything else is the browser's. */
export function inPlaceClick(e: MouseEvent, go: () => void): void {
  if (!isPlainClick(e)) return;
  e.preventDefault();
  go();
}

export function ProjectsPage({
  projects,
  error,
  loading,
  onRetry,
  onOpen,
  onNew,
  leading,
}: {
  projects: ProjectSummary[] | null;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
  onOpen: (projectId: string) => void;
  onNew: () => void;
  leading?: ReactNode;
}) {
  const list = projects === null ? null : byRecent(projects);
  return (
    <>
      <WorkspaceHeader title="Projects" leading={leading}>
        {list !== null && list.length > 0 && (
          <Button size="sm" onClick={onNew}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            New project
          </Button>
        )}
      </WorkspaceHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4 px-6 pb-6">
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                <span className="min-w-0">{error}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  className="ml-auto"
                  onClick={onRetry}
                  disabled={loading}
                >
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {list === null && error === null && (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          )}
          {list !== null && list.length === 0 && (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderKanban aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No projects yet</EmptyTitle>
                <EmptyDescription>
                  A project keeps the chats about one piece of work together, so your
                  agent always knows what you're working on.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button size="sm" onClick={onNew}>
                  <Plus data-icon="inline-start" aria-hidden="true" />
                  New project
                </Button>
              </EmptyContent>
            </Empty>
          )}
          {list !== null && list.length > 0 && (
            <ul className="grid gap-4 md:grid-cols-2" aria-label="Projects">
              {list.map((p) => {
                const line = firstLine(p.description);
                return (
                  <li key={p.projectId}>
                    <a
                      href={workspaceRoutePath({ kind: 'project', id: p.projectId })}
                      onClick={(e) => inPlaceClick(e, () => onOpen(p.projectId))}
                      className="block h-full rounded-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Card className="flex h-full flex-col transition-colors hover:bg-accent">
                        <CardHeader className="flex-1">
                          <CardTitle className="truncate text-[15px]" title={p.name}>
                            {p.name}
                          </CardTitle>
                          {line !== null && (
                            <CardDescription className="truncate" title={line}>
                              {line}
                            </CardDescription>
                          )}
                        </CardHeader>
                        <CardFooter className="text-[12.5px] text-muted-foreground">
                          Updated {timeAgo(p.updatedAt)}
                        </CardFooter>
                      </Card>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
