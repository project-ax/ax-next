import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SitesTab } from '../SitesTab';
import * as agentsLib from '@/lib/agents';
import * as connLib from '@/lib/connections';
import * as sitesLib from '@/lib/remembered-sites';
import * as connectorsLib from '@/lib/connectors';
import {
  headingOutline,
  headingOutlineProblems,
} from '@/test-utils/heading-outline';

/*
  Settings › Sites (slice 2a). The two site lists used to sit at the bottom of
  Settings › Connectors. Connectors is an admin page now, and these lists are
  everyone's, so they got a page of their own. The panels themselves are
  unchanged and tested on their own (AllowedSitesPanel.test.tsx,
  RememberedSitesPanel.test.tsx); this file pins only that the page holds both,
  in order, under the outline the Connectors tab gave them.
*/
describe('SitesTab', () => {
  beforeEach(() => {
    vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue([]);
    vi.spyOn(connLib, 'listAllAllowedSites').mockResolvedValue([]);
    vi.spyOn(sitesLib, 'listRememberedSites').mockResolvedValue([]);
    vi.spyOn(connectorsLib, 'listConnectors');
  });
  afterEach(() => vi.restoreAllMocks());

  it('holds Allowed sites, then Sites we read without asking', async () => {
    render(<SitesTab />);
    await screen.findByText('Allowed sites');

    // A FRAGMENT under the pane title's `h1` ("Sites"), so it opens at h2.
    expect(headingOutlineProblems(document.body, 2)).toEqual([]);
    expect(headingOutline()).toEqual([
      'h2: Allowed sites',
      'h2: Sites we read without asking',
    ]);
  });

  it('never reads connector definitions — those are an admin page now', async () => {
    render(<SitesTab />);
    await screen.findByText('Allowed sites');
    expect(connectorsLib.listConnectors).not.toHaveBeenCalled();
  });
});
