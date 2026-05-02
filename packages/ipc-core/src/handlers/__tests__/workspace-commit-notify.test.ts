import { describe, it, expect } from 'vitest';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type Plugin,
  type WorkspaceVersion,
} from '@ax/core';
import { createMockWorkspacePlugin } from '@ax/test-harness';
import { workspaceCommitNotifyHandler } from '../workspace-commit-notify.js';

// ---------------------------------------------------------------------------
// workspace.commit-notify handler — handler-specific tests.
//
// The bundler pipeline (verify → walk → filter → prepareScratchRepo) is
// covered exhaustively by the bundler unit tests
// (`packages/ipc-core/src/bundler/__tests__/{filter,scratch,verify,walk}.test.ts`).
// The end-to-end commit-notify path against a real workspace-git-server
// is covered by the Phase 3 canary scenarios in
// `presets/k8s/src/__tests__/acceptance.test.ts`.
//
// What's left for THIS file: handler-specific concerns the bundler
// tests can't see and the canary doesn't isolate cleanly.
//   - Empty-bundle short-circuit (no apply, no bundler call).
//   - Schema validation (400 VALIDATION on malformed wire).
//   - Backend gate (Phase 3 wire requires
//     workspace:export-baseline-bundle to be registered; otherwise
//     the handler refuses up front rather than silently mis-handling
//     subsequent applies).
// ---------------------------------------------------------------------------

interface Env {
  bus: HookBus;
  ctx: AgentContext;
}

async function makeEnv(extraPlugins: Plugin[] = []): Promise<Env> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [createMockWorkspacePlugin(), ...extraPlugins],
    config: {},
  });
  const ctx = makeAgentContext({
    sessionId: 'wcn-test',
    agentId: 'wcn-agent',
    userId: 'wcn-user',
  });
  return { bus, ctx };
}

describe('workspace.commit-notify handler — empty bundle', () => {
  it('short-circuits to accepted:true with parentVersion preserved', async () => {
    const { bus, ctx } = await makeEnv();
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: 'v-existing',
        reason: 'turn',
        bundleBytes: '',
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    const body = result.body as { accepted: true; version: string };
    expect(body.accepted).toBe(true);
    expect(body.version).toBe('v-existing');
  });

  it('short-circuits to accepted:true even with null parentVersion', async () => {
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
    expect((result.body as { accepted: boolean }).accepted).toBe(true);
  });
});

describe('workspace.commit-notify handler — schema validation', () => {
  it('malformed request (missing bundleBytes) → 400 VALIDATION', async () => {
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

  it('rejects non-base64 bundleBytes with 400 VALIDATION', async () => {
    // The shared BundleBytesSchema validates canonical base64 at the
    // protocol boundary so malformed payloads surface as a request
    // error here rather than as an INTERNAL 500 deep in
    // `git fetch <bundle>`.
    const { bus, ctx } = await makeEnv();
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'turn',
        bundleBytes: 'not!valid!base64!!',
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(400);
    const errBody = result.body as { error: { code: string; message: string } };
    expect(errBody.error.code).toBe('VALIDATION');
  });
});

describe('workspace.commit-notify handler — backend gate', () => {
  it('returns 500 when workspace:export-baseline-bundle is not registered', async () => {
    // MockWorkspace registers apply/read/list/diff but NOT the Phase 3
    // bundle hooks. A non-empty bundleBytes from the runner needs the
    // host to load a baseline before the bundler can decode the thin
    // bundle; without export-baseline-bundle there's no way to do
    // that for subsequent turns. Reject up front (500 with a logged
    // diagnostic) rather than silently breaking on turn 2.
    const { bus, ctx } = await makeEnv();
    // Any non-empty (canonical base64) bundleBytes value.
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'turn',
        bundleBytes: 'UEFDSwAAAAA=',
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(500);
  });

  it('proceeds past the gate when both Phase 3 hooks are registered', async () => {
    // Probe plugin: registers both export-baseline-bundle (returns a
    // synthetic empty bundle string — handler will then fail in
    // prepareScratchRepo when it tries to load malformed bytes, but
    // that's OK; we just want to verify the gate accepts) and
    // apply-bundle.
    //
    // We're testing handler control flow only — the bundle won't load
    // and prepareScratchRepo will throw. The handler catches that and
    // returns accepted:false (NOT a 500), proving the gate let us
    // through and the error surfaced as a normal "baseline drift"
    // outcome.
    const probe: Plugin = {
      manifest: {
        name: '@ax/test-bundle-probe',
        version: '0.0.0',
        registers: [
          'workspace:apply-bundle',
          'workspace:export-baseline-bundle',
        ],
        calls: [],
        subscribes: [],
      },
      init({ bus: pluginBus }) {
        pluginBus.registerService(
          'workspace:export-baseline-bundle',
          '@ax/test-bundle-probe',
          async () => ({ bundleBytes: 'UEFDSwAAAAA=' }), // garbage; loads will fail
        );
        pluginBus.registerService(
          'workspace:apply-bundle',
          '@ax/test-bundle-probe',
          async () => ({
            version: 'v-probe' as WorkspaceVersion,
            delta: {
              before: null,
              after: 'v-probe' as WorkspaceVersion,
              changes: [],
            },
          }),
        );
      },
    };
    const { bus, ctx } = await makeEnv([probe]);
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'turn',
        bundleBytes: 'UEFDSwAAAAA=',
      },
      ctx,
      bus,
    );
    // Gate passed; handler reached prepareScratchRepo; bundle was
    // garbage so it failed gracefully as accepted:false (not a 500).
    expect(result.status).toBe(200);
    const body = result.body as { accepted: false; reason: string };
    expect(body.accepted).toBe(false);
    expect(body.reason).toMatch(/baseline drift|prerequisite/i);
  });
});
