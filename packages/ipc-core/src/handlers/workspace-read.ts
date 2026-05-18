import type {
  WorkspaceReadInput,
  WorkspaceReadOutput,
} from '@ax/core';
import {
  WorkspaceReadRequestSchema,
  WorkspaceReadResponseSchema,
} from '@ax/ipc-protocol';
import { internalError, logInternalError, validationError } from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /workspace.read — Phase 2 (attachments translation, D3).
//
// Bridges the wire shape to the host's existing `workspace:read` service
// hook. The caller's session row scopes which workspace is read; we
// never accept a workspaceId on the wire (the session bearer is the
// authority).
//
// Bytes round-trip base64-encoded. The hook returns Buffer; we encode at
// the boundary so the JSON envelope is unambiguous.
// ---------------------------------------------------------------------------

export const workspaceReadHandler: ActionHandler = async (
  rawPayload,
  ctx,
  bus,
) => {
  const parsed = WorkspaceReadRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`workspace.read: ${parsed.error.message}`);
  }

  let body: { found: true; bytesBase64: string } | { found: false };
  try {
    const result = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      ctx,
      { path: parsed.data.path },
    );
    if (result.found) {
      body = {
        found: true,
        bytesBase64: Buffer.from(result.bytes).toString('base64'),
      };
    } else {
      body = { found: false };
    }
  } catch (err) {
    logInternalError(ctx.logger, 'workspace.read', err);
    return internalError();
  }

  const checked = WorkspaceReadResponseSchema.safeParse(body);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'workspace.read',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
