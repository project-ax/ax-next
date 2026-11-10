/**
 * The artifact preview: untrusted bytes, drawn without handing them our origin
 * (spec §6.5). HTML and images load from a minted content-origin URL; the
 * iframe gets scripts and downloads and nothing else, and no referrer.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { ArtifactPreview } from '../ArtifactPreview';

function renderPreview(over: Partial<ComponentProps<typeof ArtifactPreview>> = {}) {
  const props: ComponentProps<typeof ArtifactPreview> = {
    preview: 'html',
    title: 'Deal tracker',
    loadToken: vi.fn(async () => ({ url: 'http://127.0.0.1:9091/v/tok' })),
    loadText: vi.fn(async () => ({ text: '', truncated: false })),
    onDownload: vi.fn(),
    ...over,
  };
  return { ...render(<ArtifactPreview {...props} />), props };
}

describe('ArtifactPreview', () => {
  it('iframe sandbox and referrer policy', async () => {
    const { props } = renderPreview();
    const f = await screen.findByTitle('Deal tracker');
    expect(f.tagName).toBe('IFRAME');
    expect(f.getAttribute('sandbox')).toBe('allow-scripts allow-downloads');
    expect(f.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(f.getAttribute('allow')).toBe("camera 'none'; microphone 'none'; display-capture 'none'; geolocation 'none'");
    expect(f.getAttribute('src')).toBe('http://127.0.0.1:9091/v/tok');
    expect(props.loadToken).toHaveBeenCalledWith('view');
  });

  it('a minted address on the app origin, or off the /v/ path, is refused: no frame', async () => {
    for (const url of [`${window.location.origin}/v/tok`, 'http://127.0.0.1:9091/d/tok', 'javascript:alert(1)']) {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const r = renderPreview({ loadToken: vi.fn(async () => ({ url })) });
      expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
      expect(screen.queryByTitle('Deal tracker')).toBeNull();
      r.unmount();
    }
  });

  it('markdown keeps <script> as text and images as alt text', async () => {
    const { container } = renderPreview({
      preview: 'markdown',
      loadText: vi.fn(async () => ({
        text: '# Plan\n\n<script>window.x=1</script>\n\n![a chart](https://evil.example/pixel.png)',
        truncated: false,
      })),
    });
    expect(await screen.findByRole('heading', { name: 'Plan' })).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('a chart')).toBeTruthy();
  });

  it('images load from the token url with referrerpolicy no-referrer', async () => {
    renderPreview({ preview: 'image', title: 'Logo' });
    const img = await screen.findByRole('img', { name: 'Logo' });
    expect(img.getAttribute('src')).toBe('http://127.0.0.1:9091/v/tok');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('PDF says "Download to open"; xlsx says "We can\'t preview this one yet"; both offer Download', () => {
    const pdf = renderPreview({ preview: 'pdf' });
    expect(screen.getByText('Download to open')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(pdf.props.onDownload).toHaveBeenCalledTimes(1);
    expect(pdf.props.loadToken).not.toHaveBeenCalled();
    pdf.unmount();

    const xlsx = renderPreview({ preview: 'none' });
    expect(screen.getByText('We can’t preview this one yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(xlsx.props.onDownload).toHaveBeenCalledTimes(1);
    expect(xlsx.props.loadToken).not.toHaveBeenCalled();
  });

  it('a truncated text preview says it shows the beginning', async () => {
    const { container } = renderPreview({
      preview: 'text',
      loadText: vi.fn(async () => ({ text: 'a,b\n1,2', truncated: true })),
    });
    expect(await screen.findByText('Showing the beginning of this file.')).toBeTruthy();
    expect(container.querySelector('pre')?.textContent).toBe('a,b\n1,2');
  });

  it('a whole text preview says nothing about the beginning', async () => {
    renderPreview({ preview: 'text', loadText: vi.fn(async () => ({ text: 'hello', truncated: false })) });
    expect(await screen.findByText('hello')).toBeTruthy();
    expect(screen.queryByText('Showing the beginning of this file.')).toBeNull();
  });

  it('a failed token says so plainly and Try again mints a fresh one', async () => {
    const loadToken = vi
      .fn<(p: 'view' | 'download') => Promise<{ url: string }>>()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce({ url: 'http://127.0.0.1:9091/v/tok2' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderPreview({ loadToken });
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    const f = await screen.findByTitle('Deal tracker');
    expect(f.getAttribute('src')).toBe('http://127.0.0.1:9091/v/tok2');
    await waitFor(() => expect(loadToken).toHaveBeenCalledTimes(2));
  });
});
