import { describe, expect, it, vi } from 'vitest';
import { createConfigChangeHook } from '../config-change.js';

// TASK-1217: the CLI reloads its skills (and its settings, when a settings
// file existed at start) when they change on disk mid-session, and the
// agent's shell can change them. The hook blocks every such reload. It logs
// which kind of configuration changed, and nothing the agent chose.

type Hook = ReturnType<typeof createConfigChangeHook>;

const HOOK_OPTS = { signal: new AbortController().signal };

/** A path the agent picked: it must never reach a log line. */
const AGENT_PATH = '/home/runner/.ax/session/skills/evil-T1217/SKILL.md';

function configChange(source: unknown, filePath: string | undefined = AGENT_PATH): Parameters<Hook>[0] {
  return {
    hook_event_name: 'ConfigChange',
    session_id: 'sess-1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/files',
    source,
    ...(filePath !== undefined ? { file_path: filePath } : {}),
  } as unknown as Parameters<Hook>[0];
}

const BLOCK = {
  decision: 'block',
  reason: "This session's configuration is fixed when it starts.",
};

describe('createConfigChangeHook', () => {
  it('blocks a change from every source and logs one line naming that source', async () => {
    for (const source of ['user_settings', 'project_settings', 'local_settings', 'policy_settings', 'skills']) {
      const log = vi.fn();
      const hook = createConfigChangeHook(log);

      expect(await hook(configChange(source), undefined, HOOK_OPTS), source).toEqual(BLOCK);
      expect(log, source).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0], source).toBe(
        `runner: blocked a mid-session change to the CLI's ${source} (its configuration is fixed when the session starts)`,
      );
    }
  });

  it('blocks a change from a source it does not know, and logs it as unknown on one line', async () => {
    for (const source of ['weird\nsource', 'skills\nrunner: ok', 'toString', '', 42, null, undefined]) {
      const log = vi.fn();
      const hook = createConfigChangeHook(log);

      expect(await hook(configChange(source), undefined, HOOK_OPTS), String(source)).toEqual(BLOCK);
      expect(log, String(source)).toHaveBeenCalledTimes(1);
      const line = log.mock.calls[0]![0] as string;
      expect(line, String(source)).toBe(
        "runner: blocked a mid-session change to the CLI's unknown (its configuration is fixed when the session starts)",
      );
      expect(line, String(source)).not.toMatch(/[\r\n]/);
    }
  });

  it('never logs the changed file path: the agent chose it', async () => {
    const log = vi.fn();
    const hook = createConfigChangeHook(log);

    await hook(configChange('skills'), undefined, HOOK_OPTS);
    await hook(configChange('user_settings', '/tmp/x\nrunner: forged line'), undefined, HOOK_OPTS);

    const logged = log.mock.calls.map((c) => c[0] as string).join('\n');
    expect(logged).not.toContain(AGENT_PATH);
    expect(logged).not.toContain('evil-T1217');
    expect(logged).not.toContain('forged line');
  });

  // The CLI counts a hook that throws as "not blocked" and reloads (measured in
  // the 2.1.119 hook runner), so the block must never depend on the log line.
  it('still blocks when its log line cannot be written', async () => {
    const hook = createConfigChangeHook(() => {
      throw new Error('EPIPE');
    });

    expect(await hook(configChange('skills'), undefined, HOOK_OPTS)).toEqual(BLOCK);
  });

  it('blocks a change that names no file', async () => {
    const log = vi.fn();
    const hook = createConfigChangeHook(log);

    expect(await hook(configChange('skills', undefined), undefined, HOOK_OPTS)).toEqual(BLOCK);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('leaves any other hook event alone and logs nothing', async () => {
    const log = vi.fn();
    const hook = createConfigChangeHook(log);

    const out = await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/files',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
        tool_use_id: 'tu_1',
      } as unknown as Parameters<Hook>[0],
      'tu_1',
      HOOK_OPTS,
    );

    expect(out).toEqual({});
    expect(log).not.toHaveBeenCalled();
  });

  it('writes its line to stderr by default', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await createConfigChangeHook()(configChange('skills'), undefined, HOOK_OPTS);
      expect(stderrSpy.mock.calls.map((c) => String(c[0]))).toEqual([
        "runner: blocked a mid-session change to the CLI's skills (its configuration is fixed when the session starts)\n",
      ]);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
