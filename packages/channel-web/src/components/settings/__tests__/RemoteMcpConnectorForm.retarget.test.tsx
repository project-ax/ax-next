import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  pointsSomewhereNew as serverPointsSomewhereNew,
  type RetargetSubject,
} from '@ax/connectors';
import { ConnectorEditDialog } from '../ConnectorEditDialog';
import {
  CONNECTOR_SIGN_OUT_FAILED,
  CONNECTOR_SIGN_OUT_FAILED_MESSAGE,
  OWNER_ONLY_CHANGE,
  OWNER_ONLY_CHANGE_MESSAGE,
  type Connector,
} from '@/lib/connectors';

/**
 * TASK-887 — saving a connector so it points somewhere new (a new address, a
 * new or re-pointed key) signs everyone out of it. The server does that inside
 * the save: `connectors:upsert` clears every agent's sign-ins, the shared key
 * and the client secret before the edit lands. So the remote-server editor:
 *   - says so before Save, beside TASK-755's tool-permission sentence;
 *   - asks for a saved shared key and a saved client secret again (Remove
 *     lifts the secret's);
 *   - on an edit, writes the connector FIRST and its secrets after. Written
 *     before, a key typed in this very save would be wiped by the server, and
 *     a refused save would still have replaced the live key.
 * A save that points nowhere new, including one that only adds the sign-in
 * hosts discovery found, says nothing and asks for nothing.
 *
 * In its own file so sibling cards' edits to RemoteMcpConnectorForm.test.tsx
 * stay apart (the TASK-758 precedent).
 */

const OWN_SECRET_REF = 'account:linear:OAUTH_CLIENT_SECRET';
const SHARED_KEY_REF = 'account:crm:HEADER_1';
const SIGNS_OUT = 'Changing where this connector points signs everyone out of it.';
const TOOLS_RESET = 'Changing the address resets this server’s tool permissions.';

const server = (name: string, url: string) => ({
  name,
  transport: 'http' as const,
  url,
  allowedHosts: [],
  credentials: [],
});
const connectorBase = {
  description: '',
  usageNote: '',
  createdAt: '',
  updatedAt: '',
};
/** Each agent signs in with OAuth; AX sets itself up with the server. */
const oauthConnector = (): Connector => ({
  ...connectorBase,
  id: 'linear',
  name: 'Linear',
  keyMode: 'personal',
  capabilities: {
    allowedHosts: ['mcp.linear.app'],
    credentials: [{ kind: 'oauth', slot: 'MCP_OAUTH', server: 'linear' }],
    mcpServers: [server('linear', 'https://mcp.linear.app/mcp')],
    packages: { npm: [], pypi: [] },
    services: [],
  },
});
/** The same, on the OAuth client its admin registered, whose secret is saved. */
const ownClientConnector = (): Connector => {
  const connector = oauthConnector();
  connector.capabilities.credentials = [
    {
      kind: 'oauth',
      slot: 'MCP_OAUTH',
      server: 'linear',
      clientId: 'cid',
      clientSecretRef: OWN_SECRET_REF,
    },
  ];
  return connector;
};
/** One shared key for everyone, sent in a request header. */
const sharedKeyConnector = (): Connector => ({
  ...connectorBase,
  id: 'crm',
  name: 'CRM',
  keyMode: 'workspace',
  capabilities: {
    allowedHosts: ['mcp.crm.example'],
    credentials: [
      { kind: 'api-key', slot: 'HEADER_1', server: 'crm', headerName: 'X-Api-Key' },
    ],
    mcpServers: [server('crm', 'https://mcp.crm.example/mcp')],
    packages: { npm: [], pypi: [] },
    services: [],
  },
});
/** Each agent adds its own key, sent in a request header. */
const perAgentKeyConnector = (): Connector => ({
  ...sharedKeyConnector(),
  id: 'docs',
  name: 'Docs',
  keyMode: 'personal',
  capabilities: {
    ...sharedKeyConnector().capabilities,
    allowedHosts: ['mcp.docs.example'],
    credentials: [
      { kind: 'api-key', slot: 'HEADER_1', server: 'docs', headerName: 'X-Api-Key' },
    ],
    mcpServers: [server('docs', 'https://mcp.docs.example/mcp')],
  },
});

const OAUTH_SERVER = {
  hosts: [],
  auth: 'oauth',
  clientRegistration: { cimd: true, dcr: true },
};
/** A server that asks for a key but offers no OAuth. */
const KEY_SERVER = { hosts: [], auth: 'other' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

// ---------------------------------------------------------------------------
// A small stand-in for the server: one connector row and the workspace's
// stored secrets. Like `connectors:upsert` (TASK-887), a PATCH that points the
// connector somewhere new clears the connector's stored secrets BEFORE the row
// changes, decided by the server's own rule. So these tests check what the
// editor's order leaves in the vault, not only the order of its requests.
// ---------------------------------------------------------------------------
let row: Connector;
/** ref → payloadB64, the workspace's (global) secrets. */
let vault: Map<string, string>;
let signOuts: number;
/** Every state-changing request, in the order it was sent. */
let calls: string[];
let writes: { url: string; body: Record<string, unknown> }[];
let discover: (url: string) => Record<string, unknown>;
let refusePatch: (() => Response) | null;
/** How many credential writes fail (500) before they start to succeed. */
let failingCredentialWrites: number;
/** The status those failing credential writes answer with. */
let failingCredentialStatus: number;
/** What the connector's tool list answers, for the address it was loaded at. */
let toolInventory: Record<string, unknown>;

const subject = (c: Connector) =>
  ({ id: c.id, keyMode: c.keyMode, capabilities: c.capabilities }) as unknown as RetargetSubject;

beforeEach(() => {
  vault = new Map();
  signOuts = 0;
  calls = [];
  writes = [];
  discover = () => OAUTH_SERVER;
  refusePatch = null;
  failingCredentialWrites = 0;
  failingCredentialStatus = 500;
  toolInventory = { status: 'ok', checkedAt: null, tools: [], defaults: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (input.endsWith('/client-metadata'))
        return json({
          client_id: 'https://ax.example.com/api/connectors/oauth/client-metadata',
          redirect_uris: ['https://ax.example.com/api/connectors/oauth/callback'],
        });
      if (input.endsWith('/discover-hosts'))
        return json(discover((JSON.parse(String(init?.body)) as { url: string }).url));
      if (input.includes('/tool-permissions')) {
        if (method === 'GET') return json(toolInventory);
        calls.push(`${method} ${input}`);
        writes.push({ url: input, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return json({ ok: true });
      }
      if (input === '/admin/credentials')
        return json({
          credentials: [...vault.keys()].map((ref) => ({
            scope: 'global',
            ownerId: null,
            ref,
            kind: 'api-key',
            createdAt: '',
          })),
        });
      if (method === 'GET') return json({ connector: row });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(`${method} ${input}`);
      writes.push({ url: input, body });
      if (input === '/admin/destinations/account/credential') {
        if (failingCredentialWrites > 0) {
          failingCredentialWrites--;
          return new Response('{}', { status: failingCredentialStatus });
        }
        const destination = body.destination as { service: string; slot: string };
        if (body.scope === 'global')
          vault.set(`account:${destination.service}:${destination.slot}`, String(body.payloadB64));
        return json({ ok: true });
      }
      // PATCH /admin/connectors/:id
      if (refusePatch) return refusePatch();
      const next: Connector = {
        ...row,
        name: String(body.name),
        keyMode: body.keyMode as Connector['keyMode'],
        capabilities: body.capabilities as Connector['capabilities'],
      };
      if (serverPointsSomewhereNew(subject(row), subject(next))) {
        signOuts++;
        for (const ref of [...vault.keys()])
          if (ref === `account:${row.id}` || ref.startsWith(`account:${row.id}:`))
            vault.delete(ref);
      }
      row = next;
      return json({ connector: row });
    }),
  );
});

async function openEditor(connector: Connector, stored: Record<string, string> = {}) {
  row = connector;
  for (const [ref, value] of Object.entries(stored)) vault.set(ref, btoa(value));
  const options = {
    target: connector,
    open: true,
    onOpenChange: vi.fn(),
    onSaved: vi.fn(),
  };
  render(<ConnectorEditDialog {...options} />);
  await screen.findByLabelText('Name');
  await saveIsLive();
  return options;
}
const saveButton = () => screen.getByRole('button', { name: 'Save changes' });
/** Discovery has answered for the URL on screen (it waits 500 ms after the
 *  last keystroke), so Save is live. Generous: the machine may be busy. */
const saveIsLive = () =>
  waitFor(() => expect(saveButton()).toBeEnabled(), { timeout: 5000 });
async function moveTo(url: string) {
  fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: url } });
  await saveIsLive();
}
const note = () => screen.queryByTestId('address-change-resets-tools');

describe('RemoteMcpConnectorForm — pointing a connector somewhere new signs everyone out (TASK-887)', () => {
  it('moving an OAuth connector says it signs everyone out and each agent signs in again', async () => {
    await openEditor(oauthConnector());
    expect(note()).toBeNull();
    await moveTo('https://elsewhere.example/mcp');
    const alert = note()!;
    // Advice beside a field being typed in (TASK-790), not an interruption.
    expect(alert).toHaveAttribute('role', 'note');
    expect(alert).toHaveTextContent(
      `${SIGNS_OUT} Each agent signs in again from its Connectors tab.`,
    );
    // TASK-755's sentence still stands beside it.
    expect(alert).toHaveTextContent(TOOLS_RESET);
    // It sets itself up, so there is nothing of its own to type again.
    expect(alert).not.toHaveTextContent(/client secret|shared key|adds its key/);
  });

  it('moving a per-agent-key connector says each agent adds its key again, and asks nothing more', async () => {
    discover = () => KEY_SERVER;
    const options = await openEditor(perAgentKeyConnector());
    await moveTo('https://mcp.other-docs.example/mcp');
    expect(note()).toHaveTextContent(
      `${SIGNS_OUT} Each agent adds its key again from its Connectors tab.`,
    );
    // No "Send saved headers to …" check any more: the save signs everyone
    // out, so nothing saved is sent anywhere new.
    expect(screen.queryByText(/Send saved headers to/)).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(calls).toEqual(['PATCH /admin/connectors/docs']);
    expect(signOuts).toBe(1);
  });

  it('moving a shared-key connector asks for its saved header value again', async () => {
    // A server that says nothing about sign-in: the header section starts closed.
    discover = () => ({ hosts: [], auth: 'none' });
    await openEditor(sharedKeyConnector(), { [SHARED_KEY_REF]: 'old-shared-key' });
    expect(screen.queryByLabelText('Value')).toBeNull();
    await moveTo('https://mcp.other-crm.example/mcp');
    expect(note()).toHaveTextContent(
      `${SIGNS_OUT} It also clears the shared key, so enter it again below.`,
    );
    // The section opens on an empty box: the save clears the saved value, so
    // it isn't "Saved securely" any more.
    const value = screen.getByLabelText('Value');
    expect(value).toHaveValue('');
    expect(screen.queryByText('Saved securely')).toBeNull();
    fireEvent.click(saveButton());
    expect(
      await screen.findByText(
        'Enter this value again. Changing where this connector points clears it.',
      ),
    ).toBeVisible();
    expect(value).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(value).toHaveFocus());
    expect(calls).toEqual([]);
    expect(vault.get(SHARED_KEY_REF)).toBe(btoa('old-shared-key'));
  });

  it('a retarget save writes the connector first, then the re-entered key', async () => {
    discover = () => KEY_SERVER;
    const options = await openEditor(sharedKeyConnector(), {
      [SHARED_KEY_REF]: 'old-shared-key',
    });
    await moveTo('https://mcp.other-crm.example/mcp');
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: 'new-shared-key' },
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(calls).toEqual([
      'PATCH /admin/connectors/crm',
      'POST /admin/destinations/account/credential',
    ]);
    expect(JSON.stringify(writes[0]!.body)).not.toContain('new-shared-key');
    expect(writes[1]!.body).toMatchObject({
      scope: 'global',
      ownerId: null,
      destination: { kind: 'account', service: 'crm', slot: 'HEADER_1' },
      payloadB64: btoa('new-shared-key'),
    });
    // The move signed everyone out once, and the key typed in it survived that.
    expect(signOuts).toBe(1);
    expect(vault.get(SHARED_KEY_REF)).toBe(btoa('new-shared-key'));
  });

  it('a retarget save writes the connector first, then the re-entered client secret', async () => {
    const options = await openEditor(ownClientConnector(), {
      [OWN_SECRET_REF]: 'old-client-secret',
    });
    expect(screen.getByText('Saved securely')).toBeVisible();
    await moveTo('https://elsewhere.example/mcp');
    expect(note()).toHaveTextContent(
      `${SIGNS_OUT} Each agent signs in again from its Connectors tab. It also clears the client secret, so enter it again below.`,
    );
    expect(screen.queryByText('Saved securely')).toBeNull();
    fireEvent.change(screen.getByLabelText(/Client secret/), {
      target: { value: 'new-client-secret' },
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(calls).toEqual([
      'PATCH /admin/connectors/linear',
      'POST /admin/destinations/account/credential',
    ]);
    // The connector names where the secret is stored before it is written:
    // that ref is fixed.
    expect(writes[0]!.body.capabilities).toMatchObject({
      credentials: [{ kind: 'oauth', clientId: 'cid', clientSecretRef: OWN_SECRET_REF }],
    });
    expect(JSON.stringify(writes[0]!.body)).not.toContain('new-client-secret');
    expect(writes[1]!.body).toMatchObject({
      scope: 'global',
      ownerId: null,
      destination: { kind: 'account', service: 'linear', slot: 'OAUTH_CLIENT_SECRET' },
      payloadB64: btoa('new-client-secret'),
    });
    expect(signOuts).toBe(1);
    expect(vault.get(OWN_SECRET_REF)).toBe(btoa('new-client-secret'));
  });

  it('the client secret is not called optional once the save needs it again', async () => {
    await openEditor(ownClientConnector(), { [OWN_SECRET_REF]: 'old-client-secret' });
    // Before the move: optional, as for any client.
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(screen.getByText('(optional)')).toBeVisible();
    expect(screen.getByLabelText(/Client secret/)).toHaveAttribute(
      'placeholder',
      'Enter only if the service requires it',
    );
    await moveTo('https://elsewhere.example/mcp');
    // After: the save clears it and asks for it again, so it is required.
    expect(screen.queryByText('(optional)')).toBeNull();
    expect(screen.getByLabelText(/Client secret/)).toHaveAttribute(
      'placeholder',
      'Enter the client secret',
    );
    // Remove lifts the requirement, so the box is optional again.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('(optional)')).toBeVisible();
  });

  it('Remove lifts the client-secret requirement on a retarget', async () => {
    const options = await openEditor(ownClientConnector(), {
      [OWN_SECRET_REF]: 'old-client-secret',
    });
    await moveTo('https://elsewhere.example/mcp');
    fireEvent.click(saveButton());
    expect(
      await screen.findByText(
        'Enter the client secret again, or remove it. Changing where this connector points clears it.',
      ),
    ).toBeVisible();
    const box = screen.getByLabelText(/Client secret/);
    expect(box).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(box).toHaveFocus());
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByText(/Enter the client secret again/)).toBeNull();
    expect(note()).toHaveTextContent(SIGNS_OUT);
    expect(note()).not.toHaveTextContent('client secret');
    fireEvent.click(saveButton());
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(calls).toEqual(['PATCH /admin/connectors/linear']);
    const [slot] = (writes[0]!.body.capabilities as { credentials: Record<string, unknown>[] })
      .credentials;
    expect(slot).toMatchObject({ kind: 'oauth', clientId: 'cid' });
    expect(slot).not.toHaveProperty('clientSecretRef');
    expect(vault.has(OWN_SECRET_REF)).toBe(false);
  });

  it('a refused PATCH (503 connector-sign-out-failed) shows its message and writes no secret', async () => {
    refusePatch = () => json({ error: CONNECTOR_SIGN_OUT_FAILED }, 503);
    const options = await openEditor(ownClientConnector(), {
      [OWN_SECRET_REF]: 'old-client-secret',
    });
    await moveTo('https://elsewhere.example/mcp');
    fireEvent.change(screen.getByLabelText(/Client secret/), {
      target: { value: 'new-client-secret' },
    });
    fireEvent.click(saveButton());
    expect(await screen.findByText(CONNECTOR_SIGN_OUT_FAILED_MESSAGE)).toBeVisible();
    expect(calls).toEqual(['PATCH /admin/connectors/linear']);
    expect(vault.get(OWN_SECRET_REF)).toBe(btoa('old-client-secret'));
    expect(options.onSaved).not.toHaveBeenCalled();
    expect(options.onOpenChange).not.toHaveBeenCalledWith(false);
    // What was typed is still there for the next try.
    expect(screen.getByLabelText(/Client secret/)).toHaveValue('new-client-secret');
  });

  // Every edit writes the connector first, not only the ones the editor's copy
  // of the rule calls a move, so a refused save never replaces the live key.
  it('a refused PATCH leaves the live shared key alone, even with no move (403 owner-only-change)', async () => {
    discover = () => KEY_SERVER;
    refusePatch = () => json({ error: OWNER_ONLY_CHANGE }, 403);
    await openEditor(sharedKeyConnector(), { [SHARED_KEY_REF]: 'old-shared-key' });
    fireEvent.click(screen.getByRole('button', { name: /Saved securely/ }));
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: 'new-shared-key' },
    });
    expect(note()).toBeNull();
    fireEvent.click(saveButton());
    expect(await screen.findByText(OWNER_ONLY_CHANGE_MESSAGE)).toBeVisible();
    expect(calls).toEqual(['PATCH /admin/connectors/crm']);
    expect(vault.get(SHARED_KEY_REF)).toBe(btoa('old-shared-key'));
  });

  it('partial save: a key write that fails after the PATCH says so, stays open, and Save writes it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    discover = () => KEY_SERVER;
    failingCredentialWrites = 1;
    const options = await openEditor(sharedKeyConnector(), {
      [SHARED_KEY_REF]: 'old-shared-key',
    });
    await moveTo('https://mcp.other-crm.example/mcp');
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: 'new-shared-key' },
    });
    fireEvent.click(saveButton());
    expect(
      await screen.findByText(
        'We saved the connector, but couldn’t save the key. Try saving again.',
      ),
    ).toBeVisible();
    expect(calls).toEqual([
      'PATCH /admin/connectors/crm',
      'POST /admin/destinations/account/credential',
    ]);
    expect(options.onSaved).not.toHaveBeenCalled();
    expect(options.onOpenChange).not.toHaveBeenCalledWith(false);
    // The connector moved and its old key is gone; the one typed is kept.
    expect(vault.has(SHARED_KEY_REF)).toBe(false);
    expect(screen.getByLabelText('Value')).toHaveValue('new-shared-key');
    await saveIsLive();
    fireEvent.click(saveButton());
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(calls).toEqual([
      'PATCH /admin/connectors/crm',
      'POST /admin/destinations/account/credential',
      'PATCH /admin/connectors/crm',
      'POST /admin/destinations/account/credential',
    ]);
    // The retry sends the same connector, which the server already has, so it
    // signs nobody out again: the one sign-out was the move's.
    expect(writes[2]!.body).toEqual(writes[0]!.body);
    expect(signOuts).toBe(1);
    expect(vault.get(SHARED_KEY_REF)).toBe(btoa('new-shared-key'));
  });

  it('partial save: a 503 from the key store adds no reason that contradicts the sentence', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    discover = () => KEY_SERVER;
    failingCredentialWrites = 1;
    failingCredentialStatus = 503;
    await openEditor(sharedKeyConnector(), { [SHARED_KEY_REF]: 'old-shared-key' });
    await moveTo('https://mcp.other-crm.example/mcp');
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: 'new-shared-key' },
    });
    fireEvent.click(saveButton());
    expect(
      await screen.findByText(
        'We saved the connector, but couldn’t save the key. Try saving again.',
      ),
    ).toBeVisible();
  });

  it('partial save: a 400 with no words of its own adds no reason (it would say the server was unreachable)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    discover = () => KEY_SERVER;
    failingCredentialWrites = 1;
    failingCredentialStatus = 400;
    await openEditor(sharedKeyConnector(), { [SHARED_KEY_REF]: 'old-shared-key' });
    await moveTo('https://mcp.other-crm.example/mcp');
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: 'new-shared-key' },
    });
    fireEvent.click(saveButton());
    expect(
      await screen.findByText(
        'We saved the connector, but couldn’t save the key. Try saving again.',
      ),
    ).toBeVisible();
  });

  it('partial save: a rejected key (422) shows the reason after the saved-the-connector sentence', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    discover = () => KEY_SERVER;
    failingCredentialWrites = 1;
    failingCredentialStatus = 422;
    const options = await openEditor(sharedKeyConnector(), {
      [SHARED_KEY_REF]: 'old-shared-key',
    });
    await moveTo('https://mcp.other-crm.example/mcp');
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: 'new-shared-key' },
    });
    fireEvent.click(saveButton());
    expect(
      await screen.findByText(
        'We saved the connector, but couldn’t save the key. Try saving again. We could not confirm this key. Check it and try again.',
      ),
    ).toBeVisible();
    expect(options.onSaved).not.toHaveBeenCalled();
  });

  it('partial save: a rejected client secret (422) shows the reason after the saved-the-connector sentence', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    failingCredentialWrites = 1;
    failingCredentialStatus = 422;
    const options = await openEditor(ownClientConnector(), {
      [OWN_SECRET_REF]: 'old-client-secret',
    });
    await moveTo('https://elsewhere.example/mcp');
    fireEvent.change(screen.getByLabelText(/Client secret/), {
      target: { value: 'new-client-secret' },
    });
    fireEvent.click(saveButton());
    expect(
      await screen.findByText(
        'We saved the connector, but couldn’t save the client secret. Try saving again. We could not confirm this key. Check it and try again.',
      ),
    ).toBeVisible();
    expect(options.onSaved).not.toHaveBeenCalled();
  });

  it('partial save: a client secret write that fails after the PATCH says so, and Save writes it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    failingCredentialWrites = 1;
    const options = await openEditor(ownClientConnector(), {
      [OWN_SECRET_REF]: 'old-client-secret',
    });
    await moveTo('https://elsewhere.example/mcp');
    fireEvent.change(screen.getByLabelText(/Client secret/), {
      target: { value: 'new-client-secret' },
    });
    fireEvent.click(saveButton());
    expect(
      await screen.findByText(
        'We saved the connector, but couldn’t save the client secret. Try saving again.',
      ),
    ).toBeVisible();
    expect(options.onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Client secret/)).toHaveValue('new-client-secret');
    await saveIsLive();
    fireEvent.click(saveButton());
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(calls).toEqual([
      'PATCH /admin/connectors/linear',
      'POST /admin/destinations/account/credential',
      'PATCH /admin/connectors/linear',
      'POST /admin/destinations/account/credential',
    ]);
    expect(writes[2]!.body).toEqual(writes[0]!.body);
    expect(signOuts).toBe(1);
    expect(vault.get(OWN_SECRET_REF)).toBe(btoa('new-client-secret'));
  });

  // After a save whose PATCH landed, the connector the server holds is the one
  // to compare against, not the one that was loaded: otherwise putting the
  // original address back says nothing while the server signs everyone out again.
  describe('after a partial save, the saved connector is what the next save is compared with', () => {
    it('a shared key: putting the original address back warns again; keeping the new one does not', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      discover = () => KEY_SERVER;
      failingCredentialWrites = 1;
      const options = await openEditor(sharedKeyConnector(), {
        [SHARED_KEY_REF]: 'old-shared-key',
      });
      await moveTo('https://mcp.other-crm.example/mcp');
      fireEvent.change(screen.getByLabelText('Value'), {
        target: { value: 'new-shared-key' },
      });
      fireEvent.click(saveButton());
      expect(
        await screen.findByText(
          'We saved the connector, but couldn’t save the key. Try saving again.',
        ),
      ).toBeVisible();
      expect(signOuts).toBe(1);
      // The server holds the new address now: keeping it points nowhere new.
      await saveIsLive();
      // Nor does it change the address, so nothing at all is said.
      expect(note()).toBeNull();
      // Putting the original address back is another move, and warns.
      await moveTo('https://mcp.crm.example/mcp');
      expect(note()).toHaveTextContent(SIGNS_OUT);
      expect(note()).toHaveTextContent('It also clears the shared key, so enter it again below.');
      // The key typed earlier stays in view, so Save writes what is shown.
      expect(screen.getByLabelText('Value')).toHaveValue('new-shared-key');
      fireEvent.click(saveButton());
      await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
      expect(signOuts).toBe(2);
      expect(vault.get(SHARED_KEY_REF)).toBe(btoa('new-shared-key'));
    });

    it('a client secret: putting the original address back asks for it again; keeping the new one does not', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      failingCredentialWrites = 1;
      await openEditor(ownClientConnector(), { [OWN_SECRET_REF]: 'old-client-secret' });
      await moveTo('https://elsewhere.example/mcp');
      fireEvent.change(screen.getByLabelText(/Client secret/), {
        target: { value: 'new-client-secret' },
      });
      fireEvent.click(saveButton());
      expect(
        await screen.findByText(
          'We saved the connector, but couldn’t save the client secret. Try saving again.',
        ),
      ).toBeVisible();
      expect(signOuts).toBe(1);
      await saveIsLive();
      // Nor does it change the address, so nothing at all is said.
      expect(note()).toBeNull();
      // That save's PATCH already cleared the saved secret, so it's still asked
      // for, not optional.
      expect(screen.queryByText('(optional)')).toBeNull();
      await moveTo('https://mcp.linear.app/mcp');
      expect(note()).toHaveTextContent(SIGNS_OUT);
      expect(note()).toHaveTextContent('It also clears the client secret, so enter it again below.');
      expect(screen.queryByText('(optional)')).toBeNull();
      // Emptied, it is asked for again rather than saved without.
      fireEvent.change(screen.getByLabelText(/Client secret/), { target: { value: '' } });
      const patches = () => calls.filter((c) => c.startsWith('PATCH')).length;
      const before = patches();
      fireEvent.click(saveButton());
      expect(
        await screen.findByText(
          'Enter the client secret again, or remove it. Changing where this connector points clears it.',
        ),
      ).toBeVisible();
      expect(patches()).toBe(before);
    });
  });

  it('after a partial save, the tool-permission sentence is judged against the saved address too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    discover = () => KEY_SERVER;
    failingCredentialWrites = 1;
    await openEditor(sharedKeyConnector(), { [SHARED_KEY_REF]: 'old-shared-key' });
    await moveTo('https://mcp.other-crm.example/mcp');
    expect(note()).toHaveTextContent(TOOLS_RESET);
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: 'new-shared-key' },
    });
    fireEvent.click(saveButton());
    expect(
      await screen.findByText(
        'We saved the connector, but couldn’t save the key. Try saving again.',
      ),
    ).toBeVisible();
    await saveIsLive();
    // The server holds the new address: keeping it resets nothing.
    expect(note()?.textContent ?? '').not.toContain(TOOLS_RESET);
    // Putting the original address back is a new address again.
    await moveTo('https://mcp.crm.example/mcp');
    expect(note()).toHaveTextContent(TOOLS_RESET);
  });

  // TASK-755/758 — the tool list loaded at open is the OLD address's. Once a
  // save's PATCH has moved the connector, a retry that keeps the new address
  // must neither show that list as the new address's nor write it there.
  it('after a partial save that moved the connector, the old address’s tool list is neither shown nor written', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    discover = () => KEY_SERVER;
    failingCredentialWrites = 1;
    // A read-only tool with no saved default: Save would write its suggestion.
    toolInventory = {
      status: 'ok',
      checkedAt: null,
      tools: [
        {
          toolKey: 'mcp.crm.list_records',
          name: 'list_records',
          title: 'List records',
          description: '',
          readOnly: true,
          outward: false,
        },
      ],
      defaults: [],
    };
    const options = await openEditor(sharedKeyConnector(), {
      [SHARED_KEY_REF]: 'old-shared-key',
    });
    const toolRow = () => screen.queryByRole('group', { name: 'Permission for List records' });
    await waitFor(() => expect(toolRow()).not.toBeNull());
    await moveTo('https://mcp.other-crm.example/mcp');
    expect(toolRow()).toBeNull();
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: 'new-shared-key' },
    });
    fireEvent.click(saveButton());
    expect(
      await screen.findByText(
        'We saved the connector, but couldn’t save the key. Try saving again.',
      ),
    ).toBeVisible();
    await saveIsLive();
    // The list on hand is the old address's, so it isn't offered as the new one's.
    expect(toolRow()).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(calls).toEqual([
      'PATCH /admin/connectors/crm',
      'POST /admin/destinations/account/credential',
      'PATCH /admin/connectors/crm',
      'POST /admin/destinations/account/credential',
    ]);
    expect(calls.some((c) => c.includes('/tool-permissions'))).toBe(false);
  });

  it('closing after a partial save refreshes the list (the connector did change)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    discover = () => KEY_SERVER;
    failingCredentialWrites = 1;
    const options = await openEditor(sharedKeyConnector(), {
      [SHARED_KEY_REF]: 'old-shared-key',
    });
    await moveTo('https://mcp.other-crm.example/mcp');
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: 'new-shared-key' },
    });
    fireEvent.click(saveButton());
    expect(
      await screen.findByText(
        'We saved the connector, but couldn’t save the key. Try saving again.',
      ),
    ).toBeVisible();
    expect(options.onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(options.onSaved).toHaveBeenCalledTimes(1);
    expect(options.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closing without saving does not refresh the list', async () => {
    const options = await openEditor(oauthConnector());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(options.onOpenChange).toHaveBeenCalledWith(false);
    expect(options.onSaved).not.toHaveBeenCalled();
  });

  // A partial save's PATCH landed and cleared the saved key or secret, so a
  // retry that keeps the new address still has to write it: the vault no
  // longer holds one, whatever the next save's own comparison says.
  describe('after a partial save, what that PATCH cleared is still asked for', () => {
    it('a shared key: emptying the box is refused, not shown as "Saved securely"', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      discover = () => KEY_SERVER;
      failingCredentialWrites = 1;
      const options = await openEditor(sharedKeyConnector(), {
        [SHARED_KEY_REF]: 'old-shared-key',
      });
      await moveTo('https://mcp.other-crm.example/mcp');
      fireEvent.change(screen.getByLabelText('Value'), {
        target: { value: 'new-shared-key' },
      });
      fireEvent.click(saveButton());
      expect(
        await screen.findByText(
          'We saved the connector, but couldn’t save the key. Try saving again.',
        ),
      ).toBeVisible();
      expect(vault.has(SHARED_KEY_REF)).toBe(false);
      await saveIsLive();
      fireEvent.change(screen.getByLabelText('Value'), { target: { value: '' } });
      expect(screen.queryByText('Saved securely')).toBeNull();
      const before = calls.length;
      fireEvent.click(saveButton());
      expect(
        await screen.findByText(
          'Enter this value again. Changing where this connector points clears it.',
        ),
      ).toBeVisible();
      expect(calls.length).toBe(before);
      expect(options.onSaved).not.toHaveBeenCalled();
    });

    it('a client secret: emptying the box is refused, not shown as "Saved securely"', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      failingCredentialWrites = 1;
      const options = await openEditor(ownClientConnector(), {
        [OWN_SECRET_REF]: 'old-client-secret',
      });
      await moveTo('https://elsewhere.example/mcp');
      fireEvent.change(screen.getByLabelText(/Client secret/), {
        target: { value: 'new-client-secret' },
      });
      fireEvent.click(saveButton());
      expect(
        await screen.findByText(
          'We saved the connector, but couldn’t save the client secret. Try saving again.',
        ),
      ).toBeVisible();
      expect(vault.has(OWN_SECRET_REF)).toBe(false);
      await saveIsLive();
      fireEvent.change(screen.getByLabelText(/Client secret/), { target: { value: '' } });
      expect(screen.queryByText('Saved securely')).toBeNull();
      const before = calls.length;
      fireEvent.click(saveButton());
      expect(
        await screen.findByText(
          'Enter the client secret again, or remove it. Changing where this connector points clears it.',
        ),
      ).toBeVisible();
      expect(calls.length).toBe(before);
      expect(options.onSaved).not.toHaveBeenCalled();
    });

    // Not a move at all: a first-time secret. The PATCH names where it will be
    // stored, so once that lands and the write fails, the connector names a
    // secret the vault doesn't have, and it's asked for like a cleared one.
    it('a first client secret the PATCH named but failed to write: emptying the box is refused, not shown as "Saved securely"', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      failingCredentialWrites = 1;
      // Its own OAuth client, with no client secret saved.
      const connector = ownClientConnector();
      connector.capabilities.credentials = [
        { kind: 'oauth', slot: 'MCP_OAUTH', server: 'linear', clientId: 'cid' },
      ];
      const options = await openEditor(connector);
      fireEvent.change(screen.getByLabelText(/Client secret/), {
        target: { value: 'first-client-secret' },
      });
      fireEvent.click(saveButton());
      expect(
        await screen.findByText(
          'We saved the connector, but couldn’t save the client secret. Try saving again.',
        ),
      ).toBeVisible();
      // The connector now names a secret the vault doesn't hold.
      expect(writes[0]!.body.capabilities).toMatchObject({
        credentials: [{ kind: 'oauth', clientSecretRef: OWN_SECRET_REF }],
      });
      expect(vault.has(OWN_SECRET_REF)).toBe(false);
      await saveIsLive();
      fireEvent.change(screen.getByLabelText(/Client secret/), { target: { value: '' } });
      expect(screen.queryByText('Saved securely')).toBeNull();
      const before = calls.length;
      fireEvent.click(saveButton());
      expect(
        await screen.findByText(
          'Enter the client secret again, or remove it. Changing where this connector points clears it.',
        ),
      ).toBeVisible();
      expect(calls.length).toBe(before);
      expect(options.onSaved).not.toHaveBeenCalled();
      // Typed again, it is written, and the requirement lifts.
      fireEvent.change(screen.getByLabelText(/Client secret/), {
        target: { value: 'first-client-secret' },
      });
      fireEvent.click(saveButton());
      await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
      expect(vault.get(OWN_SECRET_REF)).toBe(btoa('first-client-secret'));
    });
  });

  // Typed during a move, then the move is undone: the value stays on screen,
  // so Save never replaces a live key with something the admin can't see.
  it('putting the address back keeps a re-typed key in view, and Save writes what is shown', async () => {
    discover = () => KEY_SERVER;
    const options = await openEditor(sharedKeyConnector(), {
      [SHARED_KEY_REF]: 'old-shared-key',
    });
    await moveTo('https://mcp.other-crm.example/mcp');
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: 'new-shared-key' },
    });
    await moveTo('https://mcp.crm.example/mcp');
    expect(note()).toBeNull();
    expect(screen.queryByText('Saved securely')).toBeNull();
    expect(screen.getByLabelText('Value')).toHaveValue('new-shared-key');
    fireEvent.click(saveButton());
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(calls).toEqual([
      'PATCH /admin/connectors/crm',
      'POST /admin/destinations/account/credential',
    ]);
    expect(signOuts).toBe(0);
    expect(vault.get(SHARED_KEY_REF)).toBe(btoa('new-shared-key'));
  });

  it('putting the address back keeps a re-typed client secret in view too', async () => {
    await openEditor(ownClientConnector(), { [OWN_SECRET_REF]: 'old-client-secret' });
    await moveTo('https://elsewhere.example/mcp');
    fireEvent.change(screen.getByLabelText(/Client secret/), {
      target: { value: 'new-client-secret' },
    });
    await moveTo('https://mcp.linear.app/mcp');
    expect(note()).toBeNull();
    expect(screen.queryByText('Saved securely')).toBeNull();
    expect(screen.getByLabelText(/Client secret/)).toHaveValue('new-client-secret');
  });

  describe('a save that points nowhere new', () => {
    it.each([
      ['an OAuth connector', oauthConnector, OAUTH_SERVER, {}],
      ['an OAuth connector on its own client', ownClientConnector, OAUTH_SERVER, { [OWN_SECRET_REF]: 'old' }],
      ['a shared-key connector', sharedKeyConnector, KEY_SERVER, { [SHARED_KEY_REF]: 'old' }],
    ])(
      'a plain no-op save of %s does not warn, asks for nothing again, and signs nobody out',
      async (_name, make, answer, stored) => {
        discover = () => answer;
        const options = await openEditor(make(), stored);
        expect(note()).toBeNull();
        fireEvent.click(saveButton());
        await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
        expect(calls).toEqual([`PATCH /admin/connectors/${row.id}`]);
        expect(signOuts).toBe(0);
        expect([...vault.keys()]).toEqual(Object.keys(stored));
      },
    );

    it.each([
      ['an OAuth connector', oauthConnector, OAUTH_SERVER, {}],
      ['a header-only connector', sharedKeyConnector, KEY_SERVER, { [SHARED_KEY_REF]: 'old' }],
    ])(
      'no-op save with newly discovered hosts does not warn (%s)',
      async (_name, make, answer, stored) => {
        const connector = make();
        const savedUrl = connector.capabilities.mcpServers[0]!.url;
        // Discovery finds a sign-in host the row never stored.
        discover = (url) =>
          url === savedUrl ? { ...answer, hosts: ['auth.discovered.example'] } : answer;
        const options = await openEditor(connector, stored);
        expect(note()).toBeNull();
        fireEvent.click(saveButton());
        await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
        // The host is saved, and that alone binds no stored credential anywhere
        // new: only a key with no header goes to these hosts.
        expect(writes[0]!.body.capabilities).toMatchObject({
          allowedHosts: expect.arrayContaining(['auth.discovered.example']),
        });
        expect(calls).toEqual([`PATCH /admin/connectors/${connector.id}`]);
        expect(signOuts).toBe(0);
        expect([...vault.keys()]).toEqual(Object.keys(stored));
      },
    );
  });
});
