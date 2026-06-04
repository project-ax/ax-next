import { PluginError } from '@ax/core';
import {
  ProxyDrainEgressBlocksRequestSchema,
  ProxyDrainEgressBlocksResponseSchema,
  type ProxyDrainEgressBlocksRequest,
  type ProxyDrainEgressBlocksResponse,
} from '@ax/ipc-protocol';
import {
  internalError,
  logInternalError,
  mapPluginError,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /proxy.drain-egress-blocks
//
// Agent-visible egress-block note. The runner drains its session's allowlist-
// blocked hosts at PostToolUse; if any come back it injects a remediation note
// into the agent's context (the agent's own `npx`/curl saw only a cryptic
// `statusCode=403`). Calls the `proxy:drain-session-egress-blocks` service hook,
// which reads the session from `ctx.sessionId` (bound by the IPC server's auth
// gate after the bearer token resolves).
//
// The request body is `.strict({})`. There is intentionally NO sessionId in the
// body — an agent cannot drain someone else's session because the host reads
// ctx, not the body (the same load-bearing invariant as session.get-config). A
// future change adding a body field would need a security review; the schema
// keeps that conversation visible.
//
// Degradation: the single-session CLI never loads @ax/credential-proxy, so the
// hook is absent there. We guard with hasService and return an empty list
// rather than 500 — a missing egress proxy means there were no policy blocks to
// surface (the CLI has no allowlist gate), so an empty drain is the correct,
// non-fatal answer. (Declared `optional` in DISPATCHER_DEPENDENCIES.)
// ---------------------------------------------------------------------------

interface BusDrainOutput {
  hosts: string[];
}

export const proxyDrainEgressBlocksHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = ProxyDrainEgressBlocksRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`proxy.drain-egress-blocks: ${parsed.error.message}`);
  }

  // No egress proxy in this deployment → no allowlist gate → nothing to drain.
  // (Inline hook literal — the dependency-sync scanner keys off the call site.)
  if (!bus.hasService('proxy:drain-session-egress-blocks')) {
    return { status: 200, body: { hosts: [] } satisfies ProxyDrainEgressBlocksResponse };
  }

  let drained: BusDrainOutput;
  try {
    drained = await bus.call<ProxyDrainEgressBlocksRequest, BusDrainOutput>(
      'proxy:drain-session-egress-blocks',
      ctx,
      parsed.data,
    );
  } catch (err) {
    logInternalError(ctx.logger, 'proxy.drain-egress-blocks', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }

  const checked = ProxyDrainEgressBlocksResponseSchema.safeParse(drained);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'proxy.drain-egress-blocks',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
