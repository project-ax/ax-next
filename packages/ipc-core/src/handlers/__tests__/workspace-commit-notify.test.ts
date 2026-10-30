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
import {
  WORKSPACE_COMMIT_REASON_MAX,
  WORKSPACE_COMMIT_REJECT_REASON_MAX,
} from '@ax/ipc-protocol';
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
    // which must surface as { accepted: false, recoverable: false } — a
    // refused write must be CLEARED, not preserved, because the runner
    // re-stages its whole tree every turn: a preserved refused file would be
    // re-submitted and refused again forever, wedging the agent (B1).
    //
    // This subscriber names no offending path, so the runner has nothing to
    // scope the clear to and falls back to the whole-tree reset. The scoped
    // case is the next test.
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
    // Nothing to scope to ⟹ no `discardPaths` ⟹ the runner keeps its
    // whole-tree behaviour. `toMatchObject` would not have caught a stray one.
    expect((result.body as { discardPaths?: unknown }).discardPaths).toBeUndefined();
  });

  it('TASK-690: pre-apply is told how big the write is, and a size veto reaches the runner verbatim', async () => {
    // The disk-quota subscriber decides on `sizeBytes`. The policy-visible
    // `changes` are only the `.ax/**` / `.claude/**` slice, so they cannot say
    // how big the whole write is; the decoded bundle length can, and the host
    // (not the runner) derives it. The refusal must come back as
    // recoverable:false with NO discardPaths: the runner then hands the reason
    // to the agent (it only does that for recoverable:false) and clears the
    // tree, so the refused files are not re-submitted every turn.
    prepareScratchRepoMock.mockResolvedValueOnce({
      ...DEFAULT_SCRATCH,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    verifyBundleAuthorMock.mockResolvedValueOnce(undefined);
    walkBundleChangesMock.mockResolvedValueOnce([
      { path: 'big/file.bin', kind: 'put', content: new Uint8Array(10) },
    ]);

    const probe = makePhase3Probe('@ax/test-size-veto-probe');
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [probe], config: {} });
    let seen: { sizeBytes?: unknown; changes?: unknown } | undefined;
    bus.subscribe<{ sizeBytes?: unknown; changes?: unknown }>(
      'workspace:pre-apply',
      '@ax/test-size-veto-subscriber',
      async (_ctx, payload) => {
        seen = payload;
        return reject({ reason: 'Storage for this workspace is full.' });
      },
    );
    const ctx = makeAgentContext({
      sessionId: 'wcn-test-size',
      agentId: 'wcn-agent-size',
      userId: 'wcn-user-size',
    });
    const bundle = Buffer.alloc(3000, 7);

    const result = await workspaceCommitNotifyHandler(
      { parentVersion: null, reason: 'turn', bundleBytes: bundle.toString('base64') },
      ctx,
      bus,
    );

    // Decoded length, not the base64 length (which is 4000).
    expect(seen?.sizeBytes).toBe(3000);
    // `big/file.bin` is not policy-visible: the size must still cover it.
    expect(seen?.changes).toEqual([]);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      accepted: false,
      recoverable: false,
      reason: 'Storage for this workspace is full.',
    });
    expect((result.body as { discardPaths?: unknown }).discardPaths).toBeUndefined();
  });

  it('TASK-720: the JSON action forwards the veto code too (older sandboxes share the core)', async () => {
    prepareScratchRepoMock.mockResolvedValueOnce({
      ...DEFAULT_SCRATCH,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    verifyBundleAuthorMock.mockResolvedValueOnce(undefined);
    walkBundleChangesMock.mockResolvedValueOnce([]);
    const probe = makePhase3Probe('@ax/test-code-veto-probe');
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [probe], config: {} });
    bus.subscribe(
      'workspace:pre-apply',
      '@ax/test-code-veto-subscriber',
      async () => reject({ reason: 'Storage for this workspace is full.', code: 'storage-full' }),
    );
    const ctx = makeAgentContext({
      sessionId: 'wcn-test-code',
      agentId: 'wcn-agent-code',
      userId: 'wcn-user-code',
    });
    const result = await workspaceCommitNotifyHandler(
      { parentVersion: null, reason: 'turn', bundleBytes: 'UEFDSwAAAAA=' },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      accepted: false,
      reason: 'Storage for this workspace is full.',
      recoverable: false,
      code: 'storage-full',
    });
  });

  it('TASK-287: a veto that names its path scopes the discard to that path', async () => {
    // The realistic trigger: an agent writes CLAUDE.md (a policy-visible exact
    // path, and one @ax/validator-skill refuses unconditionally) in the same
    // turn it wrote real work. Before TASK-287 the whole turn — plus every
    // earlier turn still above the last accepted baseline — went with it.
    prepareScratchRepoMock.mockResolvedValueOnce({
      ...DEFAULT_SCRATCH,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    verifyBundleAuthorMock.mockResolvedValueOnce(undefined);
    walkBundleChangesMock.mockResolvedValueOnce([
      { path: 'CLAUDE.md', kind: 'put', content: new Uint8Array([1]) },
      { path: '.ax/notes/keep.md', kind: 'put', content: new Uint8Array([2]) },
    ]);

    const probe = makePhase3Probe('@ax/test-scoped-veto-probe');
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [probe], config: {} });
    bus.subscribe(
      'workspace:pre-apply',
      '@ax/validator-skill',
      async () =>
        reject({
          reason: 'CLAUDE.md: SDK-config paths are host-only',
          offendingPaths: ['CLAUDE.md'],
        }),
    );
    const ctx = makeAgentContext({
      sessionId: 'wcn-scoped',
      agentId: 'wcn-agent-scoped',
      userId: 'wcn-user-scoped',
    });

    const result = await workspaceCommitNotifyHandler(
      { parentVersion: null, reason: 'turn', bundleBytes: 'UEFDSwAAAAA=' },
      ctx,
      bus,
    );

    expect(result.status).toBe(200);
    // Still refused, still non-recoverable — the veto is exactly as strict.
    // What changed is that the runner is told WHICH file to drop, so
    // `.ax/notes/keep.md` is not collateral.
    expect(result.body).toMatchObject({
      accepted: false,
      recoverable: false,
      discardPaths: ['CLAUDE.md'],
    });
  });

  it('TASK-287: a path the batch never contained is refused, not forwarded', async () => {
    // Fail CLOSED. `discardPaths` becomes `rm` targets inside the sandbox, and
    // a subscriber naming something we did not send it means we have lost
    // track of what the veto is about — so we drop the scoping entirely and
    // take the whole-tree reset rather than act on an unrecognised path.
    prepareScratchRepoMock.mockResolvedValueOnce({
      ...DEFAULT_SCRATCH,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    verifyBundleAuthorMock.mockResolvedValueOnce(undefined);
    walkBundleChangesMock.mockResolvedValueOnce([
      { path: 'CLAUDE.md', kind: 'put', content: new Uint8Array([1]) },
    ]);

    const probe = makePhase3Probe('@ax/test-unknown-path-probe');
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [probe], config: {} });
    bus.subscribe(
      'workspace:pre-apply',
      '@ax/test-rogue-subscriber',
      async () =>
        reject({
          reason: 'nope',
          offendingPaths: ['CLAUDE.md', '../../etc/passwd'],
        }),
    );
    const warn = vi.fn();
    const ctx = makeAgentContext({
      sessionId: 'wcn-unknown',
      agentId: 'wcn-agent-unknown',
      userId: 'wcn-user-unknown',
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
        child: vi.fn(),
      } as unknown as AgentContext['logger'],
    });

    const result = await workspaceCommitNotifyHandler(
      { parentVersion: null, reason: 'turn', bundleBytes: 'UEFDSwAAAAA=' },
      ctx,
      bus,
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ accepted: false, recoverable: false });
    expect((result.body as { discardPaths?: unknown }).discardPaths).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'workspace_pre_apply_discard_paths_unrecognized',
      expect.objectContaining({ unrecognized: ['../../etc/passwd'] }),
    );
  });

  it('TASK-287: author-verify failure keeps the unscoped whole-tree reset', async () => {
    // The two `recoverable: false` branches must NOT collapse into one. Here
    // we could not establish who authored the bundle, so nothing it claims to
    // contain can be believed and there is no trustworthy path set to name —
    // "keep the rest" is not a coherent offer. This branch stays whole-tree.
    prepareScratchRepoMock.mockResolvedValueOnce({
      ...DEFAULT_SCRATCH,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    verifyBundleAuthorMock.mockRejectedValueOnce(new Error('bad author: attacker <x@y>'));

    const probe = makePhase3Probe('@ax/test-author-verify-probe');
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [probe], config: {} });
    const ctx = makeAgentContext({
      sessionId: 'wcn-author',
      agentId: 'wcn-agent-author',
      userId: 'wcn-user-author',
    });

    const result = await workspaceCommitNotifyHandler(
      { parentVersion: null, reason: 'turn', bundleBytes: 'UEFDSwAAAAA=' },
      ctx,
      bus,
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      accepted: false,
      reason: 'bundle author verification failed',
      recoverable: false,
    });
    expect((result.body as { discardPaths?: unknown }).discardPaths).toBeUndefined();
  });

  it('logs the veto reason and the plugin that vetoed', async () => {
    // The wire response is not a channel anyone watches: the runner writes the
    // reason to stderr (k8s: `kubectl logs` on an ephemeral pod) and, on this
    // branch, hard-resets the turn. Without a host-side log line an operator
    // asking "why did that agent's work vanish?" has nowhere to look.
    // Pre-apply validators do not all log their own rejection.
    prepareScratchRepoMock.mockResolvedValueOnce({
      ...DEFAULT_SCRATCH,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    verifyBundleAuthorMock.mockResolvedValueOnce(undefined);
    walkBundleChangesMock.mockResolvedValueOnce([]);

    const probe = makePhase3Probe('@ax/test-pre-apply-veto-log-probe');
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [probe], config: {} });
    bus.subscribe(
      'workspace:pre-apply',
      '@ax/validator-skill',
      async () => reject({ reason: 'skills/nightly/SKILL.md: invalid frontmatter' }),
    );

    const warn = vi.fn();
    const ctx = makeAgentContext({
      sessionId: 'wcn-test-veto-log',
      agentId: 'wcn-agent-veto-log',
      userId: 'wcn-user-veto-log',
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
        child: vi.fn(),
      } as unknown as AgentContext['logger'],
    });

    const result = await workspaceCommitNotifyHandler(
      { parentVersion: null, reason: 'turn', bundleBytes: 'UEFDSwAAAAA=' },
      ctx,
      bus,
    );

    expect(result.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      'workspace_pre_apply_rejected',
      expect.objectContaining({
        action: 'workspace.commit-notify',
        // Which plugin refused, and in its own words why.
        rejectedBy: '@ax/validator-skill',
        reason: 'skills/nightly/SKILL.md: invalid frontmatter',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// TASK-486 / TASK-494 → TASK-989 / TASK-991 — the runner-immutable guard is gone.
//
// It refused runner-originated writes to two host-owned paths:
// `memory/system/rules.md` (until TASK-989 moved the people's Instructions into
// @ax/agents) and the facts export `permanent/memory/facts/**` (until TASK-991
// wrote the export only to the read-only `/memory` volume). Nothing reads
// either from a workspace now, so these tests pin that a turn touching them
// applies like any other.
// ---------------------------------------------------------------------------

/**
 * Like `makePhase3Probe`, but hands back the `workspace:apply-bundle` spy so a
 * test can assert the apply NEVER RAN. "accepted:false" alone would also be
 * true of a guard that refused the response after landing the write, which is
 * the failure this whole card is about.
 */
function makeSpyingPhase3Probe(name: string): {
  plugin: Plugin;
  applyBundle: ReturnType<typeof vi.fn>;
} {
  const applyBundle = vi.fn().mockResolvedValue({
    version: 'v-probe' as WorkspaceVersion,
    delta: { before: null, after: 'v-probe' as WorkspaceVersion, changes: [] },
  });
  const plugin: Plugin = {
    manifest: {
      name,
      version: '0.0.0',
      registers: ['workspace:apply-bundle', 'workspace:export-baseline-bundle'],
      calls: [],
      subscribes: [],
    },
    init({ bus: pluginBus }) {
      pluginBus.registerService(
        'workspace:export-baseline-bundle',
        name,
        async () => ({ bundleBytes: 'UEFDSwAAAAA=' }),
      );
      pluginBus.registerService('workspace:apply-bundle', name, applyBundle);
    },
  };
  return { plugin, applyBundle };
}

describe('workspace.commit-notify handler — formerly runner-immutable paths are ordinary agent writes (TASK-989, TASK-991)', () => {
  async function driveTurn(
    changes: Array<{ path: string; kind: 'put' | 'delete'; content?: Uint8Array }>,
    label: string,
  ): Promise<{
    result: Awaited<ReturnType<typeof workspaceCommitNotifyHandler>>;
    applyBundle: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  }> {
    prepareScratchRepoMock.mockResolvedValueOnce({
      ...DEFAULT_SCRATCH,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    verifyBundleAuthorMock.mockResolvedValueOnce(undefined);
    walkBundleChangesMock.mockResolvedValueOnce(changes);

    const { plugin, applyBundle } = makeSpyingPhase3Probe(`@ax/test-${label}`);
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [plugin], config: {} });
    const warn = vi.fn();
    const ctx = makeAgentContext({
      sessionId: `wcn-${label}`,
      agentId: `wcn-agent-${label}`,
      userId: `wcn-user-${label}`,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
        child: vi.fn(),
      } as unknown as AgentContext['logger'],
    });

    const result = await workspaceCommitNotifyHandler(
      // The runner picks `reason` — pinned here to the most obviously
      // trustworthy-looking string it could send, because the guard must not
      // consult it. A `reason`-based allowlist would hand the sandbox the key.
      { parentVersion: null, reason: 'turn', bundleBytes: 'UEFDSwAAAAA=' },
      ctx,
      bus,
    );
    return { result, applyBundle, warn };
  }

  it('leaves the agent’s OWN memory writes alone — the old Rules file included (TASK-989)', async () => {
    // Scope check. `memory/**` is the agent's to write. `memory/system/rules.md`
    // used to be guarded because @ax/memory injected it at the top of every
    // prompt; nothing reads it now (Instructions live in @ax/agents), so it is
    // an ordinary file and a turn that touches it applies normally.
    const { result, applyBundle } = await driveTurn(
      [
        { path: 'memory/system/user.md', kind: 'put', content: new Uint8Array([1]) },
        { path: 'memory/docs/entity/acme.md', kind: 'put', content: new Uint8Array([2]) },
        { path: 'memory/system/rules.md', kind: 'put', content: new Uint8Array([3]) },
      ],
      'immutable-allowed',
    );

    expect(result.body).toMatchObject({ accepted: true });
    expect(applyBundle).toHaveBeenCalledTimes(1);
  });

  it('accepts writes under the old facts export path — the export left the workspace (TASK-991)', async () => {
    // The host writes the facts export only to the read-only `/memory` volume
    // now, and nothing reads `permanent/memory/facts/**` from a workspace, so a
    // runner write there is an ordinary agent write.
    const { result, applyBundle } = await driveTurn(
      [
        { path: 'permanent/memory/facts/profile.md', kind: 'put', content: new Uint8Array([1]) },
        { path: 'permanent/memory/facts/user/2026-09.md', kind: 'delete' },
        { path: 'permanent/memory/system/user.md', kind: 'put', content: new Uint8Array([2]) },
      ],
      'old-facts-path',
    );

    expect(result.body).toMatchObject({ accepted: true });
    expect(applyBundle).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// TASK-781 — the rejection `reason` is capped on the wire, and the handler
// clamps every reason it did not write itself BEFORE its own response parse.
// A `workspace:pre-apply` subscriber is plugin code and a PluginError message
// is backend text; neither length is ours to promise, and an over-long one
// must still arrive as that refusal — not as a 500 that the runner reads as a
// host fault. The astral character straddles the cut on purpose: a plain
// slice would leave a lone surrogate.
// ---------------------------------------------------------------------------

describe('workspace.commit-notify handler — reason caps (TASK-781)', () => {
  const longReason =
    'x'.repeat(WORKSPACE_COMMIT_REJECT_REASON_MAX - 1) + '\u{1F6AB}' + 'tail';

  it('clamps an over-long pre-apply veto reason instead of 500ing', async () => {
    prepareScratchRepoMock.mockResolvedValueOnce({
      ...DEFAULT_SCRATCH,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    verifyBundleAuthorMock.mockResolvedValueOnce(undefined);
    walkBundleChangesMock.mockResolvedValueOnce([]);

    const probe = makePhase3Probe('@ax/test-long-veto-probe');
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [probe], config: {} });
    bus.subscribe('workspace:pre-apply', '@ax/test-long-veto-subscriber', async () =>
      reject({ reason: longReason }),
    );
    const ctx = makeAgentContext({
      sessionId: 'wcn-test-long-veto',
      agentId: 'wcn-agent-long-veto',
      userId: 'wcn-user-long-veto',
    });

    const result = await workspaceCommitNotifyHandler(
      { parentVersion: null, reason: 'turn', bundleBytes: 'UEFDSwAAAAA=' },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    const body = result.body as { accepted: false; reason: string; recoverable: false };
    expect(body).toMatchObject({ accepted: false, recoverable: false });
    expect(body.reason).toBe('x'.repeat(WORKSPACE_COMMIT_REJECT_REASON_MAX - 1));
  });

  it('clamps an over-long parent-mismatch message instead of 500ing', async () => {
    const { PluginError: PE } = await import('@ax/core');
    const probe: Plugin = {
      manifest: {
        name: '@ax/test-long-mismatch-probe',
        version: '0.0.0',
        registers: ['workspace:apply-bundle', 'workspace:export-baseline-bundle'],
        calls: [],
        subscribes: [],
      },
      init({ bus: pluginBus }) {
        pluginBus.registerService(
          'workspace:export-baseline-bundle',
          '@ax/test-long-mismatch-probe',
          async () => {
            throw new PE({
              code: 'parent-mismatch',
              plugin: '@ax/test-long-mismatch-probe',
              message: longReason,
              cause: { actualParent: 'newhead' },
            });
          },
        );
        pluginBus.registerService(
          'workspace:apply-bundle',
          '@ax/test-long-mismatch-probe',
          async () => ({
            version: 'v-probe' as WorkspaceVersion,
            delta: { before: null, after: 'v-probe' as WorkspaceVersion, changes: [] },
          }),
        );
      },
    };
    const { bus, ctx } = await makeEnv([probe]);
    const result = await workspaceCommitNotifyHandler(
      { parentVersion: 'oldhead', reason: 'turn', bundleBytes: 'UEFDSwAAAAA=' },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    const body = result.body as { accepted: false; reason: string; actualParent: string };
    expect(body.accepted).toBe(false);
    expect(body.actualParent).toBe('newhead');
    expect(body.reason.length).toBeLessThanOrEqual(WORKSPACE_COMMIT_REJECT_REASON_MAX);
    expect(body.reason.startsWith('parent-mismatch: xxx')).toBe(true);
    // No lone high surrogate left dangling at the cut.
    expect(/[\uD800-\uDBFF]$/.test(body.reason)).toBe(false);
  });

  it('refuses a commit label past the cap at the wire (400, not a passthrough)', async () => {
    const { bus, ctx } = await makeEnv();
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'x'.repeat(WORKSPACE_COMMIT_REASON_MAX + 1),
        bundleBytes: '',
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(400);
  });
});


describe('retired routine paths at runner commit', () => {
  it.each(['.ax/routines/a.md', '.ax\\routines\\a.md', './.ax/routines/a.md', '.ax/./routines/a.md', '.ax/routines/../a.md', '.ax//routines/a.md'])('refuses %s before subscribers or apply-bundle', async (path) => {
    prepareScratchRepoMock.mockResolvedValueOnce(DEFAULT_SCRATCH);
    verifyBundleAuthorMock.mockResolvedValueOnce(undefined);
    walkBundleChangesMock.mockResolvedValueOnce([{ path, kind: 'put', content: new Uint8Array([1]) }]);
    const { plugin, applyBundle } = makeSpyingPhase3Probe('@ax/retired-probe');
    const { bus, ctx } = await makeEnv([plugin]);
    const permissive = vi.fn(async () => undefined);
    const throwing = vi.fn(async () => { throw new Error('bad subscriber'); });
    bus.subscribe('workspace:pre-apply', 'earlier-permissive', permissive);
    bus.subscribe('workspace:pre-apply', 'throwing', throwing);
    const result = await workspaceCommitNotifyHandler({ bundleBytes: 'UEFDSwAAAAA=', parentVersion: null, reason: 'turn' }, ctx, bus);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ accepted: false, recoverable: false, code: path === '.ax/routines/a.md' ? 'routine-files-retired' : 'invalid-path' });
    if (path === '.ax/routines/a.md') expect(result.body).toMatchObject({ reason: 'Routine files are no longer supported. Use the routine tools.' });
    expect(permissive).not.toHaveBeenCalled();
    expect(throwing).not.toHaveBeenCalled();
    expect(applyBundle).not.toHaveBeenCalled();
  });
  it('allows deleting retired files', async () => {
    prepareScratchRepoMock.mockResolvedValueOnce(DEFAULT_SCRATCH);
    verifyBundleAuthorMock.mockResolvedValueOnce(undefined);
    walkBundleChangesMock.mockResolvedValueOnce([{ path: '.ax/routines/a.md', kind: 'delete' }]);
    const { plugin, applyBundle } = makeSpyingPhase3Probe('@ax/retired-delete-probe');
    const { bus, ctx } = await makeEnv([plugin]);
    const result = await workspaceCommitNotifyHandler({ bundleBytes: 'UEFDSwAAAAA=', parentVersion: null, reason: 'turn' }, ctx, bus);
    expect(result.body).toMatchObject({ accepted: true });
    expect(applyBundle).toHaveBeenCalledTimes(1);
  });
});
