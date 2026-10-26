import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CredentialSlotRow } from '../CredentialSlotRow';

const row = (routineId = 'first') => <CredentialSlotRow
  destination={{ kind: 'routine-hmac', agentId: 'agent', routineId }}
  slot={{ label: 'Webhook HMAC secret', kind: 'api-key' }}
  scope={{ scope: 'agent', ownerId: 'agent' }}
/>;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function directory() { return response({ routine: { name: 'Daily digest', revision: 'rev7', permissions: { manageSecret: true } } }); }
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

describe('own routine signing-secret controls', () => {
  beforeEach(() => { vi.spyOn(globalThis, 'fetch'); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('loads configured state without the global list and removes an existing key', async () => {
    let configured = true;
    const fetch = vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/settings/routines/')) return directory();
      if (url.includes('/settings/destinations/routine-hmac/credential')) {
        if (init?.method === 'DELETE') { configured = false; return new Response(null, { status: 204 }); }
        return response({ configured });
      }
      return response({ error: 'forbidden' }, 403);
    });
    render(row());
    fireEvent.click(await screen.findByRole('button', { name: 'Replace key' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove key' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Not set')).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/admin/credentials'))).toBe(false);
    const deletion = fetch.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(JSON.parse(String(deletion?.[1]?.body))).toMatchObject({ expectedRevision: 'rev7', destination: { routineId: 'first' } });
  });

  it('saves with the authoritative revision then refreshes configured state', async () => {
    let configured = false;
    const fetch = vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/settings/routines/')) return directory();
      if (url.includes('/settings/destinations/routine-hmac/credential')) {
        if (init?.method === 'POST') { configured = true; return new Response(null, { status: 204 }); }
        return response({ configured });
      }
      return response({ error: 'forbidden' }, 403);
    });
    render(row());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add key' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    const write = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(String(write?.[0])).toBe('/settings/destinations/routine-hmac/credential');
    expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({ expectedRevision: 'rev7' });
  });

  it('shows a retryable status error rather than a false unset state', async () => {
    let available = false;
    vi.mocked(globalThis.fetch).mockImplementation(async input => {
      if (String(input).includes('/settings/routines/')) return directory();
      return available ? response({ configured: true }) : response({ error: 'PRIVATE outage' }, 503);
    });
    render(row());
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check the signing secret.');
    expect(screen.queryByText('Not set')).not.toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add key' })).toBeDisabled();
    available = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('ignores a late configured result from the previous task', async () => {
    const first = deferred();
    const fetch = vi.mocked(globalThis.fetch).mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/settings/routines/')) return directory();
      if (url.includes('/settings/destinations/routine-hmac/credential')) return url.includes('routineId=first') ? first.promise : response({ configured: false });
      return response({ credentials: [] });
    });
    const view = render(row());
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('routineId=first'))).toBe(true));
    view.rerender(row('second'));
    expect(await screen.findByText('Not set')).toBeInTheDocument();
    await act(async () => { first.resolve(response({ configured: true })); });
    expect(screen.getByText('Not set')).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('keeps the saved state and draft when a write fails without exposing response details', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input).includes('/settings/routines/')) return directory();
      if (init?.method === 'POST' || init?.method === 'DELETE') return response({ error: 'PRIVATE secret error' }, 503);
      return response({ configured: true });
    });
    render(row());
    fireEvent.click(await screen.findByRole('button', { name: 'Replace key' }));
    fireEvent.change(screen.getByLabelText('Replace API key'), { target: { value: 'keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(await screen.findByRole('alert')).not.toHaveTextContent('PRIVATE');
    expect(screen.getByLabelText('Replace API key')).toHaveValue('keep this draft');
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove key' })).toBeEnabled());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Replace API key')).toHaveValue('keep this draft');
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('does not close a new task draft when an old task save completes', async () => {
    const save = deferred();
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input).includes('/settings/routines/')) return directory();
      if (init?.method === 'POST') return save.promise;
      return String(input).includes('/admin/credentials') ? response({ credentials: [] }) : response({ configured: false });
    });
    const view = render(row());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add key' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'old secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    view.rerender(row('second'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add key' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'new draft' } });
    await act(async () => { save.resolve(new Response(null, { status: 204 })); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('API key')).toHaveValue('new draft');
  });
});
