import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthoredSkillsSection } from '../AuthoredSkillsSection';

vi.mock('@/lib/admin', () => ({
  listAuthoredSkills: vi.fn(),
  promoteAuthoredSkill: vi.fn(),
  deleteAuthoredSkill: vi.fn(),
}));

import {
  listAuthoredSkills,
  promoteAuthoredSkill,
  deleteAuthoredSkill,
} from '@/lib/admin';

const mockList = vi.mocked(listAuthoredSkills);
const mockPromote = vi.mocked(promoteAuthoredSkill);
const mockDelete = vi.mocked(deleteAuthoredSkill);

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

  it('filters out blank credential slots before calling promoteAuthoredSkill', async () => {
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

    // Add a credential slot but leave it blank (simulates admin clicking Add then not filling it)
    fireEvent.click(screen.getByRole('button', { name: /add credential/i }));
    // The slot input appears but we do NOT fill it in (blank = should be filtered)
    expect(screen.getByPlaceholderText(/SLOT_NAME/i)).toBeInTheDocument();

    // Submit
    const promoteButtons = screen.getAllByRole('button', { name: /^Promote$/i });
    const dialogPromoteBtn = promoteButtons[promoteButtons.length - 1]!;
    fireEvent.click(dialogPromoteBtn);

    await waitFor(() => {
      expect(mockPromote).toHaveBeenCalledWith(AGENT_ID, {
        skillId: SKILL_CLEAN.id,
        targetScope: 'global',
        grants: {
          allowedHosts: [],
          // The blank credential row must be filtered out — not sent to the server.
          credentials: [],
          mcpServers: [],
        },
      });
    });
  });

  it('submits promoteAuthoredSkill with targetScope:user when user scope is selected', async () => {
    mockList.mockResolvedValue([SKILL_CLEAN]);
    mockPromote.mockResolvedValue({
      promoted: true,
      skillId: SKILL_CLEAN.id,
      targetScope: 'user',
    });
    render(<AuthoredSkillsSection agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByText('weather-api')).toBeInTheDocument();
    });

    // Open dialog
    fireEvent.click(screen.getByRole('button', { name: /^Promote$/i }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Change target scope to 'user' via the Select (combobox → click option)
    const scopeTrigger = screen.getByRole('combobox');
    fireEvent.click(scopeTrigger);
    // After click, the dropdown portal renders the options
    const userOption = await screen.findByText(/User \(agent owner/i);
    fireEvent.click(userOption);

    // Submit the dialog
    const promoteButtons = screen.getAllByRole('button', { name: /^Promote$/i });
    const dialogPromoteBtn = promoteButtons[promoteButtons.length - 1]!;
    fireEvent.click(dialogPromoteBtn);

    await waitFor(() => {
      expect(mockPromote).toHaveBeenCalledWith(AGENT_ID, {
        skillId: SKILL_CLEAN.id,
        targetScope: 'user',
        grants: {
          allowedHosts: [],
          credentials: [],
          mcpServers: [],
        },
      });
    });

    // Dialog closed after success; list refreshed
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

  // Delete authored drafts (admin surface) — there was previously no way to
  // remove a stale draft from this section (only Promote).

  it('shows a Delete button for each authored skill', async () => {
    mockList.mockResolvedValue([SKILL_CLEAN]);
    render(<AuthoredSkillsSection agentId={AGENT_ID} />);
    await waitFor(() => {
      expect(screen.getByText('weather-api')).toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: /Delete weather-api/i }),
    ).toBeInTheDocument();
  });

  it('Delete confirms, calls deleteAuthoredSkill, and refreshes the list', async () => {
    mockList.mockResolvedValueOnce([SKILL_CLEAN]); // initial load
    mockDelete.mockResolvedValue(undefined);
    mockList.mockResolvedValue([]); // post-delete refresh
    render(<AuthoredSkillsSection agentId={AGENT_ID} />);
    await waitFor(() => {
      expect(screen.getByText('weather-api')).toBeInTheDocument();
    });

    // Open the confirm dialog (no call yet).
    fireEvent.click(screen.getByRole('button', { name: /Delete weather-api/i }));
    await waitFor(() => {
      expect(screen.getByText('Delete authored draft?')).toBeInTheDocument();
    });
    expect(mockDelete).not.toHaveBeenCalled();

    // Confirm.
    const deleteButtons = screen.getAllByRole('button', { name: /^Delete$/ });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]!);

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith(AGENT_ID, SKILL_CLEAN.id);
    });
    // Dialog closes + list refreshed (now empty).
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByText('No authored skills.')).toBeInTheDocument();
    });
  });

  it('surfaces a delete error and keeps the skill listed', async () => {
    mockList.mockResolvedValue([SKILL_CLEAN]);
    mockDelete.mockRejectedValue(new Error('authored-skill-not-found'));
    render(<AuthoredSkillsSection agentId={AGENT_ID} />);
    await waitFor(() => {
      expect(screen.getByText('weather-api')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Delete weather-api/i }));
    const deleteButtons = await screen.findAllByRole('button', { name: /^Delete$/ });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]!);

    await waitFor(() => {
      expect(screen.getByText('authored-skill-not-found')).toBeInTheDocument();
      // Dialog stays open (in-dialog error), so the draft is never lost.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    // The list wasn't wiped (the empty-state never appeared) and the row remains
    // (id renders in both the row and the dialog description → at least one).
    expect(screen.queryByText('No authored skills.')).not.toBeInTheDocument();
    expect(screen.getAllByText('weather-api').length).toBeGreaterThanOrEqual(1);
  });
});
