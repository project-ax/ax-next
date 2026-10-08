import { PluginError, type AgentContext, type HookBus } from '@ax/core';

export const USER_ACCOUNT_PURGE_MARKER_KEY =
  'credentials:agent-owned-sign-ins:user-account-purged';

/**
 * One-time boot purge of person-level connector credentials (agent-owned
 * sign-ins, slice 5). A connector credential (`account:` ref) belongs to an
 * agent or to the whole workspace; one stored at a person's own (user) scope
 * would let an agent act as whoever is chatting with it. The lookup already
 * ignores those rows and `credentials:set` refuses new ones — this removes the
 * ones a vault written before the change still holds.
 *
 * `purge` is the plugin's own `credentials:purge-account` with
 * `{ scopes: ['user'] }` (every `account:` row at user scope, other ref
 * namespaces and other scopes untouched).
 *
 * Marker-guarded like `wipePreRedesignCredentials`, and it fails toward
 * keeping data without ever failing the boot:
 *   - no `storage:get` / `storage:set` producer -> skip (nowhere to record
 *     that it ran);
 *   - marker present -> skip;
 *   - any throw (marker read, purge, marker write) -> warn and return; the
 *     marker is only written after a purge that finished, so the next boot
 *     retries. Rows tombstoned before a midway failure stay tombstoned.
 *
 * Logs counts only — never a ref, an owner, or the error text (which can name
 * either) — and only when it removed something.
 */
export async function purgeUserAccountCredentials(
  bus: HookBus,
  ctx: AgentContext,
  purge: (ctx: AgentContext) => Promise<{ purged: number }>,
): Promise<{ ran: boolean; purged: number }> {
  if (!bus.hasService('storage:get') || !bus.hasService('storage:set')) {
    return { ran: false, purged: 0 };
  }
  try {
    const marker = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx,
      { key: USER_ACCOUNT_PURGE_MARKER_KEY },
    );
    if (marker.value !== undefined && marker.value.length > 0) {
      return { ran: false, purged: 0 };
    }
    const { purged } = await purge(ctx);
    await bus.call('storage:set', ctx, {
      key: USER_ACCOUNT_PURGE_MARKER_KEY,
      value: new TextEncoder().encode(new Date().toISOString()),
    });
    // Silent when there was nothing to remove: the CLI's boot ctx logs to
    // stdout, which is also where it prints the chat reply.
    if (purged > 0) ctx.logger.info('credentials_user_account_purged', { purged });
    return { ran: true, purged };
  } catch (err) {
    ctx.logger.warn('credentials_user_account_purge_failed', {
      code: err instanceof PluginError ? err.code : 'unknown',
    });
    return { ran: false, purged: 0 };
  }
}
