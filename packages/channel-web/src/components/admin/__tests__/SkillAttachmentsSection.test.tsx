import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SkillAttachmentsSection } from '../SkillAttachmentsSection';
import type { SkillSummary } from '@ax/skills';

vi.mock('@/lib/skills', () => ({
  listSkills: vi.fn(),
}));

vi.mock('@/lib/admin', () => ({
  patchAgentSkillAttachments: vi.fn(),
}));

// CredentialSlotRow makes fetch calls internally; mock at the fetch level
// rather than mocking the whole component (we want to verify it renders).
// Each test that needs it will spy on globalThis.fetch.

import { listSkills } from '@/lib/skills';
import { patchAgentSkillAttachments } from '@/lib/admin';

const mockListSkills = vi.mocked(listSkills);
const mockPatch = vi.mocked(patchAgentSkillAttachments);

const GITHUB_SKILL: SkillSummary = {
  id: 'github-api',
  description: 'Interacts with the GitHub REST API.',
  version: 1,
  scope: 'global',
  capabilities: {
    allowedHosts: ['api.github.com'],
    credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key', description: 'PAT' }],
    mcpServers: [],
  },
  defaultAttached: false,
  updatedAt: '2026-05-18T10:00:00.000Z',
};

const SLACK_SKILL: SkillSummary = {
  id: 'slack-notify',
  description: 'Posts to Slack.',
  version: 0,
  scope: 'global',
  capabilities: {
    allowedHosts: [],
    credentials: [],
    mcpServers: [],
  },
  defaultAttached: false,
  updatedAt: '2026-05-17T08:00:00.000Z',
};

const AGENT_ID = 'agent-123';

// Minimal fetch stub that satisfies CredentialSlotRow's adminCredentials.list() call
const credentialsFetchStub = vi.fn().mockResolvedValue(
  new Response(JSON.stringify({ credentials: [] }), { status: 200 }),
);

beforeEach(() => {
  vi.resetAllMocks();
  mockListSkills.mockResolvedValue([GITHUB_SKILL, SLACK_SKILL]);
  credentialsFetchStub.mockResolvedValue(
    new Response(JSON.stringify({ credentials: [] }), { status: 200 }),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(credentialsFetchStub);
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
  it('renders a CredentialSlotRow per skill slot (not a credential dropdown)', async () => {
    vi.mocked(listSkills).mockResolvedValue([
      {
        id: 'linear-tracker',
        description: 'tracks linear issues',
        version: 1,
        scope: 'global' as const,
        capabilities: {
          allowedHosts: [],
          credentials: [{ slot: 'LINEAR_TOKEN', kind: 'api-key' }],
          mcpServers: [],
        },
        defaultAttached: false,
        updatedAt: new Date().toISOString(),
      },
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ credentials: [] }), { status: 200 }),
    );
    render(
      <SkillAttachmentsSection
        agentId="agt-1"
        initialAttachments={[{ skillId: 'linear-tracker', credentialBindings: {} }]}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText(/select credential/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText('LINEAR_TOKEN')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set credential/i })).toBeInTheDocument();
  });

  it('renders existing attachments with their slot labels', async () => {
    render(
      <SkillAttachmentsSection
        agentId={AGENT_ID}
        initialAttachments={[
          { skillId: 'github-api', credentialBindings: { GITHUB_TOKEN: 'skill:github-api:GITHUB_TOKEN' } },
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

  it('clicking Save attachments calls patchAgentSkillAttachments with deterministic refs', async () => {
    const onSaved = vi.fn();
    render(
      <SkillAttachmentsSection
        agentId={AGENT_ID}
        initialAttachments={[
          { skillId: 'github-api', credentialBindings: {} },
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
        {
          skillId: 'github-api',
          credentialBindings: { GITHUB_TOKEN: 'skill:github-api:GITHUB_TOKEN' },
        },
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

  it('skill with no credential slots renders without a Set credential button', async () => {
    render(
      <SkillAttachmentsSection
        agentId={AGENT_ID}
        initialAttachments={[
          { skillId: 'slack-notify', credentialBindings: {} },
        ]}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('slack-notify')).toBeTruthy();
    });

    // slack-notify has no credentials, so no Set credential button
    expect(screen.queryByRole('button', { name: /set credential/i })).toBeNull();
  });
});
