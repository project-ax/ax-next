import { describe, expect, it } from 'vitest';
import { CapabilitiesSchema, ResolveOutputSchema } from '../types.js';

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

  /**
   * TASK-319 — the drift guard for `connectors:resolve`'s consumers.
   *
   * `connectors:resolve` is registered with `returns: ResolveOutputSchema`, and
   * `HookBus.call` returns `safeParse(...).data` — so a zod `z.object` STRIPS
   * any key it does not declare. A consumer that digests a field (the freshness
   * guard in `@ax/skill-broker` digests all five below, so a re-pointed endpoint
   * re-opens an approval instead of replaying it) therefore depends on this
   * schema continuing to declare it, and would silently lose that coverage with
   * no type error anywhere if it stopped. Assert the round trip rather than
   * trusting the declaration.
   */
  it('carries the pinned OAuth client, both endpoints and a healthcheck through a resolve round trip', () => {
    const parsed = ResolveOutputSchema.parse({
      id: 'linear',
      keyMode: 'personal',
      usageNote: '',
      capabilities: {
        allowedHosts: ['mcp.linear.app', 'auth.linear.app'],
        credentials: [
          {
            slot: 'MCP_TOKEN',
            kind: 'oauth',
            server: 'linear',
            scopes: ['read'],
            clientId: 'client-a',
            clientSecretRef: 'account:linear:oauth',
            authServerUrl: 'https://auth.linear.app',
            tokenUrl: 'https://auth.linear.app/token',
          },
        ],
        mcpServers: [
          {
            name: 'linear',
            transport: 'http',
            url: 'https://mcp.linear.app',
            allowedHosts: ['mcp.linear.app'],
            credentials: [],
          },
        ],
        packages: { npm: [], pypi: [] },
        services: [
          {
            name: 'cache',
            image: `redis@sha256:${'a'.repeat(64)}`,
            ports: [6379],
            env: {},
            healthcheck: { kind: 'exec', command: ['redis-cli', 'ping'] },
            writablePaths: [],
          },
        ],
      },
      credentialPlan: [],
      requiresSharedKeyConsent: false,
    });

    expect(parsed.capabilities.credentials[0]).toMatchObject({
      clientId: 'client-a',
      clientSecretRef: 'account:linear:oauth',
      authServerUrl: 'https://auth.linear.app',
      tokenUrl: 'https://auth.linear.app/token',
    });
    expect(parsed.capabilities.services?.[0]?.healthcheck).toEqual({
      kind: 'exec',
      command: ['redis-cli', 'ping'],
    });
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
