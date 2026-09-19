// TASK-414 — a caller-supplied `WorkspaceVersion` must never reach the `git`
// binary as an option, on THIS backend either.
//
// WHY THIS EXISTS. PR #583 closed exactly this hole in `@ax/workspace-git-core`
// and shipped `__tests__/version-argv.test.ts` there. It never reached
// `@ax/workspace-git-server`, whose `SECURITY.md` described the sibling as
// pure-JS `isomorphic-git` with "no spawn at all" — a claim that was false when
// written. Both packages spawn the real `git` binary, and this one's host-side
// engine casts `input.version` / `input.from` / `input.to` straight into argv:
//
//   - `git ls-tree -r --name-only <version>`          (workspace:list)
//   - `git diff-tree -r --name-status --root <f> <t>` (workspace:diff)
//   - `git cat-file -e <version>:<path>`              (workspace:read)
//   - `git cat-file blob <version>:<path>`            (workspace:read)
//
// An argument that starts with a dash is parsed by git as an OPTION, and none
// of these call sites pass `--`.
//
// `asWorkspaceVersion` in `@ax/core` is a bare cast with NO validation, and it
// has to stay that way: the version's shape is a backend's business, and
// `MockWorkspace` deliberately mints non-SHA `mock-N` strings to prove the
// contract is storage-agnostic (Invariant 1). So the check belongs here, in the
// backend that mints SHAs and is entitled to demand them — not in core.
//
// EVERY hostile case below fails against the unvalidated engine: without
// `requireOid` the call does NOT reject — it runs git with an option-shaped
// argument and surfaces whatever git says, or (for `--name-only`-style values
// on `ls-tree`) succeeds and returns nonsense.
//
// The `parent` case is deliberately different, and the anti-vacuity block below
// pins why. `parent` is NOT `requireOid`-validated — narrowing it would turn a
// garbage parent's `parent-mismatch` into a different code, and that code is
// the workspace-CAS rebase-retry contract. It is closed structurally instead,
// by enforcing the invariant the code already documented: on an empty mirror,
// `parent` must be null or equal the declared `baselineCommit`.

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asWorkspaceVersion, type WorkspaceVersion } from '@ax/core';
import {
  createWorkspaceGitServer,
  type WorkspaceGitServer,
} from '../../server/index.js';
import { createGitEngine, type GitEngine } from '../git-engine.js';
import { createMirrorCache, type MirrorCache } from '../mirror-cache.js';
import { createRepoLifecycleClient } from '../repo-lifecycle.js';

const TOKEN = 'version-argv-token';
const WS = 'ws-versionargv000';
const enc = new TextEncoder();

interface Harness {
  server: WorkspaceGitServer;
  engine: GitEngine;
  mirrorCache: MirrorCache;
  repoRoot: string;
}

let h: Harness;

beforeEach(async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-versionargv-repos-'));
  const server = await createWorkspaceGitServer({
    repoRoot,
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const mirrorCache = createMirrorCache();
  const engine = createGitEngine({
    baseUrl,
    token: TOKEN,
    mirrorCache,
    lifecycleClient: createRepoLifecycleClient({ baseUrl, token: TOKEN }),
  });
  h = { server, engine, mirrorCache, repoRoot };
});

afterEach(async () => {
  await h.engine.shutdown();
  await h.mirrorCache.shutdown();
  await h.server.close();
  await rm(h.repoRoot, { recursive: true, force: true });
});

// Values a caller could supply that git would read as an option, plus the
// near-misses that prove the check is a real regex and not `startsWith('-')`.
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

async function seed(): Promise<WorkspaceVersion> {
  const out = await h.engine.apply(WS, {
    changes: [{ path: 'a.md', kind: 'put', content: enc.encode('hi') }],
    parent: null,
  });
  return out.version;
}

describe('workspace version must be a 40-hex oid before it reaches git argv', () => {
  it('read rejects every option-shaped version', async () => {
    await seed();
    for (const [, value] of HOSTILE) {
      await expect(
        h.engine.read(WS, {
          path: 'a.md',
          version: asWorkspaceVersion(value),
        }),
        `read should reject version ${JSON.stringify(value)}`,
      ).rejects.toMatchObject(INVALID_VERSION);
    }
  });

  it('list rejects every option-shaped version', async () => {
    await seed();
    for (const [, value] of HOSTILE) {
      await expect(
        h.engine.list(WS, { version: asWorkspaceVersion(value) }),
        `list should reject version ${JSON.stringify(value)}`,
      ).rejects.toMatchObject(INVALID_VERSION);
    }
  });

  it('diff rejects an option-shaped `from`', async () => {
    const good = await seed();
    await expect(
      h.engine.diff(WS, {
        from: asWorkspaceVersion('--name-only'),
        to: good,
      }),
    ).rejects.toMatchObject(INVALID_VERSION);
  });

  it('diff rejects an option-shaped `to`', async () => {
    await seed();
    await expect(
      h.engine.diff(WS, { from: null, to: asWorkspaceVersion('-z') }),
    ).rejects.toMatchObject(INVALID_VERSION);
  });

  it('apply-bundle refuses a parent that is neither null nor the declared baseline', async () => {
    // `parent` is NOT requireOid-validated (see the header). It is closed by
    // the empty-mirror invariant instead, and the error code stays
    // `parent-mismatch` so the CAS rebase-retry contract still fires.
    await expect(
      h.engine.applyBundle(WS, {
        bundleBytes: '',
        baselineCommit: '0'.repeat(40),
        parent: asWorkspaceVersion('--output=/tmp/pwned'),
        reason: 'hostile',
      }),
    ).rejects.toMatchObject({ code: 'parent-mismatch' });
  });
});

describe('anti-vacuity: the legitimate paths still work', () => {
  // Without these, "reject everything" would satisfy every assertion above.
  // All of these pass before AND after the fix, by design.
  it('a real minted version still reads, lists and diffs', async () => {
    const v = await seed();
    expect(v).toMatch(/^[0-9a-f]{40}$/);

    expect((await h.engine.list(WS, { version: v })).paths).toEqual(['a.md']);
    expect((await h.engine.read(WS, { path: 'a.md', version: v })).found).toBe(
      true,
    );
    expect(
      (await h.engine.diff(WS, { from: null, to: v })).delta.changes.map(
        (c) => c.path,
      ),
    ).toEqual(['a.md']);
  });

  it('an omitted version (HEAD) is still allowed on read and list', async () => {
    await seed();
    expect((await h.engine.list(WS, {})).paths).toEqual(['a.md']);
    expect((await h.engine.read(WS, { path: 'a.md' })).found).toBe(true);
  });

  it('a second apply with the prior version as parent still lands', async () => {
    const v1 = await seed();
    const out = await h.engine.apply(WS, {
      changes: [{ path: 'b.md', kind: 'put', content: enc.encode('yo') }],
      parent: v1,
    });
    expect(out.version).toMatch(/^[0-9a-f]{40}$/);
    expect(out.version).not.toBe(v1);
    expect((await h.engine.list(WS, {})).paths.sort()).toEqual([
      'a.md',
      'b.md',
    ]);
  });
});
