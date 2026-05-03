import Anthropic from '@anthropic-ai/sdk';
import { PluginError, type LlmCallInput, type LlmCallOutput, type Plugin } from '@ax/core';
import { fromAnthropicResponse, toAnthropicRequest } from './translate.js';

const PLUGIN_NAME = '@ax/llm-anthropic';
const PLUGIN_VERSION = '0.0.0';

// Statuses we consider transient — a 1-shot retry buys us resilience without
// turning the plugin into a backoff library. Anything else (auth, validation,
// quota-exhausted-with-no-retry-after) is the orchestrator's problem.
const TRANSIENT_STATUSES = new Set<number>([429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAY_MS = 1000;

export interface LlmAnthropicConfig {
  /**
   * Anthropic API key. Falls back to `process.env.ANTHROPIC_API_KEY` if
   * unset. We refuse to init without one — silent fallback to "no auth"
   * would be a footgun.
   */
  apiKey?: string;
  /** Model used when the caller doesn't specify one. */
  defaultModel?: string;
  /** `max_tokens` used when the caller doesn't specify one. */
  defaultMaxTokens?: number;
  /**
   * Delay between the first attempt and the single retry, in milliseconds.
   * Tests pass `0` to keep the suite fast; production callers should leave
   * this at the default (1s) or set their own policy via a wrapper plugin.
   */
  retryDelayMs?: number;
  /**
   * Test seam: hand back a stub Anthropic client instead of constructing
   * a real one. Production callers leave this unset.
   */
  clientFactory?: (apiKey: string) => Anthropic;
}

export function createLlmAnthropicPlugin(cfg: LlmAnthropicConfig = {}): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: ['llm:call'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      const apiKey = cfg.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (apiKey === undefined || apiKey.length === 0) {
        throw new PluginError({
          code: 'init-failed',
          plugin: PLUGIN_NAME,
          hookName: 'init',
          message:
            'ANTHROPIC_API_KEY not set and cfg.apiKey not provided — refusing to init',
        });
      }
      const client =
        cfg.clientFactory !== undefined ? cfg.clientFactory(apiKey) : new Anthropic({ apiKey });
      bus.registerService<LlmCallInput, LlmCallOutput>(
        'llm:call',
        PLUGIN_NAME,
        async (_ctx, input) => callWithRetry(client, input, cfg),
      );
    },
  };
}

async function callWithRetry(
  client: Anthropic,
  input: LlmCallInput,
  cfg: LlmAnthropicConfig,
): Promise<LlmCallOutput> {
  const req = toAnthropicRequest(input, cfg);
  const retryDelayMs = cfg.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastErr: unknown;

  // Two attempts max — initial + one retry on transient status.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await client.messages.create(req);
      return fromAnthropicResponse(res);
    } catch (e) {
      lastErr = e;
      if (attempt === 0 && isTransient(e)) {
        if (retryDelayMs > 0) await sleep(retryDelayMs);
        continue;
      }
      throw new PluginError({
        code: 'unknown',
        plugin: PLUGIN_NAME,
        hookName: 'llm:call',
        message: `Anthropic API call failed: ${errorMessage(e)}`,
        ...(e instanceof Error ? { cause: e } : {}),
      });
    }
  }

  // Reachable only if attempt 0 was transient and attempt 1 also failed
  // without re-entering the catch's throw branch (defensive — the loop
  // structure makes this unreachable today, but the explicit throw keeps
  // the function total).
  throw new PluginError({
    code: 'unknown',
    plugin: PLUGIN_NAME,
    hookName: 'llm:call',
    message: `Anthropic API call exhausted retries: ${errorMessage(lastErr)}`,
  });
}

function isTransient(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && TRANSIENT_STATUSES.has(status);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
