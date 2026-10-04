import { describe, it, expect } from 'vitest';
import { makeAgentContext, PluginError, type AgentContext } from '@ax/core';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  buildStreamableHttpOptions,
  buildSseOptions,
  createTransport,
  type BusLike,
} from '../transports.js';
import type { McpServerConfig } from '../config.js';

// Build a bus stub whose only service is `credentials:get`. We don't go through
// the real HookBus here — this lets us assert exact call counts and arguments
// without spinning up a full plugin host. Phase 3 shape: ({ ref, userId }) → string.
function makeCredsBus(
  secrets: Record<string, string>,
  opts?: { throwFor?: string },
): { bus: BusLike; calls: Array<{ ref: string; userId: string }> } {
  const calls: Array<{ ref: string; userId: string }> = [];
  const bus: BusLike = {
    async call(hookName, _ctx, input) {
      if (hookName !== 'credentials:get') {
        throw new Error(`unexpected hook: ${hookName}`);
      }
      const { ref, userId } = input as { ref: string; userId: string };
      calls.push({ ref, userId });
      if (opts?.throwFor === ref) {
        throw new PluginError({
          code: 'credential-not-found',
          plugin: '@ax/credentials',
          message: `no credential for ref='${ref}'`,
        });
      }
      const value = secrets[ref];
      if (value === undefined) {
        throw new PluginError({
          code: 'credential-not-found',
          plugin: '@ax/credentials',
          message: `no credential for ref='${ref}'`,
        });
      }
      return value as unknown as never;
    },
  };
  return { bus, calls };
}

function ctx(): AgentContext {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

const streamableConfig = (
  overrides: Partial<Extract<McpServerConfig, { transport: 'streamable-http' }>> = {},
) =>
  ({
    id: 'gh',
    enabled: true,
    transport: 'streamable-http',
    url: 'https://api.github.com/mcp',
    ...overrides,
  }) as Extract<McpServerConfig, { transport: 'streamable-http' }>;

const sseConfig = (
  overrides: Partial<Extract<McpServerConfig, { transport: 'sse' }>> = {},
) =>
  ({
    id: 'sse',
    enabled: true,
    transport: 'sse',
    url: 'https://example.com/sse',
    ...overrides,
  }) as Extract<McpServerConfig, { transport: 'sse' }>;

describe('buildStreamableHttpOptions', () => {
  it('exposes resolved header credentials under requestInit.headers', async () => {
    const { bus, calls } = makeCredsBus({ 'gh-id': 'token-abc' });
    const { url, options } = await buildStreamableHttpOptions({
      config: streamableConfig({ headerCredentialRefs: { Authorization: 'gh-id' } }),
      bus,
      ctx: ctx(),
    });
    expect(url.toString()).toBe('https://api.github.com/mcp');
    expect(options.requestInit?.headers).toEqual({ Authorization: 'token-abc' });
    expect(calls).toEqual([{ ref: 'gh-id', userId: 'u' }]);
  });

  it('resolves multiple header credentials (one bus call per ref)', async () => {
    const { bus, calls } = makeCredsBus({ 'gh-id': 'aaa', 'slack-id': 'bbb' });
    const { options } = await buildStreamableHttpOptions({
      config: streamableConfig({
        headerCredentialRefs: { Authorization: 'gh-id', 'X-Slack-Token': 'slack-id' },
      }),
      bus,
      ctx: ctx(),
    });
    expect(options.requestInit?.headers).toEqual({
      Authorization: 'aaa',
      'X-Slack-Token': 'bbb',
    });
    expect(calls.map((c) => c.ref).sort()).toEqual(['gh-id', 'slack-id']);
  });

  it('credential resolution failure surfaces a redacted PluginError (no secret value echoed)', async () => {
    const { bus } = makeCredsBus({}, { throwFor: 'missing-id' });
    const config = streamableConfig({ headerCredentialRefs: { Authorization: 'missing-id' } });
    await expect(buildStreamableHttpOptions({ config, bus, ctx: ctx() })).rejects.toMatchObject({
      name: 'PluginError',
      code: 'credential-resolution-failed',
      plugin: '@ax/mcp-client',
    });

    // Error message mentions the ref name and id — but nothing about values.
    try {
      await buildStreamableHttpOptions({ config, bus, ctx: ctx() });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      const msg = (err as Error).message;
      expect(msg).toContain('Authorization');
      expect(msg).toContain('missing-id');
      // Never leak any credential value content through the message.
      expect(msg).not.toMatch(/secret|plaintext|hunter2/i);
    }
  });

  it('omits requestInit when no header credentials are configured', async () => {
    const { bus } = makeCredsBus({});
    const { options } = await buildStreamableHttpOptions({
      config: streamableConfig(),
      bus,
      ctx: ctx(),
    });
    // No headers -> no requestInit at all (don't send an empty headers object).
    expect(options.requestInit).toBeUndefined();
  });

  it('plain http URL does not throw (warning is the plugin layer`s job)', async () => {
    const { bus } = makeCredsBus({});
    const { url } = await buildStreamableHttpOptions({
      config: streamableConfig({ url: 'http://insecure.local/mcp' }),
      bus,
      ctx: ctx(),
    });
    expect(url.protocol).toBe('http:');
  });
});

describe('buildSseOptions', () => {
  it('exposes resolved header credentials under requestInit.headers', async () => {
    const { bus, calls } = makeCredsBus({ 'gh-id': 'sse-token' });
    const { url, options } = await buildSseOptions({
      config: sseConfig({ headerCredentialRefs: { Authorization: 'gh-id' } }),
      bus,
      ctx: ctx(),
    });
    expect(url.toString()).toBe('https://example.com/sse');
    expect(options.requestInit?.headers).toEqual({ Authorization: 'sse-token' });
    expect(calls).toEqual([{ ref: 'gh-id', userId: 'u' }]);
  });

  it('omits requestInit when no header credentials are configured', async () => {
    const { bus } = makeCredsBus({});
    const { options } = await buildSseOptions({
      config: sseConfig(),
      bus,
      ctx: ctx(),
    });
    expect(options.requestInit).toBeUndefined();
  });
});

describe('createTransport', () => {
  it('returns a StreamableHTTPClientTransport for streamable-http configs', async () => {
    const { bus } = makeCredsBus({});
    const transport = await createTransport({
      config: streamableConfig(),
      bus,
      ctx: ctx(),
    });
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it('returns an SSEClientTransport for sse configs', async () => {
    const { bus } = makeCredsBus({});
    const transport = await createTransport({
      config: sseConfig(),
      bus,
      ctx: ctx(),
    });
    expect(transport).toBeInstanceOf(SSEClientTransport);
  });

  it('refuses a stdio config at runtime (fail closed: nothing is spawned, nothing is returned)', async () => {
    const { bus, calls } = makeCredsBus({});
    // `McpServerConfig` no longer has a stdio member and `parseConfig` rejects
    // it, so this only models a value that skipped validation.
    const stdio = {
      id: 'fs',
      enabled: true,
      transport: 'stdio',
      command: 'mcp-server-filesystem',
      args: ['/tmp'],
    } as unknown as McpServerConfig;
    await expect(createTransport({ config: stdio, bus, ctx: ctx() })).rejects.toMatchObject({
      name: 'PluginError',
      code: 'unsupported-transport',
      plugin: '@ax/mcp-client',
    });
    // It never even resolved credentials for it.
    expect(calls).toEqual([]);
  });
});
