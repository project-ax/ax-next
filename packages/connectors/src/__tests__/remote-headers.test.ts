import { describe, expect, it } from 'vitest';
import { validateCapabilities } from '../store.js';
import { deriveCredentialPlan } from '../credential-plan.js';
import type { Connector } from '../types.js';

const remote = {
  name: 'remote',
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
  allowedHosts: [],
  credentials: [],
};
const header = {
  kind: 'api-key',
  slot: 'header-one',
  server: 'remote',
  headerName: 'X-API-Key',
};
function caps(credentials: unknown[]) {
  return {
    allowedHosts: ['mcp.example.com'],
    mcpServers: [remote],
    credentials,
    packages: { npm: [], pypi: [] },
  };
}
describe('remote request headers', () => {
  it('persists only the header binding, and keeps the existing OAuth reference stable', () => {
    const capabilities = validateCapabilities(
      caps([
        {
          kind: 'oauth',
          slot: 'TOKEN',
          server: 'remote',
          clientRegistration: 'cimd',
        },
        header,
      ]),
    );
    const plan = deriveCredentialPlan({
      id: 'remote',
      keyMode: 'personal',
      capabilities,
    } as Connector);
    expect(plan.map((p) => p.ref)).toEqual([
      'account:remote',
      'account:remote:header-one',
    ]);
    expect(capabilities.credentials[1]).toEqual(header);
  });
  it.each(['Host', 'Cookie', 'Mcp-Session-Id', 'X-Key\r\n'])(
    'rejects transport header %s',
    (name) => {
      expect(() =>
        validateCapabilities(caps([{ ...header, headerName: name }])),
      ).toThrow();
    },
  );
  it('rejects duplicate names, missing server bindings, and OAuth Authorization overrides', () => {
    expect(() =>
      validateCapabilities(
        caps([header, { ...header, slot: 'two', headerName: 'x-api-key' }]),
      ),
    ).toThrow(/unique/);
    expect(() =>
      validateCapabilities(caps([{ ...header, server: 'other' }])),
    ).toThrow(/remote MCP/);
    expect(() =>
      validateCapabilities(
        caps([
          { ...header, headerName: 'Authorization' },
          { kind: 'oauth', slot: 'TOKEN', server: 'remote' },
        ]),
      ),
    ).toThrow(/OAuth/);
    expect(() =>
      validateCapabilities(caps([{ ...header, headerName: 'Authorization' }])),
    ).not.toThrow();
  });
  it('allows four headers per remote server, rather than limiting an existing multi-server connector', () => {
    const credentials = Array.from({ length: 4 }, (_, index) => ({
      ...header,
      slot: `h${index}`,
      headerName: `X-${index}`,
    }));
    expect(() =>
      validateCapabilities(
        caps([
          ...credentials,
          { ...header, slot: 'fifth', headerName: 'X-Fifth' },
        ]),
      ),
    ).toThrow(/four/);
    expect(() =>
      validateCapabilities({
        ...caps(credentials),
        mcpServers: [remote, { ...remote, name: 'other' }],
        credentials: [
          ...credentials,
          { ...header, server: 'other', slot: 'other' },
        ],
      }),
    ).not.toThrow();
  });
});
