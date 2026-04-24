import {
  PluginError,
  type FileChange,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceVersion,
} from '@ax/core';
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
// One per-turn (NOT per-tool-call) notify from the runner. Wire shape:
//   { parentVersion, commitRef, message, changes }
//
// Hook pipeline:
//   fire('workspace:pre-apply')  →  observe/transform, may reject
//   call('workspace:apply')      →  the registered workspace plugin
//   fire('workspace:applied')    →  observe-only (audit, scanners, etc.)
//
// `commitRef` is an opaque runner-side identifier (the runner's local
// snapshot handle — git impl uses a SHA, others may not). The host never
// dispatches on it; the `changes` array IS the source of truth. Keeping
// `commitRef` on the schema lets the runner correlate without forcing the
// host into a backend-specific lookup.
//
// Wire response is `{accepted, version, delta: null}` on success — the
// delta is intentionally NEVER serialized (Invariant I5). `WorkspaceDelta`
// carries lazy `contentBefore`/`contentAfter` fetchers that don't survive
// JSON, and exposing the content set across the trust boundary widens the
// blast radius of a compromised sandbox. Subscribers that need the delta
// run host-side via `workspace:applied`.
// ---------------------------------------------------------------------------

export const workspaceCommitNotifyHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = WorkspaceCommitNotifyRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`workspace.commit-notify: ${parsed.error.message}`);
  }
  const { parentVersion, message, changes } = parsed.data;

  // The wire schema's `parentVersion` is `string | null`; stamp the brand so
  // the workspace plugin keeps its opaque-token contract.
  const parent = (parentVersion as WorkspaceVersion | null) ?? null;
  // After Zod's transform, `changes[i].content` is a Uint8Array — shape-
  // compatible with the kernel `FileChange` type.
  const fileChanges: FileChange[] = changes;

  // ---- pre-apply: subscribers can transform or veto ----
  const pre = await bus.fire<{ changes: FileChange[]; parent: WorkspaceVersion | null; reason: string }>(
    'workspace:pre-apply',
    ctx,
    { changes: fileChanges, parent, reason: message },
  );
  if (pre.rejected) {
    const body = { accepted: false as const, reason: pre.reason };
    const checked = WorkspaceCommitNotifyResponseSchema.safeParse(body);
    if (!checked.success) {
      logInternalError(
        ctx.logger,
        'workspace.commit-notify',
        new Error(`response shape drift (rejected): ${checked.error.message}`),
      );
      return internalError();
    }
    return { status: 200, body: checked.data };
  }

  // ---- apply: thrown PluginError({code:'parent-mismatch'}) is the one
  // failure mode we surface as accepted:false. Anything else bubbles up
  // to the dispatcher, which turns it into a sanitized 500. ----
  let applied: WorkspaceApplyOutput;
  try {
    applied = await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      ctx,
      {
        changes: pre.payload.changes,
        parent: pre.payload.parent,
        reason: pre.payload.reason,
      },
    );
  } catch (err) {
    if (err instanceof PluginError && err.code === 'parent-mismatch') {
      const body = {
        accepted: false as const,
        reason: `parent-mismatch: ${err.message}`,
      };
      const checked = WorkspaceCommitNotifyResponseSchema.safeParse(body);
      if (!checked.success) {
        logInternalError(
          ctx.logger,
          'workspace.commit-notify',
          new Error(`response shape drift (parent-mismatch): ${checked.error.message}`),
        );
        return internalError();
      }
      return { status: 200, body: checked.data };
    }
    // Re-throw — the dispatcher's catch-all logs and writes a 500.
    throw err;
  }

  // ---- applied: observers (audit, canary, skill validator) get the
  // host-side delta with its lazy fetchers intact. ----
  const post = await bus.fire('workspace:applied', ctx, applied.delta);
  if (post.rejected) {
    // `workspace:applied` is post-fact — a "rejection" here means a
    // subscriber tried to veto something already landed. Treat as
    // misuse and 500 (sanitized). Log the reason for debugging.
    logInternalError(
      ctx.logger,
      'workspace.commit-notify',
      new Error(`workspace:applied subscriber rejected post-fact: ${post.reason}`),
    );
    return internalError();
  }

  const body = {
    accepted: true as const,
    // Wire schema brands the version via .transform on parse; we hand off
    // the unbranded string and let the schema re-brand on the way out.
    version: applied.version as string,
    delta: null,
  };
  const checked = WorkspaceCommitNotifyResponseSchema.safeParse(body);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'workspace.commit-notify',
      new Error(`response shape drift (accepted): ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
