import type { AgentContext, HookBus } from '@ax/core';

export const WIPE_MARKER_KEY = 'credentials:redesign-2026-05-19:wiped';
export const CREDENTIAL_PREFIX = 'credential:'; // strict superset of v1 + v2

/**
 * One-shot wipe of pre-redesign credential rows. Idempotent via a marker
 * key in `storage:set`. Safe to re-run; the second invocation reads the
 * marker and skips the delete.
 *
 * Pre-MVP / kind-dev only — see design §5. To force a re-wipe, delete the
 * marker key (`credentials:redesign-2026-05-19:wiped`) from storage, then
 * call again.
 */
export async function wipePreRedesignCredentials(
  bus: HookBus,
  ctx: AgentContext,
): Promise<{ wiped: boolean; deleted: number }> {
  const marker = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
    'storage:get',
    ctx,
    { key: WIPE_MARKER_KEY },
  );
  if (marker.value !== undefined && marker.value.length > 0) {
    return { wiped: false, deleted: 0 };
  }
  const { deleted } = await bus.call<{ prefix: string }, { deleted: number }>(
    'storage:delete-prefix',
    ctx,
    { prefix: CREDENTIAL_PREFIX },
  );
  await bus.call('storage:set', ctx, {
    key: WIPE_MARKER_KEY,
    value: new TextEncoder().encode(new Date().toISOString()),
  });
  return { wiped: true, deleted };
}
