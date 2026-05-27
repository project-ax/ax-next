import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BundleReviewDialog } from '../BundleReviewDialog';
import type { CatalogRequest } from '@ax/skills';

vi.mock('@/lib/catalog', () => ({ decideCatalogRequest: vi.fn() }));
vi.mock('@/lib/skills', () => ({ getSkillOrNull: vi.fn() }));
import { decideCatalogRequest } from '@/lib/catalog';
import { getSkillOrNull } from '@/lib/skills';
const mockDecide = vi.mocked(decideCatalogRequest);
const mockGetOrNull = vi.mocked(getSkillOrNull);

const SHARE_REQ: CatalogRequest = {
  requestId: 'r1',
  kind: 'share',
  skillId: 'linear',
  requestedByUserId: 'u1',
  sourceOwnerUserId: 'u1',
  status: 'pending',
  description: 'Linear.',
  createdAt: '2026-05-26T00:00:00.000Z',
  manifestYaml: 'name: linear\ndescription: Linear.\nversion: 1\n',
  bodyMd: '# linear v2\n',
  files: [{ path: 'scripts/q.py', contents: 'print(2)' }],
};

const COLD_REQ: CatalogRequest = {
  requestId: 'r2',
  kind: 'cold-start',
  skillId: 'jira',
  requestedByUserId: 'u2',
  sourceOwnerUserId: null,
  status: 'pending',
  description: 'I needed Jira.',
  createdAt: '2026-05-26T00:00:00.000Z',
  manifestYaml: null,
  bodyMd: null,
  files: [],
};

describe('BundleReviewDialog', () => {
  beforeEach(() => vi.resetAllMocks());

  it('shows a new-skill share bundle (no existing catalog version)', async () => {
    mockGetOrNull.mockResolvedValue(null);
    render(<BundleReviewDialog request={SHARE_REQ} onClose={vi.fn()} onDecided={vi.fn()} />);
    expect(await screen.findByText('scripts/q.py')).toBeTruthy();
    // a brand-new file is marked "added"
    expect(screen.getAllByText(/added/i).length).toBeGreaterThan(0);
  });

  it('admits a share request', async () => {
    mockGetOrNull.mockResolvedValue(null);
    mockDecide.mockResolvedValue({ admitted: true, skillId: 'linear' });
    const onDecided = vi.fn();
    render(<BundleReviewDialog request={SHARE_REQ} onClose={vi.fn()} onDecided={onDecided} />);
    fireEvent.click(await screen.findByRole('button', { name: /^admit$/i }));
    await waitFor(() => expect(mockDecide).toHaveBeenCalledWith('r1', 'admit'));
    await waitFor(() => expect(onDecided).toHaveBeenCalled());
  });

  it('disables Admit for a cold-start request (nothing to promote)', async () => {
    render(<BundleReviewDialog request={COLD_REQ} onClose={vi.fn()} onDecided={vi.fn()} />);
    const admit = (await screen.findByRole('button', { name: /^admit$/i })) as HTMLButtonElement;
    expect(admit.disabled).toBe(true);
    // reject is available
    expect((screen.getByRole('button', { name: /^reject$/i }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('keeps Admit disabled while the bundle diff is still loading', async () => {
    // getSkillOrNull never resolves → entries stays null (loading).
    mockGetOrNull.mockReturnValue(new Promise(() => {}));
    render(<BundleReviewDialog request={SHARE_REQ} onClose={vi.fn()} onDecided={vi.fn()} />);
    const admit = (await screen.findByRole('button', { name: /^admit$/i })) as HTMLButtonElement;
    expect(admit.disabled).toBe(true);
    // The loading state is shown, not a reviewable diff.
    expect(screen.getByText(/loading bundle/i)).toBeTruthy();
  });

  it('keeps Admit disabled if the current-version fetch fails (un-reviewable)', async () => {
    mockGetOrNull.mockRejectedValue(new Error('skills API 500'));
    render(<BundleReviewDialog request={SHARE_REQ} onClose={vi.fn()} onDecided={vi.fn()} />);
    // The error surfaces and Admit stays disabled — no admitting un-reviewed bytes.
    await waitFor(() => expect(screen.getByText(/skills API 500/)).toBeTruthy());
    expect((screen.getByRole('button', { name: /^admit$/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('shows a submitted file even when its path is a magic key (__proto__)', async () => {
    // `__proto__` is a valid bundle path that catalog:admit promotes verbatim;
    // it must appear in the review diff, not be silently hidden by a plain-{}
    // prototype setter. (Regression for the null-prototype-map fix.)
    mockGetOrNull.mockResolvedValue(null);
    render(
      <BundleReviewDialog
        request={{
          ...SHARE_REQ,
          files: [{ path: '__proto__', contents: 'sneaky payload' }],
        }}
        onClose={vi.fn()}
        onDecided={vi.fn()}
      />,
    );
    expect(await screen.findByText('__proto__')).toBeTruthy();
  });

  it('renders untrusted submitted contents as escaped text (no HTML injection)', async () => {
    mockGetOrNull.mockResolvedValue(null);
    render(
      <BundleReviewDialog
        request={{
          ...SHARE_REQ,
          files: [{ path: 'evil.txt', contents: '<img src=x onerror=alert(1)>' }],
        }}
        onClose={vi.fn()}
        onDecided={vi.fn()}
      />,
    );
    expect(await screen.findByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
});
