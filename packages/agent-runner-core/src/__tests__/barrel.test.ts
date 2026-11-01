import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// TASK-995: the git workspace tier, the governed-path re-rooting and the
// save-refused notices are gone, and so is every name the two runners used to
// import for them. This pins the package's public surface so none of it comes
// back by accident — and names what the runners use now instead.
// ---------------------------------------------------------------------------

describe('@ax/agent-runner-core public surface', () => {
  it('exports nothing from the git tier, the re-rooting or the save-refused notices', async () => {
    const barrel = await import('../index.js');
    for (const name of [
      'materializeWorkspace',
      'scaffoldWorkspaceGitignore',
      'commitTurnAndBundle',
      'commitNotifyWithResync',
      'flushWorkspaceToHost',
      'flushPreconditionMessage',
      'resolveGovernedPaths',
      'resolveAttachmentPaths',
      'IDENTITY_SCAFFOLD',
      'SOUL_SCAFFOLD',
    ]) {
      expect(Object.keys(barrel), name).not.toContain(name);
    }
    // The shell, the env reader and the tool policy are still exported.
    for (const name of ['runRunner', 'readRunnerEnv', 'runnerHomeDir', 'createToolPolicy', 'buildToolCacheEnv']) {
      expect(Object.keys(barrel), name).toContain(name);
    }
  });

  it('declares no internal git-workspace subpath', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, unknown> };
    expect(Object.keys(pkg.exports)).not.toContain('./internal/git-workspace.js');
    // The other test-only subpaths stay.
    expect(Object.keys(pkg.exports)).toEqual(
      expect.arrayContaining(['.', './internal/python-venv.js', './internal/inbox-loop.js', './internal/transcript-delta.js']),
    );
  });
});
