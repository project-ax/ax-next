import { describe, expect, it } from 'vitest';
import {
  remoteCapabilities,
  remoteDraft,
  remoteErrors,
  serverHost,
} from '../remote-mcp-form';
import { deriveCredentialPlan, type Connector } from '../connectors';
const connector: Connector = {
  id: 'linear',
  name: 'Linear',
  description: 'Keep description',
  usageNote: 'Keep instructions',
  keyMode: 'personal',
  visibility: 'shared',
  createdAt: '',
  updatedAt: '',
  capabilities: {
    allowedHosts: ['mcp.example.com', 'auth.example.com'],
    credentials: [
      {
        kind: 'oauth',
        slot: 'TOKEN',
        server: 'remote',
        clientId: 'existing',
        clientSecretRef: 'account:linear:client',
        authServerUrl: 'https://auth.example.com',
        tokenUrl: 'https://auth.example.com/token',
      },
    ],
    mcpServers: [
      {
        name: 'remote',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        allowedHosts: ['inner.example.com'],
        credentials: [],
      },
      {
        name: 'second',
        transport: 'http',
        url: 'https://mcp.example.com/second',
        allowedHosts: [],
        credentials: [],
      },
    ],
    packages: { npm: ['extra'], pypi: [] },
    services: [],
  },
};
describe('remote MCP form data', () => {
  it('requires an HTTPS endpoint that the existing proxy and discovery can reach', () => {
    expect(serverHost('https://mcp.example.com:443/mcp')).toBe(
      'mcp.example.com',
    );
    for (const url of [
      'http://mcp.example.com/mcp',
      'https://mcp.example.com:8443/mcp',
      'https://user:secret@mcp.example.com/mcp',
      'https://mcp.example.com/mcp#fragment',
      `https://mcp.example.com/${'a'.repeat(2048)}`,
    ])
      expect(serverHost(url)).toBeUndefined();
  });
  it('round-trips hidden fields, other servers, scopes, and the saved client secret', () => {
    const draft = remoteDraft(connector);
    expect(draft.registration).toBe('custom');
    const result = remoteCapabilities(draft, connector.id, connector, [
      'tokens.example.com',
    ]);
    expect(result.mcpServers).toEqual(connector.capabilities.mcpServers);
    expect(result.packages).toEqual(connector.capabilities.packages);
    expect(result.credentials[0]).toMatchObject(
      connector.capabilities.credentials[0]!,
    );
    expect(result.allowedHosts).toContain('tokens.example.com');
    expect(connector.capabilities.allowedHosts).not.toContain(
      'tokens.example.com',
    );
  });
  it('stores bindings rather than values and leaves the existing token reference intact', () => {
    const draft = remoteDraft(connector);
    draft.headers = [
      {
        slot: 'header-one',
        name: 'X-Key',
        value: 'secret-never-in-capabilities',
        saved: false,
      },
    ];
    const result = remoteCapabilities(draft, connector.id, connector);
    expect(JSON.stringify(result)).not.toContain(
      'secret-never-in-capabilities',
    );
    expect(
      deriveCredentialPlan({ ...connector, capabilities: result }).map(
        (p) => p.ref,
      ),
    ).toEqual(['account:linear', 'account:linear:header-one']);
  });
  it('switches authentication without dropping hidden capabilities', () => {
    const draft = remoteDraft(connector);
    draft.signIn = 'none';
    expect(
      remoteCapabilities(draft, connector.id, connector).credentials,
    ).toEqual([]);
    draft.signIn = 'oauth';
    draft.registration = 'dcr';
    const oauth = remoteCapabilities(draft, connector.id, connector)
      .credentials[0]!;
    expect(oauth).not.toHaveProperty('clientId');
    expect(oauth).not.toHaveProperty('clientSecretRef');
    expect(oauth).toHaveProperty('authServerUrl', 'https://auth.example.com');
  });
  it('keeps saved hosts and adds discovered ones without a manual host list', () => {
    const draft = remoteDraft(connector);
    expect(draft).not.toHaveProperty('hosts');
    expect(
      remoteCapabilities(draft, connector.id, connector, [
        'tokens.example.com',
        'auth.example.com',
      ]).allowedHosts,
    ).toEqual(['mcp.example.com', 'auth.example.com', 'tokens.example.com']);
    expect(
      remoteCapabilities(draft, connector.id, connector).allowedHosts,
    ).toEqual(connector.capabilities.allowedHosts);
  });
  it('validates custom client IDs, duplicate names, OAuth overrides and header injection', () => {
    const draft = remoteDraft(connector);
    draft.clientId = '';
    draft.headers = [
      { slot: 'a', name: 'Authorization', value: 'x', saved: false },
      { slot: 'b', name: 'X-Key', value: 'x\r\nInjected: yes', saved: false },
      { slot: 'c', name: 'x-key', value: '', saved: true },
    ];
    expect(Object.keys(remoteErrors(draft, 'workspace'))).toEqual([
      'clientId',
      'name-a',
      'value-b',
      'name-c',
    ]);
  });
  // Slice 5 — a per-agent-key connector's header values are never entered in
  // the editor: each agent adds its own when it adds the connector.
  it('asks for no header value when each agent adds its own key', () => {
    const draft = remoteDraft(connector);
    draft.headers = [{ slot: 'a', name: 'X-Key', value: '', saved: false }];
    expect(Object.keys(remoteErrors(draft, 'workspace'))).toContain('value-a');
    expect(Object.keys(remoteErrors(draft, 'personal'))).not.toContain('value-a');
  });
  describe('OAuth or an API key (TASK-761)', () => {
    const keyConnector: Connector = {
      ...connector,
      capabilities: {
        ...connector.capabilities,
        credentials: [
          {
            kind: 'api-key',
            slot: 'header-key',
            server: 'remote',
            headerName: 'Authorization',
          },
        ],
      },
    };
    it('opens a saved header-only connector in API-key mode and everything else in OAuth mode', () => {
      expect(remoteDraft().useKey).toBe(false);
      expect(remoteDraft(connector).useKey).toBe(false);
      const draft = remoteDraft(keyConnector);
      expect(draft.useKey).toBe(true);
      expect(draft.signIn).toBe('none');
      expect(draft.headers).toEqual([
        { slot: 'header-key', name: 'Authorization', value: '', saved: true },
      ]);
    });
    it('accepts an Authorization header in API-key mode but not with OAuth', () => {
      const draft = remoteDraft(keyConnector);
      expect(remoteErrors(draft, 'workspace')).toEqual({});
      expect(
        Object.keys(remoteErrors({ ...draft, useKey: false, signIn: 'oauth' }, 'workspace')),
      ).toEqual(['name-header-key']);
    });
    it('asks for the header that carries the key when API-key mode has none', () => {
      const draft = { ...remoteDraft(keyConnector), headers: [] };
      expect(Object.keys(remoteErrors(draft, 'workspace'))).toEqual(['keyHeader']);
      expect(
        remoteErrors({ ...draft, useKey: false, signIn: 'none' }, 'workspace'),
      ).toEqual({});
    });
    it('saves API-key mode as header slots with no OAuth slot', () => {
      const draft = remoteDraft(connector);
      draft.useKey = true;
      draft.signIn = 'none';
      draft.headers = [
        { slot: 'header-key', name: 'Authorization', value: 'Bearer k', saved: false },
      ];
      expect(remoteErrors(draft, 'workspace')).toEqual({});
      expect(
        remoteCapabilities(draft, connector.id, connector).credentials,
      ).toEqual([
        {
          kind: 'api-key',
          slot: 'header-key',
          headerName: 'Authorization',
          server: 'remote',
          description: 'Authorization',
        },
      ]);
    });
  });
});
