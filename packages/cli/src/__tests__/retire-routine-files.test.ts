import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus, makeAgentContext } from '@ax/core';
import { registerWorkspaceGitHooks } from '@ax/workspace-git-core';
import { describe, it, expect } from 'vitest';
import { runRetireRoutineFilesCommand } from '../retire-routine-files.js';

describe('retire-routine-files CLI', () => {
  it('publishes both exact bin names and reaches maintenance through the built entrypoint', async () => {
    const metadata = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(metadata.bin).toEqual({ ax: './dist/main.js', 'ax-next': './dist/main.js' });
    const root = await mkdtemp(join(tmpdir(), 'routine-cli-entry-'));
    try {
      const output = execFileSync(process.execPath, [fileURLToPath(new URL('../../dist/main.js', import.meta.url)), 'retire-routine-files', '--repo-root', root], { encoding: 'utf8' });
      expect(JSON.parse(output)).toEqual({ dryRun: true, repositories: 0, removed: 0, failures: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('defaults to an offline dry-run and reports fixed JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'routine-cli-'));
    try {
      const lines: string[] = [];
      expect(await runRetireRoutineFilesCommand({ argv: ['--repo-root', root], out: line => lines.push(line) })).toBe(0);
      expect(JSON.parse(lines[0]!)).toEqual({ dryRun: true, repositories: 0, removed: 0, failures: [] });
      lines.length = 0;
      expect(await runRetireRoutineFilesCommand({ argv: ['--repo-root', root, '--apply'], out: line => lines.push(line) })).toBe(0);
      expect(JSON.parse(lines[0]!).dryRun).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('applies to a real bare repository only with --apply, then verifies a clean current tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'routine-cli-repo-'));
    try {
      const bus = new HookBus(); registerWorkspaceGitHooks(bus, { repoRoot: root });
      const ctx = makeAgentContext({ sessionId: 'maintenance', agentId: 'cli-test', userId: 'owner' });
      await bus.call('workspace:apply-internal', ctx, { parent: null, changes: [{ kind: 'put', path: '.ax/routines/old.md', content: new TextEncoder().encode('do not print') }] });
      const lines: string[] = []; const out = (line: string) => lines.push(line);
      expect(await runRetireRoutineFilesCommand({ argv: ['--repo-root', root], out })).toBe(0);
      expect(JSON.parse(lines.pop()!)).toMatchObject({ dryRun: true, removed: 1 });
      expect(await runRetireRoutineFilesCommand({ argv: ['--repo-root', root, '--apply'], out })).toBe(0);
      expect(JSON.parse(lines.pop()!)).toMatchObject({ dryRun: false, removed: 1 });
      expect(await runRetireRoutineFilesCommand({ argv: ['--repo-root', root], out })).toBe(0);
      expect(JSON.parse(lines.pop()!)).toMatchObject({ removed: 0, failures: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('reports an inaccessible root with a fixed code and unsuccessful exit', async () => {
    const lines: string[] = [];
    expect(await runRetireRoutineFilesCommand({ argv: ['--repo-root', '/definitely-absent-routine-test-root'], out: line => lines.push(line) })).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ failures: [{ repository: '<root>', code: 'maintenance-failed' }] });
  });
  it.each([[], ['--repo-root', 'relative'], ['--repo-root', '/tmp', '--unknown'], ['--repo-root', '/tmp', '--repo-root', '/tmp']].map(argv => ({ argv })))('rejects invalid arguments without echoing input', async ({ argv }) => {
    const errors: string[] = [];
    expect(await runRetireRoutineFilesCommand({ argv, err: line => errors.push(line) })).toBe(2);
    expect(errors).toEqual(['usage: ax retire-routine-files --repo-root <absolute-root> [--apply] (host must be stopped)']);
  });
});
