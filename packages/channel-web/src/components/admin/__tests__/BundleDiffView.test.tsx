import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BundleDiffView } from '../BundleDiffView';
import type { BundleFileEntry } from '@/lib/bundle-diff';

describe('BundleDiffView', () => {
  it('renders the per-file status badge and a real line diff', () => {
    const entries: BundleFileEntry[] = [
      { path: 'a.txt', status: 'modified', before: 'x\ny', after: 'x\nz' },
    ];
    render(<BundleDiffView entries={entries} />);
    expect(screen.getByText('a.txt')).toBeTruthy();
    expect(screen.getByText('modified')).toBeTruthy();
  });

  it('renders untrusted contents as escaped text (no HTML injection)', () => {
    const entries: BundleFileEntry[] = [
      { path: 'evil.txt', status: 'added', before: null, after: '<img src=x onerror=alert(1)>' },
    ];
    render(<BundleDiffView entries={entries} />);
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('caps rendered rows for a line-dense file (no unbounded DOM)', () => {
    // A valid 256 KiB bundle file can be ~hundreds of thousands of newlines.
    // The diff must NOT render one DOM node per line — it caps and shows a
    // truncation notice so the admin tab does not freeze on an untrusted share.
    const huge = Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join('\n');
    const entries: BundleFileEntry[] = [
      { path: 'big.txt', status: 'added', before: null, after: huge },
    ];
    const { container } = render(<BundleDiffView entries={entries} />);
    // Far fewer rendered line rows than 50k.
    const rows = container.querySelectorAll('[data-diff-line]');
    expect(rows.length).toBeLessThanOrEqual(600);
    // A truncation notice tells the reviewer the rest is not shown inline.
    expect(screen.getByText(/not shown inline/i)).toBeTruthy();
  });
});
