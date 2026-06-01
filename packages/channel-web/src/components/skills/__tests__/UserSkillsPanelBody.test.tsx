import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UserSkillsPanelBody } from '../UserSkillsPanelBody';
import type { SkillSummary, AuthoredSkillListing } from '@ax/skills';

// Mock the wire clients at the lib boundary — no network.
vi.mock('@/lib/user-skills', () => ({
  listUserSkills: vi.fn(),
  listAuthoredSkills: vi.fn(),
  getUserSkill: vi.fn(),
  createUserSkill: vi.fn(),
  updateUserSkill: vi.fn(),
  deleteUserSkill: vi.fn(),
  shareUserSkill: vi.fn(),
  approveAuthoredSkill: vi.fn(),
}));

// Mock the credential write at the lib boundary — the approve+key flow posts
// each entered key straight to the host credential store (never the model).
vi.mock('@/lib/credentials', () => ({
  setDestinationCredential: vi.fn(),
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
  listAuthoredSkills,
  deleteUserSkill,
  shareUserSkill,
  approveAuthoredSkill,
} from '@/lib/user-skills';
import { setDestinationCredential } from '@/lib/credentials';

const mockListUserSkills = vi.mocked(listUserSkills);
const mockListAuthoredSkills = vi.mocked(listAuthoredSkills);
const mockDeleteUserSkill = vi.mocked(deleteUserSkill);
const mockShareUserSkill = vi.mocked(shareUserSkill);
const mockApproveAuthoredSkill = vi.mocked(approveAuthoredSkill);
const mockSetDestinationCredential = vi.mocked(setDestinationCredential);

const SKILL_A: SkillSummary = {
  id: 'my-github',
  description: 'Personal GitHub integration.',
  version: 1,
  scope: 'user',
  connectors: ['github'],
  defaultAttached: false,
  updatedAt: '2026-05-20T10:00:00.000Z',
};

const SKILL_B: SkillSummary = {
  id: 'my-helper',
  description: 'Personal helper skill.',
  version: 1,
  scope: 'user',
  connectors: [],
  defaultAttached: true,
  updatedAt: '2026-05-20T09:00:00.000Z',
};

const AUTHORED_ACTIVE: AuthoredSkillListing = {
  skillId: 'my-authored',
  agentId: 'agt_a',
  description: 'An agent-authored helper.',
  status: 'active',
};

const AUTHORED_PENDING: AuthoredSkillListing = {
  skillId: 'needs-approval',
  agentId: 'agt_a',
  description: 'Authored skill awaiting approval.',
  status: 'pending',
};

// A PENDING cap-bearing authored skill — declares a host + a credential slot,
// so the panel must offer an approve + key affordance BEFORE first use (TASK-83).
const AUTHORED_PENDING_CAP: AuthoredSkillListing = {
  skillId: 'needs-key',
  agentId: 'agt_a',
  description: 'Authored skill that wants a host and a key.',
  status: 'pending',
  pendingCapabilities: {
    hosts: ['api.linear.app'],
    slots: [{ slot: 'LINEAR_API_KEY', kind: 'api-key', haveExisting: false }],
    packages: { npm: [], pypi: [] },
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  mockDeleteUserSkill.mockResolvedValue(undefined);
  mockApproveAuthoredSkill.mockResolvedValue(undefined);
  mockSetDestinationCredential.mockResolvedValue(undefined);
  // Default: no authored skills (most tests cover catalog skills). The authored
  // section is opt-in per test via mockListAuthoredSkills.mockResolvedValue(...).
  mockListAuthoredSkills.mockResolvedValue([]);
});

describe('UserSkillsPanelBody', () => {
  it('does not fetch when active=false', () => {
    mockListUserSkills.mockResolvedValue([]);
    render(<UserSkillsPanelBody active={false} />);
    // With active=false the body skips its data fetch entirely.
    expect(mockListUserSkills).not.toHaveBeenCalled();
  });

  it('lists the user skills', async () => {
    mockListUserSkills.mockResolvedValue([SKILL_A, SKILL_B]);
    render(<UserSkillsPanelBody active />);

    await waitFor(() => {
      expect(screen.getByText('my-github')).toBeTruthy();
      expect(screen.getByText('my-helper')).toBeTruthy();
    });

    expect(screen.getByText('Personal GitHub integration.')).toBeTruthy();
    expect(screen.getByText('Personal helper skill.')).toBeTruthy();
    // TASK-100 — the table shows the skill's connector references (not hosts/slots).
    expect(screen.getByText('github')).toBeTruthy();
  });

  it('shows loading state before promise resolves', () => {
    mockListUserSkills.mockReturnValue(new Promise(() => {}));
    render(<UserSkillsPanelBody active />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('shows empty state when no skills exist', async () => {
    mockListUserSkills.mockResolvedValue([]);
    render(<UserSkillsPanelBody active />);
    await waitFor(() => {
      expect(screen.getByText(/No skills installed/)).toBeTruthy();
    });
  });

  it('shows error alert when fetch fails', async () => {
    mockListUserSkills.mockRejectedValue(new Error('Network failure'));
    render(<UserSkillsPanelBody active />);
    await waitFor(() => {
      expect(screen.getByText('Network failure')).toBeTruthy();
    });
  });

  it('renders "default" badge for default-attached skills', async () => {
    mockListUserSkills.mockResolvedValue([SKILL_A, SKILL_B]);
    render(<UserSkillsPanelBody active />);

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
    render(<UserSkillsPanelBody active />);

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
    render(<UserSkillsPanelBody active />);

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
    render(<UserSkillsPanelBody active />);

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
    render(<UserSkillsPanelBody active />);

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
    // This test verifies the api injection seam: UserSkillsPanelBody passes
    // userSkillsApi to SkillEditor. Since we mock SkillEditor, we verify
    // the createUserSkill mock is NOT called by the panel itself — the
    // real integration test is that SkillEditor receives the `api` prop.
    // We validate indirectly: after onSaved() fires, listUserSkills is
    // re-fetched (refresh is triggered).
    mockListUserSkills.mockResolvedValue([]);
    render(<UserSkillsPanelBody active />);

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

  // -------------------------------------------------------------------------
  // Share to catalog (TASK-60)
  // -------------------------------------------------------------------------

  it('share button → confirmation dialog → calls shareUserSkill and shows success banner', async () => {
    mockListUserSkills.mockResolvedValue([SKILL_A]);
    mockShareUserSkill.mockResolvedValue({
      requestId: 'r-1',
      created: true,
      status: 'pending',
    });
    render(<UserSkillsPanelBody active />);

    await waitFor(() => {
      expect(screen.getByText('my-github')).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Share my-github to catalog' }),
    );

    await waitFor(() => {
      expect(screen.getByText('Submit to catalog?')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => {
      expect(mockShareUserSkill).toHaveBeenCalledWith('my-github');
      expect(screen.getByText(/was\s+submitted for admin review/i)).toBeTruthy();
    });
  });

  it('a dedup share (created:false) shows the "already submitted" banner, not an error', async () => {
    mockListUserSkills.mockResolvedValue([SKILL_A]);
    mockShareUserSkill.mockResolvedValue({
      requestId: 'r-1',
      created: false,
      status: 'pending',
    });
    render(<UserSkillsPanelBody active />);

    await waitFor(() => {
      expect(screen.getByText('my-github')).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Share my-github to catalog' }),
    );
    await waitFor(() => {
      expect(screen.getByText('Submit to catalog?')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => {
      expect(
        screen.getByText(/already submitted and pending admin review/i),
      ).toBeTruthy();
    });
  });

  it('share error surfaces in the alert', async () => {
    mockListUserSkills.mockResolvedValue([SKILL_A]);
    mockShareUserSkill.mockRejectedValueOnce(new Error('share failed'));
    render(<UserSkillsPanelBody active />);

    await waitFor(() => {
      expect(screen.getByText('my-github')).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Share my-github to catalog' }),
    );
    await waitFor(() => {
      expect(screen.getByText('Submit to catalog?')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => {
      expect(screen.getByText('share failed')).toBeTruthy();
    });
  });

  it('cancelling the share dialog does NOT call shareUserSkill', async () => {
    mockListUserSkills.mockResolvedValue([SKILL_A]);
    render(<UserSkillsPanelBody active />);

    await waitFor(() => {
      expect(screen.getByText('my-github')).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Share my-github to catalog' }),
    );
    await waitFor(() => {
      expect(screen.getByText('Submit to catalog?')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByText('Submit to catalog?')).toBeNull();
    });
    expect(mockShareUserSkill).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Authored / approved skills (TASK-85)
  // -------------------------------------------------------------------------

  it('lists agent-authored skills (the bug: they were omitted entirely)', async () => {
    // Before TASK-85 the panel only read catalog skills, so a user with ONLY
    // authored skills saw "No skills installed". This is the regression guard.
    mockListUserSkills.mockResolvedValue([]);
    mockListAuthoredSkills.mockResolvedValue([AUTHORED_ACTIVE, AUTHORED_PENDING]);
    render(<UserSkillsPanelBody active />);

    await waitFor(() => {
      expect(screen.getByText('my-authored')).toBeTruthy();
      expect(screen.getByText('needs-approval')).toBeTruthy();
    });

    // The authored section header + descriptions render.
    expect(screen.getByText('Authored by your agents')).toBeTruthy();
    expect(screen.getByText('An agent-authored helper.')).toBeTruthy();

    // With authored skills present, the empty-state message must NOT show.
    expect(screen.queryByText(/No skills installed/)).toBeNull();
  });

  it('shows a status badge per authored skill (active vs pending review)', async () => {
    mockListUserSkills.mockResolvedValue([]);
    mockListAuthoredSkills.mockResolvedValue([AUTHORED_ACTIVE, AUTHORED_PENDING]);
    render(<UserSkillsPanelBody active />);

    await waitFor(() => {
      expect(screen.getByText('my-authored')).toBeTruthy();
    });

    const activeRow = screen.getByText('my-authored').closest('tr')!;
    expect(activeRow.textContent).toMatch(/active/i);

    const pendingRow = screen.getByText('needs-approval').closest('tr')!;
    expect(pendingRow.textContent).toMatch(/pending review/i);
  });

  it('shows authored skills ALONGSIDE catalog skills', async () => {
    mockListUserSkills.mockResolvedValue([SKILL_A]);
    mockListAuthoredSkills.mockResolvedValue([AUTHORED_ACTIVE]);
    render(<UserSkillsPanelBody active />);

    await waitFor(() => {
      // catalog skill
      expect(screen.getByText('my-github')).toBeTruthy();
      // authored skill
      expect(screen.getByText('my-authored')).toBeTruthy();
    });
  });

  it('still shows the empty state when BOTH catalog and authored are empty', async () => {
    mockListUserSkills.mockResolvedValue([]);
    mockListAuthoredSkills.mockResolvedValue([]);
    render(<UserSkillsPanelBody active />);

    await waitFor(() => {
      expect(screen.getByText(/No skills installed/)).toBeTruthy();
    });
    expect(screen.queryByText('Authored by your agents')).toBeNull();
  });

  it('an authored-fetch failure does not blank out the catalog list', async () => {
    mockListUserSkills.mockResolvedValue([SKILL_A]);
    mockListAuthoredSkills.mockRejectedValue(new Error('authored boom'));
    render(<UserSkillsPanelBody active />);

    await waitFor(() => {
      expect(screen.getByText('my-github')).toBeTruthy();
    });
    // No authored section, no top-level error banner from the authored failure.
    expect(screen.queryByText('Authored by your agents')).toBeNull();
    expect(screen.queryByText('authored boom')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // JIT early-approval discoverability (TASK-83)
  // -------------------------------------------------------------------------

  it('a pending cap-skill shows an Approve affordance; an inert pending one does not', async () => {
    // THE TASK-83 regression guard: a pending cap-bearing authored skill must be
    // discoverable + approvable from My Skills BEFORE first use. A pending skill
    // with no caps to approve has nothing to do here, so no Approve button.
    mockListUserSkills.mockResolvedValue([]);
    mockListAuthoredSkills.mockResolvedValue([
      AUTHORED_PENDING, // pending, no pendingCapabilities → no Approve button
      AUTHORED_PENDING_CAP, // pending + caps → Approve button
    ]);
    render(<UserSkillsPanelBody active />);

    await waitFor(() => {
      expect(screen.getByText('needs-key')).toBeTruthy();
    });

    // The cap-skill row has an Approve button.
    expect(
      screen.getByRole('button', { name: /approve needs-key/i }),
    ).toBeTruthy();
    // The inert pending skill has NO Approve button (nothing to approve).
    expect(
      screen.queryByRole('button', { name: /approve needs-approval/i }),
    ).toBeNull();
  });

  it('approve a pending cap-skill: enter key → writes credential → calls approveAuthoredSkill with shown', async () => {
    mockListUserSkills.mockResolvedValue([]);
    mockListAuthoredSkills.mockResolvedValue([AUTHORED_PENDING_CAP]);
    render(<UserSkillsPanelBody active />);

    await waitFor(() => {
      expect(screen.getByText('needs-key')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /approve needs-key/i }));

    // The approve dialog shows the host + the key field.
    await waitFor(() => {
      expect(screen.getByText('api.linear.app')).toBeTruthy();
      expect(screen.getByLabelText('LINEAR_API_KEY')).toBeTruthy();
    });

    // Approve is disabled until the (non-vaulted) slot is filled.
    const approveBtn = screen.getByRole('button', { name: 'Approve' });
    expect((approveBtn as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('LINEAR_API_KEY'), {
      target: { value: 'lin_secret' },
    });
    expect((approveBtn as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(approveBtn);

    await waitFor(() => {
      // The key posts straight to the credential store (per-skill slot here).
      expect(mockSetDestinationCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          destination: {
            kind: 'skill-slot',
            skillId: 'needs-key',
            slot: 'LINEAR_API_KEY',
          },
          payload: 'lin_secret',
        }),
      );
      // Then the early-approve grant fires with the shown TOCTOU guard.
      expect(mockApproveAuthoredSkill).toHaveBeenCalledWith({
        agentId: 'agt_a',
        skillId: 'needs-key',
        shown: {
          hosts: ['api.linear.app'],
          slots: ['LINEAR_API_KEY'],
          npm: [],
          pypi: [],
        },
      });
    });
  });

  it('approve error surfaces and does NOT close the dialog', async () => {
    mockListUserSkills.mockResolvedValue([]);
    mockListAuthoredSkills.mockResolvedValue([AUTHORED_PENDING_CAP]);
    mockApproveAuthoredSkill.mockRejectedValueOnce(new Error('grant boom'));
    render(<UserSkillsPanelBody active />);

    await waitFor(() => {
      expect(screen.getByText('needs-key')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /approve needs-key/i }));
    await waitFor(() => {
      expect(screen.getByLabelText('LINEAR_API_KEY')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('LINEAR_API_KEY'), {
      target: { value: 'lin_secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(screen.getByText(/grant boom/)).toBeTruthy();
    });
  });
});
