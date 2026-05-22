import { makeAgentContext, PluginError } from '@ax/core';
import type { HookBus, ToolDescriptor } from '@ax/core';
import type { WebExtractOutput } from '../anthropic-client.js';
import { isAllowedExtractUrl } from '../url-guard.js';

const PLUGIN_NAME = '@ax/web-tools';

export const WEB_EXTRACT_DESCRIPTOR: ToolDescriptor = {
  name: 'web_extract',
  description:
    'Fetch a specific web page (by URL) and return its readable text content. ' +
    'Use after web_search, or when the user gives you a URL to read. Text pages only (not PDFs/binary).',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The http(s) URL to fetch.' },
    },
    required: ['url'],
  },
};

export interface WebExtractBackend {
  run(url: string): Promise<WebExtractOutput>;
}

export async function registerWebExtract(bus: HookBus, backend: WebExtractBackend): Promise<void> {
  const ctx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
  await bus.call('tool:register', ctx, WEB_EXTRACT_DESCRIPTOR);

  bus.registerService<{ input?: unknown }, WebExtractOutput>(
    'tool:execute:web_extract',
    PLUGIN_NAME,
    async (_ctx, call) => {
      const input = (call?.input ?? {}) as { url?: unknown };
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      if (url.length === 0) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          hookName: 'tool:execute:web_extract',
          message: 'web_extract requires a non-empty "url"',
        });
      }
      if (!isAllowedExtractUrl(url)) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          hookName: 'tool:execute:web_extract',
          // Don't echo the raw caller-supplied URL — it may carry tokens in
          // query params and could land in host logs (info leak / log injection).
          message: 'web_extract: url not allowed (must be a public http(s) URL, not an internal/private address)',
        });
      }
      return backend.run(url);
    },
    { timeoutMs: 120_000 },
  );
}
