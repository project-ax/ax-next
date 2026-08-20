import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrandingProvider, useBranding } from '../branding-context';
import * as brandingClient from '../branding';

function Probe() {
  const { branding, loaded } = useBranding();
  if (!loaded) return <div>loading</div>;
  return <div>{`loaded:${branding.name || 'ax'}:${branding.light}`}</div>;
}

describe('BrandingProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exposes the fetched branding once loaded', async () => {
    vi.spyOn(brandingClient, 'fetchBranding').mockResolvedValue({
      name: 'Canopy AI',
      logoType: 'icon',
      light: true,
      dark: false,
      version: 'V1',
    });
    render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText('loaded:Canopy AI:true')).toBeTruthy(),
    );
    // `document.title` is written by a SEPARATE effect from the state this
    // component renders (branding-context.tsx: the title effect keys off
    // `branding`, while the probe text keys off `branding` + `loaded`). So the
    // text can be on screen a tick before the title effect has flushed, and
    // asserting it bare raced — rarely locally, reliably on a loaded CI worker.
    await waitFor(() => expect(document.title).toBe('Canopy AI'));
  });

  it('falls back to the default branding when the fetch fails', async () => {
    vi.spyOn(brandingClient, 'fetchBranding').mockRejectedValue(
      new Error('offline'),
    );
    render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>,
    );
    await waitFor(() => expect(screen.getByText('loaded:ax:false')).toBeTruthy());
    await waitFor(() => expect(document.title).toBe('ax'));
  });
});
