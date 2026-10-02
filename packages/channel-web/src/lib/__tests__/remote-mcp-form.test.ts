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
  defaultAttached: true,
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
        name: 'local',
        transport: 'stdio',
        command: 'node',
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
  it('adds hosts without dropping the saved hosts that are displayed separately', () => {
    const draft = remoteDraft(connector);
    expect(draft.hosts).toBe('');
    draft.hosts = 'extra.example.com, auth.example.com';
    expect(
      remoteCapabilities(draft, connector.id, connector).allowedHosts,
    ).toEqual(['mcp.example.com', 'auth.example.com', 'extra.example.com']);
    draft.hosts = '';
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
    expect(Object.keys(remoteErrors(draft))).toEqual([
      'clientId',
      'name-a',
      'value-b',
      'name-c',
    ]);
  });
});
