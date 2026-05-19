import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createIpcServerPlugin } from '@ax/ipc-server';
import { createSandboxSubprocessPlugin } from '../plugin.js';
import type { OpenSessionResult } from '../open-session.js';

// ---------------------------------------------------------------------------
// Phase 0 acceptance — SDK skill discovery (I-P0-1/3/4/5).
//
// This is the "canary" integration test for Phase 0. It exercises the full
// sandbox-subprocess + env-contract wiring chain by:
//
//   1. Writing a workspace-authored skill at `.ax/skills/canary-skill/SKILL.md`
//      (the host-owned location).
//   2. Laying down `<workspace>/.claude/skills → ../.ax/skills` — the
//      shape the runner's `scaffoldWorkspaceSkillSurface` produces after
//      `materializeWorkspace`. Echo-stub doesn't run materialize, so we
//      reproduce the runner's post-materialize on-disk shape directly
//      from the test. The host side stopped doing this in mirror-of-PR
//      #99 (it collided with the runner's `git clone` of the bundle).
//   3. Opening a sandbox session against that workspace.
//   4. Having the spawned echo-stub act as the SDK would: readlink the
//      symlink and read the SKILL.md file through it. The stub also
//      stats `$CLAUDE_CONFIG_DIR/skills/` (the empty install target).
//
// If any of these probes fail, the SDK booting in this child would not
// see the workspace skill — which is what Phase 0 promises. The real-SDK
// turn lives in deploy/MANUAL-ACCEPTANCE.md (the "Phase 0: SDK skill
// discovery" bullet under the first-use wizard scenario).
//
// We deliberately skip stub-runner / chat-pipeline here: the orchestrator
// chain isn't load-bearing for this contract; echo-stub via openSession()
// is the lightest seam that exercises both the symlink and the env.
// ---------------------------------------------------------------------------

const ECHO_STUB = fileURLToPath(new URL('./fixtures/echo-stub.mjs', import.meta.url));

const CANARY_SKILL_BODY = `---
name: canary-skill
description: Phase-0 canary — asserts the SDK can discover workspace-authored skills via the symlinked .claude/skills/ path.
---

# Canary Skill

When asked, mention "canary-skill" by name.
`;

async function mkWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'ax-ws-'));
  return dir;
}

async function makeHarness() {
  return createTestHarness({
    services: {
      'llm:call': async () => ({
        assistantMessage: { role: 'assistant', content: '' },
        toolCalls: [],
      }),
      'tool:list': async () => ({ tools: [] }),
    },
    plugins: [
      createSessionInmemoryPlugin(),
      createIpcServerPlugin(),
      createSandboxSubprocessPlugin(),
    ],
  });
}

// echo-stub writes TWO JSON lines on stdout: env (line 1) + probe (line 2).
// Read both and parse them. Resolves once `count` newline-terminated lines
// have arrived; rejects on stdout error, on the stream closing before
// `count` lines arrive, or on a hard timeout — never hangs.
//
// Why bother with timeout + close handling: if the spawned echo-stub
// crashes during startup (missing module, unhandled exception, env-contract
// regression that throws before the JSON writes), stdout closes empty and
// a naïve `await readStdoutLines(result, 2)` waits indefinitely until
// vitest's own timeout, where the failure surfaces as "test timed out"
// with no clue about where. With explicit rejection paths the failure
// surfaces as "stdout closed before 2 lines; got 0" or "timeout after
// 5000ms; partial buffer: …" — which actually points at the regression.
function readStdoutLines(
  result: OpenSessionResult,
  count: number,
  timeoutMs = 5000,
): Promise<string[]> {
  const stdout = result.handle.child?.stdout;
  if (stdout === undefined) {
    throw new Error('test harness expected handle.child.stdout');
  }
  return new Promise<string[]>((resolve, reject) => {
    let buf = '';
    const lines: string[] = [];
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      stdout.off('data', onData);
      stdout.off('error', onErr);
      stdout.off('end', onClose);
      stdout.off('close', onClose);
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `readStdoutLines: timeout after ${timeoutMs}ms; got ${lines.length}/${count} lines. ` +
              `Partial buffer: ${JSON.stringify(buf.slice(0, 200))}`,
          ),
        ),
      );
    }, timeoutMs);

    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl = buf.indexOf('\n');
      while (nl >= 0 && lines.length < count) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
      if (lines.length >= count) {
        settle(() => resolve(lines));
      }
    };
    const onErr = (err: Error): void => {
      settle(() => reject(err));
    };
    const onClose = (): void => {
      settle(() =>
        reject(
          new Error(
            `readStdoutLines: stdout closed before ${count} lines; got ${lines.length}. ` +
              `Partial buffer: ${JSON.stringify(buf.slice(0, 200))}`,
          ),
        ),
      );
    };

    stdout.on('data', onData);
    stdout.on('error', onErr);
    stdout.on('end', onClose);
    stdout.on('close', onClose);
  });
}

type ProbeField<T> = { value: T | null; error: string | null };
interface SkillProbe {
  workspaceRoot: string | null;
  workspaceSkillsSymlinkTarget: ProbeField<string>;
  canaryReadFile: ProbeField<string>;
  installedSkillsDir: ProbeField<{ isDirectory: boolean }>;
}

describe('Phase 0: SDK skill discovery acceptance', () => {
  it('runner subprocess sees workspace SKILL.md via the symlinked .claude/skills path', async () => {
    const ws = await mkWorkspace();
    // Track the spawned session so cleanup runs even if an early assertion
    // throws. Without this guard, a failing expect() in the middle of the
    // test would skip the kill() + rm() tail and leak the child process
    // plus the workspace tempdir — destabilizing later tests in the run.
    let result: OpenSessionResult | undefined;
    try {
      // 1. Author a canary skill at the host-owned `.ax/skills/` location —
      //    same shape an agent would write through the workspace plugin.
      const canaryDir = path.join(ws, '.ax', 'skills', 'canary-skill');
      await fs.mkdir(canaryDir, { recursive: true });
      await fs.writeFile(path.join(canaryDir, 'SKILL.md'), CANARY_SKILL_BODY);

      // 2. Lay down `.claude/skills → ../.ax/skills`. In production the
      //    runner main does this via `scaffoldWorkspaceSkillSurface` right
      //    after `materializeWorkspace` (see PR #99). Echo-stub never
      //    calls materialize, so we reproduce the post-materialize shape
      //    here. The two-line setup is the contract under test: if the
      //    on-disk shape matches, the SDK's `'project'` source resolves.
      await fs.mkdir(path.join(ws, '.claude'), { recursive: true });
      await fs.symlink('../.ax/skills', path.join(ws, '.claude', 'skills'));

      const h = await makeHarness();
      const ctx = h.ctx();
      // 3. Open the sandbox. open-session allocates a per-session HOME
      //    with `$CLAUDE_CONFIG_DIR/skills/` and leaves the workspace
      //    untouched (the scaffold above is the only `.claude` content).
      result = await h.bus.call<unknown, OpenSessionResult>(
        'sandbox:open-session',
        ctx,
        { sessionId: 'p0-canary', workspaceRoot: ws, runnerBinary: ECHO_STUB },
      );

      // 3. echo-stub emits env (line 1) then probe (line 2). Parse both.
      const [envLine, probeLine] = await readStdoutLines(result, 2);
      const env = JSON.parse(envLine) as Record<string, string | null>;
      const probe = JSON.parse(probeLine) as SkillProbe;

      // The child's view of CLAUDE_CONFIG_DIR matches the runner env contract
      // (Task 3). Sanity-check before trusting the probe data.
      expect(env.CLAUDE_CONFIG_DIR).toBe(
        path.join(env.HOME as string, '.ax', 'session'),
      );
      expect(probe.workspaceRoot).toBe(ws);

      // I-P0-4: the symlink the SDK's 'project' source walks resolves to
      // `../.ax/skills` (relative target, so it survives a remount).
      expect(probe.workspaceSkillsSymlinkTarget.error).toBeNull();
      expect(probe.workspaceSkillsSymlinkTarget.value).toBe('../.ax/skills');

      // I-P0-5: the workspace-authored SKILL.md is reachable through the
      // symlink — which is the exact path the SDK walks at startup. If this
      // read fails, the SDK won't see the skill either.
      expect(probe.canaryReadFile.error).toBeNull();
      expect(probe.canaryReadFile.value).toContain('name: canary-skill');
      expect(probe.canaryReadFile.value).toContain(
        'When asked, mention "canary-skill" by name.',
      );

      // I-P0-3: `$CLAUDE_CONFIG_DIR/skills/` is pre-created. Phase 0 leaves
      // it empty; Phase 1+ will populate it with host-installed skills.
      expect(probe.installedSkillsDir.error).toBeNull();
      expect(probe.installedSkillsDir.value).toEqual({ isDirectory: true });
    } finally {
      if (result !== undefined) {
        await result.handle.kill();
        await result.handle.exited;
      }
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});
