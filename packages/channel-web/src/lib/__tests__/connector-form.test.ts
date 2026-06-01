import { describe, it, expect } from 'vitest';
import {
  emptyConnectorForm,
  formFromConnector,
  capabilitiesFromForm,
  summaryToForm,
  connectorIdFromName,
  splitList,
} from '../connector-form';
import { emptyCapabilities, type Connector } from '../connectors';

const baseConnector = (over: Partial<Connector> = {}): Connector => ({
  id: 'gdrive',
  name: 'Google Drive',
  description: 'Drive files.',
  usageNote: 'Read and write Drive.',
  keyMode: 'personal',
  visibility: 'private',
  defaultAttached: false,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
  capabilities: emptyCapabilities(),
  ...over,
});

describe('connector-form helpers', () => {
  it('emptyConnectorForm is a private, personal, non-default stdio form', () => {
    const f = emptyConnectorForm();
    expect(f.keyMode).toBe('personal');
    expect(f.visibility).toBe('private');
    expect(f.defaultAttached).toBe(false);
    expect(f.transport).toBe('stdio');
    expect(f.baseCapabilities).toEqual(emptyCapabilities());
  });

  it('splitList trims, drops empties', () => {
    expect(splitList(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
    expect(splitList('')).toEqual([]);
  });

  it('connectorIdFromName slugifies', () => {
    expect(connectorIdFromName('Google Drive!')).toBe('google-drive-');
    expect(connectorIdFromName('My_Notion.v2')).toBe('my_notion.v2');
  });

  it('formFromConnector reads the leading mcp server + slots', () => {
    const c = baseConnector({
      keyMode: 'workspace',
      visibility: 'shared',
      defaultAttached: true,
      capabilities: {
        ...emptyCapabilities(),
        allowedHosts: ['drive.googleapis.com'],
        credentials: [{ slot: 'token', kind: 'api-key' }],
        mcpServers: [
          {
            name: 'gdrive',
            transport: 'stdio',
            command: 'mcp-gdrive',
            args: ['--flag', 'x'],
            allowedHosts: [],
            credentials: [],
          },
        ],
      },
    });
    const f = formFromConnector(c);
    expect(f.keyMode).toBe('workspace');
    expect(f.visibility).toBe('shared');
    expect(f.defaultAttached).toBe(true);
    expect(f.transport).toBe('stdio');
    expect(f.command).toBe('mcp-gdrive');
    expect(f.args).toBe('--flag x');
    expect(f.allowedHosts).toBe('drive.googleapis.com');
    expect(f.credentialSlots).toBe('token');
  });

  it('capabilitiesFromForm builds an stdio mcp server when a command is set', () => {
    const f = {
      ...emptyConnectorForm(),
      name: 'GDrive',
      command: 'mcp-gdrive',
      args: 'a b',
      allowedHosts: 'drive.googleapis.com, www.googleapis.com',
      credentialSlots: 'token',
    };
    const caps = capabilitiesFromForm(f);
    expect(caps.allowedHosts).toEqual([
      'drive.googleapis.com',
      'www.googleapis.com',
    ]);
    expect(caps.credentials).toEqual([{ slot: 'token', kind: 'api-key' }]);
    expect(caps.mcpServers).toHaveLength(1);
    expect(caps.mcpServers[0]!.transport).toBe('stdio');
    expect(caps.mcpServers[0]!.command).toBe('mcp-gdrive');
    expect(caps.mcpServers[0]!.args).toEqual(['a', 'b']);
  });

  it('capabilitiesFromForm leaves mcpServers empty for a non-MCP (CLI/direct-API) connector', () => {
    const f = { ...emptyConnectorForm(), name: 'Stripe', credentialSlots: 'key' };
    const caps = capabilitiesFromForm(f);
    expect(caps.mcpServers).toEqual([]);
    expect(caps.credentials).toEqual([{ slot: 'key', kind: 'api-key' }]);
  });

  it('capabilitiesFromForm PRESERVES un-surfaced base fields (packages, env, beyond-first server) on edit', () => {
    const base = {
      ...emptyCapabilities(),
      packages: { npm: ['@org/cli'], pypi: [] },
      mcpServers: [
        {
          name: 'gdrive',
          transport: 'stdio' as const,
          command: 'old',
          args: [],
          env: { FOO: 'bar' },
          allowedHosts: ['inner.example'],
          credentials: [{ slot: 'inner', kind: 'api-key' as const }],
        },
        {
          name: 'second',
          transport: 'http' as const,
          url: 'https://second.example',
          allowedHosts: [],
          credentials: [],
        },
      ],
    };
    const f = {
      ...emptyConnectorForm(),
      name: 'GDrive',
      transport: 'stdio' as const,
      command: 'new-cmd',
      baseCapabilities: base,
    };
    const caps = capabilitiesFromForm(f);
    // packages preserved
    expect(caps.packages).toEqual({ npm: ['@org/cli'], pypi: [] });
    // leading server's command overlaid, but env + inner fields preserved
    expect(caps.mcpServers[0]!.command).toBe('new-cmd');
    expect(caps.mcpServers[0]!.env).toEqual({ FOO: 'bar' });
    expect(caps.mcpServers[0]!.allowedHosts).toEqual(['inner.example']);
    // beyond-first server untouched
    expect(caps.mcpServers[1]!.name).toBe('second');
    expect(caps.mcpServers[1]!.url).toBe('https://second.example');
  });

  it('summaryToForm carries the metadata subset incl. defaultAttached', () => {
    const partial = summaryToForm({
      id: 'org-github',
      name: 'Org GitHub',
      description: 'd',
      usageNote: 'u',
      keyMode: 'workspace',
      visibility: 'private',
      defaultAttached: true,
      createdAt: 'x',
      updatedAt: 'y',
    });
    expect(partial.connectorId).toBe('org-github');
    expect(partial.defaultAttached).toBe(true);
    expect(partial.keyMode).toBe('workspace');
  });
});
