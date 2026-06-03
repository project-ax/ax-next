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
  createAgent: vi.fn(),
  patchAgent: vi.fn(),
  patchAgentConnectorAttachments: vi.fn(),
  getAgentIdentity: vi.fn(),
  putAgentIdentity: vi.fn(),
  deleteAgent: vi.fn(),
  listTeams: vi.fn(),
}));
vi.mock('@/lib/connectors', () => ({ listConnectors: vi.fn() }));
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
  deleteAgent,
  listTeams,
  patchAgent,
  patchAgentConnectorAttachments,
  getAgentIdentity,
  putAgentIdentity,
} from '@/lib/admin';
import { listConnectors } from '@/lib/connectors';

const mockList = vi.mocked(listAdminAgents);
const mockDelete = vi.mocked(deleteAgent);

const AGENT: AdminAgent = {
  id: 'agent-1',
  ownerId: 'user-1',
  ownerType: 'user',
  visibility: 'personal',
  displayName: 'Research Bot',
  allowedTools: ['Bash'],
  mcpConfigIds: [],
  model: 'claude-sonnet-4-6',
  workspaceRef: null,
  skillAttachments: [],
  connectorAttachments: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('AgentForm — styled delete confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

describe('AgentForm — non-admin owner-scoped sources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue([AGENT]);
    vi.mocked(listTeams).mockResolvedValue([]);
    vi.mocked(listConnectors).mockResolvedValue([]);
  });

  it('a non-admin reads connectors from the user route (/settings/connectors), not the admin one', async () => {
    render(<AgentForm isAdmin={false} />);
    await waitFor(() => expect(screen.getByText('Research Bot')).toBeTruthy());
    // Opening the form triggers the deferred teams + connectors fetch.
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }));
    await waitFor(() =>
      expect(listConnectors).toHaveBeenCalledWith('/settings/connectors'),
    );
    expect(listConnectors).not.toHaveBeenCalledWith('/admin/connectors');
  });

  it('an admin reads connectors from the admin route (/admin/connectors)', async () => {
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText('Research Bot')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }));
    await waitFor(() =>
      expect(listConnectors).toHaveBeenCalledWith('/admin/connectors'),
    );
  });
});

describe('AgentForm — file-based identity editor (TASK-142)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue([AGENT]);
    vi.mocked(listTeams).mockResolvedValue([]);
    vi.mocked(listConnectors).mockResolvedValue([]);
    vi.mocked(patchAgent).mockResolvedValue(undefined);
    vi.mocked(patchAgentConnectorAttachments).mockResolvedValue(AGENT);
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
