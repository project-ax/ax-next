import { PluginError } from '@ax/core';
import {
  ConversationDrainSaveRefusalsRequestSchema,
  ConversationDrainSaveRefusalsResponseSchema,
  type ConversationDrainSaveRefusalsResponse,
} from '@ax/ipc-protocol';
import {
  internalError,
  logInternalError,
  mapPluginError,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /conversation.drain-save-refusals — TASK-749
//
// The refused workspace saves the runner's MODEL has not been told about yet
// (TASK-731's `save-refused` display rows above a per-conversation watermark),
// taken once. The runner calls it as it builds each turn, so a refusal whose
// runner process is gone — the final/idle save, or a runner that exited before
// its next message — still reaches the model on the next turn.
//
// The body is `.strict({})`. The conversation comes from `ctx.conversationId`
// and the owner from `ctx.userId`, both bound by the IPC server's auth gate to
// the bearer token — never from the body — so a runner can only drain its own
// conversation (same invariant as proxy.drain-egress-blocks). The only thing a
// misbehaving runner can do with it is keep its own model uninformed.
//
// Degradation: a run with no conversation (the single-session CLI) or a
// deployment without @ax/conversations has nothing to drain → `{ refusals: [] }`
// rather than a 500. (Declared `optional` in DISPATCHER_DEPENDENCIES.)
// ---------------------------------------------------------------------------

interface BusDrainInput {
  conversationId: string;
}

export const conversationDrainSaveRefusalsHandler: ActionHandler = async (
  rawPayload,
  ctx,
  bus,
) => {
  const parsed = ConversationDrainSaveRefusalsRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`conversation.drain-save-refusals: ${parsed.error.message}`);
  }

  const empty = { refusals: [] } satisfies ConversationDrainSaveRefusalsResponse;
  const conversationId = ctx.conversationId;
  // (Inline hook literal — the dependency-sync scanner keys off the call site.)
  if (
    conversationId === undefined ||
    conversationId.length === 0 ||
    !bus.hasService('conversations:drain-save-refusals')
  ) {
    return { status: 200, body: empty };
  }

  let drained: unknown;
  try {
    drained = await bus.call<BusDrainInput, unknown>(
      'conversations:drain-save-refusals',
      ctx,
      { conversationId },
    );
  } catch (err) {
    logInternalError(ctx.logger, 'conversation.drain-save-refusals', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }

  // Shape-drift defense: the wire carries closed codes and bounded ids only.
  const checked = ConversationDrainSaveRefusalsResponseSchema.safeParse(drained);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'conversation.drain-save-refusals',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
