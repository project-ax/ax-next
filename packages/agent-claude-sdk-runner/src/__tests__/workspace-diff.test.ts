import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDiffAccumulator } from '@ax/agent-runner-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { observePostToolUse } from '../workspace-diff.js';

let workspaceRoot: string;
let escapeRoot: string;

beforeEach(async () => {
  // Two SIBLING tmpdirs — escapeRoot lives outside workspaceRoot. We use
  // realpath so symlinks (`/var → /private/var` on macOS) don't trip the
  // containment check.
  workspaceRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ax-ws-diff-')),
  );
  escapeRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ax-ws-diff-escape-')),
  );
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(escapeRoot, { recursive: true, force: true });
});

describe('observePostToolUse (Task 7c — claude-sdk file-diff observer)', () => {
  it('records a put for a Write tool with a relative path inside the workspace', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'hi.txt'), 'hello', 'utf8');
    const diffs = createDiffAccumulator();
    await observePostToolUse(
      'Write',
      { file_path: 'hi.txt', content: 'hello' },
      { workspaceRoot, diffs },
    );
    const drained = diffs.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ path: 'hi.txt', kind: 'put' });
    if (drained[0]?.kind === 'put') {
      expect(Buffer.from(drained[0].content).toString('utf8')).toBe('hello');
    }
  });

  it('records a put for an Edit tool by reading the post-edit bytes from disk', async () => {
    // Edit's tool_input describes a transformation; the observer reads the
    // file AFTER the SDK applied the edit, so we just place the final
    // content on disk.
    await fs.writeFile(
      path.join(workspaceRoot, 'edited.txt'),
      'final content',
      'utf8',
    );
    const diffs = createDiffAccumulator();
    await observePostToolUse(
      'Edit',
      {
        file_path: 'edited.txt',
        old_string: 'old',
        new_string: 'new',
      },
      { workspaceRoot, diffs },
    );
    const drained = diffs.drain();
    expect(drained).toHaveLength(1);
    if (drained[0]?.kind === 'put') {
      expect(Buffer.from(drained[0].content).toString('utf8')).toBe(
        'final content',
      );
    }
  });

  it('ignores non-file-mutating tool names (Bash, Read, etc.)', async () => {
    const diffs = createDiffAccumulator();
    await observePostToolUse(
      'Bash',
      { command: 'echo hi' },
      { workspaceRoot, diffs },
    );
    await observePostToolUse('Read', { file_path: 'x' }, { workspaceRoot, diffs });
    expect(diffs.isEmpty()).toBe(true);
  });

  it('rejects paths that escape the workspace root via ..', async () => {
    const diffs = createDiffAccumulator();
    await observePostToolUse(
      'Write',
      { file_path: '../escape.txt', content: 'x' },
      { workspaceRoot, diffs },
    );
    expect(diffs.isEmpty()).toBe(true);
  });

  it('rejects absolute paths outside the workspace root', async () => {
    await fs.writeFile(path.join(escapeRoot, 'leak.txt'), 'leak', 'utf8');
    const diffs = createDiffAccumulator();
    await observePostToolUse(
      'Write',
      { file_path: path.join(escapeRoot, 'leak.txt'), content: 'leak' },
      { workspaceRoot, diffs },
    );
    expect(diffs.isEmpty()).toBe(true);
  });

  it('drops the observation if the file no longer exists on disk', async () => {
    // Don't create the file. Observer's readFile fails and the change is
    // silently dropped — best-effort by design.
    const diffs = createDiffAccumulator();
    await observePostToolUse(
      'Write',
      { file_path: 'ghost.txt', content: 'never-written' },
      { workspaceRoot, diffs },
    );
    expect(diffs.isEmpty()).toBe(true);
  });

  it('ignores tool inputs missing a string file_path', async () => {
    const diffs = createDiffAccumulator();
    await observePostToolUse(
      'Write',
      { content: 'orphan' },
      { workspaceRoot, diffs },
    );
    await observePostToolUse('Write', null, { workspaceRoot, diffs });
    await observePostToolUse(
      'Write',
      { file_path: 123 },
      { workspaceRoot, diffs },
    );
    expect(diffs.isEmpty()).toBe(true);
  });
});
