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
        isAdmin
        agentId="agt-1"
        initialAttachments={[{ skillId: 'linear-tracker', credentialBindings: {} }]}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('linear-tracker')).toBeInTheDocument();
    });
    // A skill declares no credential slots → no "Set credential" affordance.
    expect(screen.queryByRole('button', { name: /add key/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Linear token')).not.toBeInTheDocument();
  });

  it('renders existing attachments (skill id only — no slot labels)', async () => {
    render(
      <SkillAttachmentsSection
        isAdmin
        agentId={AGENT_ID}
        initialAttachments={[
          { skillId: 'github-api', credentialBindings: {} },
        ]}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('GitHub API')).toBeTruthy();
    });
    expect(screen.queryByText('GITHUB_TOKEN')).toBeNull();
  });

  it('clicking "Attach skill" shows a picker with skills not already attached', async () => {
    render(
      <SkillAttachmentsSection
        isAdmin
        agentId={AGENT_ID}
        initialAttachments={[
          { skillId: 'github-api', credentialBindings: {} },
        ]}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('GitHub API')).toBeTruthy();
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
        isAdmin
        agentId={AGENT_ID}
        initialAttachments={[
          { skillId: 'github-api', credentialBindings: {} },
        ]}
        onSaved={onSaved}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('GitHub API')).toBeTruthy();
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
        isAdmin
        agentId={AGENT_ID}
        initialAttachments={[]}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/No skills attached\./)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /save attachments/i }));

    await waitFor(() => {
      expect(screen.getByText('foreign key violation')).toBeTruthy();
    });
  });

  /**
   * TASK-343 / audit D9 — the missing-metadata guard's message.
   *
   * "Cannot save: missing skill metadata for x,y" names our own internal
   * shortfall and leaves the reader with nothing to do about it. The ids go to
   * the console; the sentence says which one and what to do.
   */
  it('says what to do when a skill’s details could not be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(
      <SkillAttachmentsSection
        isAdmin
        agentId={AGENT_ID}
        // Attached, but absent from the catalog the component just fetched.
        initialAttachments={[{ skillId: 'ghost-skill', credentialBindings: {} }]}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /save attachments/i }));

    await waitFor(() =>
      expect(screen.getByText(/Remove it from the list and try again/i)).toBeTruthy(),
    );
    // Humanized in the sentence, exact in the console.
    expect(screen.getByText(/“Ghost skill”/)).toBeTruthy();
    expect(screen.queryByText(/missing skill metadata/i)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[skill-attachments] missing skill metadata for',
      ['ghost-skill'],
    );
    // Nothing was sent — the guard still blocks the save.
    expect(mockPatch).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it('clicking detach removes the attachment from the in-memory list', async () => {
    render(
      <SkillAttachmentsSection
        isAdmin
        agentId={AGENT_ID}
        initialAttachments={[
          { skillId: 'github-api', credentialBindings: {} },
          { skillId: 'slack-notify', credentialBindings: {} },
        ]}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('GitHub API')).toBeTruthy();
      expect(screen.getByText('Slack notify')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Detach github-api' }));

    await waitFor(() => {
      expect(screen.queryByText('GitHub API')).toBeNull();
      expect(screen.getByText('Slack notify')).toBeTruthy();
    });

    // The patch should NOT be called — detach is local-only until Save
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('skill with no credential slots renders without a Set credential button', async () => {
    render(
      <SkillAttachmentsSection
        isAdmin
        agentId={AGENT_ID}
        initialAttachments={[
          { skillId: 'slack-notify', credentialBindings: {} },
        ]}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Slack notify')).toBeTruthy();
    });

    // slack-notify has no credentials, so no Set credential button
    expect(screen.queryByRole('button', { name: /add key/i })).toBeNull();
  });
});
