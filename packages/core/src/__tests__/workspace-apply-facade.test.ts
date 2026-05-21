import { describe, it, expect, vi } from 'vitest';
import { HookBus } from '../hook-bus.js';
import { PluginError, reject } from '../errors.js';
import { makeAgentContext, createLogger, type AgentContext } from '../context.js';
import { registerWorkspaceApplyFacade } from '../workspace-apply-facade.js';
import {
  asWorkspaceVersion,
  type FileChange,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceDelta,
} from '../workspace.js';

const FACADE_PLUGIN = '@ax/workspace-test-backend';

// ---------------------------------------------------------------------------
// Regression coverage for Finding 3: `workspace:apply` was a raw backend
// service hook, so any in-process `bus.call('workspace:apply', …)` bypassed
// the `workspace:pre-apply` veto and `workspace:applied` notify (which only
// fired inside the IPC commit path). The facade makes `workspace:apply` the
// PUBLIC entry point that always fires both around the backend's
// `workspace:apply-internal` impl.
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function silentCtx(
  overrides?: Partial<Parameters<typeof makeAgentContext>[0]>,
): AgentContext {
  return makeAgentContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
    ...overrides,
  });
}

function makeDelta(version: string): WorkspaceDelta {
  return {
    before: null,
    after: asWorkspaceVersion(version),
    changes: [],
  };
}

function makeOutput(version: string): WorkspaceApplyOutput {
  return { version: asWorkspaceVersion(version), delta: makeDelta(version) };
}

const policyChange: FileChange = {
  path: '.ax/skills/foo/SKILL.md',
  kind: 'put',
  content: enc.encode('---\nname: foo\n---\n'),
};
const nonPolicyChange: FileChange = {
  path: 'src/main.ts',
  kind: 'put',
  content: enc.encode('export const x = 1;\n'),
};

describe('registerWorkspaceApplyFacade', () => {
  it('(a) allow path: applies via internal and returns its output', async () => {
    const bus = new HookBus();
    const internal = vi.fn(async () => makeOutput('v1'));
    bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply-internal',
      FACADE_PLUGIN,
      internal,
    );
    registerWorkspaceApplyFacade(bus, FACADE_PLUGIN);

    const out = await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      silentCtx(),
      { changes: [nonPolicyChange], parent: null },
    );

    expect(out.version).toBe('v1');
    expect(internal).toHaveBeenCalledTimes(1);
  });

  it('(b) pre-apply veto throws PluginError{code:rejected} and internal is NOT called', async () => {
    const bus = new HookBus();
    const internal = vi.fn(async () => makeOutput('v1'));
    bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply-internal',
      FACADE_PLUGIN,
      internal,
    );
    bus.subscribe('workspace:pre-apply', 'validator', async () =>
      reject({ reason: 'skill schema invalid', source: 'validator' }),
    );
    registerWorkspaceApplyFacade(bus, FACADE_PLUGIN);

    const err = await bus
      .call('workspace:apply', silentCtx(), {
        changes: [policyChange],
        parent: null,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('rejected');
    expect((err as PluginError).plugin).toBe(FACADE_PLUGIN);
    expect((err as PluginError).hookName).toBe('workspace:apply');
    expect((err as PluginError).message).toContain('skill schema invalid');
    expect(internal).not.toHaveBeenCalled();
  });

  it('(c) pre-apply receives the policy-filtered subset only', async () => {
    const bus = new HookBus();
    bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply-internal',
      FACADE_PLUGIN,
      async () => makeOutput('v1'),
    );
    let seen: FileChange[] | undefined;
    bus.subscribe<{ changes: FileChange[] }>(
      'workspace:pre-apply',
      'observer',
      async (_ctx, payload) => {
        seen = payload.changes;
        return undefined;
      },
    );
    registerWorkspaceApplyFacade(bus, FACADE_PLUGIN);

    await bus.call('workspace:apply', silentCtx(), {
      changes: [policyChange, nonPolicyChange],
      parent: null,
    });

    expect(seen?.map((c) => c.path)).toEqual(['.ax/skills/foo/SKILL.md']);
  });

  it('(d) internal receives the FULL change set (not the filtered subset)', async () => {
    const bus = new HookBus();
    let internalInput: WorkspaceApplyInput | undefined;
    bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply-internal',
      FACADE_PLUGIN,
      async (_ctx, input) => {
        internalInput = input;
        return makeOutput('v1');
      },
    );
    // A subscriber that returns a transformed payload — the facade must
    // IGNORE the transform (veto-only) and apply the original full set.
    bus.subscribe<{ changes: FileChange[] }>(
      'workspace:pre-apply',
      'transformer',
      async (_ctx, payload) => ({ ...payload, changes: [] }),
    );
    registerWorkspaceApplyFacade(bus, FACADE_PLUGIN);

    await bus.call('workspace:apply', silentCtx(), {
      changes: [policyChange, nonPolicyChange],
      parent: null,
    });

    expect(internalInput?.changes.map((c) => c.path)).toEqual([
      '.ax/skills/foo/SKILL.md',
      'src/main.ts',
    ]);
  });

  it('(e) workspace:applied fires with the internal delta', async () => {
    const bus = new HookBus();
    const output = makeOutput('v1');
    bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply-internal',
      FACADE_PLUGIN,
      async () => output,
    );
    let appliedDelta: WorkspaceDelta | undefined;
    bus.subscribe<WorkspaceDelta>('workspace:applied', 'indexer', async (_ctx, delta) => {
      appliedDelta = delta;
      return undefined;
    });
    registerWorkspaceApplyFacade(bus, FACADE_PLUGIN);

    await bus.call('workspace:apply', silentCtx(), {
      changes: [policyChange],
      parent: null,
    });

    expect(appliedDelta).toBe(output.delta);
  });

  it('(f) a post-fact applied rejection is swallowed (logged); apply still succeeds', async () => {
    const bus = new HookBus();
    bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply-internal',
      FACADE_PLUGIN,
      async () => makeOutput('v1'),
    );
    bus.subscribe('workspace:applied', 'late-vetoer', async () =>
      reject({ reason: 'too late to veto' }),
    );
    registerWorkspaceApplyFacade(bus, FACADE_PLUGIN);

    const errLog = vi.fn();
    const ctx = silentCtx({
      logger: { ...createLogger({ reqId: 't', writer: () => {} }), error: errLog },
    });

    const out = await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      ctx,
      { changes: [policyChange], parent: null },
    );

    // Apply still landed.
    expect(out.version).toBe('v1');
    // And the post-fact rejection was logged, not thrown.
    expect(errLog).toHaveBeenCalled();
  });

  it('(g) ctx is passed through unchanged to pre-apply / internal / applied', async () => {
    const bus = new HookBus();
    const ctx = silentCtx({ userId: 'specific-user', agentId: 'specific-agent' });

    let preCtx: AgentContext | undefined;
    let internalCtx: AgentContext | undefined;
    let appliedCtx: AgentContext | undefined;

    bus.subscribe('workspace:pre-apply', 'pre', async (c) => {
      preCtx = c;
      return undefined;
    });
    bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply-internal',
      FACADE_PLUGIN,
      async (c) => {
        internalCtx = c;
        return makeOutput('v1');
      },
    );
    bus.subscribe('workspace:applied', 'post', async (c) => {
      appliedCtx = c;
      return undefined;
    });
    registerWorkspaceApplyFacade(bus, FACADE_PLUGIN);

    await bus.call('workspace:apply', ctx, {
      changes: [policyChange],
      parent: null,
    });

    expect(preCtx).toBe(ctx);
    expect(internalCtx).toBe(ctx);
    expect(appliedCtx).toBe(ctx);
  });

  it('rethrows internal errors UNCHANGED (e.g. parent-mismatch propagates for attachments retry)', async () => {
    const bus = new HookBus();
    const parentMismatch = new PluginError({
      code: 'parent-mismatch',
      plugin: FACADE_PLUGIN,
      hookName: 'workspace:apply-internal',
      message: 'expected parent v0, got null',
      cause: { actualParent: asWorkspaceVersion('v0') },
    });
    bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply-internal',
      FACADE_PLUGIN,
      async () => {
        throw parentMismatch;
      },
    );
    registerWorkspaceApplyFacade(bus, FACADE_PLUGIN);

    const err = await bus
      .call('workspace:apply', silentCtx(), { changes: [policyChange], parent: null })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('parent-mismatch');
    // The cause survives so the attachments retry can read actualParent.
    expect((err as PluginError).cause).toMatchObject({
      actualParent: 'v0',
    });
  });
});

// Type-only assert that the facade signature matches what backends call.
const _typecheck: (bus: HookBus, plugin: string) => void =
  registerWorkspaceApplyFacade;
void _typecheck;
