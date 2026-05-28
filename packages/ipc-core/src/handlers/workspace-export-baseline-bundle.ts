import { PluginError, type WorkspaceVersion } from '@ax/core';
import type {
  WorkspaceExportBaselineBundleInput,
  WorkspaceExportBaselineBundleOutput,
} from '@ax/workspace-bundle-protocol';
import { WorkspaceExportBaselineBundleRequestSchema } from '@ax/ipc-protocol';
import {
  hookRejected,
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
// diagnostic goes to the host log via `logInternalError`. The wire body is
// always generic.
//
// Status mapping matters here for retry behavior (P2b). A `parent-mismatch`
// from the backend means yet another writer advanced the head past `version`
// between commit-notify returning `actualParent` and this fetch landing — i.e.
// the head moved AGAIN. This is a STALE-fetch race, not a transient fault, and
// it WILL recur identically if retried. The sandbox's `IpcClient.callBinary`
// classifies 5xx as RETRYABLE (a small finite 5xx retry cap), so a 500 here
// would make it reissue the SAME stale fetch several times — each rebuilding
// the large bundle on the git-server backend — before the runner's bounded
// re-sync loop ever re-asks commit-notify for the fresher head, amplifying the
// stall this whole change exists to fix. So we map `parent-mismatch` to a
// sanitized 409 (conflict): callBinary treats 4xx as NON-retryable and fails
// fast, letting the runner's bounded re-sync loop immediately re-call
// commit-notify, learn the NEW actualParent, and fetch THAT. The body stays
// sanitized — no OID / fresher-head / git-path leak, just a generic conflict.
//
// Every OTHER failure (no backend, a real git error, a transient backend
// hiccup) keeps the sanitized 500 so callBinary's bounded 5xx retry can ride
// out a transient blip.
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
    // The real diagnostic (git stderr, fresher head in cause.actualParent, etc.)
    // always goes to the host log; the wire body is always generic.
    logInternalError(ctx.logger, 'workspace.export-baseline-bundle', err);
    // A `parent-mismatch` is the head-moved-again race — a STALE fetch that
    // would recur identically if retried. Map it to a sanitized, NON-retryable
    // 409 so the sandbox's callBinary fails fast and the runner's re-sync loop
    // re-asks commit-notify for the fresher head (P2b). The generic
    // `hookRejected` message carries no OID / head / path.
    if (err instanceof PluginError && err.code === 'parent-mismatch') {
      return hookRejected('conflict');
    }
    // Every other failure (real git error, transient backend hiccup) stays a
    // sanitized 500 — callBinary's bounded 5xx retry can ride out a blip.
    return internalError();
  }

  // Decode the backend's base64 bundle to raw bytes and stream it as the binary
  // response body. The base64→Buffer round-trip is host-local memory only; the
  // wire carries raw bytes (no 33% tax, no JSON-frame cap).
  const binary = Buffer.from(bundleBytes, 'base64');
  return { status: 200, binary, contentType: 'application/octet-stream' };
};
