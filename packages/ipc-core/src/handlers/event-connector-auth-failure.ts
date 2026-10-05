import type { AgentContext, HookBus } from '@ax/core';
import { EventConnectorAuthFailureSchema, type EventConnectorAuthFailure } from '@ax/ipc-protocol';
import { validationError } from '../errors.js';
import type { HandlerErr } from './types.js';

// ---------------------------------------------------------------------------
// POST /event.connector-auth-failure (TASK-842)
//
// The runner saw a connector's MCP server refuse it (the SDK reported the
// server `needs-auth` / `failed` at session start, or one of its tools came
// back as an error mid-turn). Fire-and-forget: the runner never waits on what
// the host does about it.
//
// The payload is a HINT from an untrusted sender. This handler does not act
// on it: it validates the closed shape (namespaces + a status enum, nothing
// else), de-duplicates, and fires `connectors:auth-failure-reported`. The
// subscriber (@ax/mcp-client) re-checks the connector itself, so a runner
// that lies can at most cause a host-side check the connectors rail could
// have caused anyway, bounded by that check's per-connector cooldown.
//
// There is no user/agent in the body: who the session belongs to comes from
// `ctx`, bound by the IPC server's auth gate (the same rule as
// session.get-config). A runner cannot name another person's connector.
//
// Degradation: with no subscriber (the local CLI never loads the connector
// inventory), the fire is a no-op and the event is dropped, which is right:
// there is no rail there to update.
// ---------------------------------------------------------------------------

export const CONNECTOR_AUTH_FAILURE_HOOK = 'connectors:auth-failure-reported';

export type ConnectorAuthFailureReported = EventConnectorAuthFailure;

export function validateEventConnectorAuthFailure(rawPayload: unknown):
  | { ok: true; payload: ConnectorAuthFailureReported }
  | HandlerErr {
  const parsed = EventConnectorAuthFailureSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`event.connector-auth-failure: ${parsed.error.message}`);
  }
  // One entry per namespace (the first wins), so a repeated namespace cannot
  // fan out into repeated checks.
  const seen = new Set<string>();
  const servers = parsed.data.servers.filter((s) => {
    if (seen.has(s.toolNamespace)) return false;
    seen.add(s.toolNamespace);
    return true;
  });
  return { ok: true, payload: { servers } };
}

export async function fireEventConnectorAuthFailure(
  ctx: AgentContext,
  bus: HookBus,
  payload: unknown,
): Promise<void> {
  const result = await bus.fire(CONNECTOR_AUTH_FAILURE_HOOK, ctx, payload);
  if (result.rejected) {
    ctx.logger.info('observation_only_hook_rejection_ignored', {
      hook: CONNECTOR_AUTH_FAILURE_HOOK,
      reason: result.reason,
    });
  }
}
