import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Tool } from 'ai';
import type { IpcClient } from '@ax/ipc-protocol';
import {
  createHoldLatch,
  createToolPolicy,
  resolveGovernedPaths,
  type RunnerEnv,
} from '@ax/agent-runner-core';
import { buildBuiltinTools } from '../tools/builtins.js';
import { policyRecognizedRoots } from '../policy-roots.js';

// ---------------------------------------------------------------------------
// W2 shared folders in the aisdk runner (spec §3.6, decision AXWM-2).
//
// A shared folder is a file-tool root ONLY. The aisdk file tools already take
// any absolute path, so nothing has to be granted. What must NOT happen is the
// tool policy's re-rooter treating a shared folder as one of its recognized
// roots: `findGovernedSegment` re-roots a top-level `.ax/`, `.claude/` or
// `CLAUDE.md` under ANY recognized root onto the governed `/agent` tier. A
// `.ax/` file in a shared folder is an ordinary project file and must stay
// where the agent pointed.
// ---------------------------------------------------------------------------

const SHARED = '/shared/sf_x';
const ENV: Pick<RunnerEnv, 'workspaceRoot' | 'ephemeralRoot' | 'userFilesRoot' | 'sharedFolders'> = {
  workspaceRoot: '/agent',
  ephemeralRoot: '/ephemeral',
  userFilesRoot: '/files',
  sharedFolders: [{ id: 'sf_x', path: SHARED, readOnly: false }],
};

describe('policyRecognizedRoots (W2)', () => {
  it('is cwd + scratch only — shared folders are never recognized roots', () => {
    expect(policyRecognizedRoots('/files', ENV)).toEqual(['/files', '/ephemeral']);
    expect(policyRecognizedRoots('/files', ENV)).not.toContain(SHARED);
  });

  it('omits the scratch tier when none is wired', () => {
    expect(policyRecognizedRoots('/agent', {})).toEqual(['/agent']);
  });
});

describe('re-rooting with the policy as main.ts constructs it (W2)', () => {
  const opts = { broaden: true, recognizedRoots: policyRecognizedRoots('/files', ENV) };
  const reroot = (input: Record<string, unknown>) => resolveGovernedPaths(input, '/agent', opts);

  it.each([
    `${SHARED}/.ax/foo`,
    `${SHARED}/.claude/skills/x/SKILL.md`,
    `${SHARED}/.claude/settings.json`,
    `${SHARED}/CLAUDE.md`,
  ])('does not re-root %s onto /agent', (p) => {
    expect(reroot({ file_path: p })).toEqual({ changed: false, input: { file_path: p } });
    expect(reroot({ path: p })).toEqual({ changed: false, input: { path: p } });
  });

  it('control: the same paths under the cwd root ARE re-rooted (the hazard a recognized root would cause)', () => {
    expect(reroot({ file_path: '/files/.ax/foo' })).toEqual({
      changed: true,
      input: { file_path: '/agent/.ax/foo' },
    });
    // …and that is exactly what would happen to a shared folder listed as a root.
    expect(
      resolveGovernedPaths({ file_path: `${SHARED}/.ax/foo` }, '/agent', {
        broaden: true,
        recognizedRoots: [...opts.recognizedRoots, SHARED],
      }),
    ).toEqual({ changed: true, input: { file_path: '/agent/.ax/foo' } });
  });
});

describe('builtin file tools on a shared folder, through the real policy (W2)', () => {
  let tmp: string;
  let workspace: string;
  let home: string;
  let shared: string;
  let tools: Record<string, Tool>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ax-aisdk-shared-'));
    workspace = join(tmp, 'agent');
    home = join(tmp, 'files');
    shared = join(tmp, 'shared', 'sf_x');
    await mkdir(workspace, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(shared, { recursive: true });
    const client = {
      call: async (action: string) => (action === 'tool.pre-call' ? { verdict: 'allow' } : {}),
      event: async () => {},
    } as unknown as IpcClient;
    const env: Pick<RunnerEnv, 'ephemeralRoot' | 'sharedFolders'> = {
      sharedFolders: [{ id: 'sf_x', path: shared, readOnly: false }],
    };
    const policy = createToolPolicy({
      client,
      workspaceRoot: workspace,
      broaden: home !== workspace,
      recognizedRoots: policyRecognizedRoots(home, env),
      drainEgressBlocks: async () => [],
    });
    tools = buildBuiltinTools({
      policy,
      homeDir: home,
      env: { PATH: process.env['PATH'] ?? '', HOME: home },
      holdLatch: createHoldLatch(),
      onHold: () => {},
      onToolFailure: () => {},
    });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function run(name: string, input: unknown): Promise<string> {
    const execute = tools[name]?.execute as unknown as (
      input: unknown,
      options: { toolCallId: string; messages: [] },
    ) => Promise<string>;
    return execute(input, { toolCallId: 'call-1', messages: [] });
  }

  it('Read returns a file another agent wrote into the shared folder', async () => {
    await writeFile(join(shared, 'notes.md'), 'hello from a peer\n');
    expect(await run('Read', { file_path: join(shared, 'notes.md') })).toContain('hello from a peer');
  });

  it('Write lands in the shared folder — a .ax/ path there is NOT re-rooted onto the governed tier', async () => {
    await run('Write', { file_path: join(shared, 'out.txt'), content: 'plain' });
    expect(await readFile(join(shared, 'out.txt'), 'utf8')).toBe('plain');

    await run('Write', { file_path: join(shared, '.ax', 'foo.md'), content: 'project file' });
    expect(await readFile(join(shared, '.ax', 'foo.md'), 'utf8')).toBe('project file');
    await expect(stat(join(workspace, '.ax', 'foo.md'))).rejects.toThrow(/ENOENT/);
  });
});
