// Boot-time sweep: hard-delete every stored stdio MCP server config (stdio was
// removed 2026-10-04 — docs/plans/2026-10-04-drop-stdio-mcp-design.md). Reads
// RAW JSON because parseConfig no longer accepts these rows. Purges the env
// credential slots the row declared (env / credentialRefs keys, plus any
// credentialRefs value in the row's own `mcp:<id>:env:` namespace), tombstones the row (the same empty-buffer
// delete `deleteConfig` uses — there is no storage:delete), and drops it from
// the index. Idempotent; logs a count only, and only when it removed something
// (the default logger writes to stdout, and the CLI preset loads this plugin —
// a quiet boot must stay quiet or `ax-next "prompt"` output gets a log line).
//
// Runs BEFORE `loadConfigs` in plugin init, so a stored stdio row is retired
// before anything could connect to it — no MCP server process is ever spawned
// on the host.
import type { AgentContext, HookBus } from '@ax/core';
import { deleteConfig } from './config.js';
import { purgeMcpCredentials } from './credential-purge.js';

const dec = new TextDecoder();

export async function sweepStdioConfigs(bus: HookBus, ctx: AgentContext): Promise<number> {
  const idx = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
    'storage:get',
    ctx,
    { key: 'mcp-server-index' },
  );
  if (idx.value === undefined || idx.value.length === 0) return 0;
  let ids: unknown;
  try {
    ids = JSON.parse(dec.decode(idx.value));
  } catch {
    return 0; // loadConfigs reports a corrupt index; not ours to fix here
  }
  if (!Array.isArray(ids)) return 0;

  let count = 0;
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const got = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx,
      { key: `mcp-server:${id}` },
    );
    if (got.value === undefined || got.value.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(dec.decode(got.value));
    } catch {
      continue;
    }
    const r = raw as { transport?: unknown; env?: unknown; credentialRefs?: unknown } | null;
    if (r?.transport !== 'stdio') continue;
    const refs =
      typeof r.credentialRefs === 'object' && r.credentialRefs !== null
        ? (r.credentialRefs as Record<string, unknown>)
        : {};
    // The old stdio transport resolved secrets through credentialRefs VALUES,
    // so a value can name a vault ref whose key differs from the env name. Purge
    // those too — but only refs in THIS server's own `mcp:<id>:env:` namespace,
    // never a ref that belongs to anything else.
    const ownPrefix = `mcp:${id}:env:`;
    const refNames = Object.values(refs)
      .filter((v): v is string => typeof v === 'string' && v.startsWith(ownPrefix))
      .map((v) => v.slice(ownPrefix.length))
      .filter((n) => n.length > 0);
    const envNames = [
      ...Object.keys(typeof r.env === 'object' && r.env !== null ? r.env : {}),
      ...Object.keys(refs),
      ...refNames,
    ];
    try {
      await purgeMcpCredentials(bus, ctx, id, [...new Set(envNames)], []);
    } catch (err) {
      ctx.logger.warn('mcp_stdio_sweep_purge_failed', {
        serverId: id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await deleteConfig(bus, ctx, id);
    } catch (err) {
      // deleteConfig rejects an id that fails ID_RE. One bad row must neither
      // stop the sweep nor fail plugin init.
      ctx.logger.warn('mcp_stdio_sweep_delete_failed', {
        serverId: id,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    count += 1;
  }
  if (count > 0) ctx.logger.info('mcp_stdio_configs_swept', { count });
  return count;
}
