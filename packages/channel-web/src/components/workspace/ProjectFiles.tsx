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
 *
 * W3c: a person who can use an editor or owner member agent can change the
 * files too: Edit on a text file, the + menu (upload, new text file, new
 * folder) and Delete in the file's menu. Viewers get none of it, and nothing
 * under `sources/` changes. The pieces live in `ProjectFileEditing`.
 *
 * W3d: History in the file's menu, for everyone (viewers read it too), with
 * Restore and Undo for editors (`ProjectFileHistory`). A path that isn't
 * there any more offers "See history", so a deleted file can be brought back.
 */
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Pencil } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { fenceLine } from '@/lib/fence-line';
import { logRequestFailure } from '@/lib/http';
import { toReadOutcome, type ReadOutcome } from '@/lib/read-register';
import { parentDirOf, useFileTree, type FileTreeState } from '@/lib/user-files';
import { workspaceApi, WorkspaceApiError } from '@/lib/workspace-api';
import { workspaceRoutePath } from '@/lib/workspace-route';
import { timeAgo } from '@/lib/workspace-time';
import type { UserFilesAnswer } from '@/lib/workspace-types';
import type { ProjectDetail } from '@/wire/projects';
import { FileBrowser, type FileBrowserCopy } from './FileBrowser';
import {
  AddMenu,
  addTargetDir,
  canEditProjectFiles,
  changeFailureMessage,
  ConflictDialog,
  DeleteFileDialog,
  FileEditor,
  FileMenu,
  isConflict,
  isDeletablePath,
  isEditableFile,
  joinPath,
  NameDialog,
  newNameProblem,
  PROJECT_FILE_EXISTS,
  PROJECT_FILE_UPLOAD_MAX_BYTES,
  UploadResults,
  type UploadOutcome,
} from './ProjectFileEditing';
import { FileHistorySheet, undoTarget } from './ProjectFileHistory';
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

/** An edit in progress on an existing file: the text and the version it started from. */
interface Editing {
  path: string;
  text: string;
  baseHash: string;
}

/**
 * The tree, following the route: the URL says where, the tree goes there.
 * With `canEdit`, also the editor, the + menu and Delete (W3c).
 */
function ProjectFilesBrowser({
  projectId,
  path,
  canEdit,
  onNavigate,
  onOpenConversation,
}: {
  projectId: string;
  path: string;
  canEdit: boolean;
  onNavigate: (path: string) => void;
  onOpenConversation?: (agentId: string, conversationId: string) => void;
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

  // ---- changes (W3c) --------------------------------------------------------
  const [editing, setEditing] = useState<Editing | null>(null);
  /** A new text file being written: its raw key and text. Not on disk until Save. */
  const [creating, setCreating] = useState<{ path: string; text: string } | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [nameDialog, setNameDialog] = useState<'file' | 'folder' | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /**
   * The file just deleted, so it can come back. After a delete the viewer goes
   * to the folder, where the "isn't here anymore" page (and its See history)
   * never shows: without this there was no way back to a deleted file
   * (production smoke test, 2026-10-19).
   */
  const [deleted, setDeleted] = useState<{ path: string; label: string } | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploads, setUploads] = useState<UploadOutcome[] | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  /** The file whose History sheet is open: its raw key and fenced name. */
  const [history, setHistory] = useState<{ path: string; label: string } | null>(null);

  // An edit belongs to one file: opening another one leaves it behind.
  const activeEdit = editing !== null && editing.path === tree.filePath ? editing : null;
  // A new file's editor shows only while no file is open.
  useEffect(() => {
    if (tree.filePath !== null) setCreating(null);
  }, [tree.filePath]);
  useEffect(() => {
    setSaveError(null);
  }, [tree.filePath]);

  const target = addTargetDir(tree.dirPath);
  /** Show `dir`'s listing fresh: re-read it when it's on screen, else go there. */
  const showDir = async (dir: string) => {
    if (tree.dirPath === dir) await tree.refresh();
    else onNavigate(dir);
  };

  async function saveEdit(overwrite: boolean) {
    if (activeEdit === null) return;
    setSaveBusy(true);
    setSaveError(null);
    try {
      await workspaceApi.writeProjectFile(
        projectId,
        activeEdit.path,
        activeEdit.text,
        overwrite ? {} : { baseHash: activeEdit.baseHash },
      );
      setConflictOpen(false);
      setEditing(null);
      await tree.refresh();
    } catch (e) {
      if (!overwrite && isConflict(e)) setConflictOpen(true);
      else {
        setConflictOpen(false);
        setSaveError(changeFailureMessage(e, 'save'));
      }
    } finally {
      setSaveBusy(false);
    }
  }

  async function saveNew() {
    if (creating === null) return;
    setSaveBusy(true);
    setSaveError(null);
    try {
      await workspaceApi.writeProjectFile(projectId, creating.path, creating.text, { createOnly: true });
      const made = creating.path;
      setCreating(null);
      if (tree.dirPath === (parentDirOf(made) ?? '')) await tree.refresh();
      onNavigate(made);
    } catch (e) {
      setSaveError(changeFailureMessage(e, 'save'));
    } finally {
      setSaveBusy(false);
    }
  }

  async function submitName(name: string) {
    const at = joinPath(target, name);
    if (nameDialog === 'file') {
      // The listing on screen may already know; the save checks again.
      if (tree.dirPath === target && tree.entries.some((e) => e.path === at)) {
        setNameError(PROJECT_FILE_EXISTS);
        return;
      }
      setNameDialog(null);
      setEditing(null);
      setSaveError(null);
      setCreating({ path: at, text: '' });
      if (tree.filePath !== null || tree.dirPath !== target) onNavigate(target);
      return;
    }
    setNameBusy(true);
    setNameError(null);
    try {
      await workspaceApi.createProjectFolder(projectId, at);
      setNameDialog(null);
      onNavigate(at);
    } catch (e) {
      setNameError(changeFailureMessage(e, 'folder'));
    } finally {
      setNameBusy(false);
    }
  }

  async function confirmDelete() {
    const doomed = tree.filePath;
    if (doomed === null) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await workspaceApi.deleteProjectFile(projectId, doomed);
      setDeleteOpen(false);
      setEditing(null);
      setUndoError(null);
      setDeleted({ path: doomed, label: tree.file?.name ?? fenceLine(doomed, 120) ?? 'The file' });
      onNavigate(parentDirOf(doomed) ?? '');
    } catch (e) {
      setDeleteError(changeFailureMessage(e, 'delete'));
    } finally {
      setDeleteBusy(false);
    }
  }

  /** Bring the just-deleted file back: restore its last write before the delete. */
  async function undoDelete() {
    if (deleted === null) return;
    setUndoBusy(true);
    setUndoError(null);
    try {
      const history = await workspaceApi.projectFileHistory(projectId, deleted.path);
      const target = undoTarget(history.versions);
      if (target === null) {
        setUndoError('This file can’t be brought back from here. Its history may still have it.');
        return;
      }
      await workspaceApi.restoreProjectFileVersion(projectId, target.versionId);
      const back = deleted.path;
      setDeleted(null);
      onNavigate(back);
    } catch (e) {
      logRequestFailure(e, 'project-file-undo-delete');
      setUndoError(changeFailureMessage(e, 'save'));
    } finally {
      setUndoBusy(false);
    }
  }

  async function upload(files: File[]) {
    if (files.length === 0) return;
    const into = target;
    setUploading(true);
    setUploads(null);
    const outcomes: UploadOutcome[] = [];
    for (const file of files) {
      // The person's own file name, but still fenced before it's drawn.
      const name = fenceLine(file.name, 120) ?? 'A file with no readable name';
      if (file.size > PROJECT_FILE_UPLOAD_MAX_BYTES) {
        outcomes.push({ name, ok: false, message: 'it’s too big. Each file can be up to 10 MB.' });
        continue;
      }
      const problem = newNameProblem(file.name);
      if (problem !== null) {
        outcomes.push({ name, ok: false, message: 'its name has characters we can’t save. Rename it and try again.' });
        continue;
      }
      try {
        await workspaceApi.writeProjectFile(projectId, joinPath(into, file.name), file, { createOnly: true });
        outcomes.push({ name, ok: true, message: '' });
      } catch (e) {
        const message = changeFailureMessage(e, 'upload');
        outcomes.push({ name, ok: false, message: lowerFirst(message) });
      }
    }
    setUploads(outcomes);
    setUploading(false);
    if (outcomes.some((o) => o.ok)) await showDir(into);
  }

  const openFile = tree.file;
  const openPath = tree.filePath;
  const canEditOpen = canEdit && activeEdit === null && openFile !== null && openFile.path === openPath && isEditableFile(openFile);
  const canDeleteOpen = canEdit && openPath !== null && openFile !== null && isDeletablePath(openPath);

  const viewerActions =
    openPath !== null && openFile !== null ? (
      <>
        {canEditOpen && (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => {
              setSaveError(null);
              setEditing({ path: openFile.path, text: openFile.body, baseHash: openFile.sha256 });
            }}
          >
            <Pencil data-icon="inline-start" />
            Edit
          </Button>
        )}
        <FileMenu
          onHistory={() => setHistory({ path: openPath, label: openFile.name })}
          onDelete={
            canDeleteOpen
              ? () => {
                  setDeleteError(null);
                  setDeleteOpen(true);
                }
              : undefined
          }
        />
      </>
    ) : undefined;

  const viewerBody =
    activeEdit !== null ? (
      <FileEditor
        value={activeEdit.text}
        onChange={(text) => setEditing({ ...activeEdit, text })}
        onSave={() => void saveEdit(false)}
        onCancel={() => {
          setEditing(null);
          setSaveError(null);
        }}
        busy={saveBusy}
        error={saveError}
      />
    ) : null;

  const newFileLabel = creating === null ? '' : (fenceLine(creating.path, 120) ?? '');
  const extraViewer =
    creating !== null && tree.filePath === null ? (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <span className="truncate font-mono text-[13px]" title={newFileLabel}>
            {newFileLabel}
          </span>
          <span className="shrink-0 text-[12.5px] text-muted-foreground">New file</span>
        </div>
        <FileEditor
          value={creating.text}
          onChange={(text) => setCreating({ ...creating, text })}
          onSave={() => void saveNew()}
          onCancel={() => {
            setCreating(null);
            setSaveError(null);
          }}
          busy={saveBusy}
          error={saveError}
          saveLabel="Save file"
        />
      </div>
    ) : null;

  const listActions = canEdit ? (
    <>
      <div className="flex justify-end">
        <AddMenu
          busy={uploading}
          onUpload={() => uploadInput.current?.click()}
          onNewFile={() => {
            setNameError(null);
            setNameDialog('file');
          }}
          onNewFolder={() => {
            setNameError(null);
            setNameDialog('folder');
          }}
        />
        <input
          ref={uploadInput}
          type="file"
          multiple
          hidden
          data-testid="project-upload-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            void upload(files);
          }}
        />
      </div>
      {uploads !== null && <UploadResults outcomes={uploads} onDismiss={() => setUploads(null)} />}
      {deleted !== null && (
        <Alert role="status">
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 break-words">Deleted {deleted.label}.</span>
            <Button size="sm" variant="secondary" disabled={undoBusy} onClick={() => void undoDelete()}>
              {undoBusy && <Spinner data-icon="inline-start" aria-hidden="true" />}
              Undo
            </Button>
            <Button size="sm" variant="ghost" disabled={undoBusy} onClick={() => setHistory({ path: deleted.path, label: deleted.label })}>
              See history
            </Button>
            <Button size="sm" variant="ghost" disabled={undoBusy} onClick={() => setDeleted(null)}>
              Dismiss
            </Button>
            {undoError !== null && (
              <span role="alert" className="w-full text-destructive">
                {undoError}
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}
    </>
  ) : undefined;

  return (
    <>
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
        listActions={listActions}
        viewerActions={viewerActions}
        viewerBody={viewerBody}
        extraViewer={extraViewer}
        missingAction={(missing) =>
          missing === '' ? null : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setHistory({ path: missing, label: fenceLine(missing, 120) ?? 'This file' })}
            >
              See history
            </Button>
          )
        }
      />
      {history !== null && (
        <FileHistorySheet
          projectId={projectId}
          path={history.path}
          label={history.label}
          open
          canEdit={canEdit}
          onOpenChange={(next) => {
            if (!next) setHistory(null);
          }}
          onRestored={() => {
            // A restored file that had been deleted comes back: re-open the route's path.
            if (tree.filePath === history.path) void tree.refresh();
            else open(path);
          }}
          {...(onOpenConversation !== undefined ? { onOpenChat: onOpenConversation } : {})}
        />
      )}
      {canEdit && (
        <>
          <ConflictDialog
            open={conflictOpen}
            busy={saveBusy}
            onReload={() => {
              setConflictOpen(false);
              setEditing(null);
              void tree.refresh();
            }}
            onSaveOver={() => void saveEdit(true)}
            onOpenChange={setConflictOpen}
          />
          <NameDialog
            open={nameDialog !== null}
            kind={nameDialog ?? 'file'}
            where={target}
            busy={nameBusy}
            error={nameError}
            onSubmit={(name) => void submitName(name)}
            onOpenChange={(next) => {
              if (!next) setNameDialog(null);
            }}
          />
          <DeleteFileDialog
            open={deleteOpen}
            name={openFile?.name ?? ''}
            busy={deleteBusy}
            error={deleteError}
            onConfirm={() => void confirmDelete()}
            onOpenChange={setDeleteOpen}
          />
        </>
      )}
    </>
  );
}

/** "Files aren’t…" → "files aren’t…", for the "name: why" lines under an upload. */
function lowerFirst(s: string): string {
  return s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);
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
  onOpenConversation,
  leading,
}: {
  projectId: string;
  path: string;
  /** Go to another path in this folder (pushes history). */
  onNavigate: (path: string) => void;
  onOpenProject: () => void;
  onAllProjects: () => void;
  /** Open one of this person's chats (a version's "Open the chat"). */
  onOpenConversation?: (agentId: string, conversationId: string) => void;
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
              // Segments come from the URL: raw, agent-written names that may
              // carry bidi or control characters. Fence them for display.
              const label = fenceLine(seg, 120) ?? '…';
              return (
                <Fragment key={at}>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                  {last ? (
                    <BreadcrumbPage className="max-w-[24ch] truncate" title={label}>
                      {label}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      className="max-w-[16ch] truncate"
                      title={label}
                      href={filesHref(at)}
                      onClick={(e) => inPlaceClick(e, () => onNavigate(at))}
                    >
                      {label}
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
        <ProjectFilesBrowser
          projectId={projectId}
          path={path}
          canEdit={canEditProjectFiles(project.members)}
          onNavigate={onNavigate}
          {...(onOpenConversation !== undefined ? { onOpenConversation } : {})}
        />
      </div>
    </>
  );
}
