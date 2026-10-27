import { PluginError, SafeToolError, safeToolMessage } from '@ax/core';
import {
  ToolExecuteHostRequestSchema,
  ToolExecuteHostResponseSchema,
  type ToolExecuteHostRequest,
} from '@ax/ipc-protocol';
import {
  internalError,
  logInternalError,
  mapPluginError,
  notFound,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /tool.execute-host
//
// Looks up a service hook named `tool:execute:${call.name}`. This is the
// *dynamic* service-hook lookup exception — the same pattern the legacy
// tool-dispatcher uses. The `calls` manifest can't list a hook name that
// depends on caller-supplied data, so we document the exception in plugin.ts.
//
// 6.5a ships with NO host-side tools registered (all current tools run in
// the sandbox). The only path that gets real coverage here is the 404 — a
// sandbox-side tool dispatcher mis-routing to the host. The happy path
// lights up once host-only tools land (Week 10+).
// ---------------------------------------------------------------------------

export const toolExecuteHostHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = ToolExecuteHostRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`tool.execute-host: ${parsed.error.message}`);
  }

  const { call } = parsed.data as ToolExecuteHostRequest;
  const hookName = `tool:execute:${call.name}`;

  if (!bus.hasService(hookName)) {
    return notFound(`no host-side tool for '${call.name}'`);
  }

  let output: unknown;
  try {
    output = await bus.call<typeof call, unknown>(hookName, ctx, call);
  } catch (err) {
    logInternalError(ctx.logger, 'tool.execute-host', err);
    if (err instanceof SafeToolError) {
      // Subtype identity allows only the CLOSED templates. Plugin code can
      // mutate Error.message and even these fields: recheck at the wire boundary.
      const message = safeToolMessage(err.toolCode, err.field);
      switch (err.toolCode) {
        case 'validation':
          return validationError(message);
        case 'not-found':
          return notFound(message);
        case 'forbidden':
        case 'not-in-check-in':
        case 'approval-required':
          return { status: 403, body: { error: { code: 'HOOK_REJECTED', message } } };
        case 'revision-conflict':
        case 'webhook-path-conflict':
        case 'request-conflict':
        case 'busy':
        case 'disabled':
        case 'cleanup-pending':
          return { status: 409, body: { error: { code: 'HOOK_REJECTED', message } } };
        case 'unavailable':
          return { status: 503, body: { error: { code: 'INTERNAL', message } } };
        default: {
          // Compile-time: a new SafeToolCode without a case above fails tsc here.
          // Runtime: a mutated/unknown code still lands on the closed 503.
          const unmapped: never = err.toolCode;
          void unmapped;
          return { status: 503, body: { error: { code: 'INTERNAL', message } } };
        }
      }
    }
    if (err instanceof PluginError) {
      // Generic redaction: a PluginError thrown by a host tool buckets to a
      // safe wire status via mapPluginError — its message is never painted onto
      // the wire (I9), because `PluginError.code`/`.plugin` are plugin-supplied
      // and a host tool's failure could carry a host-side secret. See errors.ts.
      return mapPluginError(err);
    }
    return internalError();
  }

  const checked = ToolExecuteHostResponseSchema.safeParse({ output });
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'tool.execute-host',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
