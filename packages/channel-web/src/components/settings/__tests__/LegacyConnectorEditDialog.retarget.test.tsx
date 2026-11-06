import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LegacyConnectorEditDialog } from '../LegacyConnectorEditDialog';
import * as connectorsLib from '@/lib/connectors';
import * as credentialsLib from '@/lib/credentials';
import * as oauthLib from '@/lib/connectors-oauth';
import { HttpError } from '@/lib/http';
import type { ConnectorSummary, Connector, ConnectorKeyMode } from '@/lib/connectors';

/**
 * TASK-887 — an edit that points a connector somewhere new signs everyone out
 * (the server does it inside the PATCH). The legacy editor says so before Save,
 * and on an EDIT it saves the connector first and writes the typed client secret
 * after, so the server's purge can't wipe a secret typed in the same save and a
 * refused PATCH writes nothing.
 */

const WARNING = 'endpoint-change-resets-tools';

function summary(keyMode: ConnectorKeyMode): ConnectorSummary {
  return {
    id: 'sf',
    name: 'Salesforce CLI',
    description: 'Salesforce from the command line.',
    usageNote: '',
    keyMode,
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
  };
}

/** An `sf`-shaped CLI connector: one npm package, one host, one env key. */
function cliConnector(keyMode: ConnectorKeyMode): Connector {
  return {
    ...summary(keyMode),
    capabilities: {
      ...connectorsLib.emptyCapabilities(),
      allowedHosts: ['login.salesforce.com'],
      credentials: [{ slot: 'SF_TOKEN', kind: 'api-key' }],
      packages: { npm: ['@salesforce/cli'], pypi: [] },
    },
  };
}

/** An MCP connector with a top-level oauth slot. */
const URL_SAVED = 'https://mcp.example.com/gdrive';
function oauthConnector(): Connector {
  return {
    ...summary('personal'),
    id: 'gdrive',
    name: 'Google Drive',
    capabilities: {
      ...connectorsLib.emptyCapabilities(),
      mcpServers: [
        { name: 'gdrive', transport: 'http', url: URL_SAVED, allowedHosts: [], credentials: [] },
      ],
      credentials: [{ slot: 'GDRIVE_OAUTH', kind: 'oauth', server: 'gdrive' }],
    },
  };
}

async function openEditor(
  connector: Connector,
  onSaved: () => void = () => {},
  onOpenChange: (open: boolean) => void = () => {},
) {
  vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(connector);
  render(
    <LegacyConnectorEditDialog
      target={connector}
      open
      onOpenChange={onOpenChange}
      onSaved={onSaved}
    />,
  );
  const hosts = await screen.findByLabelText(/allowed hosts/i);
  await waitFor(() =>
    expect(hosts).toHaveValue(connector.capabilities.allowedHosts.join(', ')),
  );
  return { hosts };
}

async function save() {
  const button = screen.getByRole('button', { name: /^save$/i });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

async function typeClientSecret(value: string) {
  fireEvent.click(screen.getByRole('button', { name: /advanced — custom oauth client/i }));
  fireEvent.change(await screen.findByLabelText(/client secret/i), { target: { value } });
}

describe('LegacyConnectorEditDialog — a retarget signs everyone out (TASK-887)', () => {
  beforeEach(() => {
    vi.spyOn(oauthLib, 'discoverOAuthHosts').mockResolvedValue({
      hosts: [],
      auth: 'oauth',
      clientRegistration: { cimd: false, dcr: true },
    });
    vi.spyOn(connectorsLib, 'patchConnector').mockResolvedValue(cliConnector('personal'));
    vi.spyOn(credentialsLib, 'setDestinationCredential').mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('adding a site to a CLI connector says it signs everyone out', async () => {
    const { hosts } = await openEditor(cliConnector('personal'));
    expect(screen.queryByTestId(WARNING)).not.toBeInTheDocument();
    fireEvent.change(hosts, { target: { value: 'login.salesforce.com, test.salesforce.com' } });
    const alert = await screen.findByTestId(WARNING);
    expect(alert).toHaveTextContent('Changing where this connector points signs everyone out of it.');
    expect(alert).toHaveTextContent('Each agent adds its key again from its Connectors tab.');
    expect(alert).not.toHaveTextContent(/clears the shared key/);
    // A CLI connector has no server address, so no tool-permission sentence.
    expect(alert).not.toHaveTextContent(/resets its tool permissions/i);
  });

  it('the workspace variant says the shared key is cleared', async () => {
    const { hosts } = await openEditor(cliConnector('workspace'));
    fireEvent.change(hosts, { target: { value: 'login.salesforce.com, test.salesforce.com' } });
    const alert = await screen.findByTestId(WARNING);
    expect(alert).toHaveTextContent('Changing where this connector points signs everyone out of it.');
    expect(alert).toHaveTextContent('It also clears the shared key, and you can’t enter it again from here yet.');
    expect(alert).not.toHaveTextContent('Each agent adds its key again');
  });

  it('moving an oauth connector says each agent signs in again, and keeps the tool-permissions sentence', async () => {
    await openEditor(oauthConnector());
    const url = screen.getByLabelText(/^url$/i);
    fireEvent.change(url, { target: { value: 'https://mcp.example.com/gdrive-v2' } });
    const alert = await screen.findByTestId(WARNING);
    expect(alert).toHaveTextContent('Changing where this connector points signs everyone out of it.');
    expect(alert).toHaveTextContent('Each agent signs in again from its Connectors tab.');
    expect(alert).toHaveTextContent(/Changing this server’s address resets its tool permissions/);
  });

  it('removing a site or editing the description does not warn', async () => {
    const connector = cliConnector('personal');
    connector.capabilities.allowedHosts = ['login.salesforce.com', 'test.salesforce.com'];
    const { hosts } = await openEditor(connector);
    fireEvent.change(hosts, { target: { value: 'login.salesforce.com' } });
    expect(screen.queryByTestId(WARNING)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'New words.' } });
    expect(screen.queryByTestId(WARNING)).not.toBeInTheDocument();
  });

  it('a 503 connector-sign-out-failed shows its message and stays open', async () => {
    vi.spyOn(connectorsLib, 'patchConnector').mockRejectedValue(
      new Error(connectorsLib.CONNECTOR_SIGN_OUT_FAILED),
    );
    const onSaved = vi.fn();
    const { hosts } = await openEditor(cliConnector('personal'), onSaved);
    fireEvent.change(hosts, { target: { value: 'login.salesforce.com, test.salesforce.com' } });
    await save();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      connectorsLib.CONNECTOR_SIGN_OUT_FAILED_MESSAGE,
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('an edit writes the connector before the client secret', async () => {
    const calls: string[] = [];
    vi.spyOn(connectorsLib, 'patchConnector').mockImplementation(async () => {
      calls.push('patch');
      return oauthConnector();
    });
    vi.spyOn(credentialsLib, 'setDestinationCredential').mockImplementation(async () => {
      calls.push('secret');
    });
    const onSaved = vi.fn();
    await openEditor(oauthConnector(), onSaved);
    await typeClientSecret('typed-secret');
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls).toEqual(['patch', 'secret']);
    // The PATCH names the deterministic ref before the secret exists.
    expect(connectorsLib.patchConnector).toHaveBeenCalledWith(
      'gdrive',
      expect.objectContaining({
        capabilities: expect.objectContaining({
          credentials: [
            expect.objectContaining({
              slot: 'GDRIVE_OAUTH',
              clientSecretRef: 'account:gdrive:OAUTH_CLIENT_SECRET',
            }),
          ],
        }),
      }),
      '/admin/connectors',
    );
    expect(credentialsLib.setDestinationCredential).toHaveBeenCalledWith(
      expect.objectContaining({ payload: 'typed-secret' }),
    );
  });

  it('a refused PATCH writes no client secret', async () => {
    vi.spyOn(connectorsLib, 'patchConnector').mockRejectedValue(
      new Error(connectorsLib.CONNECTOR_SIGN_OUT_FAILED),
    );
    await openEditor(oauthConnector());
    await typeClientSecret('typed-secret');
    await save();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      connectorsLib.CONNECTOR_SIGN_OUT_FAILED_MESSAGE,
    );
    expect(credentialsLib.setDestinationCredential).not.toHaveBeenCalled();
  });

  it('a client-secret write the server rejects (422) shows the reason after the sentence', async () => {
    vi.spyOn(credentialsLib, 'setDestinationCredential').mockRejectedValue(
      new HttpError(
        '/admin/destinations/account/credential',
        422,
        'We could not confirm this key. Check it and try again.',
      ),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onSaved = vi.fn();
    await openEditor(oauthConnector(), onSaved);
    await typeClientSecret('typed-secret');
    await save();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We saved the connector, but couldn’t save the client secret. Try saving again. We could not confirm this key. Check it and try again.',
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('a client-secret write refused with a bare 400 adds no reason (it would say the server was unreachable)', async () => {
    vi.spyOn(credentialsLib, 'setDestinationCredential').mockRejectedValue(
      new HttpError('/admin/destinations/account/credential', 400),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onSaved = vi.fn();
    await openEditor(oauthConnector(), onSaved);
    await typeClientSecret('typed-secret');
    await save();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent?.trim()).toBe(
      'We saved the connector, but couldn’t save the client secret. Try saving again.',
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it.each([500, 503])(
    'a client-secret write the server fell over on (%i) adds no reason that contradicts the sentence',
    async (status) => {
      vi.spyOn(credentialsLib, 'setDestinationCredential').mockRejectedValue(
        new HttpError('/admin/destinations/account/credential', status),
      );
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onSaved = vi.fn();
      await openEditor(oauthConnector(), onSaved);
      await typeClientSecret('typed-secret');
      await save();
      const alert = await screen.findByRole('alert');
      expect(alert.textContent?.trim()).toBe(
        'We saved the connector, but couldn’t save the client secret. Try saving again.',
      );
      expect(onSaved).not.toHaveBeenCalled();
    },
  );

  it('after a partial save, putting the original address back warns again; keeping the new one does not', async () => {
    const SIGNS_OUT = 'Changing where this connector points signs everyone out of it.';
    const MOVED = 'https://mcp.example.com/gdrive-v2';
    // The server answers with the connector it now holds.
    vi.spyOn(connectorsLib, 'patchConnector').mockImplementation(async (_id, body) => ({
      ...oauthConnector(),
      capabilities: body.capabilities!,
    }));
    vi.spyOn(credentialsLib, 'setDestinationCredential').mockRejectedValueOnce(
      new Error('boom'),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onSaved = vi.fn();
    await openEditor(oauthConnector(), onSaved);
    const url = screen.getByLabelText(/^url$/i);
    fireEvent.change(url, { target: { value: MOVED } });
    expect(await screen.findByTestId(WARNING)).toHaveTextContent(SIGNS_OUT);
    await typeClientSecret('typed-secret');
    await save();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We saved the connector, but couldn’t save the client secret. Try saving again.',
    );
    // The server holds the new address now: keeping it points nowhere new and
    // changes no address, so nothing at all is said.
    expect(screen.queryByTestId(WARNING)).not.toBeInTheDocument();
    // Putting the original address back is another move.
    fireEvent.change(url, { target: { value: URL_SAVED } });
    await waitFor(() => expect(screen.getByTestId(WARNING)).toHaveTextContent(SIGNS_OUT));
    // The retry that keeps the new address saves it and writes the secret.
    fireEvent.change(url, { target: { value: MOVED } });
    await waitFor(() => expect(screen.queryByTestId(WARNING)).not.toBeInTheDocument());
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(credentialsLib.setDestinationCredential).toHaveBeenCalledTimes(2);
  });

  it('after a partial save, the tool-permission sentence is judged against the saved address too', async () => {
    const TOOLS_RESET = /Changing this server’s address resets its tool permissions/;
    const MOVED = 'https://mcp.example.com/gdrive-v2';
    vi.spyOn(connectorsLib, 'patchConnector').mockImplementation(async (_id, body) => ({
      ...oauthConnector(),
      capabilities: body.capabilities!,
    }));
    vi.spyOn(credentialsLib, 'setDestinationCredential').mockRejectedValueOnce(
      new Error('boom'),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await openEditor(oauthConnector());
    const url = screen.getByLabelText(/^url$/i);
    fireEvent.change(url, { target: { value: MOVED } });
    expect(await screen.findByTestId(WARNING)).toHaveTextContent(TOOLS_RESET);
    await typeClientSecret('typed-secret');
    await save();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We saved the connector, but couldn’t save the client secret. Try saving again.',
    );
    // The server holds the new address: keeping it resets nothing.
    await waitFor(() =>
      expect(screen.queryByTestId(WARNING)?.textContent ?? '').not.toMatch(TOOLS_RESET),
    );
    // Putting the original address back is a new address again.
    fireEvent.change(url, { target: { value: URL_SAVED } });
    await waitFor(() => expect(screen.getByTestId(WARNING)).toHaveTextContent(TOOLS_RESET));
  });

  it('closing after a partial save refreshes the list (the connector did change)', async () => {
    vi.spyOn(credentialsLib, 'setDestinationCredential').mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    await openEditor(oauthConnector(), onSaved, onOpenChange);
    await typeClientSecret('typed-secret');
    await save();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We saved the connector, but couldn’t save the client secret. Try saving again.',
    );
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closing without saving does not refresh the list', async () => {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    await openEditor(oauthConnector(), onSaved, onOpenChange);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('a client-secret write that fails after the PATCH says so and stays open', async () => {
    vi.spyOn(credentialsLib, 'setDestinationCredential').mockRejectedValue(new Error('boom'));
    const onSaved = vi.fn();
    await openEditor(oauthConnector(), onSaved);
    await typeClientSecret('typed-secret');
    await save();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We saved the connector, but couldn’t save the client secret. Try saving again.',
    );
    expect(connectorsLib.patchConnector).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
