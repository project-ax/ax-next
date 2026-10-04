import { describe, expect, it } from 'vitest';
import { ceilingSourcesFor } from '../ceiling-sources.js';
import { deriveToolNamespace } from '../tool-namespace.js';
import type { Capabilities } from '../types.js';

function server(name: string): Capabilities['mcpServers'][number] {
  return {
    name,
    transport: 'http',
    url: `https://mcp.example.com/${name}`,
    allowedHosts: ['mcp.example.com'],
    credentials: [],
  };
}

function caps(
  credentials: Capabilities['credentials'],
  ...names: string[]
): Capabilities {
  return {
    allowedHosts: [],
    credentials,
    mcpServers: names.map(server),
    packages: { npm: [], pypi: [] },
    services: [],
  };
}

const ns = (s: string) => deriveToolNamespace('owner', 'conn', s);

describe('ceilingSourcesFor (TASK-809)', () => {
  it('an OAuth slot for server A makes A agent-chosen; B (no OAuth) keeps the connector ceiling', () => {
    const out = ceilingSourcesFor('owner', {
      id: 'conn',
      capabilities: caps([{ slot: 'A_TOKEN', kind: 'oauth', server: 'a' }] as unknown as Capabilities['credentials'], 'a', 'b'),
    });
    expect(out).toEqual([
      { toolNamespace: ns('a'), source: 'agent' },
      { toolNamespace: ns('b'), source: 'connector' },
    ]);
  });

  it('an api-key slot naming the server keeps the connector ceiling', () => {
    const out = ceilingSourcesFor('owner', {
      id: 'conn',
      capabilities: caps(
        [{ slot: 'A_KEY', kind: 'api-key', server: 'a', headerName: 'X-Key' }],
        'a',
      ),
    });
    expect(out).toEqual([{ toolNamespace: ns('a'), source: 'connector' }]);
  });

  it('no credentials at all keeps the connector ceiling', () => {
    const out = ceilingSourcesFor('owner', { id: 'conn', capabilities: caps([], 'a') });
    expect(out).toEqual([{ toolNamespace: ns('a'), source: 'connector' }]);
  });

  it('an OAuth slot naming a server the connector does not declare changes nothing', () => {
    const out = ceilingSourcesFor('owner', {
      id: 'conn',
      capabilities: caps([{ slot: 'Z', kind: 'oauth', server: 'zzz' }] as unknown as Capabilities['credentials'], 'a'),
    });
    expect(out).toEqual([{ toolNamespace: ns('a'), source: 'connector' }]);
  });

  it('a connector with no MCP servers yields nothing; namespaces derive from the row owner', () => {
    expect(ceilingSourcesFor('owner', { id: 'conn', capabilities: caps([]) })).toEqual([]);
    expect(
      ceilingSourcesFor('someone-else', { id: 'conn', capabilities: caps([], 'a') }),
    ).toEqual([{ toolNamespace: deriveToolNamespace('someone-else', 'conn', 'a'), source: 'connector' }]);
  });
});
