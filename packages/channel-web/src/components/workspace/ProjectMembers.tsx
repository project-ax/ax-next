/**
 * The project page's Members card (W3a, W3 spec §4.8; W3e, §8).
 *
 * Everyone sees who works in the project. Someone who manages it also gets:
 *
 * - **"Add one of your agents"** — a small dialog: which agent (from the ones
 *   they look after, minus the members) and Can edit / Can view.
 * - **a ⋯ menu on each member but the owner** — Can edit / Can view, and
 *   "Remove from project" behind a confirm that says what happens to its chats.
 *
 * Every change answers the members after it (`{ members }`), and the card
 * draws those: there is no reload, and nothing the page shows can drift from
 * what the server just said. The owner is fixed (the server refuses to touch
 * it), so it never gets a menu.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { MoreHorizontal, UserPlus } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { HttpError, logRequestFailure, userFacingMessage } from '@/lib/http';
import { workspaceApi } from '@/lib/workspace-api';
import type {
  OwnerCandidatesResponse,
  ProjectMember,
  ProjectMemberRole,
} from '@/wire/projects';
import { AgentTile } from './bits';

export const ROLE_LABEL: Record<ProjectMemberRole, string> = {
  owner: 'Owner',
  editor: 'Can edit',
  viewer: 'Can view',
};

type MemberRole = 'editor' | 'viewer';

/**
 * The remove confirm's sentence (W3e plan: "Removing a member leaves its chats
 * in the project"). Exported so the test pins the exact words.
 */
export function removeMemberCopy(agentName: string): string {
  return `${agentName} won't be able to use this project's files. Its chats in this project will stop working until you move them out.`;
}

/** A member change that didn't go through, in words a person can act on. */
function memberChangeError(e: unknown, context: string): string {
  logRequestFailure(e, context);
  // 403: the owner agent, a project they can't manage, or an agent with a
  // different owner than the project's (W2 allows only the same owner). The
  // route can't say which, so the copy names the rules.
  if (e instanceof HttpError && e.status === 403) {
    return 'That agent can’t be changed here. A project can only include agents with the same owner as the project, and only someone who looks after an agent can add or change it.';
  }
  return 'We couldn’t change that just now. Nothing changed — try again in a moment.';
}

export function ProjectMembersCard({
  projectId,
  projectName,
  members,
  canManage,
  nameOf,
  onMembers,
}: {
  projectId: string;
  projectName: string;
  /** Owner first. */
  members: ProjectMember[];
  canManage: boolean;
  /** A board agent's name, or null for one this person can't see. */
  nameOf: (agentId: string) => string | null;
  /** The members after a change, straight from the server's answer. */
  onMembers: (members: ProjectMember[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ agentId: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = (m: ProjectMember) =>
    m.displayName ?? nameOf(m.agentId) ?? 'An agent you can’t see';

  async function setRole(agentId: string, role: MemberRole) {
    setBusy(true);
    setError(null);
    try {
      const res = await workspaceApi.setProjectMember(projectId, agentId, role);
      onMembers(res.members);
    } catch (e) {
      setError(memberChangeError(e, 'project-member-role'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <CardTitle className="text-[15px]">Members</CardTitle>
          <CardDescription>The agents working in this project.</CardDescription>
        </div>
        {canManage && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(null);
              setAdding(true);
            }}
          >
            <UserPlus data-icon="inline-start" aria-hidden="true" />
            Add one of your agents
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <ul className="flex flex-col gap-2" aria-label="Members">
          {members.map((m) => {
            const name = label(m);
            return (
              <li key={m.agentId} className="flex min-h-8 items-center gap-2.5 text-[13px]">
                <AgentTile agent={{ name }} size={22} />
                <span className="min-w-0 flex-1 truncate" title={name}>
                  {name}
                </span>
                <Badge variant="secondary" size="compact">
                  {ROLE_LABEL[m.role]}
                </Badge>
                {canManage && m.role !== 'owner' && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Options for ${name}`}
                        className="size-8 max-md:size-11"
                        disabled={busy}
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuRadioGroup
                        value={m.role}
                        onValueChange={(v) => {
                          if ((v === 'editor' || v === 'viewer') && v !== m.role) {
                            void setRole(m.agentId, v);
                          }
                        }}
                      >
                        <DropdownMenuRadioItem value="editor">Can edit</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="viewer">Can view</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => {
                            setError(null);
                            setRemoving({ agentId: m.agentId, name });
                          }}
                        >
                          Remove from project
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>

      {canManage && (
        <AddMemberDialog
          open={adding}
          onOpenChange={setAdding}
          projectId={projectId}
          memberIds={members.map((m) => m.agentId)}
          onAdded={(next) => {
            onMembers(next);
            setAdding(false);
          }}
        />
      )}
      {canManage && (
        <RemoveMemberDialog
          target={removing}
          projectId={projectId}
          projectName={projectName}
          onClose={() => setRemoving(null)}
          onRemoved={(next) => {
            onMembers(next);
            setRemoving(null);
          }}
        />
      )}
    </Card>
  );
}

type Candidates =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; agents: OwnerCandidatesResponse['agents'] };

/**
 * "Add one of your agents". The choices are the agents this person looks
 * after (the same list New project offers as owners, most recently used
 * first) minus the members; the first is the default. Can edit is the default
 * role: an agent is added to work on the project, and Can view is one click.
 */
function AddMemberDialog({
  open,
  onOpenChange,
  projectId,
  memberIds,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  memberIds: string[];
  onAdded: (members: ProjectMember[]) => void;
}) {
  const [candidates, setCandidates] = useState<Candidates>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [role, setRole] = useState<MemberRole>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRole('editor');
    setError(null);
    setAgentId(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCandidates({ kind: 'loading' });
    workspaceApi
      .ownerCandidates()
      .then((res) => {
        if (!cancelled) setCandidates({ kind: 'ready', agents: res.agents });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setCandidates({ kind: 'failed', message: userFacingMessage(e, 'project-member-candidates') });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, reload]);

  const choices =
    candidates.kind === 'ready'
      ? candidates.agents.filter((a) => !memberIds.includes(a.agentId))
      : [];
  // The person's pick while it's still a choice, else the first.
  const picked = choices.find((a) => a.agentId === agentId) ?? choices[0] ?? null;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (picked === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await workspaceApi.setProjectMember(projectId, picked.agentId, role);
      onAdded(res.members);
    } catch (err) {
      setError(memberChangeError(err, 'project-member-add'));
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
          <DialogTitle>Add one of your agents</DialogTitle>
          <DialogDescription>
            It can use this project’s files, and you can start chats with it here.
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
        ) : picked === null ? (
          <Alert>
            <AlertDescription>All of your agents are already in this project.</AlertDescription>
          </Alert>
        ) : (
          <form className="flex flex-col gap-5" onSubmit={(e) => void submit(e)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="add-member-agent">Agent</FieldLabel>
                <Select value={picked.agentId} onValueChange={setAgentId} disabled={busy}>
                  <SelectTrigger id="add-member-agent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {choices.map((a) => (
                        <SelectItem key={a.agentId} value={a.agentId}>
                          {a.displayName}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <FieldSet>
                <FieldLegend variant="label">What can it do here?</FieldLegend>
                <RadioGroup
                  value={role}
                  onValueChange={(v) => {
                    if (v === 'editor' || v === 'viewer') setRole(v);
                  }}
                  disabled={busy}
                >
                  <Field orientation="horizontal">
                    <RadioGroupItem value="editor" id="add-member-editor" />
                    <FieldContent>
                      <FieldLabel htmlFor="add-member-editor">Can edit</FieldLabel>
                      <FieldDescription>Read and change the project’s files.</FieldDescription>
                    </FieldContent>
                  </Field>
                  <Field orientation="horizontal">
                    <RadioGroupItem value="viewer" id="add-member-viewer" />
                    <FieldContent>
                      <FieldLabel htmlFor="add-member-viewer">Can view</FieldLabel>
                      <FieldDescription>Read the project’s files, but not change them.</FieldDescription>
                    </FieldContent>
                  </Field>
                </RadioGroup>
              </FieldSet>
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
              <Button type="submit" disabled={busy}>
                {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
                Add
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RemoveMemberDialog({
  target,
  projectId,
  projectName,
  onClose,
  onRemoved,
}: {
  target: { agentId: string; name: string } | null;
  projectId: string;
  projectName: string;
  onClose: () => void;
  onRemoved: (members: ProjectMember[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Kept through the close animation, so the title doesn't blank out.
  const [shown, setShown] = useState(target);

  useEffect(() => {
    if (target !== null) {
      setShown(target);
      setError(null);
    }
  }, [target]);

  async function confirm() {
    if (target === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await workspaceApi.removeProjectMember(projectId, target.agentId);
      onRemoved(res.members);
    } catch (e) {
      setError(memberChangeError(e, 'project-member-remove'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Remove {shown?.name} from {projectName}?
          </AlertDialogTitle>
          <AlertDialogDescription>{removeMemberCopy(shown?.name ?? '')}</AlertDialogDescription>
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
              // Stay open until the server answers, so a failure has
              // somewhere to say so.
              e.preventDefault();
              void confirm();
            }}
          >
            {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
