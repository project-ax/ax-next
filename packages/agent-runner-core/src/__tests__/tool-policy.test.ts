import { describe, expect, it, vi } from 'vitest';
import { createToolPolicy } from '../tool-policy.js';

function fakeClient(response: unknown) {
  return { call: vi.fn().mockResolvedValue(response) } as never;
}

describe('createToolPolicy', () => {
  it('forwards the re-rooted input to tool.pre-call and allows on accept', async () => {
    const client = fakeClient({ verdict: 'allow' });
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });

    const verdict = await policy.preToolUse(
      'Read',
      { file_path: '.ax/uploads/c1/t1/a.pdf' },
      'call-1',
    );

    expect(verdict).toEqual({
      decision: 'allow',
      updatedInput: { file_path: '/agent/.ax/uploads/c1/t1/a.pdf' },
    });
    expect((client as never as { call: ReturnType<typeof vi.fn> }).call)
      .toHaveBeenCalledWith('tool.pre-call', {
        call: {
          id: 'call-1',
          name: 'Read',
          input: { file_path: '/agent/.ax/uploads/c1/t1/a.pdf' },
        },
      });
  });

  it('denies when the host rejects, carrying the reason', async () => {
    const client = fakeClient({ verdict: 'reject', reason: 'npm not permitted' });
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });

    await expect(policy.preToolUse('Bash', { command: 'npm i' }, 'call-2'))
      .resolves.toEqual({
        decision: 'deny',
        reason: 'npm not permitted',
        // A subscriber actually looked at this call and said no, so this is
        // the one case where a runner may tell the model a retry is futile.
        cause: 'policy',
      });
  });

  // TASK-239. The reason on this path used to be `err.message` verbatim, which
  // is how `connect failed: ECONNREFUSED` reached the model as policy prose —
  // and, through the persisted tool_result, a person reading the transcript.
  it('denies (fail-closed) when the IPC call throws, without leaking the error to the model', async () => {
    const client = { call: vi.fn().mockRejectedValue(new Error('connect failed: ECONNREFUSED')) } as never;
    const warn = vi.fn();
    const policy = createToolPolicy({ client, workspaceRoot: '/agent', warn });

    const verdict = await policy.preToolUse('Bash', { command: 'ls' }, 'call-3');

    expect(verdict.decision).toBe('deny');
    // Nothing was adjudicated, so the verdict must not claim a rule did it.
    expect(verdict).toMatchObject({ cause: 'unavailable' });
    const reason = (verdict as { reason: string }).reason;
    // The literal is spelled out rather than compared against the module's own
    // constant on purpose: asserting `reason === GATE_UNREACHABLE_REASON` would
    // restate the implementation and pass no matter what that constant said.
    expect(reason).toBe('the approval check could not be completed');
    expect(reason).not.toContain('ECONNREFUSED');
    expect(reason).not.toContain('connect failed');
  });

  it('hands the real error to the operator instead of dropping it', async () => {
    // The other half of not showing it to the model: before this, the error was
    // logged nowhere at all — it existed only in the model's context window, so
    // sanitizing the model-facing string would have destroyed it outright.
    const client = { call: vi.fn().mockRejectedValue(new Error('connect failed: ECONNREFUSED')) } as never;
    const warn = vi.fn();
    const policy = createToolPolicy({ client, workspaceRoot: '/agent', warn });

    await policy.preToolUse('Bash', { command: 'ls' }, 'call-3');

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls[0]![0] as string;
    expect(logged).toContain('ECONNREFUSED');
    // An operator reading a pod log needs to know which tool was refused.
    expect(logged).toContain('Bash');
    expect(logged).toContain('tool.pre-call');
  });

  it('prefers the host modifiedCall input over our re-rooted input', async () => {
    // modifiedCall is a full ToolCallSchema — { id, name, input }.
    const client = fakeClient({
      verdict: 'allow',
      modifiedCall: {
        id: 'call-4',
        name: 'Read',
        input: { file_path: '/permanent/a.pdf' },
      },
    });
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });

    await expect(
      policy.preToolUse('Read', { file_path: '.ax/uploads/c1/t1/a.pdf' }, 'call-4'),
    ).resolves.toEqual({
      decision: 'allow',
      updatedInput: { file_path: '/permanent/a.pdf' },
    });
  });

  // The original (pre-split) hook did `toolUseID ?? idGen()`, which sends the
  // literal '' as the call id when the SDK hands us an empty string — it only
  // generates a fresh id for `undefined`. These two cases pin that behaviour
  // so a `||` (or similar) regression that treats '' as "missing" is caught.
  it('sends the literal empty string as call.id, not a generated id', async () => {
    const client = fakeClient({ verdict: 'allow' });
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });

    await policy.preToolUse('Bash', { command: 'ls' }, '');

    expect((client as never as { call: ReturnType<typeof vi.fn> }).call)
      .toHaveBeenCalledWith('tool.pre-call', {
        call: { id: '', name: 'Bash', input: { command: 'ls' } },
      });
  });

  it('generates a call.id when toolUseId is undefined', async () => {
    const client = fakeClient({ verdict: 'allow' });
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });

    await policy.preToolUse('Bash', { command: 'ls' }, undefined);

    const call = (client as never as { call: ReturnType<typeof vi.fn> }).call;
    expect(call).toHaveBeenCalledTimes(1);
    const sentId = (call.mock.calls[0]![1] as { call: { id: string } }).call.id;
    expect(sentId).not.toBe('');
    expect(typeof sentId).toBe('string');
    expect(sentId.length).toBeGreaterThan(0);
  });

  // Defence in depth, and this test can only reach it because `fakeClient`
  // skips validation: the real IpcClient parses the body against this SAME
  // schema before `call()` returns, so on the production wire the in-policy
  // `.parse` cannot throw. What is genuinely covered is the behaviour a
  // non-validating client (a double, a future transport) would get — it must
  // fail CLOSED, and it must not hand the model a ZodError dump.
  it('denies (fail-closed) when a non-validating client returns an unparseable response', async () => {
    const client = fakeClient({ verdict: 'not-a-real-verdict' });
    const warn = vi.fn();
    const policy = createToolPolicy({ client, workspaceRoot: '/agent', warn });

    const verdict = await policy.preToolUse('Bash', { command: 'ls' }, 'call-5');

    expect(verdict.decision).toBe('deny');
    // A malformed response means the gate never decided anything either, so
    // this is `unavailable` for the same reason a timeout is — not `policy`.
    expect(verdict).toMatchObject({ cause: 'unavailable' });
    expect((verdict as { reason: string }).reason).not.toContain('not-a-real-verdict');
    // Schema drift has to be audible somewhere, or it reads as a mystery deny.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('maps a hold response to a hold verdict, not a deny', async () => {
    const client = fakeClient({
      verdict: 'hold',
      decisionId: 'dec_7',
      note: 'Ask first',
    });
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });
    const v = await policy.preToolUse('gmail_send', { to: 'a@b.c' }, 'tu_1');
    expect(v).toEqual({ decision: 'hold', decisionId: 'dec_7', note: 'Ask first' });
  });
});

describe('ToolPolicy.postToolUse', () => {
  function policyWith(drain: () => Promise<string[]>) {
    const client = { call: vi.fn(), event: vi.fn().mockResolvedValue(undefined) };
    const policy = createToolPolicy({
      client: client as never,
      workspaceRoot: '/agent',
      drainEgressBlocks: drain,
    });
    return { policy, client };
  }

  it('fires event.tool-post-call with the call and output', async () => {
    const { policy, client } = policyWith(async () => []);
    await policy.postToolUse('Read', 'call-1', { file_path: '/agent/a.ts' }, 'contents', true);
    expect(client.event).toHaveBeenCalledWith('event.tool-post-call', {
      call: { id: 'call-1', name: 'Read', input: { file_path: '/agent/a.ts' } },
      output: 'contents',
    });
  });

  it('returns a remediation note when builtin Bash hit blocked hosts', async () => {
    const { policy } = policyWith(async () => ['registry.npmjs.org']);
    const out = await policy.postToolUse('Bash', 'call-2', { command: 'npm i' }, '', true);
    expect(out.note).toContain('registry.npmjs.org');
  });

  it('does not drain for non-Bash tools', async () => {
    const drain = vi.fn().mockResolvedValue(['registry.npmjs.org']);
    const { policy } = policyWith(drain);
    await expect(policy.postToolUse('Read', 'call-3', {}, '', true)).resolves.toEqual({});
    expect(drain).not.toHaveBeenCalled();
  });

  it('degrades to silent when the drain throws', async () => {
    const { policy } = policyWith(async () => {
      throw new Error('proxy gone');
    });
    await expect(policy.postToolUse('Bash', 'call-4', { command: 'ls' }, '', true))
      .resolves.toEqual({});
  });

  // Guards the fix for the round-1 gap: classifySdkToolName strips the
  // `mcp__<server>__` prefix before the policy ever sees the name, so an
  // MCP tool literally named `Bash` (isBuiltinTool=false) must NOT be
  // treated as the sandbox-egress Bash and drained.
  it('does not drain a non-builtin tool named Bash (MCP tool literally named Bash)', async () => {
    const drain = vi.fn().mockResolvedValue(['registry.npmjs.org']);
    const { policy } = policyWith(drain);
    await expect(policy.postToolUse('Bash', 'call-5', { command: 'npm i' }, '', false))
      .resolves.toEqual({});
    expect(drain).not.toHaveBeenCalled();
  });

  it('falls back to empty-string call.id when toolUseId is undefined', async () => {
    const { policy, client } = policyWith(async () => []);
    await policy.postToolUse('Read', undefined, { file_path: '/agent/a.ts' }, 'contents', true);
    expect(client.event).toHaveBeenCalledWith('event.tool-post-call', {
      call: { id: '', name: 'Read', input: { file_path: '/agent/a.ts' } },
      output: 'contents',
    });
  });
});
