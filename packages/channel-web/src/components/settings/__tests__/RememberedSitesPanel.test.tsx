import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { RememberedSitesPanel } from '../RememberedSitesPanel';
import * as sitesLib from '@/lib/remembered-sites';

describe('RememberedSitesPanel', () => {
  beforeEach(() => {
    vi.spyOn(sitesLib, 'listRememberedSites').mockResolvedValue([
      { host: 'user.example.com', scope: 'user', rememberedAt: '2026-01-05T00:00:00.000Z' },
      { host: 'admin.example.com', scope: 'global', rememberedAt: '2026-01-06T00:00:00.000Z' },
    ]);
    vi.spyOn(sitesLib, 'forgetRememberedSite').mockResolvedValue({ revoked: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows a global row with "Set by your admin" and no button; a user row with "Ask again"', async () => {
    render(<RememberedSitesPanel />);

    const userRow = await screen.findByTestId('remembered-site-user.example.com');
    expect(within(userRow).getByRole('button', { name: 'Ask again' })).toBeInTheDocument();

    const globalRow = screen.getByTestId('remembered-site-admin.example.com');
    expect(within(globalRow).getByText('Set by your admin')).toBeInTheDocument();
    expect(within(globalRow).queryByRole('button', { name: 'Ask again' })).toBeNull();
  });

  it('clicking Ask again revokes the host and re-reads the list', async () => {
    render(<RememberedSitesPanel />);
    const userRow = await screen.findByTestId('remembered-site-user.example.com');
    fireEvent.click(within(userRow).getByRole('button', { name: 'Ask again' }));

    await waitFor(() =>
      expect(sitesLib.forgetRememberedSite).toHaveBeenCalledWith('user.example.com'),
    );
    await waitFor(() =>
      expect(
        (sitesLib.listRememberedSites as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  it('shows the "we\'ll ask next time" notice on revoked: true', async () => {
    render(<RememberedSitesPanel />);
    const userRow = await screen.findByTestId('remembered-site-user.example.com');
    fireEvent.click(within(userRow).getByRole('button', { name: 'Ask again' }));

    await screen.findByText('We’ll ask about that one next time.');
  });

  it('shows the "already gone" notice on revoked: false', async () => {
    vi.spyOn(sitesLib, 'forgetRememberedSite').mockResolvedValue({ revoked: false });
    render(<RememberedSitesPanel />);
    const userRow = await screen.findByTestId('remembered-site-user.example.com');
    fireEvent.click(within(userRow).getByRole('button', { name: 'Ask again' }));

    await screen.findByText('That one was already gone.');
  });

  it('shows the failure notice on a thrown DELETE, and the row stays', async () => {
    vi.spyOn(sitesLib, 'forgetRememberedSite').mockRejectedValue(new Error('boom'));
    render(<RememberedSitesPanel />);
    const userRow = await screen.findByTestId('remembered-site-user.example.com');
    fireEvent.click(within(userRow).getByRole('button', { name: 'Ask again' }));

    await screen.findByText('We couldn’t take that back just now. Nothing changed.');
    expect(screen.getByTestId('remembered-site-user.example.com')).toBeInTheDocument();
  });

  it('renders the empty state when there are no remembered sites', async () => {
    vi.spyOn(sitesLib, 'listRememberedSites').mockResolvedValue([]);
    render(<RememberedSitesPanel />);
    await screen.findByText(
      'Nothing here yet — we’ll ask the first time your assistant wants to read a new site.',
    );
  });

  /*
   * TASK-464 — a failed read must not render as an empty list.
   *
   * THE OLD TEST HERE ASSERTED `findByText('network down')`, which pinned two
   * defects at once: the panel put a raw exception message in front of a person
   * (nothing they can act on — TASK-358's standing bar), and it ALSO called
   * `setSites([])` in the same catch, so the reassuring empty-state sentence
   * rendered underneath the banner. Two claims about one fact, one of them
   * false, and the false one is the one that says the security allowlist is
   * empty.
   *
   * WHY THESE ASSERT ABSENCE AS WELL AS PRESENCE. A test that only looked for
   * the new sentence would stay green if the old one were still on screen
   * beside it — which is exactly the shipped bug. `queryByText(...)` for the
   * empty-state copy is the assertion that reddens.
   *
   * jsdom has no layout, so nothing here claims anything visual. What it does
   * assert is real in jsdom: which strings the component was handed, and the
   * accessibility tree (`role="alert"`, the button's accessible name).
   */
  // A matcher, not a literal: the sentence is split across a `<strong>` and JSX
  // whitespace, so `getByText('…')` on the whole thing would never match. The
  // distinctive clause is enough and it is the clause that carries the meaning.
  const UNKNOWN_COPY = /That’s not the same as it being empty/;
  const EMPTY_COPY =
    'Nothing here yet — we’ll ask the first time your assistant wants to read a new site.';

  it('says we could not load the list — and does NOT say the list is empty', async () => {
    vi.spyOn(sitesLib, 'listRememberedSites').mockRejectedValue(new Error('network down'));
    render(<RememberedSitesPanel />);

    await screen.findByText(UNKNOWN_COPY);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // The whole card. Against the old panel this is the failing line.
    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
  });

  it('puts no status code, path or exception text in front of the reader', async () => {
    // The message is authored copy or it is nothing. `HttpError` deliberately
    // keeps its `path → status` on `.detail` for the console; a surface that
    // renders `.message` from an arbitrary throw is rendering a browser string.
    vi.spyOn(sitesLib, 'listRememberedSites').mockRejectedValue(
      new Error('ECONNREFUSED /api/chat/remembered-sites 503'),
    );
    render(<RememberedSitesPanel />);

    await screen.findByText(UNKNOWN_COPY);
    expect(screen.queryByText(/ECONNREFUSED/)).toBeNull();
    expect(screen.queryByText(/503/)).toBeNull();
    expect(screen.queryByText(/remembered-sites/)).toBeNull();
  });

  it('offers a Try again that re-reads, and shows the list when it works', async () => {
    // The unknown state is terminal until the reader acts (`lib/read-register`),
    // so the action has to exist and has to work. This also proves the state is
    // not sticky: a later good read replaces it rather than sitting under it.
    const spy = vi
      .spyOn(sitesLib, 'listRememberedSites')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce([
        { host: 'user.example.com', scope: 'user', rememberedAt: '2026-01-05T00:00:00.000Z' },
      ]);
    render(<RememberedSitesPanel />);

    const retry = await screen.findByRole('button', { name: 'Try again' });
    fireEvent.click(retry);

    await screen.findByTestId('remembered-site-user.example.com');
    expect(screen.queryByText(UNKNOWN_COPY)).toBeNull();
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('draws no list at all while the read is unknown — not even an empty one', async () => {
    // An alert ABOVE an empty card is still showing somebody an empty list, and
    // the empty list is the false claim. Nothing on screen may assert what is
    // or is not allowed while we cannot see it.
    vi.spyOn(sitesLib, 'listRememberedSites').mockRejectedValue(new Error('network down'));
    render(<RememberedSitesPanel />);

    await screen.findByText(UNKNOWN_COPY);
    expect(screen.queryAllByTestId(/^remembered-site-/)).toHaveLength(0);
    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();

    // AND IT ADDS NO HEADING. `ui/alert.tsx` hardcodes `AlertTitle` to `<h5>`,
    // so the obvious "We couldn't load your list" title lands as an h2 → h5
    // jump under this section's own heading — `ConnectorsTab.test.tsx` caught
    // exactly that while this was being built. Pinned here as well, because the
    // temptation to add the title back lives in THIS file, and the test that
    // would object is three directories away.
    expect(
      within(screen.getByRole('alert')).queryAllByRole('heading', { hidden: true }),
    ).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'Sites we read without asking' })).toBeInTheDocument();
  });

  it('keeps the revoke notice when the re-read afterwards fails', async () => {
    // The revoke succeeded; the list read after it did not. Those are two
    // facts, and losing the first one leaves somebody who just clicked "Ask
    // again" with no word on whether it worked. The notice belongs to the
    // panel, not to the Card that the unknown state replaces.
    render(<RememberedSitesPanel />);
    const userRow = await screen.findByTestId('remembered-site-user.example.com');
    vi.spyOn(sitesLib, 'listRememberedSites').mockRejectedValue(new Error('network down'));

    fireEvent.click(within(userRow).getByRole('button', { name: 'Ask again' }));

    await screen.findByText(UNKNOWN_COPY);
    expect(screen.getByText('We’ll ask about that one next time.')).toBeInTheDocument();
  });

  it('keeps the notice on screen after the revoked row disappears from a re-read', async () => {
    render(<RememberedSitesPanel />);
    const userRow = await screen.findByTestId('remembered-site-user.example.com');

    // After the revoke, the next list() call comes back without that host —
    // the row that showed the button is gone, but the notice must still be
    // on screen (the #611 lesson: the notice belongs to the PANEL, not the row).
    vi.spyOn(sitesLib, 'listRememberedSites').mockResolvedValue([
      { host: 'admin.example.com', scope: 'global', rememberedAt: '2026-01-06T00:00:00.000Z' },
    ]);

    fireEvent.click(within(userRow).getByRole('button', { name: 'Ask again' }));

    await screen.findByText('We’ll ask about that one next time.');
    await waitFor(() =>
      expect(screen.queryByTestId('remembered-site-user.example.com')).toBeNull(),
    );
    // The row is gone; the notice must not be.
    expect(screen.getByText('We’ll ask about that one next time.')).toBeInTheDocument();
  });

  it('does not collide on React keys if the server ever sends one host twice', async () => {
    // `@ax/tool-policy` dedupes this away (one row per host, global wins) and
    // that is where the rule lives — the panel deliberately does NOT
    // re-implement it, because two copies of "global wins" is two things to
    // keep in step. What the panel owns is its own keys: keyed on the host
    // alone, two rows for one host are siblings with the same key, and React
    // reconciliation is then undefined. Keyed on scope+host they cannot be.
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    vi.spyOn(sitesLib, 'listRememberedSites').mockResolvedValue([
      { host: 'dup.example.com', scope: 'global', rememberedAt: '2026-01-06T00:00:00.000Z' },
      { host: 'dup.example.com', scope: 'user', rememberedAt: '2026-01-05T00:00:00.000Z' },
    ]);
    render(<RememberedSitesPanel />);

    await screen.findAllByTestId('remembered-site-dup.example.com');
    expect(screen.getAllByTestId('remembered-site-dup.example.com')).toHaveLength(2);
    expect(
      errors.some((a) => String(a[0] ?? '').toLowerCase().includes('same key')),
      JSON.stringify(errors),
    ).toBe(false);
    spy.mockRestore();
  });
});
