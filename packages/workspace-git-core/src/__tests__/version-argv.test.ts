// TASK-396 follow-on — a caller-supplied `WorkspaceVersion` must never reach
// the `git` binary as an option.
//
// WHY THIS EXISTS. Every version this backend accepts ends up as the leading
// characters of an argv token: standalone in
// `git ls-tree -r -z --name-only <version>`, and as the prefix of
// `<version>^{commit}` (rev-parse) and `<version>:<path>` (cat-file). An
// argument that starts with a dash is parsed by git as an OPTION, and none of
// these call sites pass `--`.
//
// `asWorkspaceVersion` in `@ax/core` is a bare cast with NO validation, and it
// has to stay that way: the version's shape is a backend's business, and
// `MockWorkspace` deliberately mints non-SHA `mock-N` strings to prove the
// contract is storage-agnostic (Invariant 1). So the check belongs here, in
// the backend that mints SHAs and is entitled to demand them.
//
// This replaced a CALLER-DISCIPLINE argument ("no untrusted caller can reach a
// version parameter"), which required a census of every plugin that forwards
// one — and that census was already wrong once. `@ax/validator-identity`
// forwards the runner's `parent` into `workspace:read` from a
// `workspace:pre-apply` subscriber, reaching `cat-file blob <version>:<path>`.
// A multi-plugin census is not a security boundary. A regex at the entry point
// is, and it stays true no matter which plugin forwards what.
//
// EVERY test below fails against the unvalidated backend: without `requireOid`
// these calls do NOT reject — they run git with an option-shaped argument and
// surface whatever git says (or, for `--name-only`-style values, succeed and
// return nonsense).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import type {
  AgentContext,
  Plugin,
  WorkspaceApplyInput,
  WorkspaceApplyOutput,
  WorkspaceDiffInput,
  WorkspaceDiffOutput,
  WorkspaceListInput,
  WorkspaceListOutput,
  WorkspaceReadInput,
  WorkspaceReadOutput,
  WorkspaceVersion,
} from '@ax/core';
import { asWorkspaceVersion } from '@ax/core';
import type {
  WorkspaceApplyBundleInput,
  WorkspaceApplyBundleOutput,
  WorkspaceExportBaselineBundleInput,
  WorkspaceExportBaselineBundleOutput,
} from '@ax/workspace-bundle-protocol';
import { registerWorkspaceGitHooks } from '../impl.js';

const enc = new TextEncoder();

function makeCorePlugin(repoRoot: string): Plugin {
  return {
    manifest: {
      name: '@ax/workspace-git-core-test-shim',
      version: '0.0.0',
      registers: [
        'workspace:apply',
        'workspace:apply-internal',
        'workspace:apply-bundle',
        'workspace:export-baseline-bundle',
        'workspace:read',
        'workspace:list',
        'workspace:diff',
      ],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      registerWorkspaceGitHooks(bus, { repoRoot });
    },
  };
}

async function setup() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-argv-'));
  const h = await createTestHarness({ plugins: [makeCorePlugin(repoRoot)] });
  const ctx: AgentContext = h.ctx({ userId: 'u', agentId: 'agent-a' });
  return { repoRoot, h, ctx };
}

// Values a caller could supply that git would read as an option, plus the
// near-misses that prove the check is a real regex and not a `startsWith('-')`.
const HOSTILE: ReadonlyArray<readonly [string, string]> = [
  ['a long option', '--name-only'],
  ['a short option', '-z'],
  ['an option with a value', '--format=%(objectname)'],
  ['the end-of-options marker', '--'],
  ['an upload-pack style option', '--upload-pack=touch /tmp/pwned'],
  ['a bare dash', '-'],
  ['empty', ''],
  ['a ref name rather than an oid', 'refs/heads/main'],
  ['a revision expression', 'HEAD~1'],
  ['uppercase hex (git accepts, our repos never mint)', 'A'.repeat(40)],
  ['39 hex chars', '0'.repeat(39)],
  ['41 hex chars', '0'.repeat(41)],
  ['40 chars with a non-hex letter', 'z'.repeat(40)],
  ['a 40-hex prefix with a suffix', `${'0'.repeat(40)}^{commit}`],
  ['whitespace around a valid oid', ` ${'0'.repeat(40)} `],
];

const INVALID_VERSION = { code: 'invalid-version' };

describe('workspace version must be a 40-hex oid before it reaches git argv', () => {
  it('workspace:read rejects every option-shaped version', async () => {
    const { h, ctx } = await setup();
    for (const [, value] of HOSTILE) {
      await expect(
        h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>('workspace:read', ctx, {
          path: 'a.md',
          version: asWorkspaceVersion(value),
        }),
        `read should reject version ${JSON.stringify(value)}`,
      ).rejects.toMatchObject(INVALID_VERSION);
    }
  });

  it('workspace:list rejects every option-shaped version', async () => {
    const { h, ctx } = await setup();
    for (const [, value] of HOSTILE) {
      await expect(
        h.bus.call<WorkspaceListInput, WorkspaceListOutput>('workspace:list', ctx, {
          version: asWorkspaceVersion(value),
        }),
        `list should reject version ${JSON.stringify(value)}`,
      ).rejects.toMatchObject(INVALID_VERSION);
    }
  });

  it('workspace:diff rejects an option-shaped `from` or `to`', async () => {
    const { h, ctx } = await setup();
    const good = asWorkspaceVersion('0'.repeat(40));
    await expect(
      h.bus.call<WorkspaceDiffInput, WorkspaceDiffOutput>('workspace:diff', ctx, {
        from: asWorkspaceVersion('--name-only'),
        to: good,
      }),
    ).rejects.toMatchObject(INVALID_VERSION);
    await expect(
      h.bus.call<WorkspaceDiffInput, WorkspaceDiffOutput>('workspace:diff', ctx, {
        from: null,
        to: asWorkspaceVersion('-z'),
      }),
    ).rejects.toMatchObject(INVALID_VERSION);
  });

  it('workspace:export-baseline-bundle rejects an option-shaped version', async () => {
    const { h, ctx } = await setup();
    await expect(
      h.bus.call<
        WorkspaceExportBaselineBundleInput,
        WorkspaceExportBaselineBundleOutput
      >('workspace:export-baseline-bundle', ctx, {
        version: asWorkspaceVersion('--upload-pack=touch /tmp/pwned'),
      }),
    ).rejects.toMatchObject(INVALID_VERSION);
  });

  it('workspace:apply-bundle rejects an option-shaped baselineCommit', async () => {
    const { h, ctx } = await setup();
    await expect(
      h.bus.call<WorkspaceApplyBundleInput, WorkspaceApplyBundleOutput>(
        'workspace:apply-bundle',
        ctx,
        {
          bundleBytes: '',
          baselineCommit: '--name-only',
          parent: null,
          reason: 'hostile',
        },
      ),
    ).rejects.toMatchObject(INVALID_VERSION);
  });

  describe('anti-vacuity: the legitimate paths still work', () => {
    // Without these, "reject everything" would satisfy every assertion above.
    // All FOUR pass before AND after the fix, by design.
    it('a real minted version still reads and lists', async () => {
      const { h, ctx } = await setup();
      const applied = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        ctx,
        {
          changes: [{ path: 'a.md', kind: 'put', content: enc.encode('hi') }],
          parent: null,
        },
      );
      expect(applied.version).toMatch(/^[0-9a-f]{40}$/);

      const listed = await h.bus.call<WorkspaceListInput, WorkspaceListOutput>(
        'workspace:list',
        ctx,
        { version: applied.version },
      );
      expect(listed.paths).toEqual(['a.md']);

      const read = await h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
        'workspace:read',
        ctx,
        { path: 'a.md', version: applied.version },
      );
      expect(read.found).toBe(true);
    });

    it('an omitted version (HEAD) is still allowed', async () => {
      const { h, ctx } = await setup();
      await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        ctx,
        {
          changes: [{ path: 'b.md', kind: 'put', content: enc.encode('yo') }],
          parent: null,
        },
      );
      const listed = await h.bus.call<WorkspaceListInput, WorkspaceListOutput>(
        'workspace:list',
        ctx,
        {},
      );
      expect(listed.paths).toEqual(['b.md']);
    });

    it('the null seed version on export-baseline-bundle is still allowed', async () => {
      const { h, ctx } = await setup();
      const out = await h.bus.call<
        WorkspaceExportBaselineBundleInput,
        WorkspaceExportBaselineBundleOutput
      >('workspace:export-baseline-bundle', ctx, { version: null });
      expect(out.bundleBytes.length).toBeGreaterThan(0);
    });

    it('a null `from` on diff is still allowed', async () => {
      const { h, ctx } = await setup();
      const applied = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        ctx,
        {
          changes: [{ path: 'c.md', kind: 'put', content: enc.encode('c') }],
          parent: null,
        },
      );
      const out = await h.bus.call<WorkspaceDiffInput, WorkspaceDiffOutput>(
        'workspace:diff',
        ctx,
        { from: null, to: applied.version as WorkspaceVersion },
      );
      expect(out.delta.changes.map((c) => c.path)).toEqual(['c.md']);
    });
  });
});
