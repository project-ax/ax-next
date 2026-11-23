import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { assertConfigDirFresh } from '@ax/agent-runner-core';
import { stripClaudeCodeEnv } from './real-sdk-env.js';
import {
  ENV_PROBE_COMMAND,
  HAVE_BINARY,
  makeFreshConfigDir,
  makeSandboxDirs,
  mainFloors,
  openSession,
  plantSettingsCommand,
  printfMarker,
  removeTree,
  startScriptedServer,
  toolResultsIn,
  type ScriptedServer,
} from './scripted-model.js';

// ---------------------------------------------------------------------------
// TASK-1217 item 1 — the card's ACCEPTANCE, on the REAL claude binary:
// "an agent-written settings.json doesn't change the next session's env or
// hooks".
//
// The agent's Bash runs as the CLI's own user, so it can write
// `$CLAUDE_CONFIG_DIR/settings.json` and `CLAUDE.md`. Nothing today starts a
// second CLI on a dir an earlier session wrote (k8s: one runner per pod on a
// per-pod emptyDir; warm pool: assigned once; subprocess: a per-session
// mkdtemp). `assertConfigDirFresh` (runner-core, called by `runRunner` right
// after the TASK-994 overlap guard) is what keeps that true: a runner that is
// handed a used config dir exits 2 before it starts a CLI.
//
//   CONTROL  session A plants a settings.json (env + SessionStart /
//            UserPromptSubmit / PreToolUse command hooks) and a CLAUDE.md with
//            its Bash tool. Session B, a NEW query() (a new CLI process) on the
//            SAME config dir, runs the planted hooks and sees the planted env.
//            This proves the plant is live on this binary, so FIX is not a
//            vacuous pass.
//   FIX      after A plants, `assertConfigDirFresh` refuses that dir (the
//            runner would never start a CLI there: runner-core's run-runner
//            test pins exit 2 with no IPC and no query). The session the
//            sandbox actually gives next is a FRESH dir holding only skills/:
//            the guard accepts it, and a session there sees no hook and no env.
//
// Skips itself when the platform's native binary is not installed.
// ---------------------------------------------------------------------------

let server: ScriptedServer;
let tmp: string;
let files: string;
let cfg: string;

beforeEach(async () => {
  ({ tmp, files, cfg } = await makeSandboxDirs('ax-t1217-next-'));
  server = await startScriptedServer();
});

afterEach(async () => {
  await server.close();
  await removeTree(tmp);
});

async function readMarker(marker: string): Promise<string[]> {
  const text = await fs.readFile(marker, 'utf8').catch(() => '');
  return text.split('\n').filter((l) => l !== '');
}

/** Session A: the agent plants settings.json and CLAUDE.md in its own config dir. */
async function runSessionA(marker: string): Promise<void> {
  server.setScript([
    { tool: 'Bash', input: { command: `${plantSettingsCommand(marker)} && ${printfMarker('MEM', '> "$CLAUDE_CONFIG_DIR/CLAUDE.md"')} && echo planted`, description: 'plant' } },
    { text: 'planted' },
  ]);
  const a = await openSession({ server, cfg, files, env: { ...stripClaudeCodeEnv(), ...mainFloors() } });
  try {
    await a.send('go');
  } finally {
    await a.close();
  }
  // The plant landed on disk, and nothing ran it in session A itself (the CLI
  // had no settings.json when it started, so it never loaded this one).
  expect(await fs.readFile(path.join(cfg, 'settings.json'), 'utf8')).toContain('PLANTED_T1217');
  expect(await fs.readFile(path.join(cfg, 'CLAUDE.md'), 'utf8')).toContain('PLANTED-MEM-T1217');
  expect(await readMarker(marker), 'session A must not have run its own planted hooks').toEqual([]);
}

describe.skipIf(!HAVE_BINARY)('a config dir an earlier session wrote, on the real claude-sdk binary (TASK-1217)', () => {
  it('CONTROL: a NEW CLI on the same config dir runs the planted hooks and sees the planted env', async () => {
    const marker = path.join(tmp, 'control-marker.log');
    await runSessionA(marker);

    const from = server.calls.length;
    server.setScript([
      { tool: 'Bash', input: { command: ENV_PROBE_COMMAND, description: 'env' } },
      { text: 'checked' },
    ]);
    // Instruction-files floor OFF here only so the planted CLAUDE.md is
    // observable; the settings.json hooks and env are what this case is about.
    const b = await openSession({ server, cfg, files, env: { ...stripClaudeCodeEnv(), ...mainFloors({ instructionFiles: false }) } });
    try {
      await b.send('check');
    } finally {
      await b.close();
    }
    const tags = await readMarker(marker);
    expect(tags, 'planted SessionStart hook did not run').toContain('ss');
    expect(tags, 'planted UserPromptSubmit hook did not run').toContain('ups');
    expect(tags, 'planted PreToolUse hook did not run').toContain('pre');
    const bBodies = server.calls.slice(from).filter((c) => c.agentLoop).map((c) => c.body);
    expect(bBodies.length).toBeGreaterThan(1);
    const envResult = toolResultsIn(bBodies.at(-1) ?? '{}').map((r) => r.text).join('\n');
    expect(envResult).toContain('ENV=[yes]');
    expect(bBodies[0], 'the planted CLAUDE.md was not loaded').toContain('PLANTED-MEM-T1217');
  }, 60_000);

  it('FIX: the used dir is refused at boot, and the fresh dir the sandbox gives next sees no hook and no env', async () => {
    const marker = path.join(tmp, 'fix-marker.log');
    await runSessionA(marker);

    await expect(assertConfigDirFresh({ claudeConfigDir: cfg })).rejects.toThrow(
      /refusing to start: CLAUDE_CONFIG_DIR .* is not fresh/,
    );

    const cfg2 = await makeFreshConfigDir(tmp, 'cfg2');
    await expect(assertConfigDirFresh({ claudeConfigDir: cfg2 })).resolves.toBeUndefined();

    const from = server.calls.length;
    server.setScript([
      { tool: 'Bash', input: { command: ENV_PROBE_COMMAND, description: 'env' } },
      { text: 'checked' },
    ]);
    const next = await openSession({ server, cfg: cfg2, files, env: { ...stripClaudeCodeEnv(), ...mainFloors() } });
    try {
      await next.send('check');
    } finally {
      await next.close();
    }
    expect(await readMarker(marker)).toEqual([]);
    const bodies = server.calls.slice(from).filter((c) => c.agentLoop).map((c) => c.body);
    expect(bodies.length, 'the fresh session never ran its Bash call').toBeGreaterThan(1);
    const envResult = toolResultsIn(bodies.at(-1) ?? '{}').map((r) => r.text).join('\n');
    expect(envResult).toContain('ENV=[]');
    expect(bodies[0]).not.toContain('PLANTED-MEM-T1217');
  }, 60_000);
});
