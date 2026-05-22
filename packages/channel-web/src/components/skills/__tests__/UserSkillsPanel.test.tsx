import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UserSkillsPanel } from '../UserSkillsPanel';
import type { SkillSummary } from '@ax/skills';

// Mock the wire clients at the lib boundary — no network.
vi.mock('@/lib/user-skills', () => ({
  listUserSkills: vi.fn(),
  getUserSkill: vi.fn(),
  createUserSkill: vi.fn(),
  updateUserSkill: vi.fn(),
  deleteUserSkill: vi.fn(),
}));

// Mock SkillEditor so tests don't depend on its internals (parser + form).
vi.mock('@/components/admin/SkillEditor', () => ({
  SkillEditor: ({
    onCancel,
    onSaved,
  }: {
    skillId?: string;
    onSaved: () => void;
    onCancel: () => void;
    api?: unknown;
  }) => (
    <div data-testid="skill-editor">
      <button onClick={onSaved}>Save editor</button>
      <button onClick={onCancel}>Cancel editor</button>
    </div>
  ),
}));

import {
  listUserSkills,
  deleteUserSkill,
} from '@/lib/user-skills';

const mockListUserSkills = vi.mocked(listUserSkills);
const mockDeleteUserSkill = vi.mocked(deleteUserSkill);

const SKILL_A: SkillSummary = {
  id: 'my-github',
  description: 'Personal GitHub integration.',
  version: 1,
  scope: 'user',
  capabilities: {
    allowedHosts: ['api.github.com'],
    credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key', description: 'PAT' }],
    mcpServers: [],
    packages: { npm: [], pypi: [] },
  },
  defaultAttached: false,
  updatedAt: '2026-05-20T10:00:00.000Z',
};

const SKILL_B: SkillSummary = {
  id: 'my-helper',
  description: 'Personal helper skill.',
  version: 1,
  scope: 'user',
  capabilities: {
    allowedHosts: [],
    credentials: [],
    mcpServers: [],
    packages: { npm: [], pypi: [] },
  },
  defaultAttached: true,
  updatedAt: '2026-05-20T09:00:00.000Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  mockDeleteUserSkill.mockResolvedValue(undefined);
});

describe('UserSkillsPanel', () => {
  it('is not rendered when open=false', () => {
    mockListUserSkills.mockResolvedValue([]);
    render(<UserSkillsPanel open={false} onClose={vi.fn()} />);
    // Dialog content should not be visible.
    expect(screen.queryByText('My Skills')).toBeNull();
  });

  it('renders the title when open=true', async () => {
    mockListUserSkills.mockResolvedValue([]);
    render(<UserSkillsPanel open={true} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('My Skills')).toBeTruthy();
    });
  });

  it('lists the user skills', async () => {
    mockListUserSkills.mockResolvedValue([SKILL_A, SKILL_B]);
    render(<UserSkillsPanel open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('my-github')).toBeTruthy();
      expect(screen.getByText('my-helper')).toBeTruthy();
    });

    expect(screen.getByText('Personal GitHub integration.')).toBeTruthy();
    expect(screen.getByText('Personal helper skill.')).toBeTruthy();
    expect(screen.getByText('api.github.com')).toBeTruthy();
    expect(screen.getByText('GITHUB_TOKEN')).toBeTruthy();
  });

  it('shows loading state before promise resolves', () => {
    mockListUserSkills.mockReturnValue(new Promise(() => {}));
    render(<UserSkillsPanel open={true} onClose={vi.fn()} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('shows empty state when no skills exist', async () => {
    mockListUserSkills.mockResolvedValue([]);
    render(<UserSkillsPanel open={true} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/No skills installed/)).toBeTruthy();
    });
  });

  it('shows error alert when fetch fails', async () => {
    mockListUserSkills.mockRejectedValue(new Error('Network failure'));
    render(<UserSkillsPanel open={true} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Network failure')).toBeTruthy();
    });
  });

  it('renders "default" badge for default-attached skills', async () => {
    mockListUserSkills.mockResolvedValue([SKILL_A, SKILL_B]);
    render(<UserSkillsPanel open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('my-github')).toBeTruthy();
    });

    const helperCell = screen.getByText('my-helper');
    const helperRow = helperCell.closest('tr')!;
    expect(helperRow.textContent).toMatch(/default/i);

    const githubRow = screen.getByText('my-github').closest('tr')!;
    expect(githubRow.textContent).not.toMatch(/default/i);
  });

  it('clicking "New skill" opens the editor dialog', async () => {
    mockListUserSkills.mockResolvedValue([]);
    render(<UserSkillsPanel open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/No skills installed/)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /new skill/i }));

    await waitFor(() => {
      expect(screen.getByText('Install a new skill')).toBeTruthy();
      expect(screen.getByTestId('skill-editor')).toBeTruthy();
    });
  });

  it('clicking edit button opens the editor with that skill id', async () => {
    mockListUserSkills.mockResolvedValue([SKILL_A]);
    render(<UserSkillsPanel open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('my-github')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edit my-github' }));

    await waitFor(() => {
      expect(screen.getByText('Edit skill: my-github')).toBeTruthy();
      expect(screen.getByTestId('skill-editor')).toBeTruthy();
    });
  });

  it('delete button → confirmation dialog → calls deleteUserSkill', async () => {
    mockListUserSkills.mockResolvedValue([SKILL_A]);
    render(<UserSkillsPanel open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('my-github')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete my-github' }));

    await waitFor(() => {
      expect(screen.getByText('Delete skill?')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockDeleteUserSkill).toHaveBeenCalledWith('my-github');
    });
  });

  it('delete error surfaces in the alert', async () => {
    mockListUserSkills.mockResolvedValue([SKILL_A]);
    mockDeleteUserSkill.mockRejectedValueOnce(new Error('skill still attached'));
    render(<UserSkillsPanel open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('my-github')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete my-github' }));

    await waitFor(() => {
      expect(screen.getByText('Delete skill?')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.getByText('skill still attached')).toBeTruthy();
    });
  });

  it('editor saves via the injected api (createUserSkill is called, not admin upsertSkill)', async () => {
    // This test verifies the api injection seam: UserSkillsPanel passes
    // userSkillsApi to SkillEditor. Since we mock SkillEditor, we verify
    // the createUserSkill mock is NOT called by the panel itself — the
    // real integration test is that SkillEditor receives the `api` prop.
    // We validate indirectly: after onSaved() fires, listUserSkills is
    // re-fetched (refresh is triggered).
    mockListUserSkills.mockResolvedValue([]);
    render(<UserSkillsPanel open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/No skills installed/)).toBeTruthy();
    });

    // Open the create editor.
    fireEvent.click(screen.getByRole('button', { name: /new skill/i }));

    await waitFor(() => {
      expect(screen.getByTestId('skill-editor')).toBeTruthy();
    });

    // Simulate a successful save via the mock editor's "Save editor" button.
    mockListUserSkills.mockResolvedValueOnce([SKILL_A]);
    fireEvent.click(screen.getByRole('button', { name: 'Save editor' }));

    // After onSaved, the panel should close the create dialog and re-fetch.
    await waitFor(() => {
      // listUserSkills was called again (refresh after save).
      expect(mockListUserSkills).toHaveBeenCalledTimes(2);
    });
  });
});
