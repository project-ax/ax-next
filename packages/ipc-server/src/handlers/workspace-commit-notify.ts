import {
  WorkspaceCommitNotifyRequestSchema,
  WorkspaceCommitNotifyResponseSchema,
} from '@ax/ipc-protocol';
import {
  internalError,
  logInternalError,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /workspace.commit-notify
//
// 6.5a STUB. We Zod-validate the request (so a mis-shaped caller gets 400 now
// and doesn't drift to the real impl later) but return a canned "accepted"
// response. The real `workspace:pre-apply` / `workspace:applied` subscribers
// don't exist yet — they land in Week 7–9 alongside the first workspace
// backend plugin. See:
//   docs/plans/2026-04-24-week-6.5a-topology-shift.md — Task 4, stub note
//   docs/plans/2026-04-24-week-6.5-agent-sandbox-design.md — workspace model
//
// Returning a plausible-shaped response keeps the sandbox-side runner honest:
// its parser exercises the happy branch of the discriminated union even
// while the host-side logic is absent.
// ---------------------------------------------------------------------------

export const workspaceCommitNotifyHandler: ActionHandler = async (rawPayload, ctx) => {
  const parsed = WorkspaceCommitNotifyRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`workspace.commit-notify: ${parsed.error.message}`);
  }

  // STUB: no subscribers fire, no service call. Week 7–9 replaces this.
  const body = {
    accepted: true as const,
    version: 'stub',
    delta: null,
  };
  const checked = WorkspaceCommitNotifyResponseSchema.safeParse(body);
  if (!checked.success) {
    // Shouldn't happen — the stub shape is controlled by this file — but the
    // defense-in-depth check catches the "someone changed the schema and
    // forgot to update the stub" class of bug.
    logInternalError(
      ctx.logger,
      'workspace.commit-notify',
      new Error(`stub shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
