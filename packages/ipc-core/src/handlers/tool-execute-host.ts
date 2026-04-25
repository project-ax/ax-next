import { PluginError } from '@ax/core';
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
    if (err instanceof PluginError) return mapPluginError(err);
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
