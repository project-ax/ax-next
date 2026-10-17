/**
 * `/workspace/projects/:projectId` — one project (W3a, W3 spec §4.8 frame 4,
 * the chats side): its name and description, this person's chats in it, a
 * composer that starts a new one with the project's agent, and a Members card.
 * Settings and Delete live behind ⋯ (frame 11), only for someone who manages
 * the owner agent.
 *
 * W3b adds the files card. Nothing here stands in for it.
 *
 * The shell keys this on the project id, so another project is a fresh mount
 * and never flashes the last one's data.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { HTTP_SESSION_ENDED, logRequestFailure } from '@/lib/http';
import { toReadOutcome, type ReadOutcome } from '@/lib/read-register';
import { workspaceApi, type WorkspaceAgent } from '@/lib/workspace-api';
import type { SendableAttachment } from '@/lib/workspace-attachments';
import { workspaceRoutePath } from '@/lib/workspace-route';
import { timeAgo } from '@/lib/workspace-time';
import type {
  ProjectConversation,
  ProjectDetail,
  ProjectMemberRole,
} from '@/wire/projects';
import { AgentTile } from './bits';
import { HomeComposer } from './HomeComposer';
import { DeleteProjectDialog, ProjectSettingsDialog } from './ProjectDialogs';
import { inPlaceClick } from './ProjectsPage';
import { WorkspaceHeader } from './WorkspaceHeader';

const LOAD_COPY: Record<ReadOutcome, string> = {
  expired: HTTP_SESSION_ENDED,
  gone: 'We couldn’t open this project. It may have been deleted, or it isn’t shared with you.',
  failed: 'We couldn’t load this project just now. Nothing was lost.',
};

const ROLE_LABEL: Record<ProjectMemberRole, string> = {
  owner: 'Owner',
  editor: 'Can edit',
  viewer: 'Can view',
};

type Loaded = { project: ProjectDetail; conversations: ProjectConversation[] };

export function ProjectPage({
  projectId,
  agents,
  onAllProjects,
  onOpenConversation,
  onStartChat,
  onChanged,
  onDeleted,
  leading,
}: {
  projectId: string;
  /** The board's agents — the ones this person can open and talk to. */
  agents: WorkspaceAgent[];
  onAllProjects: () => void;
  onOpenConversation: (agentId: string, conversationId: string) => void;
  /** Start a new chat in this project; the caller navigates to it. */
  onStartChat: (
    agentId: string,
    text: string,
    attachments?: readonly SendableAttachment[],
  ) => Promise<void>;
  /** The project's name or description changed — refresh the list. */
  onChanged: () => void;
  onDeleted: () => void;
  leading?: ReactNode;
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<ReadOutcome | null>(null);
  const [reload, setReload] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const [project, convs] = await Promise.all([
          workspaceApi.getProject(projectId),
          workspaceApi.listProjectConversations(projectId),
        ]);
        if (!cancelled) setData({ project, conversations: convs.conversations });
      } catch (e) {
        if (cancelled) return;
        logRequestFailure(e, 'workspace-project');
        setError(toReadOutcome(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, reload]);

  const nameOf = useCallback(
    (agentId: string) => agents.find((a) => a.id === agentId)?.name ?? null,
    [agents],
  );

  if (error !== null && data === null) {
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
                    <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
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

  if (data === null) {
    return (
      <>
        <WorkspaceHeader title="Project" leading={leading} />
        <div className="flex flex-1 justify-center py-10">
          <Spinner />
        </div>
      </>
    );
  }

  const { project, conversations } = data;
  /*
    WHO A NEW CHAT GOES TO. The owner agent when this person can talk to it,
    else the first member they can. `members` is owner-first and lists only
    agents this person can use, and the board is the list they can open.
  */
  const chatAgent =
    project.members
      .map((m) => agents.find((a) => a.id === m.agentId))
      .find((a): a is WorkspaceAgent => a !== undefined) ?? null;
  const showAgentOnRows = new Set(conversations.map((c) => c.agentId)).size > 1;

  return (
    <>
      <WorkspaceHeader title={project.name} leading={leading}>
        {project.canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Project options" className="md:ml-auto">
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>Settings</DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => setDeleteOpen(true)}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </WorkspaceHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4 px-6 pb-6">
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
                <BreadcrumbPage className="max-w-[32ch] truncate">{project.name}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          {project.description !== null && (
            <p className="whitespace-pre-line text-[13.5px] text-muted-foreground">
              {project.description}
            </p>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-[15px]">Your chats</CardTitle>
            </CardHeader>
            <CardContent>
              {conversations.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">
                  No chats here yet. Start one below.
                </p>
              ) : (
                <ul className="flex flex-col gap-0.5" aria-label="Your chats in this project">
                  {conversations.map((c) => {
                    const agentName = showAgentOnRows ? nameOf(c.agentId) : null;
                    return (
                      <li key={c.conversationId}>
                        <Button
                          variant="ghost"
                          onClick={() => onOpenConversation(c.agentId, c.conversationId)}
                          className="h-auto min-h-10 w-full justify-start gap-2 px-2 text-left text-[13px] font-normal"
                        >
                          <span className="min-w-0 flex-1 truncate" title={c.title ?? undefined}>
                            {c.title ?? 'Untitled conversation'}
                          </span>
                          {agentName !== null && (
                            <span className="shrink-0 text-[12px] text-muted-foreground">
                              {agentName}
                            </span>
                          )}
                          <span className="shrink-0 text-[12px] text-muted-foreground">
                            {timeAgo(c.lastActivityAt)}
                          </span>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-[15px]">Members</CardTitle>
              <CardDescription>The agents working in this project.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2" aria-label="Members">
                {project.members.map((m) => {
                  const name = m.displayName ?? nameOf(m.agentId) ?? 'An agent you can’t see';
                  return (
                    <li key={m.agentId} className="flex items-center gap-2.5 text-[13px]">
                      <AgentTile agent={{ name }} size={22} />
                      <span className="min-w-0 flex-1 truncate" title={name}>
                        {name}
                      </span>
                      <Badge variant="secondary" size="compact">
                        {ROLE_LABEL[m.role]}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
      {chatAgent !== null ? (
        <HomeComposer agents={[chatAgent]} onSend={onStartChat} />
      ) : (
        <div className="mx-auto w-full max-w-[900px] px-6 pb-6">
          <Alert>
            <AlertDescription>
              None of this project’s agents are yours to chat with, so you can read along
              but not start a chat here.
            </AlertDescription>
          </Alert>
        </div>
      )}

      <ProjectSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        projectId={project.projectId}
        initialName={project.name}
        initialDescription={project.description}
        onSaved={() => {
          setReload((n) => n + 1);
          onChanged();
        }}
      />
      <DeleteProjectDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        projectId={project.projectId}
        projectName={project.name}
        onDeleted={() => {
          setDeleteOpen(false);
          onDeleted();
        }}
      />
    </>
  );
}
