// ---------------------------------------------------------------------------
// Boot-time sweep: retire every stored host MCP server (TASK-792).
//
// Host MCP servers — the `mcp-server:<id>` rows behind `/admin/mcp-servers`
// and `ax-next mcp`, connected at boot and exposed as `mcp.<id>.<tool>` —
// were retired 2026-10-04 (docs/plans/2026-10-04-retire-host-mcp-servers.md).
// Connectors cover the need. Nothing reads these rows any more, so we
// hard-delete them rather than leave dead config (and the secrets it points
// at) sitting in storage.
//
// For every `mcp-server:<id>` key (found by prefix, so a row that fell out of
// `mcp-server-index` is swept too; tombstones — empty values — included):
//
//   1. If the row is live, delete every credential whose ref starts with
//      `mcp:<id>:` (header, env, any kind). `credentials:list` is read once
//      for the whole sweep. Skipped when the credentials service isn't loaded.
//      An id that is empty or contains ':' gets no purge: its namespace would
//      reach into another server's (`a:header` → `mcp:a:header:...`).
//   2. If the purge failed, keep the row so the next boot retries — the row
//      is the only record that those credentials need cleaning up.
//   3. Otherwise hard-delete the row (`storage:delete`).
//
// When no row was kept, `mcp-server-index` goes too. Idempotent. Logs only a
// count, and only when it removed something (the CLI preset loads this plugin
// and a quiet boot must stay quiet). Never logs a row value or a ref.
// ---------------------------------------------------------------------------

import type { AgentContext, HookBus } from '@ax/core';

const ROW_PREFIX = 'mcp-server:';
const INDEX_KEY = 'mcp-server-index';

interface CredentialRow {
  scope: 'global' | 'user' | 'agent';
  ownerId: string | null;
  ref: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function sweepHostMcpServers(bus: HookBus, ctx: AgentContext): Promise<number> {
  const { entries } = await bus.call<
    { prefix: string },
    { entries: Array<{ key: string; value: Uint8Array }> }
  >('storage:list-prefix', ctx, { prefix: ROW_PREFIX });

  const canPurge = bus.hasService('credentials:list') && bus.hasService('credentials:delete');
  // One read of the vault for the whole sweep, taken lazily so a store with
  // only tombstones (or nothing) never touches credentials at all.
  let credentials: Promise<CredentialRow[]> | undefined;
  const listCredentials = (): Promise<CredentialRow[]> => {
    credentials ??= bus
      .call<Record<string, never>, { credentials: CredentialRow[] }>('credentials:list', ctx, {})
      .then((r) => r.credentials);
    return credentials;
  };

  let count = 0;
  let kept = 0;
  for (const { key, value } of entries) {
    if (!key.startsWith(ROW_PREFIX)) continue; // defence: the store already filtered
    const id = key.slice(ROW_PREFIX.length);
    const live = value.length > 0;

    if (live && canPurge && id.length > 0 && !id.includes(':')) {
      const own = `mcp:${id}:`;
      try {
        for (const c of await listCredentials()) {
          if (!c.ref.startsWith(own)) continue;
          await bus.call<CredentialRow, void>('credentials:delete', ctx, {
            scope: c.scope,
            ownerId: c.ownerId,
            ref: c.ref,
          });
        }
      } catch (err) {
        ctx.logger.warn('mcp_host_server_sweep_purge_failed', {
          serverId: id,
          err: errMessage(err),
        });
        kept += 1;
        continue;
      }
    }

    try {
      const { deleted } = await bus.call<{ key: string }, { deleted: number }>(
        'storage:delete',
        ctx,
        { key },
      );
      if (live && deleted > 0) count += 1;
    } catch (err) {
      // One bad row must neither stop the sweep nor fail plugin init.
      ctx.logger.warn('mcp_host_server_sweep_delete_failed', {
        serverId: id,
        err: errMessage(err),
      });
      kept += 1;
    }
  }

  if (kept === 0) {
    try {
      await bus.call<{ key: string }, { deleted: number }>('storage:delete', ctx, { key: INDEX_KEY });
    } catch (err) {
      // Same rule as a row: a failed delete is retried next boot, never fatal.
      ctx.logger.warn('mcp_host_server_sweep_index_delete_failed', { err: errMessage(err) });
    }
  }
  if (count > 0) ctx.logger.info('mcp_host_servers_swept', { count });
  return count;
}
