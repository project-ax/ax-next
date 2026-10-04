import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import { AgentForm } from '../AgentForm';
import type { AdminAgent } from '@/lib/admin';

// Mock the wire clients at the lib boundary — no network.
vi.mock('@/lib/admin', () => ({
  listAdminAgents: vi.fn(),
  getAdminAgent: vi.fn(),
  createAgent: vi.fn(),
  patchAgent: vi.fn(),
  getAgentIdentity: vi.fn(),
  putAgentIdentity: vi.fn(),
  deleteAgent: vi.fn(),
  listTeams: vi.fn(),
  listAgentModelOptions: vi.fn(),
}));
// The attachment sections only render in the form view; stub them so the
// list-view delete test stays isolated.
vi.mock('../SkillAttachmentsSection', () => ({
  SkillAttachmentsSection: () => null,
}));
vi.mock('../AuthoredSkillsSection', () => ({
  AuthoredSkillsSection: () => null,
}));

import {
  listAdminAgents,
  getAdminAgent,
  createAgent,
  deleteAgent,
  listTeams,
  listAgentModelOptions,
  patchAgent,
  getAgentIdentity,
  putAgentIdentity,
} from '@/lib/admin';

const mockList = vi.mocked(listAdminAgents);
const mockDelete = vi.mocked(deleteAgent);

/** What GET /admin/agents/models returns for these tests — the deployment's
 *  allow-list ∩ the provider plugin's supported models. */
const MODEL_OPTIONS = [
  { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', kind: 'either' as const },
  { id: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7', kind: 'default' as const },
];

const AGENT: AdminAgent = {
  id: 'agent-1',
  ownerId: 'user-1',
  ownerType: 'user',
  visibility: 'personal',
  displayName: 'Research Bot',
  allowedTools: ['Bash'],
  mcpConfigIds: [],
  model: 'anthropic/claude-sonnet-4-6',
  workspaceRef: null,
  skillAttachments: [],
  connectorAttachments: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// A wildcard/bare agent — persisted with an empty allowedTools (a valid,
// store-allowed state). The combined AgentForm Save must NOT force this agent
// to enumerate tools just to edit its identity (TASK-147).
const BARE_AGENT: AdminAgent = {
  ...AGENT,
  id: 'agent-bare',
  displayName: 'Bare Bot',
  allowedTools: [],
  mcpConfigIds: [],
};

beforeEach(() => {
  vi.mocked(getAdminAgent).mockImplementation(async (id) => {
    const agents = await listAdminAgents();
    const agent = agents.find((item) => item.id === id);
    if (!agent) throw new Error('agent unavailable');
    return agent;
  });
});

describe('AgentForm — styled delete confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAgentModelOptions).mockResolvedValue({ models: MODEL_OPTIONS, defaultModel: 'anthropic/claude-sonnet-4-6' });
    mockList.mockResolvedValue([AGENT]);
    mockDelete.mockResolvedValue(undefined);
  });

  it('does not use the OS confirm; clicking delete opens a styled dialog', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<AgentForm isAdmin />);

    await waitFor(() => {
      expect(screen.getByText('Research Bot')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));

    await waitFor(() => {
      expect(screen.getByText('Delete agent?')).toBeTruthy();
    });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Research Bot')).toBeTruthy();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  // TASK-718: deleting an agent deletes its conversations, the files in them,
  // the files it saved, and its routines. The dialog used to say only "This
  // cannot be undone", which left a person free to assume their chats survive
  // the agent. It must say what goes, and must not promise anything is kept.
  it('says plainly what is deleted with the agent, and promises nothing is kept', async () => {
    render(<AgentForm isAdmin />);
    await waitFor(() => {
      expect(screen.getByText('Research Bot')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    await waitFor(() => {
      expect(screen.getByText('Delete agent?')).toBeTruthy();
    });
    const body = within(screen.getByRole('dialog')).getByText(/cannot be undone/i);
    const text = body.textContent ?? '';
    expect(text).toMatch(/conversations/i);
    expect(text).toMatch(/files/i);
    expect(text).toMatch(/routines/i);
    expect(text).not.toMatch(/\b(keep|kept|retain|archive)/i);
    // The agent's name stays in the sentence so the person can see WHICH one.
    expect(text).toContain('Research Bot');
  });

  it('confirm path → calls deleteAgent with the id', async () => {
    render(<AgentForm isAdmin />);
    await waitFor(() => {
      expect(screen.getByText('Research Bot')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    await waitFor(() => {
      expect(screen.getByText('Delete agent?')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith('agent-1');
    });
  });

  it('cancel path → dialog closes and deleteAgent is NOT called', async () => {
    render(<AgentForm isAdmin />);
    await waitFor(() => {
      expect(screen.getByText('Research Bot')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    await waitFor(() => {
      expect(screen.getByText('Delete agent?')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByText('Delete agent?')).toBeNull();
    });
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('AgentForm — team picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAgentModelOptions).mockResolvedValue({ models: MODEL_OPTIONS, defaultModel: 'anthropic/claude-sonnet-4-6' });
    mockList.mockResolvedValue([AGENT]);
    vi.mocked(listTeams).mockResolvedValue([]);
  });

  it('the team picker names each team by its displayName (TASK-571)', async () => {
    // The route's real shape. The picker used to read `.name`, which this
    // wire never carries, so every option rendered with no text at all.
    vi.mocked(listTeams).mockResolvedValue([
      {
        id: 'team_1',
        displayName: 'Engineering',
        createdBy: 'u1',
        createdAt: '2026-09-01T12:00:00.000Z',
      },
    ]);
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText('Research Bot')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }));
    const teamRadio = await screen.findByRole('radio', { name: /team/i });
    await waitFor(() => expect((teamRadio as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(teamRadio);
    const option = await screen.findByRole('option', { name: 'Engineering' });
    expect((option as HTMLOptionElement).value).toBe('team_1');
  });
});

describe('AgentForm — file-based identity editor (TASK-142)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAgentModelOptions).mockResolvedValue({ models: MODEL_OPTIONS, defaultModel: 'anthropic/claude-sonnet-4-6' });
    mockList.mockResolvedValue([AGENT]);
    vi.mocked(listTeams).mockResolvedValue([]);
    vi.mocked(patchAgent).mockResolvedValue(undefined);
    vi.mocked(putAgentIdentity).mockResolvedValue(undefined);
  });

  it('opening edit loads the agent’s .ax/ identity files into the three fields', async () => {
    vi.mocked(getAgentIdentity).mockResolvedValue({
      identity: 'I am Ada.',
      soul: 'I value clarity.',
      operating: 'Always use metric units.',
    });
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText('Research Bot')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'edit' }));

    // The editor reads the files via workspace:read (mocked at the wire).
    await waitFor(() =>
      expect(getAgentIdentity).toHaveBeenCalledWith('agent-1'),
    );
    await waitFor(() => {
      expect((screen.getByLabelText('Identity') as HTMLTextAreaElement).value).toBe(
        'I am Ada.',
      );
    });
    expect((screen.getByLabelText('Soul') as HTMLTextAreaElement).value).toBe(
      'I value clarity.',
    );
    expect(
      (screen.getByLabelText(/Operating instructions/) as HTMLTextAreaElement).value,
    ).toBe('Always use metric units.');
  });

  it('saving writes the edited identity files back via putAgentIdentity (workspace:apply)', async () => {
    vi.mocked(getAgentIdentity).mockResolvedValue({
      identity: 'I am Ada.',
      soul: 'old soul',
      operating: '',
    });
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText('Research Bot')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Soul') as HTMLTextAreaElement).value).toBe(
        'old soul',
      ),
    );

    // Edit the soul + add an operating override.
    fireEvent.change(screen.getByLabelText('Soul'), {
      target: { value: 'I value rigor.' },
    });
    fireEvent.change(screen.getByLabelText(/Operating instructions/), {
      target: { value: 'Prefer SI units.' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(putAgentIdentity).toHaveBeenCalledWith('agent-1', {
        identity: 'I am Ada.',
        soul: 'I value rigor.',
        operating: 'Prefer SI units.',
      }),
    );
  });
});

describe('AgentForm — identity save decoupled from tools gate (TASK-147)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAgentModelOptions).mockResolvedValue({ models: MODEL_OPTIONS, defaultModel: 'anthropic/claude-sonnet-4-6' });
    vi.mocked(listTeams).mockResolvedValue([]);
    vi.mocked(patchAgent).mockResolvedValue(undefined);
    vi.mocked(putAgentIdentity).mockResolvedValue(undefined);
    vi.mocked(createAgent).mockResolvedValue(AGENT);
    vi.mocked(getAgentIdentity).mockResolvedValue({
      identity: 'I am Bare.',
      soul: 'old soul',
      operating: '',
    });
  });

  it('an identity-only edit on a wildcard/bare agent saves without forcing a tool list', async () => {
    mockList.mockResolvedValue([BARE_AGENT]);
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText('Bare Bot')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Soul') as HTMLTextAreaElement).value).toBe(
        'old soul',
      ),
    );

    // Change ONLY the identity files; leave Allowed tools empty (the agent is
    // bare and the user has no intention of enumerating tools).
    fireEvent.change(screen.getByLabelText('Soul'), {
      target: { value: 'I value freedom.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // The identity write must happen — the tools gate must NOT abort the submit.
    await waitFor(() =>
      expect(putAgentIdentity).toHaveBeenCalledWith('agent-bare', {
        identity: 'I am Bare.',
        soul: 'I value freedom.',
        operating: '',
      }),
    );
    expect(
      screen.queryByText(/pick at least one tool/i),
    ).toBeNull();

    // The PATCH must NOT send the empty wildcard pair (allowedTools=[] AND
    // mcpConfigIds=[]) — the server rejects that combo. Those fields are omitted
    // so the agent stays bare.
    expect(patchAgent).toHaveBeenCalledTimes(1);
    const patchBody = vi.mocked(patchAgent).mock.calls[0]?.[1] ?? {};
    expect(patchBody).not.toHaveProperty('allowedTools');
    expect(patchBody).not.toHaveProperty('mcpConfigIds');
  });

  it('still blocks a NEW agent that lists no tools (gate preserved on create)', async () => {
    mockList.mockResolvedValue([]);
    render(<AgentForm isAdmin />);
    await waitFor(() =>
      expect(screen.getByText(/No agents yet/i)).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: /new agent/i }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Toolless' },
    });
    // Leave Allowed tools empty.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(screen.getByText(/pick at least one tool/i)).toBeTruthy(),
    );
    expect(createAgent).not.toHaveBeenCalled();
    expect(putAgentIdentity).not.toHaveBeenCalled();

    // TASK-341 / audit D2 — the message reads as an instruction rather than a
    // schema complaint ("agent must list at least one tool"), it names an
    // example so the field is answerable, and it renders through the `Alert`
    // primitive rather than one of the two hand-rolled destructive divs this
    // file used to carry (which had drifted to different padding from each
    // other — the whole argument for the primitive).
    expect(screen.getByText(/e\.g\. Bash, Read, Write/i)).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('border-destructive/50');
    expect(alert.className).not.toContain('bg-destructive/10');
  });

  it('still blocks clearing the tool list on an agent that HAD tools (no silent demotion to wildcard)', async () => {
    mockList.mockResolvedValue([AGENT]); // allowedTools: ['Bash']
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText('Research Bot')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Allowed tools') as HTMLInputElement).value,
      ).toBe('Bash'),
    );

    // Clear the previously-populated tool list.
    fireEvent.change(screen.getByLabelText('Allowed tools'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(screen.getByText(/pick at least one tool/i)).toBeTruthy(),
    );
    expect(patchAgent).not.toHaveBeenCalled();
    expect(putAgentIdentity).not.toHaveBeenCalled();
  });
});

describe('AgentForm — model policy (Default, moved notice, PATCH body)', () => {
  const ADMIN_DEFAULT_OPTIONS = [
    { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', kind: 'either' as const },
    { id: 'openrouter/moonshotai/kimi-k3', label: 'Kimi K3', kind: 'either' as const },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listTeams).mockResolvedValue([]);
    vi.mocked(patchAgent).mockResolvedValue(undefined);
    vi.mocked(putAgentIdentity).mockResolvedValue(undefined);
    vi.mocked(createAgent).mockResolvedValue(AGENT);
    vi.mocked(getAgentIdentity).mockResolvedValue({ identity: '', soul: '', operating: '' });
  });

  const modelSelect = () => document.querySelector<HTMLSelectElement>('#agent-model')!;

  it("pre-selects the admin's Default for a NEW agent (not just the first option)", async () => {
    vi.mocked(listAgentModelOptions).mockResolvedValue({
      models: ADMIN_DEFAULT_OPTIONS,
      defaultModel: 'openrouter/moonshotai/kimi-k3',
    });
    mockList.mockResolvedValue([]);
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText(/No agents yet/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }));
    await waitFor(() => expect(modelSelect().value).toBe('openrouter/moonshotai/kimi-k3'));
  });

  it('falls back to the first option when the server names no Default', async () => {
    vi.mocked(listAgentModelOptions).mockResolvedValue({ models: ADMIN_DEFAULT_OPTIONS, defaultModel: null });
    mockList.mockResolvedValue([]);
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText(/No agents yet/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }));
    await waitFor(() => expect(modelSelect().value).toBe('anthropic/claude-sonnet-4-6'));
  });

  it('an edit that leaves the model alone sends NO model in the PATCH (a swapped agent keeps its stored model)', async () => {
    vi.mocked(listAgentModelOptions).mockResolvedValue({ models: ADMIN_DEFAULT_OPTIONS, defaultModel: 'anthropic/claude-sonnet-4-6' });
    // The server resolved this agent onto the Default because its own model was removed.
    mockList.mockResolvedValue([{ ...AGENT, requestedModel: 'openrouter/moonshotai/kimi-k3' }]);
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText('Research Bot')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    await waitFor(() => expect(modelSelect().value).toBe('anthropic/claude-sonnet-4-6'));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed Bot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchAgent).toHaveBeenCalledTimes(1));
    const body = vi.mocked(patchAgent).mock.calls[0]?.[1] ?? {};
    expect(body).toMatchObject({ displayName: 'Renamed Bot' });
    expect(body).not.toHaveProperty('model');
  });

  it('an edit that changes the model sends it', async () => {
    vi.mocked(listAgentModelOptions).mockResolvedValue({ models: ADMIN_DEFAULT_OPTIONS, defaultModel: 'anthropic/claude-sonnet-4-6' });
    mockList.mockResolvedValue([AGENT]);
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText('Research Bot')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    await waitFor(() => expect(modelSelect().value).toBe('anthropic/claude-sonnet-4-6'));

    fireEvent.change(modelSelect(), { target: { value: 'openrouter/moonshotai/kimi-k3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchAgent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(patchAgent).mock.calls[0]?.[1]).toMatchObject({ model: 'openrouter/moonshotai/kimi-k3' });
  });

  it('tells the owner their agent moved, in plain words', async () => {
    vi.mocked(listAgentModelOptions).mockResolvedValue({ models: ADMIN_DEFAULT_OPTIONS, defaultModel: 'anthropic/claude-sonnet-4-6' });
    mockList.mockResolvedValue([{ ...AGENT, requestedModel: 'openrouter/moonshotai/kimi-k3' }]);
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText('Research Bot')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    expect(
      await screen.findByText(
        'Your admin changed the available models, so this agent is using Claude Sonnet 4.6 now. Pick a different model to change it.',
      ),
    ).toBeInTheDocument();
  });

  it('shows no notice for an agent on its own model', async () => {
    vi.mocked(listAgentModelOptions).mockResolvedValue({ models: ADMIN_DEFAULT_OPTIONS, defaultModel: 'anthropic/claude-sonnet-4-6' });
    mockList.mockResolvedValue([AGENT]);
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText('Research Bot')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    await waitFor(() => expect(modelSelect().value).toBe('anthropic/claude-sonnet-4-6'));
    expect(screen.queryByText(/Your admin changed the available models/)).toBeNull();
  });
});

it('opens resolved agent details so a stored removed model is shown as the Default', async () => {
  vi.mocked(listAgentModelOptions).mockResolvedValue({ models: MODEL_OPTIONS, defaultModel: 'anthropic/claude-sonnet-4-6' });
  vi.mocked(listTeams).mockResolvedValue([]);
  vi.mocked(getAgentIdentity).mockResolvedValue({ identity: '', soul: '', operating: '' });
  mockList.mockResolvedValue([{ ...AGENT, model: 'openrouter/removed' }]);
  vi.mocked(getAdminAgent).mockResolvedValue({ ...AGENT, requestedModel: 'openrouter/removed' });
  render(<AgentForm isAdmin />);
  await screen.findByText('Research Bot');
  fireEvent.click(screen.getByRole('button', { name: 'edit' }));
  expect(await screen.findByText(/Your admin changed the available models/)).toBeInTheDocument();
  expect(getAdminAgent).toHaveBeenCalledWith(AGENT.id);
  await waitFor(() => expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe(AGENT.model));
});

it('keeps a delayed Edit read from replacing a new agent draft', async () => {
  mockList.mockResolvedValue([AGENT]);
  let release!: (agent: typeof AGENT) => void;
  vi.mocked(getAdminAgent).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  render(<AgentForm isAdmin />);
  await screen.findByText('Research Bot');
  fireEvent.click(screen.getByRole('button', { name: 'edit' }));
  await waitFor(() => expect(getAdminAgent).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'New agent' }));
  const name = screen.getByLabelText('Name');
  fireEvent.change(name, { target: { value: 'New draft' } });
  release(AGENT);
  await waitFor(() => expect(getAdminAgent).toHaveBeenCalledWith(AGENT.id));
  expect(await screen.findByRole('heading', { name: 'New agent' })).toBeInTheDocument();
  expect(name).toHaveValue('New draft');
});

it('keeps a delayed first Edit from replacing a newer Edit', async () => {
  const other = { ...AGENT, id: 'agent-other', displayName: 'Other Bot' };
  mockList.mockResolvedValue([AGENT, other]);
  let first!: (agent: typeof AGENT) => void;
  let second!: (agent: typeof AGENT) => void;
  vi.mocked(getAdminAgent).mockImplementation((id) => new Promise((resolve) => {
    if (id === AGENT.id) first = resolve; else second = resolve;
  }));
  render(<AgentForm isAdmin />);
  await screen.findByText('Other Bot');
  const edits = screen.getAllByRole('button', { name: 'edit' });
  fireEvent.click(edits[0]!);
  fireEvent.click(edits[1]!);
  second(other);
  await screen.findByRole('heading', { name: 'Edit Other Bot' });
  first(AGENT);
  await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Other Bot'));
  expect(screen.queryByRole('heading', { name: 'Edit Research Bot' })).toBeNull();
});

// TASK-799 — connectors are added from the workspace rail now, not assigned
// per agent in this form. Neither a create nor an edit, for a personal or a team
// agent, may render a connector picker, an access notice for one, or a team-agent
// sign-in affordance.
describe('AgentForm — no per-agent connector assignment (TASK-799)', () => {
  const TEAMS = [
    { id: 'team_1', displayName: 'Engineering', createdBy: 'u1', createdAt: '2026-09-01T12:00:00.000Z' },
  ];
  const PERSONAL_AGENT: AdminAgent = { ...AGENT, connectorAttachments: ['github'] };
  const TEAM_AGENT: AdminAgent = {
    ...AGENT,
    id: 'team-agent-1',
    ownerId: 'team_1',
    ownerType: 'team',
    visibility: 'team',
    displayName: 'Team Bot',
    connectorAttachments: ['github'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAgentModelOptions).mockResolvedValue({ models: MODEL_OPTIONS, defaultModel: 'anthropic/claude-sonnet-4-6' });
    vi.mocked(listTeams).mockResolvedValue(TEAMS);
    vi.mocked(getAgentIdentity).mockResolvedValue({ identity: '', soul: '', operating: '' });
    mockList.mockResolvedValue([PERSONAL_AGENT, TEAM_AGENT]);
  });

  function expectNoConnectorAssignment() {
    const form = screen.getByLabelText('Name').closest('form')!;
    expect(within(form).queryByText(/^Connectors$/)).toBeNull();
    expect(within(form).queryByText(/No connectors yet/i)).toBeNull();
    expect(within(form).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(form).queryByTestId('connector-access-notice')).toBeNull();
    expect(within(form).queryByRole('button', { name: /connect|sign in/i })).toBeNull();
  }

  it('a new agent (personal, then switched to team) has no connector section', async () => {
    render(<AgentForm isAdmin />);
    await screen.findByText('Research Bot');
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }));
    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLSelectElement).value).not.toBe(''));
    expectNoConnectorAssignment();
    const teamRadio = screen.getByRole('radio', { name: /team/i });
    await waitFor(() => expect((teamRadio as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(teamRadio);
    await screen.findByRole('option', { name: 'Engineering' });
    expectNoConnectorAssignment();
  });

  it.each([
    [0, 'Research Bot'],
    [1, 'Team Bot'],
  ])('editing agent #%i (%s), which has connectors, shows no picker and no sign-in', async (idx, name) => {
    render(<AgentForm isAdmin />);
    await screen.findByText(name);
    fireEvent.click(screen.getAllByRole('button', { name: 'edit' })[idx]!);
    await screen.findByRole('heading', { name: `Edit ${name}` });
    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLSelectElement).value).not.toBe(''));
    expectNoConnectorAssignment();
  });
});
