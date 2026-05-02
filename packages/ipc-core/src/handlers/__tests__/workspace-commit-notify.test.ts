import { describe, it, expect } from 'vitest';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type AgentContext,
} from '@ax/core';
import { createMockWorkspacePlugin } from '@ax/test-harness';
import { workspaceCommitNotifyHandler } from '../workspace-commit-notify.js';

// ---------------------------------------------------------------------------
// workspace.commit-notify handler — HALF-WIRED WINDOW (Phase 3 Slice 5).
//
// The wire schema bumped from `{commitRef, message, changes}` to
// `{parentVersion, reason, bundleBytes}`. Until Slice 6 ships the real
// bundler-driven handler, this handler returns
// `{accepted: false, reason: 'bundle-wire-not-implemented'}` for every
// well-formed request, and 400 VALIDATION for malformed ones.
//
// The Slice-6 commit replaces this file's tests with the real semantics
// (empty-bundle accepted, bundle decoded → pre-apply → apply → applied,
// veto, parent-mismatch, non-ax-runner author rejected).
// ---------------------------------------------------------------------------

interface Env {
  bus: HookBus;
  ctx: AgentContext;
}

async function makeEnv(): Promise<Env> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [createMockWorkspacePlugin()],
    config: {},
  });
  const ctx = makeAgentContext({
    sessionId: 'wcn-test',
    agentId: 'wcn-agent',
    userId: 'wcn-user',
  });
  return { bus, ctx };
}

describe('workspace.commit-notify handler (Phase 3 half-wired stub)', () => {
  it('returns accepted:false with bundle-wire-not-implemented for any well-formed request', async () => {
    const { bus, ctx } = await makeEnv();
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'turn',
        bundleBytes: '',
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      accepted: false,
      reason: 'bundle-wire-not-implemented',
    });
  });

  it('returns accepted:false even for non-empty bundles (Slice 6 closes the gap)', async () => {
    const { bus, ctx } = await makeEnv();
    const b64 = Buffer.from('PACK\x00\x00').toString('base64');
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: 'v-1',
        reason: 'turn',
        bundleBytes: b64,
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    expect((result.body as { accepted: boolean }).accepted).toBe(false);
  });

  it('rejects malformed request (missing bundleBytes) with 400 VALIDATION', async () => {
    const { bus, ctx } = await makeEnv();
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'turn',
        // Missing bundleBytes — schema rejects.
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(400);
    const errBody = result.body as { error: { code: string; message: string } };
    expect(errBody.error.code).toBe('VALIDATION');
    expect(errBody.error.message).toContain('workspace.commit-notify');
  });

  it('rejects legacy wire shape (commitRef + changes) with 400 VALIDATION', async () => {
    // The pre-Phase-3 wire is no longer accepted; runners that haven't
    // upgraded see a clear schema error rather than silent no-ops.
    const { bus, ctx } = await makeEnv();
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        commitRef: 'old-runner-token',
        message: 'legacy turn',
        changes: [{ path: 'a.txt', kind: 'put', content: 'aGVsbG8=' }],
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(400);
    const errBody = result.body as { error: { code: string; message: string } };
    expect(errBody.error.code).toBe('VALIDATION');
  });
});
