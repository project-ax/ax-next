import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { makeAgentContext, PluginError, type AgentContext } from '@ax/core';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  buildStdioParams,
  buildStreamableHttpOptions,
  buildSseOptions,
  createTransport,
  BASE_STDIO_ENV_KEYS,
  type BusLike,
} from '../transports.js';
import type { McpServerConfig } from '../config.js';

// Build a bus stub whose only service is `credentials:get`. We don't go through
// the real HookBus here — this lets us assert exact call counts and arguments
// without spinning up a full plugin host.
function makeCredsBus(
  secrets: Record<string, string>,
  opts?: { throwFor?: string },
): { bus: BusLike; calls: Array<{ id: string }> } {
  const calls: Array<{ id: string }> = [];
  const bus: BusLike = {
    async call(hookName, _ctx, input) {
      if (hookName !== 'credentials:get') {
        throw new Error(`unexpected hook: ${hookName}`);
      }
      const { id } = input as { id: string };
      calls.push({ id });
      if (opts?.throwFor === id) {
        throw new PluginError({
          code: 'credential-not-found',
          plugin: '@ax/credentials',
          message: `no credential with id '${id}'`,
        });
      }
      const value = secrets[id];
      if (value === undefined) {
        throw new PluginError({
          code: 'credential-not-found',
          plugin: '@ax/credentials',
          message: `no credential with id '${id}'`,
        });
      }
      return { value } as unknown as never;
    },
  };
  return { bus, calls };
}

function ctx(): AgentContext {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

// We need to poke process.env to prove leakage behavior. Snapshot and restore.
let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  // Restore by deleting anything we added and copying back what was there.
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) process.env[k] = v;
  }
});

const stdioConfig = (overrides: Partial<Extract<McpServerConfig, { transport: 'stdio' }>> = {}) =>
  ({
    id: 'fs',
    enabled: true,
    transport: 'stdio',
    command: 'mcp-server-filesystem',
    args: ['/tmp'],
    ...overrides,
  }) as Extract<McpServerConfig, { transport: 'stdio' }>;

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

describe('buildStdioParams', () => {
  it('env is exactly allowlist + config.env + resolved credentialRefs (no process.env leakage)', async () => {
    // Poison process.env with things that must NOT appear in the subprocess env.
    process.env.SECRET_HOST_VAR = 'leak';
    process.env.AX_CREDENTIALS_KEY = 'super-secret-master-key';
    // Control every allowlisted key so the assertion is deterministic
    // across hosts — some machines set LANG/LC_ALL, some don't.
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/ax-test';
    delete process.env.LANG;
    delete process.env.LC_ALL;

    const { bus, calls } = makeCredsBus({ 'gh-id': 'gh-secret' });
    const params = await buildStdioParams({
      config: stdioConfig({
        env: { FOO: 'bar' },
        credentialRefs: { GH_TOKEN: 'gh-id' },
      }),
      bus,
      ctx: ctx(),
    });

    expect(params.command).toBe('mcp-server-filesystem');
    expect(params.args).toEqual(['/tmp']);
    expect(params.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/ax-test',
      FOO: 'bar',
      GH_TOKEN: 'gh-secret',
    });
    // Explicit non-leak assertions — regression belts against getDefaultEnvironment() creep.
    expect(params.env).not.toHaveProperty('SECRET_HOST_VAR');
    expect(params.env).not.toHaveProperty('AX_CREDENTIALS_KEY');
    expect(params.env).not.toHaveProperty('USER');
    expect(params.env).not.toHaveProperty('SHELL');
    expect(calls).toEqual([{ id: 'gh-id' }]);
  });

  it('allowlist keys not set in process.env are simply absent (no undefineds)', async () => {
    // Clear every allowlisted key so we can prove none of them appear as
    // undefined-valued entries in the result.
    for (const key of BASE_STDIO_ENV_KEYS) {
      delete process.env[key];
    }
    const { bus } = makeCredsBus({});
    const params = await buildStdioParams({
      config: stdioConfig({ env: { ONLY: 'me' } }),
      bus,
      ctx: ctx(),
    });
    expect(params.env).toEqual({ ONLY: 'me' });
  });

  it('config.env cannot override the resolved credential (credentials win last)', async () => {
    // Prove merge order: allowlist < config.env < credentialRefs. Someone writing
    // `env: { GH_TOKEN: 'oops' }` alongside `credentialRefs: { GH_TOKEN: ... }`
    // must not end up with the literal 'oops' string reaching the subprocess.
    process.env.PATH = '/bin';
    const { bus } = makeCredsBus({ 'gh-id': 'real-secret' });
    const params = await buildStdioParams({
      config: stdioConfig({
        env: { GH_TOKEN: 'oops-plaintext' },
        credentialRefs: { GH_TOKEN: 'gh-id' },
      }),
      bus,
      ctx: ctx(),
    });
    expect(params.env?.GH_TOKEN).toBe('real-secret');
  });

  it('credential resolution failure surfaces a redacted PluginError (no secret value echoed)', async () => {
    const { bus } = makeCredsBus({}, { throwFor: 'missing-id' });
    await expect(
      buildStdioParams({
        config: stdioConfig({ credentialRefs: { GH_TOKEN: 'missing-id' } }),
        bus,
        ctx: ctx(),
      }),
    ).rejects.toMatchObject({
      name: 'PluginError',
      code: 'credential-resolution-failed',
      plugin: '@ax/mcp-client',
    });

    // Error message mentions the ref name and id — but nothing about values.
    try {
      await buildStdioParams({
        config: stdioConfig({ credentialRefs: { GH_TOKEN: 'missing-id' } }),
        bus,
        ctx: ctx(),
      });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      const msg = (err as Error).message;
      expect(msg).toContain('GH_TOKEN');
      expect(msg).toContain('missing-id');
      // Never leak any credential value content through the message.
      expect(msg).not.toMatch(/secret|plaintext|hunter2/i);
    }
  });

  it('resolves multiple credentialRefs (one bus call per ref)', async () => {
    process.env.PATH = '/bin';
    const { bus, calls } = makeCredsBus({ 'gh-id': 'aaa', 'slack-id': 'bbb' });
    const params = await buildStdioParams({
      config: stdioConfig({
        credentialRefs: { GH_TOKEN: 'gh-id', SLACK_TOKEN: 'slack-id' },
      }),
      bus,
      ctx: ctx(),
    });
    expect(params.env?.GH_TOKEN).toBe('aaa');
    expect(params.env?.SLACK_TOKEN).toBe('bbb');
    expect(calls.map((c) => c.id).sort()).toEqual(['gh-id', 'slack-id']);
  });
});

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
    expect(calls).toEqual([{ id: 'gh-id' }]);
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
    expect(calls).toEqual([{ id: 'gh-id' }]);
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
  it('returns a StdioClientTransport for stdio configs', async () => {
    process.env.PATH = '/bin';
    const { bus } = makeCredsBus({});
    const transport = await createTransport({
      config: stdioConfig(),
      bus,
      ctx: ctx(),
    });
    expect(transport).toBeInstanceOf(StdioClientTransport);
    // We deliberately do NOT call start() — that would spawn a real process.
  });

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
});
