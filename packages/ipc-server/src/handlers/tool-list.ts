import { PluginError } from '@ax/core';
import {
  ToolListRequestSchema,
  ToolListResponseSchema,
  type ToolListRequest,
  type ToolListResponse,
} from '@ax/ipc-protocol';
import {
  internalError,
  logInternalError,
  mapPluginError,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /tool.list
//
// Calls the `tool:list` service hook. In production this is registered by
// @ax/tool-dispatcher (Task 7) which assembles the catalog at boot from each
// tool plugin's `tool:register` call. In tests, the mock harness registers
// a canned impl via `services` on createTestHarness.
//
// Request schema is `.strict({})` — no knobs today. We still run it through
// Zod so a future extension can't silently accept junk.
// ---------------------------------------------------------------------------

export const toolListHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = ToolListRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`tool.list: ${parsed.error.message}`);
  }

  let result: ToolListResponse;
  try {
    result = await bus.call<ToolListRequest, ToolListResponse>(
      'tool:list',
      ctx,
      parsed.data,
    );
  } catch (err) {
    logInternalError(ctx.logger, 'tool.list', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }

  const checked = ToolListResponseSchema.safeParse(result);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'tool.list',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
