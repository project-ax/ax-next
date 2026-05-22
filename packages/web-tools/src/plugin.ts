import Anthropic from '@anthropic-ai/sdk';
import { PluginError, type Plugin } from '@ax/core';
import { runWebSearch, runWebExtract, type CallOpts } from './anthropic-client.js';
import { registerWebSearch } from './tools/web-search.js';
import { registerWebExtract } from './tools/web-extract.js';

const PLUGIN_NAME = '@ax/web-tools';
const PLUGIN_VERSION = '0.0.0';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_MAX_CONTENT_TOKENS = 50_000;

export interface WebToolsConfig {
  /** Global Anthropic key. Falls back to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Inner-call model. Default 'claude-sonnet-4-6'. */
  model?: string;
  /** Operator kill-switch. When false the plugin registers nothing. Default true. */
  enabled?: boolean;
  /** Per-request timeout (ms) for the inner Messages call. */
  timeoutMs?: number;
  /** Cap on extracted content tokens (web_fetch max_content_tokens). */
  maxContentTokens?: number;
  /** Test seam — stub Anthropic client. */
  clientFactory?: (apiKey: string) => Anthropic;
}

export function createWebToolsPlugin(cfg: WebToolsConfig = {}): Plugin {
  const enabled = cfg.enabled ?? true;
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: enabled ? ['tool:execute:web_search', 'tool:execute:web_extract'] : [],
      calls: enabled ? ['tool:register'] : [],
      subscribes: [],
    },
    async init({ bus }) {
      if (!enabled) return;

      const apiKey = cfg.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (apiKey === undefined || apiKey.length === 0) {
        throw new PluginError({
          code: 'init-failed',
          plugin: PLUGIN_NAME,
          hookName: 'init',
          message:
            'ANTHROPIC_API_KEY not set and cfg.apiKey not provided — refusing to init (set cfg.enabled=false to disable web tools)',
        });
      }

      const client =
        cfg.clientFactory !== undefined
          ? cfg.clientFactory(apiKey)
          : new Anthropic({ apiKey, ...(cfg.timeoutMs !== undefined ? { timeout: cfg.timeoutMs } : {}) });

      const opts: CallOpts = { model: cfg.model ?? DEFAULT_MODEL, maxTokens: DEFAULT_MAX_TOKENS };
      const maxContentTokens = cfg.maxContentTokens ?? DEFAULT_MAX_CONTENT_TOKENS;

      await registerWebSearch(bus, { run: (query) => runWebSearch(client, opts, query) });
      await registerWebExtract(bus, { run: (url) => runWebExtract(client, opts, url, maxContentTokens) });
    },
  };
}
