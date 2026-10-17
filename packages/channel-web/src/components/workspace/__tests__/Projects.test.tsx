/**
 * W3a — projects in the workspace UI (W3 spec §4.8, §15 Q1/Q5/Q6).
 *
 * Component-level for the pieces that stand alone (the sidebar section, the
 * grid, the New project dialog), and through the real shell for everything
 * that is about wiring: the project page's composer sending with the project
 * id, a chat opening in the agent view, delete navigating away, the chat
 * breadcrumb and the rail label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { workspaceApi, type AgentDetail } from '@/lib/workspace-api';
import { UserProvider } from '@/lib/user-context';
import type { ProjectDetail, ProjectSummary } from '@/wire/projects';
import { WorkspaceShell } from '../WorkspaceShell';
import { WorkspaceSidebarNav } from '../WorkspaceSidebar';
import { ProjectsPage } from '../ProjectsPage';
import { DELETE_PROJECT_COPY, NewProjectDialog } from '../ProjectDialogs';
import { rail as railFixture } from './rail-fixture';
import { clearViewport } from './viewport';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      board: vi.fn(),
      agent: vi.fn(),
      route: vi.fn(),
      activity: vi.fn(),
      decisions: vi.fn(),
      approveDecision: vi.fn(),
      dismissDecision: vi.fn(),
      undoDecision: vi.fn(),
      grants: vi.fn(async () => ({ grants: [] })),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
      saveRules: vi.fn(),
      recallMemory: vi.fn(),
      memoryEvents: vi.fn(() => new Promise(() => {})),
      correctMemory: vi.fn(),
      forgetMemory: vi.fn(),
      unforgetMemory: vi.fn(),
      connectors: vi.fn(async () => ({ connectors: [], shared: false, manageable: true, sharedCredentials: false, connectorsSupported: true })),
      abilities: vi.fn(async () => ({ abilities: {} })),
      sendMessage: vi.fn(),
      // A reply that never ends: these tests are about where the turn went.
      streamReply: vi.fn(() => new Promise(() => {})),
      listProjects: vi.fn(),
      createProject: vi.fn(),
      getProject: vi.fn(),
      updateProject: vi.fn(),
      deleteProject: vi.fn(),
      listProjectConversations: vi.fn(),
      ownerCandidates: vi.fn(),
    },
  };
});

const api = vi.mocked(workspaceApi);

const user = { id: 'u1', email: 'u@example.com', name: 'Uma', role: 'user' as const };

const QUILL = {
  id: 'a-quill',
  name: 'Quill',
  state: 'resting' as const,
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function summary(over: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    projectId: 'p1',
    name: 'Q4 launch',
    description: 'Ship the launch.\nSecond line stays off the card.',
    updatedAt: hoursAgo(2),
    members: [{ agentId: 'a-quill', role: 'owner' }],
    ...over,
  };
}

function detail(over: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    projectId: 'p1',
    name: 'Q4 launch',
    description: 'Ship the launch.',
    createdAt: hoursAgo(48),
    updatedAt: hoursAgo(2),
    members: [{ agentId: 'a-quill', role: 'owner', displayName: 'Quill' }],
    canManage: true,
    ...over,
  };
}

function agentDetail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent: QUILL,
    conversationId: 'c-current',
    thread: [],
    decisions: { status: 'ok' },
    past: [],
    memory: { rules: { status: 'unavailable', doc: null } },
    ...over,
  } as AgentDetail;
}

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(
    <UserProvider value={user}>
      <WorkspaceShell />
    </UserProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  vi.clearAllMocks();
  api.board.mockResolvedValue({ agents: [QUILL] } as never);
  api.agent.mockResolvedValue(agentDetail());
  api.activity.mockResolvedValue({ events: [], nextBefore: null } as never);
  api.decisions.mockResolvedValue({ decisions: [] } as never);
  api.grants.mockResolvedValue({ grants: [] } as never);
  api.rail.mockResolvedValue(railFixture() as never);
  api.connectors.mockResolvedValue({ connectors: [], shared: false, manageable: true, sharedCredentials: false, connectorsSupported: true } as never);
  api.abilities.mockResolvedValue({ abilities: {} } as never);
  api.memoryEvents.mockImplementation(() => new Promise(() => {}) as never);
  api.streamReply.mockImplementation(() => new Promise(() => {}) as never);
  api.listProjects.mockResolvedValue({ projects: [summary()] });
  api.getProject.mockResolvedValue(detail());
  api.listProjectConversations.mockResolvedValue({ conversations: [] });
  api.ownerCandidates.mockResolvedValue({ agents: [{ agentId: 'a-quill', displayName: 'Quill' }] });
});

afterEach(clearViewport);

// ---------------------------------------------------------------------------

describe('sidebar Projects section', () => {
  function renderNav(over: Partial<Parameters<typeof WorkspaceSidebarNav>[0]['projects'] & object> = {}) {
    const projects = {
      items: [
        summary({ projectId: 'old', name: 'Oldest', updatedAt: hoursAgo(100) }),
        ...['a', 'b', 'c', 'd', 'e'].map((id, i) =>
          summary({ projectId: id, name: `Project ${id}`, updatedAt: hoursAgo(i + 1) }),
        ),
      ],
      activeId: 'b',
      open: true,
      onOpenChange: vi.fn(),
      onAll: vi.fn(),
      onOpen: vi.fn(),
      onNew: vi.fn(),
      ...over,
    };
    render(
      <UserProvider value={user}>
        <WorkspaceSidebarNav
          agents={[]}
          route="project"
          activeAgentId={null}
          pendingCount={0}
          rosterOpen
          onRoster={vi.fn()}
          onToday={vi.fn()}
          onActivity={vi.fn()}
          onAgent={vi.fn()}
          projects={projects}
        />
      </UserProvider>,
    );
    return projects;
  }

  it('lists the five most recent projects, then All projects and New project', () => {
    const projects = renderNav();
    expect(screen.getByRole('button', { name: 'Projects' })).toBeTruthy();
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      expect(screen.getByRole('button', { name: `Project ${id}` })).toBeTruthy();
    }
    // The sixth, oldest one is only on the grid.
    expect(screen.queryByRole('button', { name: 'Oldest' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Project b' })).toHaveAttribute('data-active', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Project c' }));
    expect(projects.onOpen).toHaveBeenCalledWith('c');
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    expect(projects.onAll).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(projects.onNew).toHaveBeenCalled();
  });

  it('navigates through the shell: All projects opens the grid', async () => {
    renderAt('/workspace');
    fireEvent.click(await screen.findByRole('button', { name: 'All projects' }));
    expect(window.location.pathname).toBe('/workspace/projects');
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
    // And a recent project opens its page.
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Workspace' })).getByRole('button', { name: 'Q4 launch' }));
    expect(window.location.pathname).toBe('/workspace/projects/p1');
  });
});

// ---------------------------------------------------------------------------

describe('projects grid', () => {
  it('draws a card per project: name, first line, and how long ago it changed', () => {
    const onOpen = vi.fn();
    render(
      <ProjectsPage
        projects={[summary(), summary({ projectId: 'p2', name: 'Hiring', description: null, updatedAt: hoursAgo(30) })]}
        error={null}
        loading={false}
        onRetry={vi.fn()}
        onOpen={onOpen}
        onNew={vi.fn()}
      />,
    );
    const list = screen.getByRole('list', { name: 'Projects' });
    const cards = within(list).getAllByRole('link');
    expect(cards).toHaveLength(2);
    // Most recently updated first.
    expect(cards[0]).toHaveTextContent('Q4 launch');
    expect(cards[0]).toHaveTextContent('Ship the launch.');
    expect(cards[0]).not.toHaveTextContent('Second line');
    expect(cards[0]).toHaveTextContent('Updated 2h ago');
    expect(cards[0]).toHaveAttribute('href', '/workspace/projects/p1');
    expect(cards[1]).toHaveTextContent('Hiring');

    fireEvent.click(cards[0]!);
    expect(onOpen).toHaveBeenCalledWith('p1');
  });

  it('shows an empty state with a New project button when there are none', () => {
    const onNew = vi.fn();
    render(
      <ProjectsPage projects={[]} error={null} loading={false} onRetry={vi.fn()} onOpen={vi.fn()} onNew={onNew} />,
    );
    expect(screen.getByText('No projects yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(onNew).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('New project dialog', () => {
  function renderDialog() {
    const onCreated = vi.fn();
    render(<NewProjectDialog open onOpenChange={vi.fn()} onCreated={onCreated} />);
    return { onCreated };
  }

  it('needs a name before it will create', async () => {
    renderDialog();
    const name = await screen.findByLabelText('What are you working on?');
    const create = screen.getByRole('button', { name: 'Create project' });
    expect(create).toBeDisabled();
    fireEvent.change(name, { target: { value: '   ' } });
    expect(create).toBeDisabled();
    fireEvent.change(name, { target: { value: 'Q4 launch' } });
    expect(create).toBeEnabled();
    expect(name).toHaveAttribute('maxLength', '80');
    expect(screen.getByLabelText('What are you trying to get done?')).toHaveAttribute('maxLength', '500');
  });

  it('hides the owner choice when the person manages one agent', async () => {
    renderDialog();
    await screen.findByLabelText('What are you working on?');
    expect(screen.queryByLabelText('Which agent looks after it?')).toBeNull();
  });

  it('offers the owner choice for two, defaulting to the most recently used', async () => {
    api.ownerCandidates.mockResolvedValue({
      agents: [
        { agentId: 'a-quill', displayName: 'Quill' },
        { agentId: 'a-scribe', displayName: 'Scribe' },
      ],
    });
    renderDialog();
    const owner = await screen.findByLabelText('Which agent looks after it?');
    expect(owner).toHaveTextContent('Quill');
  });

  it('creates with the default owner and hands back the new id', async () => {
    api.ownerCandidates.mockResolvedValue({
      agents: [
        { agentId: 'a-scribe', displayName: 'Scribe' },
        { agentId: 'a-quill', displayName: 'Quill' },
      ],
    });
    api.createProject.mockResolvedValue({ projectId: 'p-new' });
    const { onCreated } = renderDialog();
    fireEvent.change(await screen.findByLabelText('What are you working on?'), {
      target: { value: '  Q4 launch ' },
    });
    fireEvent.change(screen.getByLabelText('What are you trying to get done?'), {
      target: { value: 'Ship it.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('p-new'));
    expect(api.createProject).toHaveBeenCalledWith({
      name: 'Q4 launch',
      description: 'Ship it.',
      ownerAgentId: 'a-scribe',
    });
  });

  it('says what went wrong in an Alert and keeps the form', async () => {
    api.createProject.mockRejectedValue(new Error('boom'));
    const { onCreated } = renderDialog();
    fireEvent.change(await screen.findByLabelText('What are you working on?'), {
      target: { value: 'Q4 launch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByLabelText('What are you working on?')).toHaveValue('Q4 launch');
  });

  it('navigates to the new project from the shell', async () => {
    api.createProject.mockResolvedValue({ projectId: 'p-new' });
    api.getProject.mockResolvedValue(detail({ projectId: 'p-new', name: 'Hiring' }));
    renderAt('/workspace/projects');
    await screen.findByRole('list', { name: 'Projects' });
    // The page's own button, not the sidebar's.
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'New project' }));
    fireEvent.change(await screen.findByLabelText('What are you working on?'), {
      target: { value: 'Hiring' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(window.location.pathname).toBe('/workspace/projects/p-new'));
    expect(await screen.findByRole('heading', { name: 'Hiring' })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe('project page', () => {
  it('shows the description, the person’s chats and the Members card', async () => {
    api.listProjectConversations.mockResolvedValue({
      conversations: [
        { conversationId: 'c-old', agentId: 'a-quill', title: 'Launch checklist', lastActivityAt: hoursAgo(3) },
      ],
    });
    renderAt('/workspace/projects/p1');
    expect(await screen.findByRole('heading', { name: 'Q4 launch' })).toBeTruthy();
    expect(screen.getByText('Ship the launch.')).toBeTruthy();
    const chats = screen.getByRole('list', { name: 'Your chats in this project' });
    expect(within(chats).getByRole('button', { name: /Launch checklist/ })).toBeTruthy();
    const members = screen.getByRole('list', { name: 'Members' });
    expect(members).toHaveTextContent('Quill');
    expect(members).toHaveTextContent('Owner');
    // No placeholder for W3b's files.
    expect(screen.queryByText(/files/i)).toBeNull();
  });

  it('opens a chat in the agent view, on that conversation', async () => {
    api.listProjectConversations.mockResolvedValue({
      conversations: [
        { conversationId: 'c-old', agentId: 'a-quill', title: 'Launch checklist', lastActivityAt: hoursAgo(3) },
      ],
    });
    api.agent.mockImplementation(async (_id: string, conversationId?: string) =>
      agentDetail({
        past: [{ id: 'c-old', title: 'Launch checklist', lastActivityAt: hoursAgo(3), project: { projectId: 'p1', name: 'Q4 launch' } }],
        ...(conversationId === 'c-old' ? { conversationId: 'c-old' } : {}),
      }),
    );
    renderAt('/workspace/projects/p1');
    fireEvent.click(await screen.findByRole('button', { name: /Launch checklist/ }));
    expect(window.location.pathname).toBe('/workspace/agents/a-quill');
    await waitFor(() => expect(api.agent).toHaveBeenCalledWith('a-quill', 'c-old'));
  });

  it('starts a new chat in the project with the owner agent', async () => {
    api.sendMessage.mockResolvedValue({ reqId: 'r1', conversationId: 'c-new' } as never);
    renderAt('/workspace/projects/p1');
    const input = await screen.findByPlaceholderText(/^Ask Quill/);
    fireEvent.change(input, { target: { value: 'Draft the launch email' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith({
        agentId: 'a-quill',
        conversationId: null,
        text: 'Draft the launch email',
        projectId: 'p1',
      }),
    );
    await waitFor(() => expect(window.location.pathname).toBe('/workspace/agents/a-quill'));
  });

  it('hides Settings and Delete from someone who can’t manage it', async () => {
    api.getProject.mockResolvedValue(detail({ canManage: false }));
    renderAt('/workspace/projects/p1');
    await screen.findByRole('heading', { name: 'Q4 launch' });
    expect(screen.queryByRole('button', { name: 'Project options' })).toBeNull();
  });

  it('saves settings through updateProject', async () => {
    api.updateProject.mockResolvedValue({ projectId: 'p1', name: 'Q4 launch v2', description: null, updatedAt: hoursAgo(0) });
    renderAt('/workspace/projects/p1');
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Project options' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Project settings' });
    fireEvent.change(within(dialog).getByLabelText('What are you working on?'), { target: { value: 'Q4 launch v2' } });
    fireEvent.change(within(dialog).getByLabelText('What are you trying to get done?'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith('p1', { name: 'Q4 launch v2', description: null }),
    );
  });

  it('deletes after the Q1 warning, then goes back to all projects', async () => {
    api.deleteProject.mockResolvedValue(undefined);
    renderAt('/workspace/projects/p1');
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Project options' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(
      "This deletes the project's files and every chat in it, including chats other people started. You can't undo this.",
    );
    expect(DELETE_PROJECT_COPY).toBe(
      "This deletes the project's files and every chat in it, including chats other people started. You can't undo this.",
    );
    expect(api.deleteProject).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(api.deleteProject).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(window.location.pathname).toBe('/workspace/projects'));
  });

  it('says so when the project can’t be opened', async () => {
    const { HttpError } = await import('@/lib/http');
    api.getProject.mockRejectedValue(new HttpError('/api/workspace/projects/p1', 404));
    renderAt('/workspace/projects/p1');
    expect(await screen.findByText(/couldn’t open this project/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'All projects' }));
    expect(window.location.pathname).toBe('/workspace/projects');
  });
});

// ---------------------------------------------------------------------------

describe('a project chat in the agent view', () => {
  it('shows a breadcrumb back to the project, and follows it', async () => {
    api.agent.mockResolvedValue(agentDetail({ project: { projectId: 'p1', name: 'Q4 launch' } }));
    renderAt('/workspace/agents/a-quill');
    const crumb = await screen.findByRole('navigation', { name: 'Project' });
    const link = within(crumb).getByRole('link', { name: 'Q4 launch' });
    expect(link).toHaveAttribute('href', '/workspace/projects/p1');
    fireEvent.click(link);
    expect(window.location.pathname).toBe('/workspace/projects/p1');
  });

  it('has no breadcrumb outside a project', async () => {
    api.agent.mockResolvedValue(agentDetail({ project: null }));
    renderAt('/workspace/agents/a-quill');
    await screen.findByRole('heading', { name: 'Conversation' });
    expect(screen.queryByRole('navigation', { name: 'Project' })).toBeNull();
  });

  it('labels only the project chats in the rail', async () => {
    api.agent.mockResolvedValue(
      agentDetail({
        past: [
          { id: 'c1', title: 'Launch checklist', lastActivityAt: hoursAgo(30), project: { projectId: 'p1', name: 'Q4 launch' } },
          { id: 'c2', title: 'Grocery list', lastActivityAt: hoursAgo(40), project: null },
        ],
      }),
    );
    renderAt('/workspace/agents/a-quill');
    const projectRow = await screen.findByRole('button', { name: 'Launch checklist' });
    const plainRow = screen.getByRole('button', { name: 'Grocery list' });
    expect(within(projectRow).getByText('Q4 launch')).toBeTruthy();
    expect(projectRow).toHaveAccessibleDescription(/^In Q4 launch, /);
    expect(within(plainRow).queryByText('Q4 launch')).toBeNull();
  });
});
