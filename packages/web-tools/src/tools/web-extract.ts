import { makeAgentContext, PluginError } from '@ax/core';
import type { AgentContext, HookBus, ToolDescriptor } from '@ax/core';
import type { WebExtractOutput } from '../anthropic-client.js';
import { isAllowedExtractUrl } from '../url-guard.js';

const PLUGIN_NAME = '@ax/web-tools';

/**
 * @ax/tool-policy's egress allowlist (TASK-330). OPTIONAL — see the manifest
 * note in `../plugin.ts`.
 */
const REMEMBER_HOOK = 'egress-allowlist:remember';

export const WEB_EXTRACT_DESCRIPTOR: ToolDescriptor = {
  name: 'web_extract',
  description:
    'Fetch a specific web page (by URL) and return its readable text content. ' +
    'Use after web_search, or when the user gives you a URL to read. Text pages only (not PDFs/binary).',
  activityPhrase: 'Reading a web page',
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

/**
 * The HOSTNAME of an already-guarded URL, or `null`.
 *
 * A HOSTNAME AND NOTHING ELSE — no scheme, no port, no path, no query, no
 * fragment. What we send is what the allowlist stores and later matches, so a
 * path- or URL-shaped value here would make the list bypassable by appending a
 * query string to a host somebody once approved.
 *
 * TOTAL. It is called only after a fetch has already SUCCEEDED, and nothing on
 * that path is allowed to throw.
 */
function hostOf(url: string): string | null {
  try {
    // Brackets stripped for the same reason `url-guard.ts` strips them: an
    // IPv6 literal's `hostname` keeps them, and `[::1]` is not the host the
    // allowlist would ever hold.
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/**
 * "We just read a page from this host, under a verdict that permitted it."
 *
 * WHY AFTER THE FETCH AND NOT BEFORE. Every execution of
 * `tool:execute:web_extract` was already permitted by policy — a silent allow,
 * a consumed approval after the person said yes, or the host replaying an
 * approval from their queue. Recording on the way out means we only ever
 * remember a host a permitted read actually reached.
 *
 * FAILING TO RECORD IS THE SAFE DIRECTION. Every early return and the catch
 * below cost exactly one thing: the next read from this host is held for
 * approval again. None of them grant anything.
 */
async function rememberHost(bus: HookBus, ctx: AgentContext, url: string): Promise<void> {
  // The CLI preset loads @ax/web-tools without @ax/tool-policy, so the hook is
  // genuinely absent there — not broken, just not installed.
  if (!bus.hasService(REMEMBER_HOOK)) return;

  // An init/canary context is not a person. `'system'` owns no allowlist, and
  // filing an entry under it would be filing it under nobody.
  const userId = ctx.userId.trim();
  if (userId.length === 0 || userId === 'system') return;

  const host = hostOf(url);
  if (host === null) return;

  try {
    await bus.call(REMEMBER_HOOK, ctx, { host });
  } catch (err) {
    // Never the raw url — it is model-authored and can carry tokens in its
    // query string, the same reason the guard's error message above refuses to
    // echo it. The hostname alone is safe to name.
    ctx.logger.warn('web_extract_remember_host_failed', {
      plugin: PLUGIN_NAME,
      host,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function registerWebExtract(bus: HookBus, backend: WebExtractBackend): Promise<void> {
  const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
  await bus.call('tool:register', initCtx, WEB_EXTRACT_DESCRIPTOR);

  bus.registerService<{ input?: unknown }, WebExtractOutput>(
    'tool:execute:web_extract',
    PLUGIN_NAME,
    async (ctx, call) => {
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
      // The guard runs FIRST and stays above nothing: an internal address is
      // refused here whether or not anybody allowlisted it, so a private host
      // never reaches the recording below.
      const out = await backend.run(url);
      // Only once the fetch has resolved, and never in a way that can change
      // what we return or turn a good fetch into a failure.
      await rememberHost(bus, ctx, url);
      return out;
    },
    { timeoutMs: 120_000 },
  );
}
