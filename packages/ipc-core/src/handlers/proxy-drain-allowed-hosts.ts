import { PluginError } from '@ax/core';
import {
  ProxyDrainAllowedHostsRequestSchema,
  ProxyDrainAllowedHostsResponseSchema,
  type ProxyDrainAllowedHostsRequest,
  type ProxyDrainAllowedHostsResponse,
} from '@ax/ipc-protocol';
import { zodSummary,
  internalError,
  logInternalError,
  mapPluginError,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /proxy.drain-allowed-hosts (TASK-1199)
//
// The "now allowed" line. When a person allows a blocked host, the host-only
// `proxy:add-host` widens the live session allowlist and records the host. The
// runner drains that record at the start of each person's turn; if any hosts
// come back it opens the turn with a system line saying they are now allowed
// (the block note had told the agent to stop retrying). Calls the
// `proxy:drain-session-allowed-hosts` service hook, which reads the session
// from `ctx.sessionId` (bound by the IPC server's auth gate after the bearer
// token resolves).
//
// The request body is `.strict({})`. There is intentionally NO sessionId in the
// body — an agent cannot drain someone else's session because the host reads
// ctx, not the body (the same load-bearing invariant as session.get-config and
// proxy.drain-egress-blocks). A future change adding a body field would need a
// security review; the schema keeps that conversation visible. This action
// only reads and clears; it never widens egress (proxy:add-host stays off the
// IPC surface).
//
// Degradation: the single-session CLI never loads @ax/credential-proxy, so the
// hook is absent there. We guard with hasService and return an empty list
// rather than 500 — no egress proxy means no live host grants, so an empty
// drain is the correct, non-fatal answer. (Declared `optional` in
// DISPATCHER_DEPENDENCIES.)
// ---------------------------------------------------------------------------

interface BusDrainOutput {
  hosts: string[];
}

export const proxyDrainAllowedHostsHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = ProxyDrainAllowedHostsRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`proxy.drain-allowed-hosts: ${zodSummary(parsed.error)}`);
  }

  // No egress proxy in this deployment → no live host grants → nothing to drain.
  // (Inline hook literal — the dependency-sync scanner keys off the call site.)
  if (!bus.hasService('proxy:drain-session-allowed-hosts')) {
    return { status: 200, body: { hosts: [] } satisfies ProxyDrainAllowedHostsResponse };
  }

  let drained: BusDrainOutput;
  try {
    drained = await bus.call<ProxyDrainAllowedHostsRequest, BusDrainOutput>(
      'proxy:drain-session-allowed-hosts',
      ctx,
      parsed.data,
    );
  } catch (err) {
    logInternalError(ctx.logger, 'proxy.drain-allowed-hosts', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }

  const checked = ProxyDrainAllowedHostsResponseSchema.safeParse(drained);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'proxy.drain-allowed-hosts',
      new Error(`response shape drift: ${zodSummary(checked.error)}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
