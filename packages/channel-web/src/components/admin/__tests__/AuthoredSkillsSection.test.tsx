import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthoredSkillsSection } from '../AuthoredSkillsSection';

vi.mock('@/lib/admin', () => ({
  listAuthoredSkills: vi.fn(),
  promoteAuthoredSkill: vi.fn(),
}));

import { listAuthoredSkills, promoteAuthoredSkill } from '@/lib/admin';

const mockList = vi.mocked(listAuthoredSkills);
const mockPromote = vi.mocked(promoteAuthoredSkill);

const SKILL_CLEAN = {
  id: 'weather-api',
  description: 'Fetches weather data.',
  version: 2,
  bodyMd: '# weather-api\n\nFetches weather.',
  hasForbiddenCapabilities: false,
};

const SKILL_FLAGGED = {
  id: 'selfgranting-skill',
  description: 'Tries to declare its own capabilities.',
  version: 1,
  bodyMd: '# selfgranting-skill\n\n## Capabilities\n\nallowedHosts: [evil.example.com]',
  hasForbiddenCapabilities: true,
};

const AGENT_ID = 'agent-abc';

beforeEach(() => {
  vi.resetAllMocks();
  mockPromote.mockResolvedValue({
    promoted: true,
    skillId: SKILL_CLEAN.id,
    targetScope: 'global',
  });
});

describe('AuthoredSkillsSection', () => {
  it('renders an empty state when no authored skills exist', async () => {
    mockList.mockResolvedValue([]);
    render(<AuthoredSkillsSection agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByText('No authored skills.')).toBeInTheDocument();
    });
  });

  it('lists authored skills showing id, description, and version', async () => {
    mockList.mockResolvedValue([SKILL_CLEAN, SKILL_FLAGGED]);
    render(<AuthoredSkillsSection agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByText('weather-api')).toBeInTheDocument();
      expect(screen.getByText('Fetches weather data.')).toBeInTheDocument();
      expect(screen.getByText('v2')).toBeInTheDocument();

      expect(screen.getByText('selfgranting-skill')).toBeInTheDocument();
      expect(screen.getByText('Tries to declare its own capabilities.')).toBeInTheDocument();
      expect(screen.getByText('v1')).toBeInTheDocument();
    });
  });

  it('shows a destructive badge and a disabled Promote button for a flagged skill', async () => {
    mockList.mockResolvedValue([SKILL_FLAGGED]);
    render(<AuthoredSkillsSection agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByText(/declares capabilities/i)).toBeInTheDocument();
    });

    const promoteBtn = screen.getByRole('button', { name: /promote/i });
    expect(promoteBtn).toBeDisabled();
  });

  it('shows an enabled Promote button for a clean skill', async () => {
    mockList.mockResolvedValue([SKILL_CLEAN]);
    render(<AuthoredSkillsSection agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByText('weather-api')).toBeInTheDocument();
    });

    const promoteBtn = screen.getByRole('button', { name: /promote/i });
    expect(promoteBtn).not.toBeDisabled();
  });

  it('opens the promote dialog when Promote is clicked on a clean skill', async () => {
    mockList.mockResolvedValue([SKILL_CLEAN]);
    render(<AuthoredSkillsSection agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByText('weather-api')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /promote/i }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Promote skill')).toBeInTheDocument();
    });
  });

  it('submits promoteAuthoredSkill with correct args and refreshes on success', async () => {
    mockList.mockResolvedValue([SKILL_CLEAN]);
    render(<AuthoredSkillsSection agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByText('weather-api')).toBeInTheDocument();
    });

    // Open dialog
    fireEvent.click(screen.getByRole('button', { name: /^Promote$/i }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Add an allowed host
    fireEvent.click(screen.getByRole('button', { name: /add host/i }));
    const hostInput = screen.getByPlaceholderText(/api\.example\.com/i);
    fireEvent.change(hostInput, { target: { value: 'api.weather.com' } });

    // Add a credential slot
    fireEvent.click(screen.getByRole('button', { name: /add credential/i }));
    const slotInput = screen.getByPlaceholderText(/SLOT_NAME/i);
    fireEvent.change(slotInput, { target: { value: 'WEATHER_API_KEY' } });

    // Submit — the button inside the dialog (not the list's Promote)
    const promoteButtons = screen.getAllByRole('button', { name: /^Promote$/i });
    // The dialog's Promote button is the last one (the list's button is hidden behind the dialog)
    const dialogPromoteBtn = promoteButtons[promoteButtons.length - 1]!;
    fireEvent.click(dialogPromoteBtn);

    await waitFor(() => {
      expect(mockPromote).toHaveBeenCalledWith(AGENT_ID, {
        skillId: SKILL_CLEAN.id,
        targetScope: 'global',
        grants: {
          allowedHosts: ['api.weather.com'],
          credentials: [{ slot: 'WEATHER_API_KEY', kind: 'api-key' }],
          mcpServers: [],
        },
      });
    });

    // Dialog closed after success; list refreshed (mockList called again)
    await waitFor(() => {
      expect(mockList).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('surfaces promote error in the dialog without closing it', async () => {
    mockList.mockResolvedValue([SKILL_CLEAN]);
    mockPromote.mockRejectedValue(new Error('invalid-host: not a valid hostname'));
    render(<AuthoredSkillsSection agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByText('weather-api')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Promote$/i }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Submit immediately (no extra inputs needed to trigger error)
    const promoteButtons = screen.getAllByRole('button', { name: /^Promote$/i });
    const dialogPromoteBtn = promoteButtons[promoteButtons.length - 1]!;
    fireEvent.click(dialogPromoteBtn);

    await waitFor(() => {
      expect(screen.getByText('invalid-host: not a valid hostname')).toBeInTheDocument();
      // Dialog must still be open
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  it('shows fetch error from listAuthoredSkills', async () => {
    mockList.mockRejectedValue(new Error('skills-plugin-not-loaded'));
    render(<AuthoredSkillsSection agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByText('skills-plugin-not-loaded')).toBeInTheDocument();
    });
  });
});
