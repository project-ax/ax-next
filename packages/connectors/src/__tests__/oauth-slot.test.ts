import { describe, expect, it } from 'vitest';
import { CapabilitiesSchema } from '../types.js';

describe('oauth credential slot', () => {
  it('accepts an oauth slot referencing a server, with optional pinned client', () => {
    const parsed = CapabilitiesSchema.parse({
      allowedHosts: ['mcp.example.com', 'auth.example.com'],
      credentials: [
        { slot: 'MCP_TOKEN', kind: 'oauth', server: 'example', scopes: ['read'] },
      ],
      mcpServers: [
        { name: 'example', transport: 'http', url: 'https://mcp.example.com',
          allowedHosts: ['mcp.example.com'], credentials: [] },
      ],
      packages: { npm: [], pypi: [] },
    });
    expect(parsed.credentials[0]).toMatchObject({ kind: 'oauth', server: 'example' });
  });

  it('still accepts a plain api-key slot (back-compat)', () => {
    const parsed = CapabilitiesSchema.parse({
      allowedHosts: [], credentials: [{ slot: 'X', kind: 'api-key' }],
      mcpServers: [], packages: { npm: [], pypi: [] },
    });
    expect(parsed.credentials[0].kind).toBe('api-key');
  });

  it('rejects backend vocabulary smuggled onto the oauth slot', () => {
    expect(() =>
      CapabilitiesSchema.parse({
        allowedHosts: [], packages: { npm: [], pypi: [] }, mcpServers: [],
        credentials: [{ slot: 'X', kind: 'oauth', server: 'e', command: 'curl' }],
      }),
    ).toThrow();
  });
});
