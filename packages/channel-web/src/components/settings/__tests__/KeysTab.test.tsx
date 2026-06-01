import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { KeysTab } from '../KeysTab';
import * as credLib from '../../../lib/credentials';
import * as connLib from '../../../lib/connections';

describe('KeysTab', () => {
  beforeEach(() => {
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([
      { scope: 'user', ownerId: 'u1', ref: 'account:linear', kind: 'api-key', createdAt: '2026-05-20T00:00:00Z' },
      { scope: 'user', ownerId: 'u1', ref: 'skill:github:GH_TOKEN', kind: 'api-key', createdAt: '2026-05-22T00:00:00Z' },
    ]);
    vi.spyOn(connLib, 'getAccountUsage').mockResolvedValue({
      linear: ['linear', 'linear-search'],
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists a service-keyed account row with a used-by hint from account-usage', async () => {
    render(<KeysTab />);
    // account:linear → service label "linear" + used-by from the usage map.
    expect(await screen.findByText(/used by: linear, linear-search/)).toBeInTheDocument();
    // the masked indicator is rendered per row.
    expect(screen.getAllByText('••••••').length).toBe(2);
    // the raw secret value is never rendered as a key=value pair.
    expect(screen.queryByText(/GH_TOKEN=/)).not.toBeInTheDocument();
  });

  it('keeps per-slot (skill) rows working (back-compat)', async () => {
    render(<KeysTab />);
    // skill:github:GH_TOKEN → used by: github · GH_TOKEN
    expect(await screen.findByText(/used by: github · GH_TOKEN/)).toBeInTheDocument();
  });

  it('falls back to the service name when no skill references it yet', async () => {
    vi.spyOn(connLib, 'getAccountUsage').mockResolvedValue({});
    render(<KeysTab />);
    // account:linear with empty usage → "used by: linear" (the service name).
    expect(await screen.findByText('used by: linear')).toBeInTheDocument();
  });

  it('Add a key by service calls setDestinationCredential with the account destination', async () => {
    const set = vi.spyOn(credLib, 'setDestinationCredential').mockResolvedValue();
    render(<KeysTab />);
    await screen.findByText(/used by: linear/);
    fireEvent.click(screen.getByRole('button', { name: /^add a key$/i }));
    fireEvent.change(await screen.findByLabelText(/which service is this key for/i), {
      target: { value: 'github' },
    });
    fireEvent.change(screen.getByLabelText(/^value$/i), { target: { value: 'ghp_secret' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith({
        destination: { kind: 'account', service: 'github' },
        slot: { kind: 'api-key' },
        scope: { scope: 'user', ownerId: null },
        payload: 'ghp_secret',
      }),
    );
  });

  it('normalizes a friendly service name to a slug and never shows slug-grammar copy', async () => {
    const set = vi.spyOn(credLib, 'setDestinationCredential').mockResolvedValue();
    render(<KeysTab />);
    await screen.findByText(/used by: linear/);
    fireEvent.click(screen.getByRole('button', { name: /^add a key$/i }));
    // A human types a friendly, mixed-case name with spaces + punctuation.
    fireEvent.change(await screen.findByLabelText(/which service is this key for/i), {
      target: { value: 'My Service!' },
    });
    // No slug-grammar validation copy is ever surfaced to the user.
    expect(screen.queryByText(/lowercase service name/i)).not.toBeInTheDocument();
    // Save is enabled once a value is present (input slugifies non-empty).
    fireEvent.change(screen.getByLabelText(/^value$/i), { target: { value: 'sekret' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith({
        destination: { kind: 'account', service: 'my-service' },
        slot: { kind: 'api-key' },
        scope: { scope: 'user', ownerId: null },
        payload: 'sekret',
      }),
    );
  });

  it('keeps Save disabled when the service name slugifies to empty', async () => {
    render(<KeysTab />);
    await screen.findByText(/used by: linear/);
    fireEvent.click(screen.getByRole('button', { name: /^add a key$/i }));
    fireEvent.change(await screen.findByLabelText(/which service is this key for/i), {
      target: { value: '   ' },
    });
    fireEvent.change(screen.getByLabelText(/^value$/i), { target: { value: 'sekret' } });
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('shows a humane error with a next step (not a raw dump) when the list fails', async () => {
    vi.spyOn(credLib.myCredentials, 'list').mockRejectedValue(new Error('HTTP 500'));
    render(<KeysTab />);
    // The leading sentence names a next step the user can take.
    expect(
      await screen.findByText(/check it's correct and try again/i),
    ).toBeInTheDocument();
    // No "[object Object]" String(e) dump is ever rendered.
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it('renders a humane next step even for a non-Error rejection', async () => {
    // A bare string rejection must still surface the next-step sentence.
    vi.spyOn(credLib.myCredentials, 'list').mockRejectedValue('kaboom');
    render(<KeysTab />);
    expect(
      await screen.findByText(/check it's correct and try again/i),
    ).toBeInTheDocument();
  });

  it('does not leak a raw kind:value string for an unknown credential ref', async () => {
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([
      { scope: 'user', ownerId: 'u1', ref: 'provider:anthropic', kind: 'api-key', createdAt: '2026-05-20T00:00:00Z' },
    ]);
    vi.spyOn(connLib, 'getAccountUsage').mockResolvedValue({});
    render(<KeysTab />);
    // A friendly label is shown for the unknown ref.
    expect(await screen.findByText(/model provider/i)).toBeInTheDocument();
    // The raw "provider:anthropic" string never reaches the user.
    expect(screen.queryByText('provider:anthropic')).not.toBeInTheDocument();
    expect(screen.queryByText(/used by: provider:anthropic/)).not.toBeInTheDocument();
  });

  it('falls back to a calm label for an unknown ref whose kind collides with a prototype key', async () => {
    // A kind segment equal to a prototype key (e.g. "toString") must NOT resolve
    // to the inherited function — that would crash the row render. It falls back
    // to the calm "Other credential" label.
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([
      { scope: 'user', ownerId: 'u1', ref: 'toString:weird', kind: 'api-key', createdAt: '2026-05-20T00:00:00Z' },
    ]);
    vi.spyOn(connLib, 'getAccountUsage').mockResolvedValue({});
    render(<KeysTab />);
    expect(await screen.findByText(/other credential/i)).toBeInTheDocument();
    expect(screen.queryByText('toString:weird')).not.toBeInTheDocument();
  });

  it('Remove on an account row calls clearDestinationCredential with the account destination', async () => {
    const clear = vi.spyOn(credLib, 'clearDestinationCredential').mockResolvedValue();
    render(<KeysTab />);
    await screen.findByText(/used by: linear/);
    // the first Remove button is the account:linear row.
    fireEvent.click(screen.getAllByRole('button', { name: /^remove$/i })[0]!);
    await waitFor(() =>
      expect(clear).toHaveBeenCalledWith({
        destination: { kind: 'account', service: 'linear' },
        scope: { scope: 'user', ownerId: null },
      }),
    );
  });

  it('Remove on a per-slot row calls clearDestinationCredential with the skill-slot destination', async () => {
    const clear = vi.spyOn(credLib, 'clearDestinationCredential').mockResolvedValue();
    render(<KeysTab />);
    await screen.findByText(/used by: github · GH_TOKEN/);
    // the second Remove button is the skill:github:GH_TOKEN row.
    fireEvent.click(screen.getAllByRole('button', { name: /^remove$/i })[1]!);
    await waitFor(() =>
      expect(clear).toHaveBeenCalledWith({
        destination: { kind: 'skill-slot', skillId: 'github', slot: 'GH_TOKEN' },
        scope: { scope: 'user', ownerId: null },
      }),
    );
  });

  it('shows an empty-state when there are no keys', async () => {
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([]);
    render(<KeysTab />);
    expect(await screen.findByText(/no keys yet/i)).toBeInTheDocument();
  });

  // TASK-124 — per-slot credential refs (`account:<service>:<slot>`, a
  // multi-slot connector). The list must label the row with the slot and the
  // Replace/Remove writes must thread the slot back so they address the SAME
  // row (never collapsing it to `account:<service>`, which would also throw on
  // the server's assertNoColon if the service were the mis-parsed
  // `<service>:<slot>`).
  describe('per-slot account ref (TASK-124)', () => {
    beforeEach(() => {
      vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([
        {
          scope: 'user',
          ownerId: 'u1',
          ref: 'account:github:GITHUB_TOKEN',
          kind: 'api-key',
          createdAt: '2026-06-01T00:00:00Z',
        },
      ]);
      vi.spyOn(connLib, 'getAccountUsage').mockResolvedValue({});
    });

    it('labels the row with `service · SLOT`', async () => {
      render(<KeysTab />);
      expect(await screen.findByText('github · GITHUB_TOKEN')).toBeInTheDocument();
    });

    it('Remove threads the slot into the account destination', async () => {
      const clear = vi.spyOn(credLib, 'clearDestinationCredential').mockResolvedValue();
      render(<KeysTab />);
      await screen.findByText('github · GITHUB_TOKEN');
      fireEvent.click(screen.getAllByRole('button', { name: /^remove$/i })[0]!);
      await waitFor(() =>
        expect(clear).toHaveBeenCalledWith({
          destination: { kind: 'account', service: 'github', slot: 'GITHUB_TOKEN' },
          scope: { scope: 'user', ownerId: null },
        }),
      );
    });
  });
});
