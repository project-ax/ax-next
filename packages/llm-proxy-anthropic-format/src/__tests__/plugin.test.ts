import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeChatContext } from '@ax/core';
import type { ChatContext, ServiceHandler } from '@ax/core';
import { createLlmProxyAnthropicFormatPlugin } from '../plugin.js';

async function bootPlugin(): Promise<{
  bus: HookBus;
  ctx: ChatContext;
  stop: () => Promise<void>;
}> {
  const bus = new HookBus();
  const resolveToken: ServiceHandler = async () => ({
    sessionId: 'does-not-matter',
    workspaceRoot: '/tmp/ws',
  });
  const llmCall: ServiceHandler = async () => ({
    assistantMessage: { role: 'assistant', content: 'ok' },
    toolCalls: [],
  });
  bus.registerService('session:resolve-token', 'mock', resolveToken);
  bus.registerService('llm:call', 'mock', llmCall);

  const plugin = createLlmProxyAnthropicFormatPlugin();
  await plugin.init({ bus, config: {} });

  const ctx = makeChatContext({
    sessionId: 'test',
    agentId: 'test',
    userId: 'test',
    workspace: { rootPath: '/tmp/ws' },
  });

  const startedSessions: string[] = [];
  const origCall = bus.call.bind(bus);
  bus.call = async <I, O>(hook: string, c: ChatContext, input: I): Promise<O> => {
    if (hook === 'llm-proxy:start') {
      const out = await origCall<I, O>(hook, c, input);
      startedSessions.push((input as { sessionId: string }).sessionId);
      return out;
    }
    return origCall<I, O>(hook, c, input);
  };

  return {
    bus,
    ctx,
    stop: async () => {
      for (const sid of startedSessions) {
        await bus.call('llm-proxy:stop', ctx, { sessionId: sid }).catch(() => undefined);
      }
    },
  };
}

describe('@ax/llm-proxy-anthropic-format plugin', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups) await c();
    cleanups.length = 0;
  });

  it('manifest declares registers and calls in the expected shape', () => {
    const plugin = createLlmProxyAnthropicFormatPlugin();
    expect(plugin.manifest.name).toBe('@ax/llm-proxy-anthropic-format');
    expect(plugin.manifest.registers).toEqual(['llm-proxy:start', 'llm-proxy:stop']);
    expect(plugin.manifest.calls).toEqual(['session:resolve-token', 'llm:call']);
    expect(plugin.manifest.subscribes).toEqual([]);
  });

  it('llm-proxy:start on a fresh sessionId returns {url, port} and serves a healthz probe', async () => {
    const h = await bootPlugin();
    cleanups.push(h.stop);
    const result = await h.bus.call<{ sessionId: string }, { url: string; port: number }>(
      'llm-proxy:start',
      h.ctx,
      { sessionId: 's-fresh' },
    );
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(result.port).toBeGreaterThan(0);

    const healthy = await new Promise<number>((resolve, reject) => {
      const u = new URL(result.url);
      const req = http.request(
        {
          hostname: u.hostname,
          port: Number(u.port),
          path: '/_healthz',
          method: 'GET',
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(healthy).toBe(200);
  });

  it('llm-proxy:start twice on the same sessionId throws PluginError(already-running)', async () => {
    const h = await bootPlugin();
    cleanups.push(h.stop);
    await h.bus.call('llm-proxy:start', h.ctx, { sessionId: 's-dup' });
    let caught: unknown;
    try {
      await h.bus.call('llm-proxy:start', h.ctx, { sessionId: 's-dup' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('already-running');
  });

  it('llm-proxy:stop closes the listener and frees the port', async () => {
    const h = await bootPlugin();
    // Don't register cleanup here — we call stop manually below.
    const { port } = await h.bus.call<{ sessionId: string }, { url: string; port: number }>(
      'llm-proxy:start',
      h.ctx,
      { sessionId: 's-stop' },
    );
    await h.bus.call('llm-proxy:stop', h.ctx, { sessionId: 's-stop' });

    // Re-bind on the released port to prove close() worked.
    const reclaim = http.createServer();
    await new Promise<void>((resolve, reject) => {
      reclaim.once('error', reject);
      reclaim.listen(port, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => reclaim.close(() => resolve()));
  });

  it('llm-proxy:stop on an unknown sessionId is idempotent (no throw)', async () => {
    const h = await bootPlugin();
    cleanups.push(h.stop);
    await expect(
      h.bus.call('llm-proxy:stop', h.ctx, { sessionId: 'never-started' }),
    ).resolves.toBeTruthy();
  });

  it('llm-proxy:start rejects non-string sessionId with invalid-payload', async () => {
    const h = await bootPlugin();
    cleanups.push(h.stop);
    let caught: unknown;
    try {
      await h.bus.call('llm-proxy:start', h.ctx, { sessionId: 42 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
  });
});
