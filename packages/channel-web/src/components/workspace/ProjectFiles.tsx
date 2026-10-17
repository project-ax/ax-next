/**
 * A project's files, read-only (W3b, W3 spec §5.3): the card on the project
 * page and the full-page browser at `/workspace/projects/:id/files/*`.
 *
 * Both read through `GET /api/workspace/projects/:id/files[/*]`; the folder's
 * storage id never reaches the browser. The browser is `FileBrowser` — the
 * same list, viewer and phone drill-in the agent's Files tab uses — with the
 * project's own sentences, none of which names an agent: the files belong to
 * the project, and the reader may not know which agent wrote one.
 *
 * The URL is the source of truth for where the browser is. Every folder and
 * file click navigates (a history push), and the browser follows the route, so
 * Back and Forward walk the folders and a copied link opens the same file.
 */
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { projectDownloadFailureMessage } from '@/lib/file-download';
import { logRequestFailure } from '@/lib/http';
import { toReadOutcome, type ReadOutcome } from '@/lib/read-register';
import { useFileTree, type FileTreeState } from '@/lib/user-files';
import { workspaceApi, WorkspaceApiError } from '@/lib/workspace-api';
import { workspaceRoutePath } from '@/lib/workspace-route';
import { timeAgo } from '@/lib/workspace-time';
import type { UserFilesAnswer } from '@/lib/workspace-types';
import type { ProjectDetail } from '@/wire/projects';
import { FileBrowser, type FileBrowserCopy } from './FileBrowser';
import { ProjectLoadFailure } from './ProjectLoadFailure';
import { inPlaceClick } from './ProjectsPage';
import { WorkspaceHeader } from './WorkspaceHeader';

/** What the card and the browser say when this server can't read project files. */
export const PROJECT_FILES_UNAVAILABLE = 'Files aren’t available on this server.';

/**
 * The five places every project folder has, in the order the card lists them
 * (W3 spec §5.3) — fixed, so the card reads the same in every project.
 */
export const PROJECT_FILE_SLOTS = [
  { label: 'Instructions', path: 'instructions.md' },
  { label: 'Memory', path: 'memory' },
  { label: 'Playbooks', path: 'playbooks' },
  { label: 'Sources', path: 'sources' },
  { label: 'Work', path: 'work' },
] as const;

type SlotDetail = { exists: false } | { exists: true; detail: string };

type CardState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'failed' }
  | { status: 'ready'; slots: Record<string, SlotDetail> };

function itemCount(answer: Extract<UserFilesAnswer, { kind: 'dir' }>): string {
  const n = answer.entries.length;
  if (n === 0) return 'Empty';
  const more = answer.truncated ? '+' : '';
  return n === 1 && !answer.truncated ? '1 item' : `${n}${more} items`;
}

/**
 * Read the card's rows: one listing of the root, then one listing of each of
 * the four folders that exists, in parallel. All five are cheap host reads.
 * A folder whose own listing fails still shows as there — it IS there — just
 * without a count.
 */
async function loadCard(projectId: string): Promise<CardState> {
  let root: UserFilesAnswer;
  try {
    root = await workspaceApi.projectFiles(projectId, '');
  } catch (e) {
    if (e instanceof WorkspaceApiError && e.status === 503) return { status: 'unavailable' };
    // No folder yet: every row is empty, which is the truth.
    if (e instanceof WorkspaceApiError && e.status === 404) {
      return { status: 'ready', slots: {} };
    }
    logRequestFailure(e, 'workspace-project-files');
    return { status: 'failed' };
  }
  if (root.kind !== 'dir') return { status: 'failed' };
  const slots: Record<string, SlotDetail> = {};
  await Promise.all(
    PROJECT_FILE_SLOTS.map(async ({ path }) => {
      const entry = root.entries.find((e) => e.path === path);
      if (entry === undefined) return;
      if (entry.kind === 'file') {
        slots[path] = {
          exists: true,
          detail: entry.updatedAt !== undefined ? `Updated ${timeAgo(entry.updatedAt)}` : '',
        };
        return;
      }
      try {
        const listing = await workspaceApi.projectFiles(projectId, path);
        slots[path] = { exists: true, detail: listing.kind === 'dir' ? itemCount(listing) : '' };
      } catch {
        slots[path] = { exists: true, detail: 'Folder' };
      }
    }),
  );
  return { status: 'ready', slots };
}

/**
 * The files card on the project page: five rows, no headings, and a way into
 * the whole folder. Plumbing stays out of sight — the only extra things it
 * ever says are that this server has no files, or that the read failed.
 */
export function ProjectFilesCard({
  projectId,
  onOpen,
}: {
  projectId: string;
  /** Open the browser at a raw path in the folder; `''` is the root. */
  onOpen: (path: string) => void;
}) {
  const [state, setState] = useState<CardState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void loadCard(projectId).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, attempt]);

  const href = (path: string) => workspaceRoutePath({ kind: 'project-files', id: projectId, path });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-[15px]">Files</CardTitle>
        {state.status !== 'unavailable' && (
          <Button variant="link" size="sm" className="h-auto px-0" asChild>
            <a href={href('')} onClick={(e) => inPlaceClick(e, () => onOpen(''))}>
              Browse all files
            </a>
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {state.status === 'unavailable' ? (
          <p className="text-[13px] text-muted-foreground">{PROJECT_FILES_UNAVAILABLE}</p>
        ) : state.status === 'failed' ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 text-[13px] text-muted-foreground">
              We couldn’t load the files just now.
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5" aria-label="Project files">
            {PROJECT_FILE_SLOTS.map(({ label, path }) => {
              const slot = state.status === 'ready' ? (state.slots[path] ?? { exists: false }) : null;
              const detail =
                slot === null ? (
                  <Skeleton className="h-3 w-14" />
                ) : slot.exists ? (
                  slot.detail
                ) : (
                  'Empty'
                );
              const row = (
                <>
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <span className="shrink-0 text-[12px] text-muted-foreground">{detail}</span>
                </>
              );
              return (
                <li key={path}>
                  {slot !== null && slot.exists ? (
                    <Button
                      variant="ghost"
                      className="h-10 w-full justify-start gap-2 px-2 text-left text-[13px] font-normal"
                      asChild
                    >
                      <a href={href(path)} onClick={(e) => inPlaceClick(e, () => onOpen(path))}>
                        {row}
                        <ChevronRight aria-hidden="true" className="shrink-0 text-muted-foreground" />
                      </a>
                    </Button>
                  ) : (
                    /*
                      Not a link: there is nothing there to open yet, and a row
                      that opens onto "that isn't here" teaches people to stop
                      clicking rows.
                    */
                    <div className="flex h-10 items-center gap-2 px-2 text-[13px] text-muted-foreground">
                      {row}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** The project browser's sentences. None of them names an agent. */
const BROWSER_COPY: FileBrowserCopy = {
  unavailable: PROJECT_FILES_UNAVAILABLE,
  missing: 'That isn’t here anymore. It may have been moved or deleted.',
  failed: 'We couldn’t load the files just now. Nothing was lost.',
  emptyRoot: 'This project doesn’t have any files yet.',
  truncated: (n) => `Showing the first ${n}. This folder has more than we list here.`,
  binary: 'This file can’t be previewed.',
};

/** The tree, following the route: the URL says where, the tree goes there. */
function ProjectFilesBrowser({
  projectId,
  path,
  onNavigate,
}: {
  projectId: string;
  path: string;
  onNavigate: (path: string) => void;
}) {
  const read = useCallback((p: string) => workspaceApi.projectFiles(projectId, p), [projectId]);
  const tree = useFileTree(read, { initialPath: null });
  const { open } = tree;
  useEffect(() => {
    open(path);
  }, [open, path]);

  /*
    "Try again" re-reads the path the URL names, not the last folder that
    listed: on a deep link that failed, those are different places.
  */
  const routed: FileTreeState = { ...tree, reload: () => open(path) };

  return (
    <FileBrowser
      tree={routed}
      treeKey={`project:${projectId}`}
      copy={BROWSER_COPY}
      download={(p) => () => workspaceApi.downloadProjectFile(projectId, p)}
      downloadFailure={projectDownloadFailureMessage}
      showTrail={false}
      onOpenDir={onNavigate}
      onOpenFile={onNavigate}
      drillOnFile
    />
  );
}

/**
 * `/workspace/projects/:projectId/files/*` — the whole folder.
 *
 * Reads the project first: its name heads the breadcrumb, and a project that
 * is gone or not shared says so in the project page's own words before any
 * file is asked for.
 */
export function ProjectFilesPage({
  projectId,
  path,
  onNavigate,
  onOpenProject,
  onAllProjects,
  leading,
}: {
  projectId: string;
  path: string;
  /** Go to another path in this folder (pushes history). */
  onNavigate: (path: string) => void;
  onOpenProject: () => void;
  onAllProjects: () => void;
  leading?: ReactNode;
}) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<ReadOutcome | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const got = await workspaceApi.getProject(projectId);
        if (!cancelled) setProject(got);
      } catch (e) {
        if (cancelled) return;
        logRequestFailure(e, 'workspace-project');
        setError(toReadOutcome(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, attempt]);

  if (error !== null && project === null) {
    return (
      <ProjectLoadFailure
        error={error}
        leading={leading}
        onRetry={() => setAttempt((n) => n + 1)}
        onAllProjects={onAllProjects}
      />
    );
  }

  if (project === null) {
    return (
      <>
        <WorkspaceHeader title="Files" leading={leading} />
        <div className="flex flex-1 justify-center py-10">
          <Spinner />
        </div>
      </>
    );
  }

  const segments = path === '' ? [] : path.split('/');
  const filesHref = (p: string) => workspaceRoutePath({ kind: 'project-files', id: projectId, path: p });

  return (
    <>
      <WorkspaceHeader title="Files" leading={leading} />
      <div className="px-6 pb-3">
        <Breadcrumb>
          <BreadcrumbList className="text-[12.5px]">
            <BreadcrumbItem>
              <BreadcrumbLink
                href={workspaceRoutePath({ kind: 'projects' })}
                onClick={(e) => inPlaceClick(e, onAllProjects)}
              >
                Projects
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink
                className="max-w-[24ch] truncate"
                title={project.name}
                href={workspaceRoutePath({ kind: 'project', id: projectId })}
                onClick={(e) => inPlaceClick(e, onOpenProject)}
              >
                {project.name}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              {segments.length === 0 ? (
                <BreadcrumbPage>Files</BreadcrumbPage>
              ) : (
                <BreadcrumbLink href={filesHref('')} onClick={(e) => inPlaceClick(e, () => onNavigate(''))}>
                  Files
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {segments.map((seg, i) => {
              const at = segments.slice(0, i + 1).join('/');
              const last = i === segments.length - 1;
              return (
                <Fragment key={at}>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                  {last ? (
                    <BreadcrumbPage className="max-w-[24ch] truncate" title={seg}>
                      {seg}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      className="max-w-[16ch] truncate"
                      title={seg}
                      href={filesHref(at)}
                      onClick={(e) => inPlaceClick(e, () => onNavigate(at))}
                    >
                      {seg}
                    </BreadcrumbLink>
                  )}
                  </BreadcrumbItem>
                </Fragment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      <div className="flex min-h-0 flex-1 border-t border-border">
        <ProjectFilesBrowser projectId={projectId} path={path} onNavigate={onNavigate} />
      </div>
    </>
  );
}
