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

import { listAdminAgents, deleteAgent } from '@/lib/admin';

const mockList = vi.mocked(listAdminAgents);
const mockDelete = vi.mocked(deleteAgent);

const AGENT: AdminAgent = {
  id: 'agent-1',
  ownerId: 'user-1',
  ownerType: 'user',
  visibility: 'personal',
  displayName: 'Research Bot',
  systemPrompt: '',
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
    render(<AgentForm />);

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
    render(<AgentForm />);
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
    render(<AgentForm />);
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
