/**
 * The pieces people change a project's files with (W3c, W3 spec §6.3): the
 * rules for what may be changed where, the sentences a refusal reads as, and
 * the editor, dialogs and + menu `ProjectFiles` wires into its browser.
 *
 * The rules here only decide what to OFFER. `@ax/projects` enforces each of
 * them again (who may write, `sources/` read-only, the two files that can't be
 * deleted, the 10 MiB cap), so a stale page can at worst show a button whose
 * answer is a clear refusal.
 *
 * Every name drawn here is fenced: the server fences listing and file names,
 * and a name a person typed or picked from their disk goes through the same
 * `fenceLine` before it reaches a dialog.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { MoreHorizontal, Plus } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { fenceLine } from '@/lib/fence-line';
import { logRequestFailure } from '@/lib/http';
import type { UserFileBody } from '@/lib/user-files';
import { ProjectFileChangeError, WorkspaceApiError } from '@/lib/workspace-api';
import type { ProjectMember } from '@/wire/projects';

/** Files up to this size can be edited as text (the server's preview). */
export const PROJECT_FILE_EDIT_MAX_BYTES = 1024 * 1024;
/** The most one upload (one file) may be: `@ax/projects`' write cap. */
export const PROJECT_FILE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** The longest name the + menu takes for a new file or folder. */
const NEW_NAME_MAX_CHARS = 200;

/** The sentence for "the server can't change files right now". */
export const PROJECT_FILES_CHANGE_UNAVAILABLE = 'Files aren’t available right now.';
/** A create-only save found something already there. */
export const PROJECT_FILE_EXISTS = 'A file with that name already exists.';
export const PROJECT_FILE_CONFLICT_TITLE = 'Someone changed this file. Reload, or save over it?';

/** The folders the + menu adds into; anywhere else, it adds into `work/`. */
const ADD_TARGETS = ['work', 'memory', 'playbooks'] as const;
const DEFAULT_ADD_TARGET = 'work';
/** Files the project leans on: they can be edited, never deleted. */
const PROTECTED_PATHS = new Set(['instructions.md', 'memory/status.md']);

/**
 * May this person change the project's files? Only through a member agent
 * they can use whose role is editor or owner. `displayName` is set exactly
 * for the members on their own agent list (the server's `namedMembers`), so a
 * member without one isn't theirs to act through.
 */
export function canEditProjectFiles(members: readonly ProjectMember[]): boolean {
  return members.some((m) => m.displayName !== undefined && m.role !== 'viewer');
}

/** `sources/` holds copies from connected sources: nothing in it changes here. */
export function isReadOnlyPath(path: string): boolean {
  return path === 'sources' || path.startsWith('sources/');
}

/** Can this file be deleted from the UI? Not the protected two, nothing under `sources/`. */
export function isDeletablePath(path: string): boolean {
  return !PROTECTED_PATHS.has(path) && !isReadOnlyPath(path);
}

/**
 * Where the + menu adds: the folder on screen when it's inside `work/`,
 * `memory/` or `playbooks/`, else `work/`.
 */
export function addTargetDir(dirPath: string): string {
  return ADD_TARGETS.some((t) => dirPath === t || dirPath.startsWith(`${t}/`)) ? dirPath : DEFAULT_ADD_TARGET;
}

/** `dir` + `name` as one raw key. */
export function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/**
 * Can this open file be edited as text? Only when the server vouched that its
 * body IS the whole file (`sha256`), and it's small enough to.
 */
export function isEditableFile(file: UserFileBody | null): file is UserFileBody & { sha256: string; body: string } {
  return (
    file !== null &&
    typeof file.sha256 === 'string' &&
    file.clipped === null &&
    typeof file.body === 'string' &&
    (file.size ?? 0) <= PROJECT_FILE_EDIT_MAX_BYTES &&
    !isReadOnlyPath(file.path)
  );
}

/**
 * Why a name can't be used, or `null` when it can. One plain segment: no
 * slash, not `.` or `..`, and nothing `fenceLine` would change — so no
 * control, bidi or zero-width characters and no stray spaces at either end.
 */
export function newNameProblem(name: string): string | null {
  if (name.length === 0) return 'Give it a name.';
  if (name.includes('/') || name.includes('\\')) return 'A name can’t have a slash in it.';
  if (name === '.' || name === '..') return 'Pick a different name.';
  if (fenceLine(name, NEW_NAME_MAX_CHARS) !== name) {
    return 'Use plain letters, numbers and punctuation, with no hidden characters.';
  }
  return null;
}

/** The parts of a change failure the sentences below read. */
function failureOf(e: unknown): { status: number | null; code: string | undefined } {
  if (e instanceof ProjectFileChangeError) return { status: e.status, code: e.code };
  if (e instanceof WorkspaceApiError) return { status: e.status, code: undefined };
  return { status: null, code: undefined };
}

/**
 * What a refused or failed change says, in plain words. `exists` /
 * `conflict` are answered by the callers (their own dialog or sentence); any
 * 409 that reaches here reads as "already exists".
 */
export function changeFailureMessage(e: unknown, op: 'save' | 'delete' | 'upload' | 'folder'): string {
  const { status, code } = failureOf(e);
  if (status === 503 || code === 'project-files-unavailable' || code === 'projects-unavailable') {
    return PROJECT_FILES_CHANGE_UNAVAILABLE;
  }
  if (code === 'forbidden') {
    return 'Your agents in this project can only view it, so its files can’t be changed from here.';
  }
  if (code === 'protected-path') return 'This file keeps the project running, so it can be edited but not deleted.';
  if (code === 'read-only-path') return 'Sources is read-only. It holds copies from connected sources.';
  if (status === 413) return 'That’s too big to save here. Each file can be up to 10 MB.';
  if (status === 409) return op === 'folder' ? 'Something with that name is already there.' : PROJECT_FILE_EXISTS;
  if (status === 404) return 'That isn’t here anymore. It may have been moved or deleted.';
  if (status === 400) {
    return op === 'delete'
      ? 'That can’t be deleted from here. A folder has to be empty first.'
      : 'We couldn’t use that name. Try a simpler one.';
  }
  logRequestFailure(e, `project-file-${op}`);
  switch (op) {
    case 'delete':
      return 'We couldn’t delete that just now. Try again in a moment.';
    case 'folder':
      return 'We couldn’t make that folder just now. Try again in a moment.';
    default:
      return 'We couldn’t save that just now. Nothing was lost, so try again in a moment.';
  }
}

/** Is this the "someone changed it" answer to a save sent with a base hash? */
export function isConflict(e: unknown): boolean {
  const { status, code } = failureOf(e);
  return status === 409 && (code === 'conflict' || code === undefined);
}

// ---------------------------------------------------------------------------

/** The text editor that takes the place of a file's body while it's edited. */
export function FileEditor({
  value,
  onChange,
  onSave,
  onCancel,
  busy,
  error,
  saveLabel = 'Save',
}: {
  value: string;
  onChange: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
  saveLabel?: string;
}) {
  return (
    <form
      className="flex max-w-[680px] flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <Textarea
        aria-label="File contents"
        className="min-h-[50vh] font-mono text-[12.5px] leading-relaxed"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={busy}
        spellCheck
        autoFocus
      />
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
          {saveLabel}
        </Button>
      </div>
    </form>
  );
}

/** "Someone changed this file." Reload drops the edit; Save over it keeps it. */
export function ConflictDialog({
  open,
  busy,
  onReload,
  onSaveOver,
  onOpenChange,
}: {
  open: boolean;
  busy: boolean;
  onReload: () => void;
  onSaveOver: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{PROJECT_FILE_CONFLICT_TITLE}</AlertDialogTitle>
          <AlertDialogDescription>
            Reload shows the newer version and drops your edit. Save over it replaces their change with yours.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={onReload}>
            Reload
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              onSaveOver();
            }}
          >
            {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
            Save over it
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Asks for one name: a new text file's or a new folder's. */
export function NameDialog({
  open,
  kind,
  where,
  busy,
  error,
  onSubmit,
  onOpenChange,
}: {
  open: boolean;
  kind: 'file' | 'folder';
  /** The folder it goes into, as a raw key. Fenced before it's drawn. */
  where: string;
  busy: boolean;
  /** A refusal from the caller (e.g. "already exists"). */
  error: string | null;
  onSubmit: (name: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      setName('');
      setTouched(false);
    }
  }, [open]);
  const problem = newNameProblem(name);
  const shown = touched && name.length > 0 ? problem : null;
  const message = shown ?? error;
  const whereLabel = fenceLine(`${where}/`, 120) ?? `${where}/`;

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (problem === null) onSubmit(name);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{kind === 'file' ? 'New text file' : 'New folder'}</DialogTitle>
          <DialogDescription>It goes in {whereLabel}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <FieldGroup>
            <Field data-invalid={message !== null ? true : undefined}>
              <FieldLabel htmlFor="project-new-name">Name</FieldLabel>
              <Input
                id="project-new-name"
                value={name}
                placeholder={kind === 'file' ? 'notes.md' : 'drafts'}
                maxLength={NEW_NAME_MAX_CHARS}
                autoComplete="off"
                aria-invalid={message !== null ? true : undefined}
                disabled={busy}
                onChange={(e) => {
                  setName(e.target.value);
                  setTouched(true);
                }}
              />
              {message !== null ? (
                <FieldError>{message}</FieldError>
              ) : (
                kind === 'file' && <FieldDescription>End it in .md for Markdown, or .txt for plain text.</FieldDescription>
              )}
            </Field>
          </FieldGroup>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || problem !== null}>
              {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
              {kind === 'file' ? 'Continue' : 'Create folder'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Delete ‹name›?" — `name` is the server's fenced label, fenced again here. */
export function DeleteFileDialog({
  open,
  name,
  busy,
  error,
  onConfirm,
  onOpenChange,
}: {
  open: boolean;
  name: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const label = fenceLine(name, 120) ?? 'this file';
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">Delete {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            It’s removed from the project for everyone, including its agents.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: 'destructive' })}
            disabled={busy}
            onClick={(e) => {
              // Stay open until the delete answers, so a failure has somewhere to say so.
              e.preventDefault();
              onConfirm();
            }}
          >
            {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The + menu over the file list. */
export function AddMenu({
  busy,
  onUpload,
  onNewFile,
  onNewFolder,
}: {
  busy: boolean;
  onUpload: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={busy}>
          {busy ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Plus data-icon="inline-start" />}
          Add
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={onUpload}>Upload files</DropdownMenuItem>
          <DropdownMenuItem onSelect={onNewFile}>New text file</DropdownMenuItem>
          <DropdownMenuItem onSelect={onNewFolder}>New folder</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The open file's own menu: History for everyone, Delete for editors where it's allowed. */
export function FileMenu({ onHistory, onDelete }: { onHistory: () => void; onDelete?: (() => void) | undefined }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="File options" className="shrink-0">
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={onHistory}>History</DropdownMenuItem>
          {onDelete !== undefined && (
            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One upload's outcome. `name` is already fenced. */
export interface UploadOutcome {
  name: string;
  ok: boolean;
  message: string;
}

/** What happened to each file in the last upload, until the person closes it. */
export function UploadResults({ outcomes, onDismiss }: { outcomes: UploadOutcome[]; onDismiss: () => void }) {
  const failed = outcomes.filter((o) => !o.ok);
  const saved = outcomes.length - failed.length;
  return (
    <Alert variant={failed.length > 0 ? 'destructive' : 'default'} aria-label="Upload results">
      <AlertDescription className="flex flex-col gap-1.5 text-[12.5px]">
        <span>
          {failed.length === 0
            ? saved === 1
              ? 'Uploaded 1 file.'
              : `Uploaded ${saved} files.`
            : saved === 0
              ? 'Nothing was uploaded.'
              : `Uploaded ${saved} of ${outcomes.length} files.`}
        </span>
        {failed.length > 0 && (
          <ul className="flex flex-col gap-1">
            {failed.map((o, i) => (
              <li key={`${o.name}:${i}`} className="break-words">
                <span className="font-medium">{o.name}</span>: {o.message}
              </li>
            ))}
          </ul>
        )}
        <Button variant="secondary" size="sm" className="self-start" onClick={onDismiss}>
          OK
        </Button>
      </AlertDescription>
    </Alert>
  );
}
