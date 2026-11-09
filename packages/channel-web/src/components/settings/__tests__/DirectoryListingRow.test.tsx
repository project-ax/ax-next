/**
 * TASK-1101 — one directory listing: its row (title, who published it, the
 * description, chips) and its detail sheet (Published by, Connects to, How
 * people connect, Listing, the trust note, Set it up).
 *
 * Every listing field is untrusted registry text. `listing text with markup
 * renders as literal text` is the card's acceptance test for that: markup
 * stays text, and nothing becomes an element, a link or a source.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DirectoryListingRow } from '../DirectoryListingRow';
import type { DirectoryEntry } from '@/lib/connector-directory';
import { directoryEntry } from '@/lib/__tests__/directory-fixtures';
import { monthDay } from '@/lib/workspace-time';

const TRUST =
  'The directory checks who published a server, not what it does. An agent with this connector can send it whatever the agent is working on, so only add servers you’d trust with that.';
const NOTE_ACCOUNT = 'A community listing. It isn’t checked against any company.';

function renderRow(entry: DirectoryEntry, added = false) {
  const onSetUp = vi.fn();
  const view = render(<DirectoryListingRow entry={entry} added={added} onSetUp={onSetUp} />);
  return { ...view, onSetUp };
}

/** The row itself. Only reachable while no sheet is open (the sheet is modal). */
function row(title: string): HTMLElement {
  return screen.getByRole('button', { name: `Details for ${title}` });
}

async function openSheet(title: string): Promise<HTMLElement> {
  fireEvent.click(row(title));
  return screen.findByRole('dialog', { name: title });
}

/** The `dd` the sheet shows under one `dt` label. */
function detailFor(sheet: HTMLElement, term: string): HTMLElement {
  const dd = within(sheet).getByText(term, { selector: 'dt' }).nextElementSibling;
  if (!(dd instanceof HTMLElement) || dd.tagName !== 'DD') throw new Error(`no value under "${term}"`);
  return dd;
}

describe('DirectoryListingRow', () => {
  it('a verified listing shows its domain with a shield, and the sheet says what was proved', async () => {
    renderRow(directoryEntry());
    const proof = screen.getByTestId('directory-proof-domain');
    expect(proof).toHaveTextContent('Published by linear.app');
    // The shield is decoration. A screen reader hears "(verified)" instead.
    expect(proof.querySelector('svg.lucide-shield-check')).toHaveAttribute('aria-hidden', 'true');
    expect(proof).toHaveTextContent(/^Published by linear\.app \(verified\)$/);
    expect(screen.queryByTestId('directory-proof-account')).toBeNull();

    const sheet = await openSheet('Linear');
    expect(
      within(detailFor(sheet, 'Published by')).getByText('The publisher proved they control linear.app.'),
    ).toBeInTheDocument();
    expect(detailFor(sheet, 'Connects to').textContent).toBe('mcp.linear.app');
    expect(detailFor(sheet, 'Listing').textContent).toBe(
      `Version 1.4.0 · updated ${monthDay('2026-11-03T12:00:00.000Z')}`,
    );
    // A note beside the decision, not an alert: `role="alert"` means something broke.
    expect(within(sheet).getByRole('note')).toHaveTextContent(TRUST);
  });

  it('a community listing never claims a company or GitHub', async () => {
    renderRow(directoryEntry({ publisherProof: 'account', publisher: 'quickmcp-dev' }));
    expect(screen.getByTestId('directory-proof-account')).toHaveTextContent(/^Community · quickmcp-dev$/);
    expect(screen.queryByTestId('directory-proof-domain')).toBeNull();

    const sheet = await openSheet('Linear');
    expect(within(detailFor(sheet, 'Published by')).getByText(NOTE_ACCOUNT)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/GitHub/);
    expect(document.body.textContent).not.toMatch(/proved they control/);
    // No shield and no "(verified)" anywhere, in the row or the sheet.
    expect(document.querySelector('svg.lucide-shield-check')).toBeNull();
    expect(document.body.textContent).not.toMatch(/verified/i);
  });

  it('auth chips: API key, Sign-in, and nothing for a listing that declares no key', () => {
    render(
      <>
        <DirectoryListingRow
          entry={directoryEntry({ title: 'Keyed', auth: 'key', keyHeader: 'X-API-Key' })}
          added={false}
          onSetUp={vi.fn()}
        />
        <DirectoryListingRow entry={directoryEntry({ title: 'Signed', auth: 'signin' })} added={false} onSetUp={vi.fn()} />
        <DirectoryListingRow entry={directoryEntry({ title: 'Undeclared' })} added={false} onSetUp={vi.fn()} />
      </>,
    );
    expect(within(row('Keyed')).getByText('API key')).toBeInTheDocument();
    expect(within(row('Keyed')).queryByText('Sign-in')).toBeNull();
    expect(within(row('Signed')).getByText('Sign-in')).toBeInTheDocument();
    expect(within(row('Signed')).queryByText('API key')).toBeNull();
    expect(within(row('Undeclared')).queryByText('API key')).toBeNull();
    expect(within(row('Undeclared')).queryByText('Sign-in')).toBeNull();
    expect(screen.queryByText(/no sign-in/i)).toBeNull();
    // None of these is added or deprecated, so none says so.
    expect(screen.queryByText('Added')).toBeNull();
    expect(screen.queryByText('Deprecated')).toBeNull();
  });

  it('How people connect says only what the listing says', async () => {
    const cases: Array<[DirectoryEntry, string]> = [
      [
        directoryEntry({ auth: 'key', keyHeader: 'X-API-Key' }),
        'Needs an API key, sent in the X-API-Key header. You choose whether each agent brings its own key or everyone shares one.',
      ],
      [
        directoryEntry({ auth: 'key' }),
        'Needs an API key. You’ll add the request header it goes in when you set it up.',
      ],
      [directoryEntry({ auth: 'signin' }), 'Each person signs in from their agent’s Connectors tab.'],
      [
        directoryEntry(),
        'The listing doesn’t mention a key. When you set it up, we’ll check whether people need to sign in.',
      ],
    ];
    for (const [entry, how] of cases) {
      const { unmount } = renderRow(entry);
      const sheet = await openSheet('Linear');
      expect(detailFor(sheet, 'How people connect').textContent).toBe(how);
      expect(document.body.textContent).not.toMatch(/no sign-in/i);
      unmount();
    }
  });

  it('listing text with markup renders as literal text', async () => {
    const title = '<img src=x onerror=alert(1)>Evil';
    const description = '<b>bold</b><script>alert(1)</script>';
    renderRow(directoryEntry({ title, description, publisher: '<i>pub</i>', version: '<u>1</u>' }));
    expect(screen.getByText(description)).toBeInTheDocument();
    expect(screen.getByTestId('directory-proof-domain')).toHaveTextContent('Published by <i>pub</i>');
    expect(screen.getByRole('button', { name: 'Details for <img src=x onerror=alert(1)>Evil' })).toBeInTheDocument();

    const sheet = await openSheet(title);
    expect(within(sheet).getByText(description)).toBeInTheDocument();
    expect(within(sheet).getByText('The publisher proved they control <i>pub</i>.')).toBeInTheDocument();
    expect(detailFor(sheet, 'Listing').textContent).toMatch(/^Version <u>1<\/u>/);
    expect(document.querySelector('b, script, img, i, u')).toBeNull();
    // Row and sheet both: no link, and nothing anywhere loads or points at a URL.
    expect(screen.queryAllByRole('link', { hidden: true })).toEqual([]);
    expect(document.querySelectorAll('[href], [src]')).toHaveLength(0);
  });

  it('an added listing offers no Set it up', async () => {
    renderRow(directoryEntry(), true);
    expect(within(row('Linear')).getByText('Added')).toBeInTheDocument();
    const sheet = await openSheet('Linear');
    expect(within(sheet).getByRole('button', { name: 'Already in your connectors' })).toBeDisabled();
    expect(within(sheet).queryByRole('button', { name: 'Set it up' })).toBeNull();
  });

  it('Set it up closes the sheet and hands the listing up', async () => {
    const entry = directoryEntry({ auth: 'key', keyHeader: 'X-API-Key' });
    const { onSetUp } = renderRow(entry);
    const sheet = await openSheet('Linear');
    expect(within(sheet).queryByRole('button', { name: 'Already in your connectors' })).toBeNull();
    expect(within(sheet).queryByText(/deprecated/i)).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set it up' }));
    expect(onSetUp).toHaveBeenCalledTimes(1);
    expect(onSetUp).toHaveBeenCalledWith(entry);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a deprecated listing says so and can still be set up', async () => {
    renderRow(directoryEntry({ deprecated: true }));
    expect(within(row('Linear')).getByText('Deprecated')).toBeInTheDocument();
    const sheet = await openSheet('Linear');
    expect(
      within(sheet).getByText('This listing is marked deprecated, so it may stop working.'),
    ).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Set it up' })).toBeEnabled();
  });

  it('a listing without a description says so in the sheet', async () => {
    for (const description of ['', '   ']) {
      const { unmount } = renderRow(directoryEntry({ description }));
      const sheet = await openSheet('Linear');
      expect(within(sheet).getByText('The publisher didn’t add a description.')).toBeInTheDocument();
      unmount();
    }
  });
});
