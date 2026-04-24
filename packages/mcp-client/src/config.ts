import { z } from 'zod';
import { PluginError, type ChatContext } from '@ax/core';

const PLUGIN_NAME = '@ax/mcp-client';
// ID is user-facing (used in tool namespacing like `mcp__<id>__<tool>`), so
// cap it at 64 chars — shorter than the credentials plugin's 128.
const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const STORAGE_KEY_PREFIX = 'mcp-server:';
const INDEX_KEY = 'mcp-server-index';

// Field names that strongly suggest inline secrets. Matched case-insensitively
// against every key, at every depth, in the config object.
//
// This is a name-based check. We do NOT sniff values — e.g. `args: ['--token=xxx']`
// will pass. Heuristic value-scanning is a rabbit hole and a footgun; we trust
// the user to use credentialRefs / headerCredentialRefs for real secrets, and
// this check exists only to catch the obvious `password: 'hunter2'` mistake.
const SECRET_LIKE = ['password', 'secret', 'token', 'apikey', 'api_key'] as const;

function rejectInlineSecrets(obj: unknown, path = '', seen = new WeakSet<object>()): void {
  if (obj === null || typeof obj !== 'object') return;
  if (seen.has(obj as object)) return;
  seen.add(obj as object);
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => rejectInlineSecrets(v, `${path}[${i}]`, seen));
    return;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (SECRET_LIKE.includes(lower as (typeof SECRET_LIKE)[number])) {
      throw new PluginError({
        code: 'inline-secret-rejected',
        plugin: PLUGIN_NAME,
        message: `inline secret field '${path}${k}' rejected — use credentialRefs / headerCredentialRefs instead`,
      });
    }
    rejectInlineSecrets(v, `${path}${k}.`, seen);
  }
}

const IdSchema = z.string().regex(ID_RE, {
  message: `id must match ${ID_RE.source}`,
});

const UrlSchema = z.string().refine((v) => /^https?:\/\//.test(v), {
  message: 'url must use http:// or https://',
});

const StdioConfig = z
  .object({
    id: IdSchema,
    enabled: z.boolean(),
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()).optional(),
    credentialRefs: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const HttpBase = {
  id: IdSchema,
  enabled: z.boolean(),
  url: UrlSchema,
  headerCredentialRefs: z.record(z.string(), z.string()).optional(),
};

const StreamableHttpConfig = z
  .object({ ...HttpBase, transport: z.literal('streamable-http') })
  .strict();

const SseConfig = z
  .object({ ...HttpBase, transport: z.literal('sse') })
  .strict();

export const McpServerConfigSchema = z.discriminatedUnion('transport', [
  StdioConfig,
  StreamableHttpConfig,
  SseConfig,
]);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * Parse an unknown value into a validated McpServerConfig.
 *
 * Runs the inline-secret scan BEFORE the Zod parse, so a `password` field
 * buried in a config produces a targeted "use credentialRefs instead" error
 * rather than a generic "unrecognized key" strict-mode failure.
 */
export function parseConfig(input: unknown): McpServerConfig {
  rejectInlineSecrets(input);
  return McpServerConfigSchema.parse(input);
}

// Storage I/O layer ---------------------------------------------------------

type CallFn = <I, O>(hook: string, ctx: ChatContext, input: I) => Promise<O>;
interface BusLike {
  call: CallFn;
}

function storageKey(id: string): string {
  return `${STORAGE_KEY_PREFIX}${id}`;
}

const dec = new TextDecoder();
const enc = new TextEncoder();

async function readIndex(bus: BusLike, ctx: ChatContext): Promise<string[]> {
  const got = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
    'storage:get',
    ctx,
    { key: INDEX_KEY },
  );
  if (got.value === undefined || got.value.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(got.value));
  } catch (err) {
    throw new PluginError({
      code: 'corrupt-index',
      plugin: PLUGIN_NAME,
      message: `mcp-server-index is not valid JSON`,
      cause: err,
    });
  }
  if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) {
    throw new PluginError({
      code: 'corrupt-index',
      plugin: PLUGIN_NAME,
      message: `mcp-server-index is not a JSON array of strings`,
    });
  }
  return parsed;
}

async function writeIndex(bus: BusLike, ctx: ChatContext, ids: string[]): Promise<void> {
  await bus.call('storage:set', ctx, {
    key: INDEX_KEY,
    value: enc.encode(JSON.stringify(ids)),
  });
}

export async function saveConfig(
  bus: BusLike,
  ctx: ChatContext,
  raw: unknown,
): Promise<McpServerConfig> {
  const cfg = parseConfig(raw);
  // Write the row first, then update the index. Mid-failure therefore leaves
  // an unindexed row (garbage but harmless) rather than an index entry pointing
  // at a non-existent row. loadConfigs tolerates the latter case too (it skips
  // missing ids), but row-first is still the less-confusing order.
  await bus.call('storage:set', ctx, {
    key: storageKey(cfg.id),
    value: enc.encode(JSON.stringify(cfg)),
  });
  const index = await readIndex(bus, ctx);
  if (!index.includes(cfg.id)) {
    index.push(cfg.id);
    await writeIndex(bus, ctx, index);
  }
  return cfg;
}

export async function loadConfigs(bus: BusLike, ctx: ChatContext): Promise<McpServerConfig[]> {
  const ids = await readIndex(bus, ctx);
  const results: McpServerConfig[] = [];
  for (const id of ids) {
    const got = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx,
      { key: storageKey(id) },
    );
    if (got.value === undefined || got.value.length === 0) {
      // Stale index entry (e.g. crash between row-write and index-write, or
      // a deleteConfig tombstone). Skip and carry on — a future `ax-next mcp
      // gc` subcommand can prune these.
      ctx.logger.warn('mcp-client: skipping stale index entry', { id });
      continue;
    }
    try {
      const cfg = parseConfig(JSON.parse(dec.decode(got.value)));
      results.push(cfg);
    } catch (err) {
      // Don't fail the entire load on one corrupt config — log and skip so
      // the rest of the configs remain reachable. The user can fix the bad
      // one via the CLI.
      ctx.logger.warn('mcp-client: skipping corrupt config', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
  }
  return results;
}

export async function deleteConfig(bus: BusLike, ctx: ChatContext, id: string): Promise<void> {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `id must match ${ID_RE.source}`,
    });
  }
  // @ax/storage-sqlite has no storage:delete yet; tombstone the row with an
  // empty buffer. loadConfigs treats empty values as stale and skips them.
  // Replace with a real delete when storage:delete lands.
  await bus.call('storage:set', ctx, {
    key: storageKey(id),
    value: new Uint8Array(0),
  });
  const index = await readIndex(bus, ctx);
  const next = index.filter((x) => x !== id);
  if (next.length !== index.length) {
    await writeIndex(bus, ctx, next);
  }
}
