import type { IpcClient } from '@ax/ipc-protocol';
import { describe, expect, it } from 'vitest';
import {
  createPreToolUseHook,
  resolveAttachmentPaths,
  resolveGovernedPaths,
} from '../pre-tool-use.js';

// PreToolUse is the primary `tool.pre-call` forwarder: the SDK fires it
// for EVERY tool invocation, including built-ins the CLI auto-approves
// internally (e.g. Bash under permissionMode 'default'). canUseTool does
// NOT cover those, which is the bug Week 6.5d Task 14's acceptance test
// uncovered. These tests pin the hook's translation contract.

function mkClient(
  callImpl: (action: string, payload: unknown) => Promise<unknown>,
): { client: IpcClient; calls: Array<{ action: string; payload: unknown }> } {
  const calls: Array<{ action: string; payload: unknown }> = [];
  const client: IpcClient = {
    async call(action, payload) {
      calls.push({ action, payload });
      return await callImpl(action, payload);
    },
    callGet: async () => {
      throw new Error('callGet not expected');
    },
    callBinary: async () => {
      throw new Error('callBinary not expected');
    },
    event: async () => {
      throw new Error('event not expected');
    },
    close: async () => {
      /* no-op */
    },
  };
  return { client, calls };
}

const HOOK_OPTS = { signal: new AbortController().signal };

function preToolUseInput(overrides: {
  tool_name: string;
  tool_input: unknown;
}): Parameters<ReturnType<typeof createPreToolUseHook>>[0] {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp/workspace',
    tool_name: overrides.tool_name,
    tool_input: overrides.tool_input,
    tool_use_id: 'tu_abc',
  } as unknown as Parameters<ReturnType<typeof createPreToolUseHook>>[0];
}

describe('createPreToolUseHook', () => {
  it('forwards built-in tool name verbatim to tool.pre-call and allows on verdict=allow', async () => {
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const hook = createPreToolUseHook({ client, workspaceRoot: '/agent', idGen: () => 'id-1' });
    const out = await hook(
      preToolUseInput({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(calls).toEqual([
      {
        action: 'tool.pre-call',
        payload: {
          call: { id: 'tu_abc', name: 'Bash', input: { command: 'ls' } },
        },
      },
    ]);
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
  });

  it('strips the mcp__ax-host-tools__ prefix for our MCP host tools', async () => {
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const hook = createPreToolUseHook({ client, workspaceRoot: '/agent', idGen: () => 'id-2' });
    await hook(
      preToolUseInput({
        tool_name: 'mcp__ax-host-tools__memory.recall',
        tool_input: { q: 'x' },
      }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(calls[0]).toEqual({
      action: 'tool.pre-call',
      payload: { call: { id: 'tu_abc', name: 'memory.recall', input: { q: 'x' } } },
    });
  });

  it('propagates modifiedCall.input as hookSpecificOutput.updatedInput on allow', async () => {
    const { client } = mkClient(async () => ({
      verdict: 'allow',
      modifiedCall: {
        id: 'tu_abc',
        name: 'Bash',
        input: { command: 'ls -la' },
      },
    }));
    const hook = createPreToolUseHook({ client, workspaceRoot: '/agent', idGen: () => 'id-3' });
    const out = await hook(
      preToolUseInput({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { command: 'ls -la' },
      },
    });
  });

  it('translates verdict=reject into permissionDecision=deny with the reason', async () => {
    const { client } = mkClient(async () => ({
      verdict: 'reject',
      reason: 'path escapes workspace root',
    }));
    const hook = createPreToolUseHook({ client, workspaceRoot: '/agent', idGen: () => 'id-4' });
    const out = await hook(
      preToolUseInput({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'path escapes workspace root',
      },
    });
  });

  it('denies disabled tool names without touching IPC', async () => {
    const { client, calls } = mkClient(async () => {
      throw new Error('IPC should not be reached for disabled tools');
    });
    const hook = createPreToolUseHook({ client, workspaceRoot: '/agent', idGen: () => 'id-5' });
    const out = await hook(
      preToolUseInput({ tool_name: 'WebFetch', tool_input: { url: 'https://x' } }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(calls).toEqual([]);
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'tool disabled by policy',
      },
    });
  });

  it('translates IPC errors into a deny so the SDK surfaces the failure', async () => {
    const { client } = mkClient(async () => {
      throw new Error('host unavailable');
    });
    const hook = createPreToolUseHook({ client, workspaceRoot: '/agent', idGen: () => 'id-6' });
    const out = await hook(
      preToolUseInput({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'host unavailable',
      },
    });
  });

  it('re-roots a home-prefixed .ax/uploads path AND lets the host adjudicate the resolved path', async () => {
    // The bug: the model resolves the workspace-relative `.ax/uploads/...`
    // attachment path under a home dir (`.ax` reads as a home dotfile), so
    // `Read /home/user/.ax/uploads/...` fails. The hook must rewrite it to
    // /agent/.ax/uploads/... via updatedInput so the file actually opens —
    // and the rewrite happens BEFORE tool:pre-call, so the host policy-checks
    // the real path (not the mis-rooted one).
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const hook = createPreToolUseHook({
      client,
      workspaceRoot: '/agent',
      idGen: () => 'id-att',
    });
    const out = await hook(
      preToolUseInput({
        tool_name: 'Read',
        tool_input: { file_path: '/home/user/.ax/uploads/cnv_x/req-y/h__report.pdf' },
      }),
      'tu_abc',
      HOOK_OPTS,
    );
    // The host saw the RESOLVED path, not the model's mis-rooted one.
    expect((calls[0]!.payload as { call: { input: unknown } }).call.input).toEqual({
      file_path: '/agent/.ax/uploads/cnv_x/req-y/h__report.pdf',
    });
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          file_path: '/agent/.ax/uploads/cnv_x/req-y/h__report.pdf',
        },
      },
    });
  });

  it('does NOT set updatedInput for a path outside the attachment namespace', async () => {
    const { client } = mkClient(async () => ({ verdict: 'allow' }));
    const hook = createPreToolUseHook({
      client,
      workspaceRoot: '/agent',
      idGen: () => 'id-noatt',
    });
    const out = await hook(
      preToolUseInput({
        tool_name: 'Read',
        tool_input: { file_path: 'src/index.ts' },
      }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
  });

  it('with broaden, re-roots a cwd-relative .ax/** write back to the governed tier', async () => {
    // TASK-164 §14 linchpin at the hook level: under Plan 2 cwd=/workspace
    // (ungoverned NFS). A model Write of `.ax/SOUL.md` would resolve onto NFS;
    // the hook must re-root it to /agent BEFORE adjudication so the host
    // policy-checks the governed path and the SDK writes it on the git tier.
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const hook = createPreToolUseHook({
      client,
      workspaceRoot: '/agent',
      broaden: true,
      recognizedRoots: ['/workspace', '/ephemeral'],
      idGen: () => 'id-broaden',
    });
    const out = await hook(
      preToolUseInput({
        tool_name: 'Write',
        tool_input: { file_path: '/workspace/.ax/SOUL.md', content: 'x' },
      }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect((calls[0]!.payload as { call: { input: unknown } }).call.input).toEqual({
      file_path: '/agent/.ax/SOUL.md',
      content: 'x',
    });
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { file_path: '/agent/.ax/SOUL.md', content: 'x' },
      },
    });
  });

  it('without broaden, a .claude/** write is NOT re-rooted (today behavior)', async () => {
    // When AX_USERFILES_ROOT is unset, cwd/HOME=/agent and there's no NFS to
    // drift onto: only the legacy `.ax/uploads/` safety-net runs. A `.claude/`
    // write is left exactly as the model emitted it.
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const hook = createPreToolUseHook({
      client,
      workspaceRoot: '/agent',
      idGen: () => 'id-nobroaden',
    });
    const out = await hook(
      preToolUseInput({
        tool_name: 'Write',
        tool_input: { file_path: '.claude/settings.json', content: '{}' },
      }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect((calls[0]!.payload as { call: { input: unknown } }).call.input).toEqual({
      file_path: '.claude/settings.json',
      content: '{}',
    });
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
  });

  it('ignores non-PreToolUse events (defensive narrow)', async () => {
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const hook = createPreToolUseHook({ client, workspaceRoot: '/agent', idGen: () => 'id-7' });
    // Cast is fine; in practice the SDK matcher never routes a different
    // event here, but the adapter guards the wire shape anyway.
    const out = await hook(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-1',
      } as unknown as Parameters<ReturnType<typeof createPreToolUseHook>>[0],
      'tu_abc',
      HOOK_OPTS,
    );
    expect(out).toEqual({});
    expect(calls).toEqual([]);
  });
});

describe('resolveAttachmentPaths', () => {
  it('re-roots a home-prefixed .ax/uploads path to <workspaceRoot> (the bug)', () => {
    expect(
      resolveAttachmentPaths(
        { file_path: '/home/user/.ax/uploads/c/t/h__f.pdf' },
        '/agent',
      ),
    ).toEqual({
      changed: true,
      input: { file_path: '/agent/.ax/uploads/c/t/h__f.pdf' },
    });
  });

  it('makes a bare relative .ax/uploads path absolute under the workspace root', () => {
    expect(
      resolveAttachmentPaths({ file_path: '.ax/uploads/c/t/h__f.pdf' }, '/agent'),
    ).toEqual({
      changed: true,
      input: { file_path: '/agent/.ax/uploads/c/t/h__f.pdf' },
    });
  });

  it('re-roots the path/notebook_path fields too (Glob/Grep/NotebookEdit)', () => {
    expect(
      resolveAttachmentPaths({ path: '/home/user/.ax/uploads/c/t' }, '/agent'),
    ).toEqual({ changed: true, input: { path: '/agent/.ax/uploads/c/t' } });
    expect(
      resolveAttachmentPaths(
        { notebook_path: '.ax/uploads/c/t/n.ipynb' },
        '/agent',
      ),
    ).toEqual({
      changed: true,
      input: { notebook_path: '/agent/.ax/uploads/c/t/n.ipynb' },
    });
  });

  it('does NOT rewrite free-text fields — only structured path fields', () => {
    // An Edit's old_string/new_string, Write's content, or a Bash command/
    // description may legitimately MENTION `.ax/uploads/…` as text; rewriting
    // them would corrupt the edit/command. Only path-bearing keys are touched.
    expect(
      resolveAttachmentPaths(
        {
          file_path: '/home/user/.ax/uploads/c/t/f.txt',
          old_string: 'see .ax/uploads/c/t/f.txt for details',
          command: 'cat /home/user/.ax/uploads/c/t/f.txt',
        },
        '/agent',
      ),
    ).toEqual({
      changed: true,
      input: {
        file_path: '/agent/.ax/uploads/c/t/f.txt',
        old_string: 'see .ax/uploads/c/t/f.txt for details',
        command: 'cat /home/user/.ax/uploads/c/t/f.txt',
      },
    });
  });

  it('does not match `.ax/uploads/` unless it is a path segment', () => {
    // `foo.ax/uploads/x` is not the attachment namespace — must be left alone.
    expect(
      resolveAttachmentPaths({ file_path: 'foo.ax/uploads/x' }, '/agent'),
    ).toEqual({ changed: false, input: { file_path: 'foo.ax/uploads/x' } });
  });

  it('is idempotent on an already-correct workspace path (changed=false)', () => {
    expect(
      resolveAttachmentPaths(
        { file_path: '/agent/.ax/uploads/c/t/h__f.pdf' },
        '/agent',
      ),
    ).toEqual({
      changed: false,
      input: { file_path: '/agent/.ax/uploads/c/t/h__f.pdf' },
    });
  });

  it('normalizes a workspaceRoot trailing slash to avoid a double slash', () => {
    expect(
      resolveAttachmentPaths({ file_path: '.ax/uploads/x' }, '/agent/'),
    ).toEqual({
      changed: true,
      input: { file_path: '/agent/.ax/uploads/x' },
    });
  });

  it('refuses to re-root a path with a .. traversal segment (security)', () => {
    // A crafted `.ax/uploads/../../etc/x` must NOT be re-rooted (which could
    // walk out of the workspace). Legit attachment paths never contain `..`.
    expect(
      resolveAttachmentPaths(
        { file_path: '/home/user/.ax/uploads/../../../etc/passwd' },
        '/agent',
      ),
    ).toEqual({
      changed: false,
      input: { file_path: '/home/user/.ax/uploads/../../../etc/passwd' },
    });
  });

  it('leaves inputs outside the .ax/uploads namespace untouched (changed=false)', () => {
    expect(
      resolveAttachmentPaths({ file_path: 'src/index.ts', n: 3 }, '/agent'),
    ).toEqual({ changed: false, input: { file_path: 'src/index.ts', n: 3 } });
  });

  it('returns an empty object (changed=false) for non-object input', () => {
    expect(resolveAttachmentPaths(null, '/agent')).toEqual({
      changed: false,
      input: {},
    });
  });

  it('default opts (broaden:false) keeps the legacy uploads-only scope', () => {
    // `resolveGovernedPaths` with no opts === the back-compat `resolveAttachmentPaths`.
    expect(
      resolveGovernedPaths({ file_path: '.ax/uploads/c/t/f.txt' }, '/agent'),
    ).toEqual({ changed: true, input: { file_path: '/agent/.ax/uploads/c/t/f.txt' } });
    // A non-uploads governed path is NOT re-rooted without broaden.
    expect(
      resolveGovernedPaths({ file_path: '.ax/SOUL.md' }, '/agent'),
    ).toEqual({ changed: false, input: { file_path: '.ax/SOUL.md' } });
  });
});

// ---------------------------------------------------------------------------
// TASK-164 §14 governance LINCHPIN: the broadened re-rooter. Under Plan 2 the
// agent's cwd/HOME is the ungoverned `/workspace` NFS mount, so a relative or
// cwd-prefixed `.ax/**`/`.claude/**` write would land on NFS and bypass the
// validator + git tier. With `broaden:true` the re-rooter pulls the FULL
// validator policy scope (`@ax/core` POLICY_PREFIXES + POLICY_EXACT_PATHS) back
// onto the governed `/agent` tier. These tests pin that match exhaustively.
// ---------------------------------------------------------------------------
describe('resolveGovernedPaths (broaden: the §14 linchpin)', () => {
  // Recognized roots mirror main.ts: cwd (=/workspace, the NFS mount) + scratch
  // (/ephemeral). /agent (workspaceRoot) is auto-added; /home/+~/ are always on.
  const B = { broaden: true, recognizedRoots: ['/workspace', '/ephemeral'] } as const;
  const reroot = (input: unknown): { changed: boolean; input: Record<string, unknown> } =>
    resolveGovernedPaths(input, '/agent', B);

  it('re-roots a bare relative .ax/** path to the governed tier', () => {
    expect(reroot({ file_path: '.ax/SOUL.md' })).toEqual({
      changed: true,
      input: { file_path: '/agent/.ax/SOUL.md' },
    });
  });

  it('re-roots a bare relative .claude/** path to the governed tier', () => {
    expect(reroot({ file_path: '.claude/settings.json' })).toEqual({
      changed: true,
      input: { file_path: '/agent/.claude/settings.json' },
    });
  });

  it('re-roots a cwd/NFS-prefixed .ax/** path (the core hazard)', () => {
    // cwd=/workspace, so a relative `.ax/x` the SDK resolves becomes
    // `/workspace/.ax/x` — the exact path that would drift onto ungoverned NFS.
    expect(reroot({ file_path: '/workspace/.ax/notes/todo.md' })).toEqual({
      changed: true,
      input: { file_path: '/agent/.ax/notes/todo.md' },
    });
    expect(reroot({ path: '/workspace/.claude/agents/x.md' })).toEqual({
      changed: true,
      input: { path: '/agent/.claude/agents/x.md' },
    });
  });

  it('re-roots a home-prefixed governed path (HOME=/workspace, dotfile illusion)', () => {
    expect(reroot({ file_path: '/home/runner/.claude/skills/evil/SKILL.md' })).toEqual({
      changed: true,
      input: { file_path: '/agent/.claude/skills/evil/SKILL.md' },
    });
  });

  it('re-roots the root-exact CLAUDE.md / CLAUDE.local.md SDK memory files', () => {
    expect(reroot({ file_path: 'CLAUDE.md' })).toEqual({
      changed: true,
      input: { file_path: '/agent/CLAUDE.md' },
    });
    expect(reroot({ file_path: '/workspace/CLAUDE.local.md' })).toEqual({
      changed: true,
      input: { file_path: '/agent/CLAUDE.local.md' },
    });
  });

  it('does NOT match CLAUDE.md when it is a directory component, only as the final file', () => {
    // `CLAUDE.md/foo` is a dir literally named CLAUDE.md — not the SDK memory
    // file, so it must be left alone (only the exact final segment matches).
    expect(reroot({ file_path: '/workspace/CLAUDE.md/foo.txt' })).toEqual({
      changed: false,
      input: { file_path: '/workspace/CLAUDE.md/foo.txt' },
    });
  });

  it('does NOT re-root user-file paths (the whole point — they stay on NFS)', () => {
    for (const file_path of [
      '/workspace/data/dataset.csv',
      '/workspace/repo/src/index.ts',
      'src/index.ts',
      'notes.md',
      '/workspace/.git/config', // NOT a governed prefix — user repo dotdir
      '/workspace/.skill-draft/x/SKILL.md', // drafts live on /workspace by design
    ]) {
      expect(reroot({ file_path })).toEqual({
        changed: false,
        input: { file_path },
      });
    }
  });

  it('still re-roots the legacy .ax/uploads/** subset (superset behavior)', () => {
    expect(reroot({ file_path: '/home/user/.ax/uploads/c/t/f.pdf' })).toEqual({
      changed: true,
      input: { file_path: '/agent/.ax/uploads/c/t/f.pdf' },
    });
  });

  it('is idempotent on an already-governed-rooted path (changed=false)', () => {
    expect(reroot({ file_path: '/agent/.ax/SOUL.md' })).toEqual({
      changed: false,
      input: { file_path: '/agent/.ax/SOUL.md' },
    });
    expect(reroot({ file_path: '/agent/.claude/settings.json' })).toEqual({
      changed: false,
      input: { file_path: '/agent/.claude/settings.json' },
    });
  });

  it('refuses to re-root a governed path with a .. traversal segment (security)', () => {
    expect(
      reroot({ file_path: '/workspace/.ax/../../etc/passwd' }),
    ).toEqual({ changed: false, input: { file_path: '/workspace/.ax/../../etc/passwd' } });
    expect(
      reroot({ file_path: '.claude/../.ssh/id_rsa' }),
    ).toEqual({ changed: false, input: { file_path: '.claude/../.ssh/id_rsa' } });
  });

  it('does not match a governed prefix unless it is a path segment', () => {
    // `foo.ax/x` / `my.claude/x` are not the governed dirs.
    expect(reroot({ file_path: 'foo.ax/x' })).toEqual({
      changed: false,
      input: { file_path: 'foo.ax/x' },
    });
    expect(reroot({ file_path: '/workspace/my.claude/x' })).toEqual({
      changed: false,
      input: { file_path: '/workspace/my.claude/x' },
    });
  });

  it('does NOT re-root a governed dir NESTED under a user subtree (matches validator scope)', () => {
    // A cloned repo's own `/workspace/myrepo/.claude/` is the user's file, NOT
    // AX governed state — the validator only governs git-root-relative top-level
    // `.ax/`+`.claude/`, so neither should this re-rooter. Re-rooting it would
    // corrupt the user's repo by yanking the file to a different tier.
    for (const file_path of [
      '/workspace/myrepo/.claude/settings.json',
      '/workspace/projects/sub/.ax/notes.md',
      'myrepo/.claude/x', // bare-relative but nested → not top-level
      '/home/runner/projects/.ax/x', // nested under home, not directly under it
    ]) {
      expect(reroot({ file_path })).toEqual({ changed: false, input: { file_path } });
    }
  });

  it('re-roots a top-level governed path under the scratch (/ephemeral) root too', () => {
    // /ephemeral is a recognized root, so a top-level governed path there also
    // re-roots to /agent (the agent shouldn't keep governed state on scratch).
    expect(reroot({ file_path: '/ephemeral/.ax/SOUL.md' })).toEqual({
      changed: true,
      input: { file_path: '/agent/.ax/SOUL.md' },
    });
  });

  it('does NOT re-root a top-level governed path under an UNRECOGNIZED absolute root', () => {
    // `/var/tmp` is not a recognized root, so `/var/tmp/.ax/x` is left alone
    // (it's some absolute path the model invented; not the agent's governed state).
    expect(reroot({ file_path: '/var/tmp/.ax/x' })).toEqual({
      changed: false,
      input: { file_path: '/var/tmp/.ax/x' },
    });
  });

  it('rewrites only structured path fields, never free text mentioning .ax/.claude', () => {
    expect(
      reroot({
        file_path: '/workspace/.ax/IDENTITY.md',
        old_string: 'see .claude/settings.json',
        content: 'edit .ax/SOUL.md by hand',
        command: 'cat /workspace/.ax/notes.md',
      }),
    ).toEqual({
      changed: true,
      input: {
        file_path: '/agent/.ax/IDENTITY.md',
        old_string: 'see .claude/settings.json',
        content: 'edit .ax/SOUL.md by hand',
        command: 'cat /workspace/.ax/notes.md',
      },
    });
  });

  it('re-roots the path / notebook_path fields too', () => {
    expect(reroot({ path: '/workspace/.claude/agents' })).toEqual({
      changed: true,
      input: { path: '/agent/.claude/agents' },
    });
    expect(reroot({ notebook_path: '.ax/notebooks/n.ipynb' })).toEqual({
      changed: true,
      input: { notebook_path: '/agent/.ax/notebooks/n.ipynb' },
    });
  });

  it('normalizes a workspaceRoot trailing slash to avoid a double slash', () => {
    expect(
      resolveGovernedPaths({ file_path: '.ax/SOUL.md' }, '/agent/', B),
    ).toEqual({ changed: true, input: { file_path: '/agent/.ax/SOUL.md' } });
  });
});
