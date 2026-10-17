/**
 * The three project dialogs (W3a, W3 spec §4.8 frames 3 and 11):
 *
 * - **New project** asks two questions — "What are you working on?" (the name)
 *   and "What are you trying to get done?" (optional) — and, only when the
 *   person manages more than one agent, which agent looks after it (§15 Q5).
 * - **Project settings** edits the same two fields.
 * - **Delete** confirms in an `AlertDialog`, in the words §15 Q1 settled on:
 *   deleting a project deletes every chat in it, including other people's.
 *
 * The length caps mirror `@ax/projects`' content rule (name 1–80 on one line,
 * description ≤ 500). The server is the authority; these only stop a person
 * typing something it will refuse.
 */
import { useEffect, useState, type FormEvent } from 'react';
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { userFacingMessage } from '@/lib/http';
import { workspaceApi } from '@/lib/workspace-api';
import type { OwnerCandidatesResponse } from '@/wire/projects';

export const PROJECT_NAME_MAX = 80;
export const PROJECT_DESCRIPTION_MAX = 500;

/** The Q1 sentence. Exported so the test pins the exact words. */
export const DELETE_PROJECT_COPY =
  "This deletes the project's files and every chat in it, including chats other people started. You can't undo this.";

/** A name the server will take: something on one line, at most 80 characters. */
function nameIsValid(name: string): boolean {
  const t = name.trim();
  return t.length > 0 && t.length <= PROJECT_NAME_MAX;
}

/** The two questions, shared by New project and Settings. */
function ProjectFields({
  idPrefix,
  name,
  description,
  onName,
  onDescription,
  disabled,
}: {
  idPrefix: string;
  name: string;
  description: string;
  onName: (v: string) => void;
  onDescription: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-name`}>What are you working on?</FieldLabel>
        <Input
          id={`${idPrefix}-name`}
          autoFocus
          placeholder="e.g. Q4 launch"
          value={name}
          // A name is one line; a pasted newline becomes a space.
          onChange={(e) => onName(e.target.value.replace(/[\r\n]+/g, ' '))}
          maxLength={PROJECT_NAME_MAX}
          disabled={disabled}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-description`}>
          What are you trying to get done?
        </FieldLabel>
        <Textarea
          id={`${idPrefix}-description`}
          placeholder="A sentence or two is plenty."
          value={description}
          onChange={(e) => onDescription(e.target.value)}
          maxLength={PROJECT_DESCRIPTION_MAX}
          disabled={disabled}
          aria-describedby={`${idPrefix}-description-help`}
        />
        <FieldDescription id={`${idPrefix}-description-help`}>
          Optional. Your agent reads this at the start of every chat in the project.
        </FieldDescription>
      </Field>
    </>
  );
}

type Candidates =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; agents: OwnerCandidatesResponse['agents'] };

export function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The new project's id; the caller refreshes and navigates. */
  onCreated: (projectId: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidates>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh form every time it opens, and a fresh read of who may own it.
  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setError(null);
    setOwner(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCandidates({ kind: 'loading' });
    workspaceApi
      .ownerCandidates()
      .then((res) => {
        if (cancelled) return;
        setCandidates({ kind: 'ready', agents: res.agents });
        // Most recently used first: the first is the default (Q5).
        setOwner(res.agents[0]?.agentId ?? null);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setCandidates({ kind: 'failed', message: userFacingMessage(e, 'project-owner-candidates') });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, reload]);

  const valid = nameIsValid(name) && owner !== null;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!valid || busy || owner === null) return;
    setBusy(true);
    setError(null);
    try {
      const desc = description.trim();
      const { projectId } = await workspaceApi.createProject({
        name: name.trim(),
        ...(desc !== '' ? { description: desc } : {}),
        ownerAgentId: owner,
      });
      onCreated(projectId);
    } catch (err) {
      setError(userFacingMessage(err, 'project-create'));
    } finally {
      setBusy(false);
    }
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
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A place for the chats and files about one piece of work.
          </DialogDescription>
        </DialogHeader>
        {candidates.kind === 'failed' ? (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span className="min-w-0">{candidates.message}</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="ml-auto"
                onClick={() => setReload((n) => n + 1)}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : candidates.kind === 'loading' ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : candidates.agents.length === 0 ? (
          <Alert>
            <AlertDescription>
              A project needs an agent of yours to look after it. Create an agent first,
              then come back here.
            </AlertDescription>
          </Alert>
        ) : (
          <form className="flex flex-col gap-5" onSubmit={(e) => void submit(e)}>
            <FieldGroup>
              <ProjectFields
                idPrefix="new-project"
                name={name}
                description={description}
                onName={setName}
                onDescription={setDescription}
                disabled={busy}
              />
              {/* Quiet, and only when there is a real choice (Q5). */}
              {candidates.agents.length > 1 && owner !== null && (
                <Field>
                  <FieldLabel htmlFor="new-project-owner">Which agent looks after it?</FieldLabel>
                  <Select value={owner} onValueChange={setOwner} disabled={busy}>
                    <SelectTrigger id="new-project-owner">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {candidates.agents.map((a) => (
                          <SelectItem key={a.agentId} value={a.agentId}>
                            {a.displayName}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </FieldGroup>
            {error !== null && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!valid || busy}>
                {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
                Create project
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ProjectSettingsDialog({
  open,
  onOpenChange,
  projectId,
  initialName,
  initialDescription,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  initialName: string;
  initialDescription: string | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setDescription(initialDescription ?? '');
    setError(null);
  }, [open, initialName, initialDescription]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!nameIsValid(name) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const desc = description.trim();
      await workspaceApi.updateProject(projectId, {
        name: name.trim(),
        // Blank clears it (the wire's `null`).
        description: desc === '' ? null : desc,
      });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(userFacingMessage(err, 'project-update'));
    } finally {
      setBusy(false);
    }
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
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>Everyone in the project sees these.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-5" onSubmit={(e) => void submit(e)}>
          <FieldGroup>
            <ProjectFields
              idPrefix="project-settings"
              name={name}
              description={description}
              onName={setName}
              onDescription={setDescription}
              disabled={busy}
            />
          </FieldGroup>
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!nameIsValid(name) || busy}>
              {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteProjectDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName: string;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await workspaceApi.deleteProject(projectId);
      onDeleted();
    } catch (err) {
      setError(userFacingMessage(err, 'project-delete'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {projectName}?</AlertDialogTitle>
          <AlertDialogDescription>{DELETE_PROJECT_COPY}</AlertDialogDescription>
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
              // Stay open until the delete answers, so a failure has somewhere
              // to say so.
              e.preventDefault();
              void confirm();
            }}
          >
            {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
            Delete project
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
