import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SkillInstallConsentDialog } from '../SkillInstallConsentDialog';
import type { CatalogSkillListing } from '@/lib/connections';

vi.mock('@/lib/connections', () => ({
  attachConnectionSkill: vi.fn(),
}));
import { attachConnectionSkill } from '@/lib/connections';
const mockAttach = vi.mocked(attachConnectionSkill);

const SKILL_WITH_CONNECTORS: CatalogSkillListing = {
  skillId: 'web-search',
  description: 'Search the web.',
  defaultAttached: false,
  connectors: ['serp', 'brave'],
};
const SKILL_NO_CONNECTORS: CatalogSkillListing = {
  skillId: 'pdf-tools',
  description: 'Work with PDFs.',
  defaultAttached: false,
  connectors: [],
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe('SkillInstallConsentDialog', () => {
  it('shows the description and the connectors the skill uses (the consent surface)', async () => {
    render(
      <SkillInstallConsentDialog
        skill={SKILL_WITH_CONNECTORS}
        agentId="a1"
        open
        onOpenChange={() => {}}
        onInstalled={() => {}}
      />,
    );
    expect(await screen.findByText('Search the web.')).toBeInTheDocument();
    expect(screen.getByText('serp')).toBeInTheDocument();
    expect(screen.getByText('brave')).toBeInTheDocument();
  });

  it('installs on confirm (server-forced attach) and calls onInstalled', async () => {
    mockAttach.mockResolvedValue({ created: true });
    const onInstalled = vi.fn();
    render(
      <SkillInstallConsentDialog
        skill={SKILL_NO_CONNECTORS}
        agentId="a1"
        open
        onOpenChange={() => {}}
        onInstalled={onInstalled}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /install/i }));
    await waitFor(() => {
      expect(mockAttach).toHaveBeenCalledWith('a1', 'pdf-tools');
      expect(onInstalled).toHaveBeenCalled();
    });
  });

  it('surfaces an install error and does not call onInstalled', async () => {
    mockAttach.mockRejectedValue(new Error('attach: 404'));
    const onInstalled = vi.fn();
    render(
      <SkillInstallConsentDialog
        skill={SKILL_NO_CONNECTORS}
        agentId="a1"
        open
        onOpenChange={() => {}}
        onInstalled={onInstalled}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /install/i }));
    expect(await screen.findByText(/attach: 404/)).toBeInTheDocument();
    expect(onInstalled).not.toHaveBeenCalled();
  });
});
