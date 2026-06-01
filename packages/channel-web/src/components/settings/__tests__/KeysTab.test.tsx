import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { KeysTab } from '../KeysTab';
import * as credLib from '../../../lib/credentials';
import * as connLib from '../../../lib/connections';
import * as connectorsLib from '../../../lib/connectors';
import type { Connector } from '../../../lib/connectors';

/** Build a full connector record for the getConnector mock. */
function connector(overrides: Partial<Connector>): Connector {
  return {
    id: 'c1',
    name: 'C1',
    description: '',
    usageNote: '',
    keyMode: 'personal',
    visibility: 'private',
    defaultAttached: false,
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    capabilities: connectorsLib.emptyCapabilities(),
    ...overrides,
  };
}

describe('KeysTab', () => {
  beforeEach(() => {
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([
      { scope: 'user', ownerId: 'u1', ref: 'account:linear', kind: 'api-key', createdAt: '2026-05-20T00:00:00Z' },
      { scope: 'user', ownerId: 'u1', ref: 'skill:github:GH_TOKEN', kind: 'api-key', createdAt: '2026-05-22T00:00:00Z' },
    ]);
    vi.spyOn(connLib, 'getAccountUsage').mockResolvedValue({
      linear: ['linear', 'linear-search'],
    });
    // Default: no connectors → the Service dropdown offers only "Custom…"
    // (defaults to Custom, so the existing free-text flow is unchanged).
    vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([]);
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

  it('Custom… add-a-key calls setDestinationCredential with the account destination', async () => {
    const set = vi.spyOn(credLib, 'setDestinationCredential').mockResolvedValue();
    render(<KeysTab />);
    await screen.findByText(/used by: linear/);
    fireEvent.click(screen.getByRole('button', { name: /^add a key$/i }));
    // Custom… is the default selection → the free-text Service name field is shown.
    fireEvent.change(await screen.findByLabelText(/^service name$/i), {
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
    fireEvent.change(await screen.findByLabelText(/^service name$/i), {
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
    fireEvent.change(await screen.findByLabelText(/^service name$/i), {
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

  // TASK-132 — the "Add a key" Service field is a dropdown of the user's existing
  // connectors + a Custom… free-text fallback. Selecting a connector reveals its
  // declared slots (the TASK-124 derivation): a single-slot connector collapses to
  // one Value; a multi-slot connector shows one labeled field per slot. Each
  // per-slot field is labeled with the slot description + `<MACHINE_NAME> ·
  // <mechanism hint>` mono subtext, truthful per mechanism.
  describe('connector-aware Add-a-key (TASK-132)', () => {
    const SINGLE = connector({
      id: 'notion',
      name: 'Notion',
      keyMode: 'personal',
      capabilities: {
        ...connectorsLib.emptyCapabilities(),
        mcpServers: [
          { name: 'notion', transport: 'http', url: 'https://api.notion.com', allowedHosts: ['api.notion.com'], credentials: [] },
        ],
        credentials: [
          { slot: 'NOTION_TOKEN', kind: 'api-key', description: 'Internal integration token', account: 'notion' },
        ],
      },
    });
    const MULTI = connector({
      id: 'salesforce',
      name: 'Salesforce',
      keyMode: 'personal',
      capabilities: {
        ...connectorsLib.emptyCapabilities(),
        mcpServers: [
          { name: 'sf', transport: 'stdio', command: 'sf-mcp', allowedHosts: [], credentials: [] },
        ],
        credentials: [
          { slot: 'CLIENT_ID', kind: 'api-key', description: 'Consumer key', account: 'salesforce' },
          { slot: 'CLIENT_SECRET', kind: 'api-key', description: 'Consumer secret', account: 'salesforce' },
        ],
      },
    });
    const DIRECT = connector({
      id: 'acme',
      name: 'Acme',
      keyMode: 'personal',
      capabilities: {
        ...connectorsLib.emptyCapabilities(),
        allowedHosts: ['api.acme.test'],
        credentials: [{ slot: 'API_KEY', kind: 'api-key', description: 'API key', account: 'acme' }],
      },
    });

    async function openSheet() {
      render(<KeysTab />);
      await screen.findByText(/used by: linear/);
      fireEvent.click(screen.getByRole('button', { name: /^add a key$/i }));
    }

    /** Pick a service from the Service dropdown (combobox → click option). */
    async function pickService(name: RegExp) {
      fireEvent.click(await screen.findByRole('combobox'));
      fireEvent.click(await screen.findByRole('option', { name }));
    }

    it('lists the user connectors plus a Custom… option in the Service dropdown', async () => {
      vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([
        { id: 'notion', name: 'Notion', description: '', usageNote: '', keyMode: 'personal', visibility: 'private', defaultAttached: false, createdAt: '', updatedAt: '' },
      ]);
      await openSheet();
      fireEvent.click(await screen.findByRole('combobox'));
      expect(await screen.findByRole('option', { name: /^Notion$/ })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /^Custom…$/ })).toBeInTheDocument();
    });

    it('single-slot connector → one Value field; save writes the collapsed account ref', async () => {
      vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([
        { id: 'notion', name: 'Notion', description: '', usageNote: '', keyMode: 'personal', visibility: 'private', defaultAttached: false, createdAt: '', updatedAt: '' },
      ]);
      vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(SINGLE);
      const set = vi.spyOn(credLib, 'setDestinationCredential').mockResolvedValue();
      await openSheet();
      await pickService(/^Notion$/);
      // The friendly label is the slot description; the mono subtext pairs the
      // machine name with the truthful mechanism hint (http MCP → header).
      const field = await screen.findByLabelText(/internal integration token/i);
      expect(screen.getByText('NOTION_TOKEN · header')).toBeInTheDocument();
      fireEvent.change(field, { target: { value: 'ntn_secret' } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
      await waitFor(() =>
        expect(set).toHaveBeenCalledWith({
          // single slot collapses → account:<service>, NO slot.
          destination: { kind: 'account', service: 'notion' },
          slot: { kind: 'api-key' },
          scope: { scope: 'user', ownerId: null },
          payload: 'ntn_secret',
        }),
      );
    });

    it('multi-slot connector → one labeled field per slot; each save threads its slotTag', async () => {
      vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([
        { id: 'salesforce', name: 'Salesforce', description: '', usageNote: '', keyMode: 'personal', visibility: 'private', defaultAttached: false, createdAt: '', updatedAt: '' },
      ]);
      vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(MULTI);
      const set = vi.spyOn(credLib, 'setDestinationCredential').mockResolvedValue();
      await openSheet();
      await pickService(/^Salesforce$/);
      // Two labeled fields, each with the stdio MCP → env var hint.
      const clientId = await screen.findByLabelText(/consumer key/i);
      const clientSecret = screen.getByLabelText(/consumer secret/i);
      expect(screen.getByText('CLIENT_ID · env var')).toBeInTheDocument();
      expect(screen.getByText('CLIENT_SECRET · env var')).toBeInTheDocument();
      fireEvent.change(clientId, { target: { value: 'id_val' } });
      fireEvent.change(clientSecret, { target: { value: 'secret_val' } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
      // Both writes thread the per-slot ref — NEVER collapsing to account:salesforce.
      await waitFor(() =>
        expect(set).toHaveBeenCalledWith({
          destination: { kind: 'account', service: 'salesforce', slot: 'CLIENT_ID' },
          slot: { kind: 'api-key' },
          scope: { scope: 'user', ownerId: null },
          payload: 'id_val',
        }),
      );
      expect(set).toHaveBeenCalledWith({
        destination: { kind: 'account', service: 'salesforce', slot: 'CLIENT_SECRET' },
        slot: { kind: 'api-key' },
        scope: { scope: 'user', ownerId: null },
        payload: 'secret_val',
      });
    });

    it('Direct API connector (no MCP) → request-auth hint', async () => {
      vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([
        { id: 'acme', name: 'Acme', description: '', usageNote: '', keyMode: 'personal', visibility: 'private', defaultAttached: false, createdAt: '', updatedAt: '' },
      ]);
      vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(DIRECT);
      await openSheet();
      await pickService(/^Acme$/);
      await screen.findByLabelText(/^api key$/i);
      expect(screen.getByText('API_KEY · request auth')).toBeInTheDocument();
    });

    it('only writes slots the user filled in (a blank slot is skipped)', async () => {
      vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([
        { id: 'salesforce', name: 'Salesforce', description: '', usageNote: '', keyMode: 'personal', visibility: 'private', defaultAttached: false, createdAt: '', updatedAt: '' },
      ]);
      vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(MULTI);
      const set = vi.spyOn(credLib, 'setDestinationCredential').mockResolvedValue();
      await openSheet();
      await pickService(/^Salesforce$/);
      // Fill only the first slot.
      fireEvent.change(await screen.findByLabelText(/consumer key/i), { target: { value: 'id_val' } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
      await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
      expect(set).toHaveBeenCalledWith({
        destination: { kind: 'account', service: 'salesforce', slot: 'CLIENT_ID' },
        slot: { kind: 'api-key' },
        scope: { scope: 'user', ownerId: null },
        payload: 'id_val',
      });
    });

    it('renders password fields and never the raw secret value', async () => {
      vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([
        { id: 'notion', name: 'Notion', description: '', usageNote: '', keyMode: 'personal', visibility: 'private', defaultAttached: false, createdAt: '', updatedAt: '' },
      ]);
      vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(SINGLE);
      await openSheet();
      await pickService(/^Notion$/);
      const field = await screen.findByLabelText(/internal integration token/i);
      expect(field).toHaveAttribute('type', 'password');
    });

    it('a connector with no credential slots shows a needs-no-key note', async () => {
      const NOKEY = connector({ id: 'open', name: 'Open Service', keyMode: 'personal' });
      vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([
        { id: 'open', name: 'Open Service', description: '', usageNote: '', keyMode: 'personal', visibility: 'private', defaultAttached: false, createdAt: '', updatedAt: '' },
      ]);
      vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(NOKEY);
      await openSheet();
      await pickService(/^Open Service$/);
      expect(await screen.findByText(/needs no key/i)).toBeInTheDocument();
    });

    it('surfaces a humane error when the connector record fails to load', async () => {
      vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([
        { id: 'notion', name: 'Notion', description: '', usageNote: '', keyMode: 'personal', visibility: 'private', defaultAttached: false, createdAt: '', updatedAt: '' },
      ]);
      vi.spyOn(connectorsLib, 'getConnector').mockRejectedValue(new Error('get connector: 500'));
      await openSheet();
      await pickService(/^Notion$/);
      expect(await screen.findByText(/get connector: 500/i)).toBeInTheDocument();
    });
  });
});
