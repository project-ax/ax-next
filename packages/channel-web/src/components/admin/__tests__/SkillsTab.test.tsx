import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SkillsTab } from '../SkillsTab';
import type { SkillSummary } from '@ax/skills';

// Mock the wire clients
vi.mock('@/lib/skills', () => ({
  listSkills: vi.fn(),
  deleteSkill: vi.fn(),
}));

// Mock SkillEditor so tests don't depend on its internals
vi.mock('../SkillEditor', () => ({
  SkillEditor: ({ onCancel }: { skillId?: string; onSaved: () => void; onCancel: () => void }) => (
    <div data-testid="skill-editor">
      <button onClick={onCancel}>Cancel editor</button>
    </div>
  ),
}));

import { listSkills, deleteSkill } from '@/lib/skills';

const mockListSkills = vi.mocked(listSkills);
const mockDeleteSkill = vi.mocked(deleteSkill);

const SKILL_A: SkillSummary = {
  id: 'github-api',
  description: 'Interacts with the GitHub REST API.',
  version: 1,
  capabilities: {
    allowedHosts: ['api.github.com'],
    credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key', description: 'PAT' }],
    mcpServers: [],
  },
  defaultAttached: false,
  updatedAt: '2026-05-18T10:00:00.000Z',
};

const SKILL_B: SkillSummary = {
  id: 'slack-notify',
  description: 'Posts messages to Slack channels.',
  version: 0,
  capabilities: {
    allowedHosts: [],
    credentials: [],
    mcpServers: [],
  },
  defaultAttached: false,
  updatedAt: '2026-05-17T08:00:00.000Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  mockDeleteSkill.mockResolvedValue(undefined);
});

describe('SkillsTab', () => {
  it('renders a list of skills', async () => {
    mockListSkills.mockResolvedValueOnce([SKILL_A, SKILL_B]);
    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByText('github-api')).toBeTruthy();
      expect(screen.getByText('slack-notify')).toBeTruthy();
    });

    expect(screen.getByText('Interacts with the GitHub REST API.')).toBeTruthy();
    expect(screen.getByText('Posts messages to Slack channels.')).toBeTruthy();
    expect(screen.getByText('api.github.com')).toBeTruthy();
    expect(screen.getByText('GITHUB_TOKEN')).toBeTruthy();
  });

  it('shows empty state when no skills are installed', async () => {
    mockListSkills.mockResolvedValueOnce([]);
    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByText(/No skills installed/)).toBeTruthy();
    });
  });

  it('shows loading state before promise resolves', () => {
    // Never resolve so we can observe the loading state
    mockListSkills.mockReturnValueOnce(new Promise(() => {}));
    render(<SkillsTab />);

    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('shows error alert when fetch fails', async () => {
    mockListSkills.mockRejectedValueOnce(new Error('Network error'));
    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy();
    });
  });

  it('clicking "New skill" opens the editor dialog', async () => {
    mockListSkills.mockResolvedValueOnce([]);
    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByText(/No skills installed/)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /new skill/i }));

    await waitFor(() => {
      expect(screen.getByText('Install a new skill')).toBeTruthy();
    });
    expect(screen.getByTestId('skill-editor')).toBeTruthy();
  });

  it('clicking edit button on a row opens the editor with that skill', async () => {
    mockListSkills.mockResolvedValueOnce([SKILL_A]);
    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByText('github-api')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edit github-api' }));

    await waitFor(() => {
      expect(screen.getByText('Edit skill: github-api')).toBeTruthy();
    });
    expect(screen.getByTestId('skill-editor')).toBeTruthy();
  });

  it('clicking delete button shows confirmation dialog; clicking Delete calls deleteSkill', async () => {
    mockListSkills.mockResolvedValue([SKILL_A]);
    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByText('github-api')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete github-api' }));

    await waitFor(() => {
      expect(screen.getByText('Delete skill?')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockDeleteSkill).toHaveBeenCalledWith('github-api');
    });
  });

  it('server-side delete error surfaces in the alert', async () => {
    mockListSkills.mockResolvedValue([SKILL_A]);
    mockDeleteSkill.mockRejectedValueOnce(new Error('skill is still attached'));
    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByText('github-api')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete github-api' }));
    await waitFor(() => {
      expect(screen.getByText('Delete skill?')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.getByText('skill is still attached')).toBeTruthy();
    });
  });

  it('renders a "default" badge for default-attached skills', async () => {
    mockListSkills.mockResolvedValueOnce([
      {
        id: 'heartbeat',
        description: 'Daily check-in.',
        version: 1,
        capabilities: { allowedHosts: [], credentials: [], mcpServers: [] },
        defaultAttached: true,
        updatedAt: '2026-05-19T00:00:00.000Z',
      },
      {
        id: 'github',
        description: 'GitHub API.',
        version: 1,
        capabilities: { allowedHosts: ['api.github.com'], credentials: [{ slot: 'X', kind: 'api-key' }], mcpServers: [] },
        defaultAttached: false,
        updatedAt: '2026-05-19T00:00:00.000Z',
      },
    ]);

    render(<SkillsTab />);

    // The default-attached row should expose the badge text.
    const heartbeatCell = await screen.findByText('heartbeat');
    const heartbeatRow = heartbeatCell.closest('tr')!;
    expect(heartbeatRow.textContent).toMatch(/default/i);

    // The non-default row should not.
    const githubRow = screen.getByText('github').closest('tr')!;
    expect(githubRow.textContent).not.toMatch(/default/i);
  });
});
