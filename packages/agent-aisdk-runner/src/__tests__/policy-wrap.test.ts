import { describe, expect, it, vi } from 'vitest';
import type { PreToolVerdict, ToolPolicy } from '@ax/agent-runner-core';
import {
  POLICY_WRAPPED,
  assertAllToolsWrapped,
  wrapWithPolicy,
} from '../tools/policy-wrap.js';

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
    const execute = wrapWithPolicy({ policy, name: 'Bash', isBuiltin: true }, run);

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
      })),
    } as never);
    const run = vi.fn(async () => 'must not run');
    const execute = wrapWithPolicy({ policy, name: 'Bash', isBuiltin: true }, run);

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
    const execute = wrapWithPolicy({ policy, name: 'Read', isBuiltin: true }, run);

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
      { policy, name: 'Bash', isBuiltin: true },
      async () => 'npm ERR! network',
    );

    const out = await execute({ command: 'npm i' }, OPTS);
    expect(out).toBe('npm ERR! network\n\nBlocked host: registry.npmjs.org');
  });

  it('re-throws an executor failure (the SDK error channel) but still audits it', async () => {
    const policy = fakePolicy();
    const execute = wrapWithPolicy(
      { policy, name: 'Read', isBuiltin: true },
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
    // wrapper must surface that as a denial result, not run the tool.
    const policy = fakePolicy({
      preToolUse: vi.fn(async () => ({
        decision: 'deny' as const,
        reason: 'host returned 503',
      })),
    } as never);
    const run = vi.fn(async () => 'ran anyway');
    const execute = wrapWithPolicy({ policy, name: 'Bash', isBuiltin: true }, run);

    await expect(execute({ command: 'ls' }, OPTS)).resolves.toContain('503');
    expect(run).not.toHaveBeenCalled();
  });

  it('marks the returned execute so a bypass is detectable', () => {
    const execute = wrapWithPolicy(
      { policy: fakePolicy(), name: 'Bash', isBuiltin: true },
      async () => 'x',
    );
    expect(execute[POLICY_WRAPPED]).toBe(true);
  });
});

describe('assertAllToolsWrapped', () => {
  it('accepts a tool set whose every execute is wrapped', () => {
    const policy = fakePolicy();
    const tools = {
      Bash: {
        execute: wrapWithPolicy(
          { policy, name: 'Bash', isBuiltin: true },
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
          { policy, name: 'Bash', isBuiltin: true },
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
});
