import { describe, it, expect, vi } from 'vitest';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  reject,
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
//   - pre-apply veto → accepted:false with recoverable:false.
//   - author-verify failure → accepted:false with recoverable:false.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Module-level mocks for the bundler pipeline.  We hoist the mock functions
// so they're available inside the vi.mock factory (which is hoisted before
// imports by vitest). The mocks start as pass-throughs (return valid empty
// results) and individual tests override them via mockImplementationOnce.
// ---------------------------------------------------------------------------

const {
  prepareScratchRepoMock,
  verifyBundleAuthorMock,
  walkBundleChangesMock,
} = vi.hoisted(() => ({
  prepareScratchRepoMock: vi.fn(),
  verifyBundleAuthorMock: vi.fn(),
  walkBundleChangesMock: vi.fn(),
}));

vi.mock('../../bundler/scratch.js', () => ({
  prepareScratchRepo: prepareScratchRepoMock,
}));
vi.mock('../../bundler/verify.js', () => ({
  verifyBundleAuthor: verifyBundleAuthorMock,
}));
vi.mock('../../bundler/walk.js', () => ({
  walkBundleChanges: walkBundleChangesMock,
}));

// Default stub: a scratch repo that succeeds with a temp dir + no-op dispose.
const DEFAULT_SCRATCH = {
  repoPath: '/tmp/scratch-test',
  baselineCommit: 'aaaa0000',
  dispose: vi.fn().mockResolvedValue(undefined),
};

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

// A probe plugin that registers both Phase 3 bundle hooks so the handler
// can proceed past the backend gate. Used by tests that need to reach the
// bundler/pre-apply stage.
function makePhase3Probe(name = '@ax/test-bundle-probe'): Plugin {
  return {
    manifest: {
      name,
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
        name,
        async () => ({ bundleBytes: 'UEFDSwAAAAA=' }),
      );
      pluginBus.registerService(
        'workspace:apply-bundle',
        name,
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

  it('returns accepted:false + actualParent (NO inline bundle) on parent-mismatch from export-baseline-bundle', async () => {
    // Simulate the concurrent-writer race: the export-baseline-bundle service
    // throws a PluginError{code:'parent-mismatch'} because the mirror advanced
    // past the runner's parent version. The handler must:
    //   - NOT return a 500
    //   - Return status 200 with accepted:false
    //   - Forward actualParent from err.cause
    //   - NOT inline any baseline bundle bytes — the runner fetches them
    //     out-of-band via the binary workspace.export-baseline-bundle action.
    //     (Inlining blew the runner's 4 MiB JSON cap on aged workspaces — same
    //     bug class as materialize BUG-W3. This test guards against regressing.)
    const { PluginError: PE } = await import('@ax/core');
    const probe: Plugin = {
      manifest: {
        name: '@ax/test-parent-mismatch-probe',
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
          '@ax/test-parent-mismatch-probe',
          async () => {
            throw new PE({
              code: 'parent-mismatch',
              plugin: '@ax/test-parent-mismatch-probe',
              message: 'mirror head newhead does not match requested version oldhead',
              cause: {
                actualParent: 'newhead',
                baselineBundleBytes: 'AAAA',
              },
            });
          },
        );
        pluginBus.registerService(
          'workspace:apply-bundle',
          '@ax/test-parent-mismatch-probe',
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
        parentVersion: 'oldhead',
        reason: 'turn',
        bundleBytes: 'UEFDSwAAAAA=',
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    const body = result.body as {
      accepted: false;
      actualParent: string;
      baselineBundleBytes?: string;
    };
    expect(body.accepted).toBe(false);
    expect(body.actualParent).toBe('newhead');
    // The bundle bytes from err.cause must NOT leak into the JSON response —
    // they travel over the dedicated binary action now.
    expect(body.baselineBundleBytes).toBeUndefined();
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
    //
    // prepareScratchRepo is MOCKED at module level. We override it here
    // to throw so the handler reaches the "baseline drift" branch.
    prepareScratchRepoMock.mockRejectedValueOnce(new Error('git bundle verify failed'));

    const { bus, ctx } = await makeEnv([makePhase3Probe()]);
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

describe('workspace.commit-notify handler — pre-apply veto', () => {
  it('a pre-apply veto returns accepted:false with recoverable:false', async () => {
    // Set up the bundler mocks to succeed so the handler reaches the
    // pre-apply stage. The workspace:pre-apply subscriber then rejects,
    // which must surface as { accepted: false, recoverable: false } —
    // an SDK-config veto must be CLEARED (hard-reset) not preserved
    // (--mixed), otherwise the bad key re-vetoes every subsequent turn
    // and wedges the agent permanently.
    prepareScratchRepoMock.mockResolvedValueOnce({
      ...DEFAULT_SCRATCH,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    verifyBundleAuthorMock.mockResolvedValueOnce(undefined);
    walkBundleChangesMock.mockResolvedValueOnce([]);

    // Build a probe with Phase 3 hooks and a pre-apply subscriber that rejects.
    const probe = makePhase3Probe('@ax/test-pre-apply-veto-probe');
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [probe], config: {} });
    // Subscribe directly on the bus after bootstrap so the subscriber
    // fires when the handler calls bus.fire('workspace:pre-apply', ...).
    bus.subscribe(
      'workspace:pre-apply',
      '@ax/test-pre-apply-veto-subscriber',
      async () => reject({ reason: 'sdk-config veto: illegal key' }),
    );
    const ctx = makeAgentContext({
      sessionId: 'wcn-test-veto',
      agentId: 'wcn-agent-veto',
      userId: 'wcn-user-veto',
    });

    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'turn',
        bundleBytes: 'UEFDSwAAAAA=',
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ accepted: false, recoverable: false });
  });
});
