import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SkillsTab } from '../SkillsTab';
import type { ConnectionSkill, CatalogSkillListing } from '@/lib/connections';

// SkillsTab is now thin chrome around SkillsAppStore (the app-store body, with
// its own thorough test). Here we just verify the tab mounts the app-store
// shelves and passes `isAdmin` through.
vi.mock('@/lib/connections', () => ({
  getConnections: vi.fn(),
  detachConnectionSkill: vi.fn(),
  attachConnectionSkill: vi.fn(),
  listCatalogSkills: vi.fn(),
}));
vi.mock('@/lib/agents', () => ({ listChatAgents: vi.fn() }));
vi.mock('@/lib/user-skills', () => ({
  listUserSkills: vi.fn(),
  listAuthoredSkills: vi.fn(),
  getUserSkill: vi.fn(),
  createUserSkill: vi.fn(),
  updateUserSkill: vi.fn(),
  deleteUserSkill: vi.fn(),
  shareUserSkill: vi.fn(),
}));
vi.mock('@/lib/skills', () => ({
  setSkillDefaultAttached: vi.fn(),
  deleteSkill: vi.fn(),
  getSkill: vi.fn(),
  upsertSkill: vi.fn(),
  updateSkill: vi.fn(),
}));
vi.mock('@/lib/catalog', () => ({
  listCatalogRequests: vi.fn(),
  decideCatalogRequest: vi.fn(),
}));
vi.mock('@/components/admin/SkillEditor', () => ({
  SkillEditor: () => <div data-testid="skill-editor" />,
}));
vi.mock('@/components/admin/BundleReviewDialog', () => ({
  BundleReviewDialog: () => <div data-testid="bundle-review" />,
}));

import { getConnections, listCatalogSkills } from '@/lib/connections';
import { listChatAgents } from '@/lib/agents';
import { listUserSkills, listAuthoredSkills } from '@/lib/user-skills';
import { listCatalogRequests } from '@/lib/catalog';

const INSTALLED: ConnectionSkill[] = [
  { skillId: 'web-search', description: 'Search the web.', source: 'default', removable: false },
];
const CATALOG: CatalogSkillListing[] = [
  { skillId: 'web-search', description: 'Search the web.', defaultAttached: true, connectors: [] },
  { skillId: 'pdf-tools', description: 'Work with PDFs.', defaultAttached: false, connectors: [] },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listChatAgents).mockResolvedValue([
    { agentId: 'a1', displayName: 'My Agent', visibility: 'personal' },
  ]);
  vi.mocked(getConnections).mockResolvedValue({ agentId: 'a1', skills: INSTALLED });
  vi.mocked(listCatalogSkills).mockResolvedValue(CATALOG);
  vi.mocked(listUserSkills).mockResolvedValue([]);
  vi.mocked(listAuthoredSkills).mockResolvedValue([]);
  vi.mocked(listCatalogRequests).mockResolvedValue([]);
});

describe('SkillsTab', () => {
  it('renders the INSTALLED and NOT INSTALLED app-store shelves', async () => {
    render(<SkillsTab isAdmin={false} />);
    expect(await screen.findByText(/^Installed/)).toBeInTheDocument();
    expect(await screen.findByText(/Not installed/i)).toBeInTheDocument();
    // The not-installed shelf surfaces the catalog item that isn't installed.
    expect(await screen.findByText('Work with PDFs.')).toBeInTheDocument();
  });

  it('passes isAdmin=false through (no admin curation affordances)', async () => {
    render(<SkillsTab isAdmin={false} />);
    await screen.findByText('Work with PDFs.');
    expect(screen.queryByRole('button', { name: /Add to workspace/i })).toBeNull();
  });

  it('passes isAdmin=true through (admin curation affordances render)', async () => {
    render(<SkillsTab isAdmin={true} />);
    await screen.findByText('Work with PDFs.');
    expect(screen.getByRole('button', { name: /Add to workspace/i })).toBeInTheDocument();
  });
});
