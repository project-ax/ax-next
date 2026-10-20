/**
 * "Updated project memory · N files" — the chip under an answer (W3d-2).
 *
 * It lists the project memory files this answer wrote, so a person can see
 * what the agent kept and take a change back right where they noticed it. It
 * is shaped like `MemoryUsedChip` (the same bordered disclosure) and is
 * CLOSED by default: the answer is the point.
 *
 * Undo is one click, inline. No dialog and no modal menu: stacked Radix modal
 * layers once left `body` with `pointer-events: none` (#997, #998), and a
 * one-file undo is easy to take back from History anyway.
 *
 * Paths are agent-authored text. They are drawn as text nodes only.
 */
import { useState } from 'react';
import { ChevronRight, FolderPen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { ProjectFileChangeError, workspaceApi } from '@/lib/workspace-api';
import { workspaceRoutePath, isPlainClick } from '@/lib/workspace-route';
import type { ProjectMemoryFile, ProjectMemoryUpdate } from '@/lib/workspace-types';
import { restoreFailureMessage } from './ProjectFileHistory';

export const PROJECT_MEMORY_CHANGED_SINCE = 'Changed since';
export const PROJECT_MEMORY_UNDONE = 'Undone';
export const PROJECT_MEMORY_UNDO_CHANGED_SINCE =
  'This file changed after that. Open History to pick a version.';
export const PROJECT_MEMORY_UNDO_NOT_UNDOABLE = 'This change can’t be undone.';

export function projectMemoryLabel(n: number): string {
  return `Updated project memory · ${n} ${n === 1 ? 'file' : 'files'}`;
}

const CHANGE_WORD: Record<ProjectMemoryFile['change'], string> = {
  created: 'added',
  edited: 'edited',
  deleted: 'removed',
};

/** The path as a person reads it: `memory/people.md` → `people.md`. */
export function projectMemoryPath(path: string): string {
  return path.startsWith('memory/') ? path.slice('memory/'.length) : path;
}

/** What a failed Undo says. The two undo refusals first, then restore's words. */
export function undoFailureMessage(e: unknown): string {
  if (e instanceof ProjectFileChangeError && e.code === 'changed-since') {
    return PROJECT_MEMORY_UNDO_CHANGED_SINCE;
  }
  if (e instanceof ProjectFileChangeError && e.code === 'not-undoable') {
    return PROJECT_MEMORY_UNDO_NOT_UNDOABLE;
  }
  return restoreFailureMessage(e);
}

type RowState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'undone' }
  /** `final`: a retry can't help (the file moved on, or it can't be undone). */
  | { kind: 'failed'; message: string; final: boolean };

export function ProjectMemoryChip({
  update,
  onOpenProject,
}: {
  update: ProjectMemoryUpdate;
  /** Open the project in place. Without it the link is a plain href. */
  onOpenProject?: ((projectId: string) => void) | undefined;
}) {
  const [rows, setRows] = useState<ReadonlyMap<string, RowState>>(new Map());
  const setRow = (versionId: string, state: RowState) =>
    setRows((prev) => new Map(prev).set(versionId, state));

  async function undo(file: ProjectMemoryFile) {
    setRow(file.versionId, { kind: 'busy' });
    try {
      await workspaceApi.undoProjectChange(update.projectId, file.versionId);
      setRow(file.versionId, { kind: 'undone' });
    } catch (e) {
      const final =
        e instanceof ProjectFileChangeError &&
        (e.code === 'changed-since' || e.code === 'not-undoable');
      setRow(file.versionId, { kind: 'failed', message: undoFailureMessage(e), final });
    }
  }

  const projectHref = workspaceRoutePath({ kind: 'project', id: update.projectId });

  return (
    <Collapsible
      data-testid="workspace-project-memory"
      className="mt-3 max-w-[600px] overflow-hidden rounded-lg border border-border"
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 bg-muted px-3.5 py-2 text-[12px] text-muted-foreground">
        <FolderPen size={12} aria-hidden="true" />
        {projectMemoryLabel(update.files.length)}
        <ChevronRight
          size={12}
          aria-hidden="true"
          className="ml-auto transition-transform duration-150 group-data-[state=open]:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="px-3.5 py-1">
          {update.files.map((file, i) => {
            const state = rows.get(file.versionId) ?? { kind: 'idle' };
            const name = projectMemoryPath(file.path);
            const offerUndo =
              update.canEdit &&
              file.undo === 'available' &&
              state.kind !== 'undone' &&
              !(state.kind === 'failed' && state.final);
            const note =
              state.kind === 'undone'
                ? PROJECT_MEMORY_UNDONE
                : file.undo === 'changed-since'
                  ? PROJECT_MEMORY_CHANGED_SINCE
                  : null;
            return (
              <li
                key={`${i}-${file.versionId}`}
                data-testid="workspace-project-memory-row"
                className={cn('flex flex-col gap-1 py-2', i > 0 && 'border-t border-rule-soft')}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="break-words text-[12.5px]">{name}</span>
                    <span className="text-[11.5px] text-muted-foreground">
                      {CHANGE_WORD[file.change]}
                    </span>
                  </div>
                  {note !== null && (
                    <span className="shrink-0 text-[11.5px] text-muted-foreground">{note}</span>
                  )}
                  {offerUndo && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      aria-label={`Undo ${name}`}
                      disabled={state.kind === 'busy'}
                      onClick={() => void undo(file)}
                    >
                      Undo
                    </Button>
                  )}
                </div>
                {state.kind === 'failed' && (
                  <p role="alert" className="text-[11.5px] text-destructive">
                    {state.message}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <div className="border-t border-rule-soft px-3.5 py-1.5">
          <Button asChild variant="link" size="sm" className="h-auto px-0 text-[12px]">
            <a
              href={projectHref}
              onClick={(e) => {
                if (!onOpenProject || !isPlainClick(e)) return;
                e.preventDefault();
                onOpenProject(update.projectId);
              }}
            >
              Open project
            </a>
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
