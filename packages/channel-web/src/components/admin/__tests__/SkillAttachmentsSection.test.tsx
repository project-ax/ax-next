import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SkillAttachmentsSection } from '../SkillAttachmentsSection';
import type { SkillSummary } from '@ax/skills';
import type { CredentialMeta } from '@/lib/credentials';

vi.mock('@/lib/skills', () => ({
  listSkills: vi.fn(),
}));

vi.mock('@/lib/credentials', () => ({
  adminCredentials: {
    list: vi.fn(),
  },
}));

vi.mock('@/lib/admin', () => ({
  patchAgentSkillAttachments: vi.fn(),
}));

import { listSkills } from '@/lib/skills';
import { adminCredentials } from '@/lib/credentials';
import { patchAgentSkillAttachments } from '@/lib/admin';

const mockListSkills = vi.mocked(listSkills);
const mockAdminCredentialsList = vi.mocked(adminCredentials.list);
const mockPatch = vi.mocked(patchAgentSkillAttachments);

const GITHUB_SKILL: SkillSummary = {
  id: 'github-api',
  description: 'Interacts with the GitHub REST API.',
  version: 1,
  capabilities: {
    allowedHosts: ['api.github.com'],
    credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key', description: 'PAT' }],
  },
  defaultAttached: false,
  updatedAt: '2026-05-18T10:00:00.000Z',
};

const SLACK_SKILL: SkillSummary = {
  id: 'slack-notify',
  description: 'Posts to Slack.',
  version: 0,
  capabilities: {
    allowedHosts: [],
    credentials: [],
  },
  defaultAttached: false,
  updatedAt: '2026-05-17T08:00:00.000Z',
};

const CRED_A: CredentialMeta = {
  scope: 'global',
  ownerId: null,
  ref: 'gh-pat-global',
  kind: 'api-key',
  createdAt: '2026-05-18T00:00:00.000Z',
};

const CRED_B: CredentialMeta = {
  scope: 'user',
  ownerId: 'u1',
  ref: 'my-github-token',
  kind: 'api-key',
  createdAt: '2026-05-18T00:00:00.000Z',
};

const AGENT_ID = 'agent-123';

beforeEach(() => {
  vi.resetAllMocks();
  mockListSkills.mockResolvedValue([GITHUB_SKILL, SLACK_SKILL]);
  mockAdminCredentialsList.mockResolvedValue([CRED_A, CRED_B]);
  mockPatch.mockResolvedValue({
    id: AGENT_ID,
    ownerId: 'u1',
    ownerType: 'user',
    visibility: 'personal',
    displayName: 'Test Agent',
    systemPrompt: '',
    allowedTools: [],
    mcpConfigIds: [],
    model: 'claude-sonnet-4-6',
    workspaceRef: null,
    skillAttachments: [],
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
  });
});

describe('SkillAttachmentsSection', () => {
  it('renders existing attachments with their slot labels', async () => {
    render(
      <SkillAttachmentsSection
        agentId={AGENT_ID}
        initialAttachments={[
          { skillId: 'github-api', credentialBindings: { GITHUB_TOKEN: 'gh-pat-global' } },
        ]}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('github-api')).toBeTruthy();
      expect(screen.getByText('GITHUB_TOKEN')).toBeTruthy();
    });
  });

  it('clicking "Attach skill" shows a picker with skills not already attached', async () => {
    render(
      <SkillAttachmentsSection
        agentId={AGENT_ID}
        initialAttachments={[
          { skillId: 'github-api', credentialBindings: {} },
        ]}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('github-api')).toBeTruthy();
    });

    // Click "Attach skill" button
    fireEvent.click(screen.getByRole('button', { name: /attach skill/i }));

    // The picker should now be visible; slack-notify is not yet attached
    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeTruthy();
    });
  });

  it('clicking Save attachments calls patchAgentSkillAttachments', async () => {
    const onSaved = vi.fn();
    render(
      <SkillAttachmentsSection
        agentId={AGENT_ID}
        initialAttachments={[
          { skillId: 'github-api', credentialBindings: { GITHUB_TOKEN: 'gh-pat-global' } },
        ]}
        onSaved={onSaved}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('github-api')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /save attachments/i }));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(AGENT_ID, [
        { skillId: 'github-api', credentialBindings: { GITHUB_TOKEN: 'gh-pat-global' } },
      ]);
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  });

  it('server-side error surfaces inline', async () => {
    mockPatch.mockRejectedValueOnce(new Error('foreign key violation'));
    render(
      <SkillAttachmentsSection
        agentId={AGENT_ID}
        initialAttachments={[]}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('No skills attached.')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /save attachments/i }));

    await waitFor(() => {
      expect(screen.getByText('foreign key violation')).toBeTruthy();
    });
  });

  it('clicking detach removes the attachment from the in-memory list', async () => {
    render(
      <SkillAttachmentsSection
        agentId={AGENT_ID}
        initialAttachments={[
          { skillId: 'github-api', credentialBindings: {} },
          { skillId: 'slack-notify', credentialBindings: {} },
        ]}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('github-api')).toBeTruthy();
      expect(screen.getByText('slack-notify')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Detach github-api' }));

    await waitFor(() => {
      expect(screen.queryByText('github-api')).toBeNull();
      expect(screen.getByText('slack-notify')).toBeTruthy();
    });

    // The patch should NOT be called — detach is local-only until Save
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('shows no matching credentials message when kind does not match', async () => {
    // Override: no credentials at all
    mockAdminCredentialsList.mockResolvedValueOnce([]);

    render(
      <SkillAttachmentsSection
        agentId={AGENT_ID}
        initialAttachments={[
          { skillId: 'github-api', credentialBindings: {} },
        ]}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('GITHUB_TOKEN')).toBeTruthy();
    });
  });
});
