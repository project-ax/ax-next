import { PluginError, type Plugin, type HookBus, type Logger } from '@ax/core';
import { createProxyListener, type ProxyListener } from './listener.js';

const PLUGIN_NAME = '@ax/llm-proxy-anthropic-format';

// ---------------------------------------------------------------------------
// @ax/llm-proxy-anthropic-format plugin
//
// Registers two service hooks:
//
//   - `llm-proxy:start` — bind a per-session HTTP proxy on
//                         127.0.0.1:<ephemeral>. Returns `{url, port}` so
//                         the sandbox can inject `AX_LLM_PROXY_URL` into
//                         the runner child. Collision on sessionId is a
//                         PluginError('already-running') — wiring bug.
//   - `llm-proxy:stop`  — close the proxy for a sessionId. Idempotent;
//                         unknown sessionId → warn + no-op.
//
// The listener itself calls `session:resolve-token` (for bearer auth) and
// `llm:call` (to execute the turn) through the bus — never directly. That
// preserves I2 (no cross-plugin imports) at runtime.
// ---------------------------------------------------------------------------

interface LlmProxyStartInput {
  sessionId: string;
}
interface LlmProxyStartOutput {
  url: string;
  port: number;
}
interface LlmProxyStopInput {
  sessionId: string;
}
type LlmProxyStopOutput = Record<string, never>;

function requireString(
  value: unknown,
  field: string,
  hookName: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'${field}' must be a non-empty string`,
    });
  }
}

export interface CreateLlmProxyAnthropicFormatPluginOptions {
  logger?: Logger;
}

export function createLlmProxyAnthropicFormatPlugin(
  opts: CreateLlmProxyAnthropicFormatPluginOptions = {},
): Plugin {
  const listeners = new Map<string, ProxyListener>();
  let busRef: HookBus | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['llm-proxy:start', 'llm-proxy:stop'],
      // Listener fires these two hooks per request. The rest of the flow
      // (translate-request, translate-response, SSE synthesis) is pure and
      // doesn't touch the bus.
      calls: ['session:resolve-token', 'llm:call'],
      subscribes: [],
    },
    init({ bus }) {
      busRef = bus;

      bus.registerService<LlmProxyStartInput, LlmProxyStartOutput>(
        'llm-proxy:start',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const hookName = 'llm-proxy:start';
          const sessionId = (input as { sessionId?: unknown })?.sessionId;
          requireString(sessionId, 'sessionId', hookName);

          if (listeners.has(sessionId)) {
            throw new PluginError({
              code: 'already-running',
              plugin: PLUGIN_NAME,
              hookName,
              message: `proxy already running for session '${sessionId}'`,
            });
          }

          if (busRef === undefined) {
            throw new PluginError({
              code: 'not-initialized',
              plugin: PLUGIN_NAME,
              hookName,
              message: 'plugin init() has not run — bus reference missing',
            });
          }

          let listener: ProxyListener;
          try {
            const listenerOpts: Parameters<typeof createProxyListener>[0] = {
              bus: busRef,
              sessionId,
            };
            if (opts.logger !== undefined) listenerOpts.logger = opts.logger;
            listener = await createProxyListener(listenerOpts);
          } catch (cause) {
            throw new PluginError({
              code: 'bind-failed',
              plugin: PLUGIN_NAME,
              hookName,
              message: `failed to bind proxy for session '${sessionId}': ${(cause as Error).message}`,
              cause,
            });
          }

          listeners.set(sessionId, listener);
          return { url: listener.url, port: listener.port };
        },
      );

      bus.registerService<LlmProxyStopInput, LlmProxyStopOutput>(
        'llm-proxy:stop',
        PLUGIN_NAME,
        async (ctx, input) => {
          const hookName = 'llm-proxy:stop';
          const sessionId = (input as { sessionId?: unknown })?.sessionId;
          requireString(sessionId, 'sessionId', hookName);

          const listener = listeners.get(sessionId);
          if (listener === undefined) {
            ctx.logger.warn('llm_proxy_stop_unknown_session', { sessionId });
            return {};
          }
          listeners.delete(sessionId);
          await listener.close();
          return {};
        },
      );
    },
  };
}
