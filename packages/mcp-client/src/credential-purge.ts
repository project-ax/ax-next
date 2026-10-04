import type { AgentContext, HookBus } from '@ax/core';

// ---------------------------------------------------------------------------
// Credential purge helper
//
// Called on server-delete (all declared header slots), on config-update (only
// slots dropped from the new config) and by the boot-time stdio sweep (the env
// slots a retired stdio row declared). Soft-dep on credentials:list /
// credentials:delete — gracefully skipped if those services aren't loaded
// (e.g. CLI or sandbox-side contexts). Wrapped in try/catch at call sites so
// a credential hiccup never wedges an MCP operation.
// ---------------------------------------------------------------------------

export interface CredentialRow {
  scope: 'global' | 'user' | 'agent';
  ownerId: string | null;
  ref: string;
}

export async function purgeMcpCredentials(
  bus: HookBus,
  ctx: AgentContext,
  serverId: string,
  envNames: string[],
  headerNames: string[],
): Promise<void> {
  if (envNames.length === 0 && headerNames.length === 0) return;
  if (!bus.hasService('credentials:list') || !bus.hasService('credentials:delete')) return;

  const refsToDelete = new Set<string>([
    ...envNames.map((n) => `mcp:${serverId}:env:${n}`),
    ...headerNames.map((n) => `mcp:${serverId}:header:${n}`),
  ]);

  const { credentials } = await bus.call<
    Record<string, never>,
    { credentials: CredentialRow[] }
  >('credentials:list', ctx, {});

  for (const c of credentials) {
    if (!refsToDelete.has(c.ref)) continue;
    await bus.call<CredentialRow, void>('credentials:delete', ctx, {
      scope: c.scope,
      ownerId: c.ownerId,
      ref: c.ref,
    });
  }
}
