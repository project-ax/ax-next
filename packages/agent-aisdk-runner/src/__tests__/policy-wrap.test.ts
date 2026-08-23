import { describe, expect, it, vi } from 'vitest';
import type { IpcClient, ToolDescriptor } from '@ax/ipc-protocol';
import {
  createHoldLatch,
  createLocalDispatcher,
  createToolPolicy,
  type PreToolVerdict,
  type ToolPolicy,
} from '@ax/agent-runner-core';
import {
  HOLD_LATCH,
  POLICY_WRAPPED,
  assertAllToolsWrapped,
  mergeToolSets,
  wrapWithPolicy,
  type WrappedExecute,
} from '../tools/policy-wrap.js';
import { buildBuiltinTools } from '../tools/builtins.js';
import { buildHostTools } from '../tools/host-tools.js';
import { buildSandboxTools } from '../tools/sandbox-tools.js';
import { buildSkillTool } from '../tools/skill-tool.js';
import type { DiscoveredSkill } from '../skills-index.js';

function fakePolicy(over: Partial<ToolPolicy> = {}): ToolPolicy & {
  preToolUse: ReturnType<typeof vi.fn>;
  postToolUse: ReturnType<typeof vi.fn>;
} {
  const policy = {
    preToolUse: vi.fn(
      async (): Promise<PreToolVerdict> => ({ decision: 'allow' }),
    ),
    postToolUse: vi.fn(async () => ({})),
    ...over,
  };
  return policy as never;
}

const OPTS = { toolCallId: 'call-1' };

describe('wrapWithPolicy — the one choke point', () => {
  it('runs the executor and returns its output when the policy allows', async () => {
    const policy = fakePolicy();
    const run = vi.fn(async () => 'the output');
    const execute = wrapWithPolicy({ policy, name: 'Bash', isBuiltin: true, holdLatch: createHoldLatch() }, run);

    await expect(execute({ command: 'ls' }, OPTS)).resolves.toBe('the output');

    expect(policy.preToolUse).toHaveBeenCalledWith(
      'Bash',
      { command: 'ls' },
      'call-1',
    );
    expect(policy.postToolUse).toHaveBeenCalledWith(
      'Bash',
      'call-1',
      { command: 'ls' },
      'the output',
      true,
    );
  });

  // The single most important assertion in this package. §3: "Vetoes return as
  // tool results, not exceptions." A throw here would abort the turn instead of
  // letting the model adapt.
  it('returns a veto as a tool RESULT and never rejects', async () => {
    const policy = fakePolicy({
      preToolUse: vi.fn(async () => ({
        decision: 'deny' as const,
        reason: 'npm is not on the egress allowlist; use pnpm',
        cause: 'policy' as const,
      })),
    } as never);
    const run = vi.fn(async () => 'must not run');
    const execute = wrapWithPolicy({ policy, name: 'Bash', isBuiltin: true, holdLatch: createHoldLatch() }, run);

    const settled = await execute({ command: 'npm i' }, OPTS).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );

    expect(settled.status).toBe('fulfilled');
    expect(settled.status === 'fulfilled' && settled.value).toContain(
      'npm is not on the egress allowlist; use pnpm',
    );
    // The executor never ran — a denial must not have side effects.
    expect(run).not.toHaveBeenCalled();
    // And no post-call audit event: the tool did not execute.
    expect(policy.postToolUse).not.toHaveBeenCalled();
  });

  it('feeds the executor the RE-ROOTED input, not the raw input', async () => {
    const policy = fakePolicy({
      preToolUse: vi.fn(async () => ({
        decision: 'allow' as const,
        updatedInput: { file_path: '/agent/.ax/uploads/c1/t1/report.pdf' },
      })),
    } as never);
    const run = vi.fn(async () => 'read ok');
    const execute = wrapWithPolicy({ policy, name: 'Read', isBuiltin: true, holdLatch: createHoldLatch() }, run);

    await execute({ file_path: '~/.ax/uploads/c1/t1/report.pdf' }, OPTS);

    expect(run).toHaveBeenCalledWith(
      { file_path: '/agent/.ax/uploads/c1/t1/report.pdf' },
      expect.objectContaining({ toolCallId: 'call-1' }),
    );
    // postToolUse observes the same re-rooted input the executor saw.
    expect(policy.postToolUse).toHaveBeenCalledWith(
      'Read',
      'call-1',
      { file_path: '/agent/.ax/uploads/c1/t1/report.pdf' },
      'read ok',
      true,
    );
  });

  it('appends the egress-block remediation note to the output', async () => {
    const policy = fakePolicy({
      postToolUse: vi.fn(async () => ({ note: 'Blocked host: registry.npmjs.org' })),
    } as never);
    const execute = wrapWithPolicy(
      { policy, name: 'Bash', isBuiltin: true, holdLatch: createHoldLatch() },
      async () => 'npm ERR! network',
    );

    const out = await execute({ command: 'npm i' }, OPTS);
    expect(out).toBe('npm ERR! network\n\nBlocked host: registry.npmjs.org');
  });

  it('re-throws an executor failure (the SDK error channel) but still audits it', async () => {
    const policy = fakePolicy();
    const execute = wrapWithPolicy(
      { policy, name: 'Read', isBuiltin: true, holdLatch: createHoldLatch() },
      async () => {
        throw new Error('ENOENT: no such file');
      },
    );

    await expect(execute({ file_path: '/nope' }, OPTS)).rejects.toThrow(
      'ENOENT: no such file',
    );
    // Dropping the audit event for exactly the calls that failed would be the
    // worst possible gap.
    expect(policy.postToolUse).toHaveBeenCalledWith(
      'Read',
      'call-1',
      { file_path: '/nope' },
      'Error: ENOENT: no such file',
      true,
    );
  });

  it('is fail-closed: a pre-call IPC failure denies (inherited from the policy)', async () => {
    // createToolPolicy converts a thrown IPC error into decision:'deny'. The
    // wrapper must surface that as a denial result, not run the tool. Scoped
    // to exactly that — a hand-built verdict cannot say anything about what
    // the REAL policy puts in `reason` or `cause`; the two TASK-239 tests
    // below drive `createToolPolicy` itself for that.
    const policy = fakePolicy({
      preToolUse: vi.fn(async () => ({
        decision: 'deny' as const,
        reason: 'the approval check could not be completed',
        cause: 'unavailable' as const,
      })),
    } as never);
    const run = vi.fn(async () => 'ran anyway');
    const execute = wrapWithPolicy({ policy, name: 'Bash', isBuiltin: true, holdLatch: createHoldLatch() }, run);

    await expect(execute({ command: 'ls' }, OPTS)).resolves.toContain(
      'approval check could not be completed',
    );
    expect(run).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // TASK-239. These two drive the REAL createToolPolicy through the REAL
  // wrapper, because the whole defect lived in the seam between them: the
  // policy produced a reason, the wrapper appended a claim about it, and no
  // test ever ran both. A `fakePolicy` supplying its own reason keeps every
  // assertion below green no matter what the runner actually says.
  // ---------------------------------------------------------------------

  it('tells the model a gate outage MIGHT clear, and never that a rule blocked the call', async () => {
    const client = {
      call: vi.fn().mockRejectedValue(new Error('connect failed: ECONNREFUSED')),
    } as never as IpcClient;
    const policy = createToolPolicy({
      client,
      workspaceRoot: '/agent',
      warn: vi.fn(),
    });
    const run = vi.fn(async () => 'ran anyway');
    const execute = wrapWithPolicy(
      { policy, name: 'Bash', isBuiltin: true, holdLatch: createHoldLatch() },
      run,
    );

    const text = await execute({ command: 'ls' }, OPTS);

    expect(run).not.toHaveBeenCalled();
    // 1. The internal error string is not the model's (or the reader's) problem.
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('connect failed');
    // 2. The false causal claim. Nothing adjudicated this call, so asserting a
    //    retry is futile is something the runner simply does not know.
    expect(text).not.toContain('retrying the same call will be denied again');
    expect(text).not.toContain('denied by policy');
    // 3. What it should say instead: no rule fired, and a retry may work.
    expect(text).toContain('No rule blocked this');
    expect(text).toMatch(/try again/i);
    // 4. But it must not overcorrect into a second unbacked claim. One of the
    //    two failures behind `unavailable` is a response we could not parse,
    //    which a retry reproduces exactly — so no timescale, and no promise.
    expect(text).not.toContain('shortly');
    expect(text).not.toMatch(/will succeed|may well/i);
  });

  it('still tells the model a real policy denial is final', async () => {
    // The other side of the branch. Softening THIS case would be its own bug:
    // a model that thinks a standing rule is a blip retries it all turn.
    const client = {
      call: vi.fn().mockResolvedValue({
        verdict: 'reject',
        reason: 'npm is not on the egress allowlist; use pnpm',
      }),
    } as never as IpcClient;
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });
    const run = vi.fn(async () => 'ran anyway');
    const execute = wrapWithPolicy(
      { policy, name: 'Bash', isBuiltin: true, holdLatch: createHoldLatch() },
      run,
    );

    const text = await execute({ command: 'npm i' }, OPTS);

    expect(run).not.toHaveBeenCalled();
    // The host's own reason still reaches the model verbatim — it was written
    // for the model, unlike an Error.message.
    expect(text).toContain('npm is not on the egress allowlist');
    expect(text).toContain('retrying the same call will be denied again');
    expect(text).not.toContain('try again');
  });

  it('marks the returned execute so a bypass is detectable', () => {
    const execute = wrapWithPolicy(
      { policy: fakePolicy(), name: 'Bash', isBuiltin: true, holdLatch: createHoldLatch() },
      async () => 'x',
    );
    expect(execute[POLICY_WRAPPED]).toBe(true);
  });

  it('returns the hold note as tool text, trips the latch, and never runs the tool', async () => {
    const latch = createHoldLatch();
    let ran = false;
    const execute = wrapWithPolicy(
      {
        policy: fakePolicy({
          preToolUse: vi.fn(async () => ({
            decision: 'hold' as const,
            decisionId: 'dec_3',
            note: 'Held: sending email',
          })),
        } as never),
        name: 'gmail_send',
        isBuiltin: false,
        holdLatch: latch,
      },
      async () => {
        ran = true;
        return 'sent';
      },
    );
    const out = await execute({ to: 'a@b.c' }, { toolCallId: 'tc_1' });
    expect(ran).toBe(false);
    expect(out).toContain('Held: sending email');
    // The instruction is the whole point of `hold` over `deny`: "not yet"
    // must not read to the model as "not this way".
    expect(out).toContain('Do not retry it and do not achieve the same effect another way.');
    expect(out).toContain('waiting for the person you are working for');
    expect(latch.decisionId).toBe('dec_3');
  });
});

describe('assertAllToolsWrapped', () => {
  it('accepts a tool set whose every execute is wrapped', () => {
    const policy = fakePolicy();
    const tools = {
      Bash: {
        execute: wrapWithPolicy(
          { policy, name: 'Bash', isBuiltin: true, holdLatch: createHoldLatch() },
          async () => 'x',
        ),
      },
    };
    expect(() => assertAllToolsWrapped(tools)).not.toThrow();
  });

  it('throws and names any tool registered on a bypass path', () => {
    const policy = fakePolicy();
    const tools = {
      Bash: {
        execute: wrapWithPolicy(
          { policy, name: 'Bash', isBuiltin: true, holdLatch: createHoldLatch() },
          async () => 'x',
        ),
      },
      // Somebody adds a tool later and wires execute directly. This is the
      // regression the assertion exists to catch.
      Sneaky: { execute: async (): Promise<string> => 'unguarded' },
    };
    expect(() => assertAllToolsWrapped(tools)).toThrow(/Sneaky/);
  });

  it('throws for a tool with no execute at all', () => {
    expect(() => assertAllToolsWrapped({ Broken: {} })).toThrow(/Broken/);
  });

  it('throws when a tool carries a DIFFERENT hold latch than the loop is watching', () => {
    // The silent-failure shape: this tool is policy-wrapped, so the old check
    // passes it. But `stopWhen` reads the loop's latch, and this one trips a
    // latch nobody watches — the call is refused and the turn keeps going.
    const loopLatch = createHoldLatch();
    const tools = {
      Bash: {
        execute: wrapWithPolicy(
          { policy: fakePolicy(), name: 'Bash', isBuiltin: true, holdLatch: loopLatch },
          async () => 'x',
        ),
      },
      Stray: {
        execute: wrapWithPolicy(
          { policy: fakePolicy(), name: 'Stray', isBuiltin: true, holdLatch: createHoldLatch() },
          async () => 'x',
        ),
      },
    };
    expect(() => assertAllToolsWrapped(tools, loopLatch)).toThrow(/Stray/);
    expect(() => assertAllToolsWrapped(tools, loopLatch)).not.toThrow(/Bash/);
    // Without the expected latch the check is opt-in and stays quiet.
    expect(() => assertAllToolsWrapped(tools)).not.toThrow();
  });
});

describe('mergeToolSets', () => {
  it('merges disjoint groups', () => {
    const merged = mergeToolSets([
      { label: 'built-ins', tools: { Bash: 1, Read: 2 } },
      { label: 'host catalog tools', tools: { web_search: 3 } },
    ]) as unknown as Record<string, number>;
    expect(Object.keys(merged).sort()).toEqual(['Bash', 'Read', 'web_search']);
  });

  // A plain object spread would silently hand `Read` to the host tool, so the
  // agent's file reads would start happening on a different machine with
  // nothing failing. Boot-time error instead.
  it('refuses to let a catalog tool shadow a built-in, and names both sides', () => {
    expect(() =>
      mergeToolSets([
        { label: 'built-ins', tools: { Read: 1 } },
        { label: 'host catalog tools', tools: { Read: 2 } },
      ]),
    ).toThrow(/'Read' is claimed by both built-ins and host catalog tools/);
  });

  it('refuses a collision with the Skill tool too', () => {
    expect(() =>
      mergeToolSets([
        { label: 'host catalog tools', tools: { Skill: 1 } },
        { label: 'the Skill tool', tools: { Skill: 2 } },
      ]),
    ).toThrow(/Skill/);
  });

  it('is a no-op for empty groups', () => {
    expect(mergeToolSets([{ label: 'a', tools: {} }])).toEqual({});
  });
});

describe('hold latch identity across the built tool set', () => {
  // A per-tool latch would let a hold return text without ever ending the
  // turn — `main.ts` reads ONE latch in `stopWhen`, so every builder MUST be
  // handed the same instance. This mirrors how `main.ts` actually assembles
  // the tool set: mergeToolSets over all four builders, one shared latch.
  //
  // What this test guards is the BUILDERS: hand them all one latch and every
  // wrapped `execute` must carry that same object. It does not re-verify
  // `main.ts`'s own wiring — that is covered by `holdLatch` being a REQUIRED
  // option on all four builder types (tsc rejects a missing wire) plus the
  // single `const holdLatch` those four call sites read.
  function mkHostClient(): IpcClient {
    return {
      call: async () => ({ ok: true }),
      callGet: async () => {
        throw new Error('callGet not expected');
      },
      callBinary: async () => {
        throw new Error('callBinary not expected');
      },
      callBinaryUpload: async () => {
        throw new Error('callBinaryUpload not expected');
      },
      event: async () => {
        throw new Error('event not expected');
      },
      close: async () => {
        /* no-op */
      },
    } as IpcClient;
  }

  const HOST_DESCRIPTOR: ToolDescriptor = {
    name: 'memory.recall',
    description: 'recall a memory',
    inputSchema: { type: 'object' },
    executesIn: 'host',
  };
  const SANDBOX_DESCRIPTOR: ToolDescriptor = {
    name: 'echo_local',
    description: 'echo (sandbox-executed)',
    inputSchema: { type: 'object' },
    executesIn: 'sandbox',
  };
  const SKILL: DiscoveredSkill = {
    id: 'pdf-filler',
    name: 'pdf-filler',
    description: 'Fills in PDF forms',
    dir: '/home/agent/.claude/skills/pdf-filler',
    body: '# pdf-filler\n\nOpen the form, then fill each field.\n',
    hasMcpServers: false,
  };

  it('gives every wrapped tool the same hold latch instance', () => {
    const latch = createHoldLatch();
    const dispatcher = createLocalDispatcher();
    dispatcher.register('echo_local', async (call) => ({ echoed: call.input }));

    const catalog = [HOST_DESCRIPTOR, SANDBOX_DESCRIPTOR];

    const tools = mergeToolSets([
      {
        label: 'built-ins',
        tools: buildBuiltinTools({
          policy: fakePolicy(),
          homeDir: '/tmp/ax-hold-latch-test-home',
          env: {},
          holdLatch: latch,
        }),
      },
      {
        label: 'host catalog tools',
        tools: buildHostTools({
          policy: fakePolicy(),
          client: mkHostClient(),
          tools: catalog,
          holdLatch: latch,
        }),
      },
      {
        label: 'sandbox catalog tools',
        tools: buildSandboxTools({
          policy: fakePolicy(),
          dispatcher,
          tools: catalog,
          holdLatch: latch,
        }),
      },
      {
        label: 'the Skill tool',
        tools: buildSkillTool({ policy: fakePolicy(), skills: [SKILL], holdLatch: latch }),
      },
    ]) as unknown as Record<string, { execute: WrappedExecute }>;

    // Non-empty and covers all four groups: built-ins (e.g. Bash), the host
    // catalog tool, the sandbox catalog tool, and Skill.
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(['Bash', 'memory.recall', 'echo_local', 'Skill']),
    );

    for (const [name, entry] of Object.entries(tools)) {
      expect(entry.execute[POLICY_WRAPPED], name).toBe(true);
      expect(entry.execute[HOLD_LATCH], name).toBe(latch);
    }
  });
});
