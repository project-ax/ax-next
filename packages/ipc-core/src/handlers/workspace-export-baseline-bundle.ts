import { type WorkspaceVersion } from '@ax/core';
import type {
  WorkspaceExportBaselineBundleInput,
  WorkspaceExportBaselineBundleOutput,
} from '@ax/workspace-bundle-protocol';
import { WorkspaceExportBaselineBundleRequestSchema } from '@ax/ipc-protocol';
import {
  internalError,
  logInternalError,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /workspace.export-baseline-bundle
//
// Sandbox -> Host RPC fired ON THE COMMIT-NOTIFY RE-SYNC PATH only. When a
// concurrent writer advanced the workspace head past the runner's parent
// version, `workspace.commit-notify` returns `{accepted:false, actualParent}`
// (a small JSON signal — NO bundle bytes). The runner then calls THIS action
// with `{ version: actualParent }` to fetch the baseline git bundle AT that
// head, rebases its turn onto it, and retries the commit-notify.
//
// Why a raw binary body (same bug class as materialize's BUG-W3): the baseline
// bundle grows unbounded with workspace age (one commit per turn). The OLD
// shape inlined it base64-in-JSON in the commit-notify re-sync response, which
// (a) inflated it ~33% and (b) had to be buffered whole in memory on both ends
// under the 4 MiB `MAX_RESPONSE_BYTES` cap. An aged workspace blew the cap, the
// re-sync never completed, the turn timed out, the session was terminated, and
// a late commit-notify hit the terminated session → `unknown token` → an
// infinite re-ask loop. Streaming the raw bytes here drops the base64 tax and
// the in-memory cap wall — the runner drains to disk under a much higher,
// disk-bounded ceiling, exactly like materialize.
//
// The bundle bytes still come from the bundle-aware backend's base64-returning
// `workspace:export-baseline-bundle` SERVICE hook (unchanged — the same hook
// materialize and commit-notify already use; NO direct backend import, so
// Invariant I2 stays clean). We decode to a Buffer at THIS wire edge and stream
// it. The base64 round-trip is host-local memory only, never the wire.
//
// `git bundle` is git-vocabulary on the wire — by Invariant I1 that's allowed
// here because this is the sandbox-host transport axis, not a subscriber-visible
// hook payload. No `workspace:*` bus hook ever sees these bundle bytes on the
// wire — they go straight into the runner's `git fetch` for the rebase.
//
// Backend gate: a backend that doesn't register `workspace:export-baseline-bundle`
// can't serve this. That's the SAME Phase 3 contract commit-notify enforces (a
// re-sync can only happen on a backend that participates in the bundle wire), so
// reaching here without the hook is a host-config bug → sanitized 500.
//
// Error sanitization: the underlying git stderr can echo a temp path or
// filename, neither of which the sandbox should see in an error envelope. Real
// diagnostic goes to the host log via `logInternalError`. A `parent-mismatch`
// from the backend (the requested version is no longer the head — yet another
// concurrent writer) is sanitized to 500 as well: the runner's retry loop
// re-materializes from scratch on a `kept` outcome rather than chasing an
// ever-advancing head here.
// ---------------------------------------------------------------------------

export const workspaceExportBaselineBundleHandler: ActionHandler = async (
  rawPayload,
  ctx,
  bus,
) => {
  const parsed = WorkspaceExportBaselineBundleRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(
      `workspace.export-baseline-bundle: ${parsed.error.message}`,
    );
  }
  const { version } = parsed.data;

  if (!bus.hasService('workspace:export-baseline-bundle')) {
    logInternalError(
      ctx.logger,
      'workspace.export-baseline-bundle',
      new Error(
        'no registered workspace plugin implements workspace:export-baseline-bundle (the bundle-wire re-sync path requires it; provided by @ax/workspace-git and @ax/workspace-git-server)',
      ),
    );
    return internalError();
  }

  let bundleBytes: string;
  try {
    const out = await bus.call<
      WorkspaceExportBaselineBundleInput,
      WorkspaceExportBaselineBundleOutput
    >('workspace:export-baseline-bundle', ctx, {
      version: version as WorkspaceVersion,
    });
    bundleBytes = out.bundleBytes;
  } catch (err) {
    // Bundle construction / parent-mismatch failures are sanitized to 500 — the
    // underlying git stderr can echo a temp path or filename, neither of which
    // the sandbox should see. Real diagnostic goes to the host log.
    logInternalError(ctx.logger, 'workspace.export-baseline-bundle', err);
    return internalError();
  }

  // Decode the backend's base64 bundle to raw bytes and stream it as the binary
  // response body. The base64→Buffer round-trip is host-local memory only; the
  // wire carries raw bytes (no 33% tax, no JSON-frame cap).
  const binary = Buffer.from(bundleBytes, 'base64');
  return { status: 200, binary, contentType: 'application/octet-stream' };
};
