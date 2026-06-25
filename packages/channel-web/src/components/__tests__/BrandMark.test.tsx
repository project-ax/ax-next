import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { BrandMark } from '../BrandMark';
import * as brandingContext from '@/lib/branding-context';
import * as theme from '@/lib/theme';
import type { Branding } from '@/lib/branding';

function mockBranding(branding: Branding, loaded = true): void {
  vi.spyOn(brandingContext, 'useBranding').mockReturnValue({
    branding,
    loaded,
    refresh: () => {},
  });
}
function mockTheme(resolved: 'light' | 'dark'): void {
  vi.spyOn(theme, 'useResolvedTheme').mockReturnValue(resolved);
}

const base: Branding = {
  name: '',
  logoType: 'full',
  light: false,
  dark: false,
  version: '',
};

afterEach(() => vi.restoreAllMocks());

describe('BrandMark — no logo', () => {
  it('shows the default "ax" wordmark when nothing is branded', () => {
    mockBranding(base);
    mockTheme('light');
    const { container } = render(<BrandMark />);
    expect(container.textContent).toContain('ax');
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows the configured name (no logo) as text beside the dot', () => {
    mockBranding({ ...base, name: 'Canopy AI' });
    mockTheme('light');
    const { container } = render(<BrandMark />);
    expect(container.textContent).toContain('Canopy AI');
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders no logo while branding is still loading', () => {
    mockBranding({ ...base, light: true, version: 'V1' }, false);
    mockTheme('light');
    const { container } = render(<BrandMark />);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('BrandMark — full logo', () => {
  it('renders only the light logo in light mode', () => {
    mockBranding({ ...base, name: 'Canopy', logoType: 'full', light: true, version: 'V1' });
    mockTheme('light');
    const { container } = render(<BrandMark />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toContain('/api/branding/logo/light?v=V1');
    expect(container.textContent).not.toContain('Canopy'); // full logo carries the wordmark
  });

  it('renders the dark logo in dark mode when one is set', () => {
    mockBranding({ ...base, logoType: 'full', light: true, dark: true, version: 'V2' });
    mockTheme('dark');
    const img = render(<BrandMark />).container.querySelector('img');
    expect(img?.getAttribute('src')).toContain('/api/branding/logo/dark?v=V2');
  });

  it('CSS-inverts the light logo in dark mode when no dark variant is set', () => {
    mockBranding({ ...base, logoType: 'full', light: true, dark: false, version: 'V3' });
    mockTheme('dark');
    const img = render(<BrandMark />).container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toContain('/api/branding/logo/light?v=V3');
    expect(img.style.filter).toContain('invert');
  });
});

describe('BrandMark — icon logo', () => {
  it('renders the icon AND the name beside it', () => {
    mockBranding({ ...base, name: 'Canopy', logoType: 'icon', light: true, version: 'V4' });
    mockTheme('light');
    const { container } = render(<BrandMark />);
    expect(container.querySelector('img')).toBeTruthy();
    expect(container.textContent).toContain('Canopy');
  });
});
