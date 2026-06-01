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
  connectors: [],
  defaultAttached: false,
  updatedAt: '2026-05-18T10:00:00.000Z',
};

const SLACK_SKILL: SkillSummary = {
  id: 'slack-notify',
  description: 'Posts to Slack.',
  version: 0,
  scope: 'global',
  connectors: [],
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
    connectorAttachments: [],
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
  });
});

describe('SkillAttachmentsSection', () => {
  it('TASK-100: renders NO per-skill credential row (a skill declares no slots)', async () => {
    vi.mocked(listSkills).mockResolvedValue([
      {
        id: 'linear-tracker',
        description: 'tracks linear issues',
        version: 1,
        scope: 'global' as const,
        connectors: ['linear'],
        defaultAttached: false,
        updatedAt: new Date().toISOString(),
      },
    ]);
    render(
      <SkillAttachmentsSection
        agentId="agt-1"
        initialAttachments={[{ skillId: 'linear-tracker', credentialBindings: {} }]}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('linear-tracker')).toBeInTheDocument();
    });
    // A skill declares no credential slots → no "Set credential" affordance.
    expect(screen.queryByRole('button', { name: /set credential/i })).not.toBeInTheDocument();
    expect(screen.queryByText('LINEAR_TOKEN')).not.toBeInTheDocument();
  });

  it('renders existing attachments (skill id only — no slot labels)', async () => {
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
    expect(screen.queryByText('GITHUB_TOKEN')).toBeNull();
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

  it('TASK-100: clicking Save attachments calls patchAgentSkillAttachments with EMPTY bindings', async () => {
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
      // A skill declares no credential slots → the attachment carries no bindings.
      expect(mockPatch).toHaveBeenCalledWith(AGENT_ID, [
        { skillId: 'github-api', credentialBindings: {} },
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
