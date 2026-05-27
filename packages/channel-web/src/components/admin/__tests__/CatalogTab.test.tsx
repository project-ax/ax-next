import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CatalogTab } from '../CatalogTab';
import type { SkillSummary } from '@ax/skills';

// Mock the wire clients
vi.mock('@/lib/skills', () => ({
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  deleteSkill: vi.fn(),
  checkSkillForUpdates: vi.fn(),
  refreshSkillFromSource: vi.fn(),
  setSkillDefaultAttached: vi.fn(),
}));

// Mock SkillEditor so tests don't depend on its internals
vi.mock('../SkillEditor', () => ({
  SkillEditor: ({ onCancel }: { skillId?: string; onSaved: () => void; onCancel: () => void }) => (
    <div data-testid="skill-editor">
      <button onClick={onCancel}>Cancel editor</button>
    </div>
  ),
}));

import {
  listSkills,
  getSkill,
  deleteSkill,
  checkSkillForUpdates,
  refreshSkillFromSource,
  setSkillDefaultAttached,
} from '@/lib/skills';

const mockListSkills = vi.mocked(listSkills);
const mockGetSkill = vi.mocked(getSkill);
const mockDeleteSkill = vi.mocked(deleteSkill);
const mockCheckSkillForUpdates = vi.mocked(checkSkillForUpdates);
const mockRefreshSkillFromSource = vi.mocked(refreshSkillFromSource);
const mockSetDefault = vi.mocked(setSkillDefaultAttached);

const SKILL_A: SkillSummary = {
  id: 'github-api',
  description: 'Interacts with the GitHub REST API.',
  version: 1,
  scope: 'global',
  capabilities: {
    allowedHosts: ['api.github.com'],
    credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key', description: 'PAT' }],
    mcpServers: [],
    packages: { npm: [], pypi: [] },
  },
  defaultAttached: false,
  updatedAt: '2026-05-18T10:00:00.000Z',
};

const SKILL_B: SkillSummary = {
  id: 'slack-notify',
  description: 'Posts messages to Slack channels.',
  version: 0,
  scope: 'global',
  capabilities: {
    allowedHosts: [],
    credentials: [],
    mcpServers: [],
    packages: { npm: [], pypi: [] },
  },
  defaultAttached: false,
  updatedAt: '2026-05-17T08:00:00.000Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  mockDeleteSkill.mockResolvedValue(undefined);
  // Default: no skill has a sourceUrl, so the check-for-updates effect
  // never fires. Tests that exercise the update path override per-test.
  mockCheckSkillForUpdates.mockResolvedValue({
    available: false,
    currentVersion: 1,
  });
  mockRefreshSkillFromSource.mockResolvedValue({ updated: true });
});

describe('CatalogTab', () => {
  it('renders a list of skills', async () => {
    mockListSkills.mockResolvedValueOnce([SKILL_A, SKILL_B]);
    render(<CatalogTab />);

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
    render(<CatalogTab />);

    await waitFor(() => {
      expect(screen.getByText(/No skills installed/)).toBeTruthy();
    });
  });

  it('shows loading state before promise resolves', () => {
    // Never resolve so we can observe the loading state
    mockListSkills.mockReturnValueOnce(new Promise(() => {}));
    render(<CatalogTab />);

    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('shows error alert when fetch fails', async () => {
    mockListSkills.mockRejectedValueOnce(new Error('Network error'));
    render(<CatalogTab />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy();
    });
  });

  it('clicking "New skill" opens the editor dialog', async () => {
    mockListSkills.mockResolvedValueOnce([]);
    render(<CatalogTab />);

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
    render(<CatalogTab />);

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
    render(<CatalogTab />);

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
    render(<CatalogTab />);

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

  it('reflects default-attached state in the inline Default toggle', async () => {
    mockListSkills.mockResolvedValueOnce([
      {
        id: 'heartbeat',
        description: 'Daily check-in.',
        version: 1,
        scope: 'global' as const,
        capabilities: { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } },
        defaultAttached: true,
        updatedAt: '2026-05-19T00:00:00.000Z',
      },
    ]);

    render(<CatalogTab />);

    // The default-attached row's toggle is checked.
    const toggle = await screen.findByRole('checkbox', { name: /default for heartbeat/i });
    expect(toggle.getAttribute('data-state')).toBe('checked');
  });

  // --- Task 11: tier badge --------------------------------------------------
  it("renders each skill's tier badge", async () => {
    mockListSkills.mockResolvedValueOnce([{ ...SKILL_A, tier: 'bounded' as const }]);
    render(<CatalogTab />);
    expect(await screen.findByText('bounded')).toBeTruthy();
  });

  // --- Task 12: read-only bundle file-view ---------------------------------
  it('opens a read-only bundle file-view for a skill', async () => {
    mockListSkills.mockResolvedValueOnce([{ ...SKILL_A, tier: 'bounded' as const }]);
    mockGetSkill.mockResolvedValue({
      ...SKILL_A,
      manifestYaml: 'name: github-api\ndescription: x\nversion: 1\n',
      bodyMd: '# gh\n',
      files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
    });
    render(<CatalogTab />);
    fireEvent.click(await screen.findByRole('button', { name: /view files for github-api/i }));
    expect(await screen.findByRole('button', { name: 'SKILL.md' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'scripts/run.py' })).toBeTruthy();
  });

  // --- Task 13: inline org-default toggle ----------------------------------
  it('marks a skill as an org default via the inline toggle', async () => {
    // SKILL_B has no credentials → eligible to be a default.
    mockListSkills.mockResolvedValue([{ ...SKILL_B, tier: 'inert' as const, defaultAttached: false }]);
    mockSetDefault.mockResolvedValue(undefined);
    render(<CatalogTab />);
    const toggle = await screen.findByRole('checkbox', { name: /default for slack-notify/i });
    fireEvent.click(toggle);
    await waitFor(() => expect(mockSetDefault).toHaveBeenCalledWith('slack-notify', true));
  });

  it('disables the default toggle for a credential-bearing skill', async () => {
    // SKILL_A declares GITHUB_TOKEN → cannot be a default.
    mockListSkills.mockResolvedValueOnce([{ ...SKILL_A, tier: 'bounded' as const }]);
    render(<CatalogTab />);
    const toggle = (await screen.findByRole('checkbox', {
      name: /default for github-api/i,
    })) as HTMLButtonElement;
    expect(toggle.disabled || toggle.getAttribute('data-disabled') !== null).toBeTruthy();
  });

  describe('source-url update flow', () => {
    const SKILL_WITH_SOURCE: SkillSummary = {
      id: 'github-api',
      description: 'Interacts with the GitHub REST API.',
      version: 1,
      scope: 'global',
      capabilities: {
        allowedHosts: ['api.github.com'],
        credentials: [],
        mcpServers: [],
        packages: { npm: [], pypi: [] },
      },
      defaultAttached: false,
      sourceUrl: 'https://example.com/github-api.md',
      updatedAt: '2026-05-18T10:00:00.000Z',
    };

    it('does NOT call checkSkillForUpdates and shows no badge when sourceUrl is unset', async () => {
      // SKILL_A has no sourceUrl.
      mockListSkills.mockResolvedValueOnce([SKILL_A]);
      render(<CatalogTab />);

      await waitFor(() => {
        expect(screen.getByText('github-api')).toBeTruthy();
      });

      // Give any pending microtasks/effects a chance to run.
      await new Promise((r) => setTimeout(r, 0));

      expect(mockCheckSkillForUpdates).not.toHaveBeenCalled();
      expect(screen.queryByText(/Update available/i)).toBeNull();
    });

    it('shows the "Update available" badge when checkSkillForUpdates returns available:true', async () => {
      mockListSkills.mockResolvedValueOnce([SKILL_WITH_SOURCE]);
      mockCheckSkillForUpdates.mockResolvedValueOnce({
        available: true,
        currentVersion: 1,
        latestVersion: 2,
        latestSkillMd: '---\nname: github-api\n---\nbody',
      });

      render(<CatalogTab />);

      await waitFor(() => {
        expect(screen.getByText('github-api')).toBeTruthy();
      });

      await waitFor(() => {
        expect(mockCheckSkillForUpdates).toHaveBeenCalledWith('github-api');
      });

      await waitFor(() => {
        expect(screen.getByText(/Update available.*v2/)).toBeTruthy();
      });
    });

    it('clicking Update calls refreshSkillFromSource and clears the badge', async () => {
      // First listSkills call: skill with sourceUrl, version 1.
      mockListSkills.mockResolvedValueOnce([SKILL_WITH_SOURCE]);
      // Second listSkills call (after refresh): skill bumped to version 2.
      mockListSkills.mockResolvedValueOnce([
        { ...SKILL_WITH_SOURCE, version: 2 },
      ]);

      // First check: update available. Second check (post-refresh): not.
      mockCheckSkillForUpdates.mockResolvedValueOnce({
        available: true,
        currentVersion: 1,
        latestVersion: 2,
        latestSkillMd: '---\nname: github-api\n---\nbody',
      });
      mockCheckSkillForUpdates.mockResolvedValueOnce({
        available: false,
        currentVersion: 2,
        latestVersion: 2,
      });

      mockRefreshSkillFromSource.mockResolvedValueOnce({
        updated: true,
        currentVersion: 1,
        newVersion: 2,
      });

      render(<CatalogTab />);

      // Wait for the badge to appear.
      await waitFor(() => {
        expect(screen.getByText(/Update available.*v2/)).toBeTruthy();
      });

      fireEvent.click(
        screen.getByRole('button', { name: /Update github-api to v2/ }),
      );

      await waitFor(() => {
        expect(mockRefreshSkillFromSource).toHaveBeenCalledWith('github-api');
      });

      // After refresh: badge gone.
      await waitFor(() => {
        expect(screen.queryByText(/Update available/i)).toBeNull();
      });
    });

    it('swallows checkSkillForUpdates errors silently (no badge, no error alert)', async () => {
      mockListSkills.mockResolvedValueOnce([SKILL_WITH_SOURCE]);
      mockCheckSkillForUpdates.mockRejectedValueOnce(
        new Error('skill-source-fetch-failed'),
      );

      render(<CatalogTab />);

      await waitFor(() => {
        expect(screen.getByText('github-api')).toBeTruthy();
      });

      await waitFor(() => {
        expect(mockCheckSkillForUpdates).toHaveBeenCalledWith('github-api');
      });

      // Let the rejected promise settle.
      await new Promise((r) => setTimeout(r, 0));

      expect(screen.queryByText(/Update available/i)).toBeNull();
      // Error alert must NOT carry per-skill check failures.
      expect(screen.queryByText('skill-source-fetch-failed')).toBeNull();
    });
  });
});
