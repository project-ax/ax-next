// ---------------------------------------------------------------------------
// TASK-554: concurrent pinned reads coalesce into one `git cat-file --batch`.
//
// Before, every `workspace:read` was its own queued engine op spawning two
// git processes, and the per-workspace queue ran them one at a time: a full
// memory hydrate cost ~23 ms per file (2.3 s at 100 docs, 7 s at 300). Now
// pinned reads that arrive while no batch for their (workspace, version) has
// started share ONE queued op and ONE `cat-file --batch`.
//
// Two things are pinned here: the batch answers exactly what one-at-a-time
// reads answer (bytes, absence, version, failure), and it really is one
// lookup — counted by spawns of `git cat-file`, which the unbatched engine
// spent two of per read.
// ---------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceReadOutput, WorkspaceVersion } from '@ax/core';

const spawnCalls: string[][] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: (cmd: string, args: readonly string[], options: object) => {
      spawnCalls.push([cmd, ...args]);
      return real.spawn(cmd, args, options);
    },
  };
});

const { createWorkspaceGitServer } = await import('../../server/index.js');
const { createGitEngine } = await import('../git-engine.js');
const { createMirrorCache } = await import('../mirror-cache.js');
const { createRepoLifecycleClient } = await import('../repo-lifecycle.js');

type GitEngine = ReturnType<typeof createGitEngine>;
type MirrorCache = ReturnType<typeof createMirrorCache>;

const TOKEN = 'pinned-batch-token';
const DEAD_BASE_URL = 'http://127.0.0.1:1';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

interface Harness {
  close: () => Promise<void>;
  engine: GitEngine;
  mirrorCache: MirrorCache;
  baseUrl: string;
}

function engineFor(baseUrl: string, mirrorCache: MirrorCache): GitEngine {
  return createGitEngine({
    baseUrl,
    token: TOKEN,
    mirrorCache,
    lifecycleClient: createRepoLifecycleClient({ baseUrl, token: TOKEN }),
  });
}

let h: Harness;

beforeEach(async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-pinned-batch-repos-'));
  const server = await createWorkspaceGitServer({
    repoRoot,
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const mirrorCache = createMirrorCache();
  const engine = engineFor(baseUrl, mirrorCache);
  h = {
    engine,
    mirrorCache,
    baseUrl,
    close: async () => {
      await engine.shutdown();
      await mirrorCache.shutdown();
      await server.close();
      await rm(repoRoot, { recursive: true, force: true });
    },
  };
});

afterEach(async () => {
  await h.close();
});

// Content chosen to break a naive line-oriented parser: embedded newlines,
// a NUL, a header-shaped line, an empty file, and one larger than a pipe
// chunk.
const FILES: Record<string, Uint8Array> = {
  'memory/system/agent.md': enc('# agent\nname: probe\n'),
  'memory/docs/with space.md': enc('spaces in the path'),
  'memory/docs/newlines.md': enc('\n\nline\n\n'),
  'memory/docs/header-shaped.md': enc(
    `${'a'.repeat(40)} blob 12\nnot a header\n`,
  ),
  'memory/docs/empty.md': new Uint8Array(0),
  'memory/docs/binary.bin': new Uint8Array([0, 10, 255, 13, 10, 0]),
  'memory/docs/big.md': enc('x'.repeat(200_000)),
};
for (let i = 0; i < 30; i++) {
  FILES[`memory/docs/entity/doc-${i}.md`] = enc(`doc ${i}\n`);
}

async function seed(ws: string): Promise<WorkspaceVersion> {
  const out = await h.engine.apply(ws, {
    changes: Object.entries(FILES).map(([path, content]) => ({
      path,
      kind: 'put' as const,
      content,
    })),
    parent: null,
  });
  return out.version;
}

const READ_PATHS = [
  ...Object.keys(FILES),
  'memory/docs/absent.md',
  'nope/at/all',
];

function catFileSpawns(): string[][] {
  return spawnCalls.filter((c) => c.includes('cat-file'));
}

describe('git-engine — concurrent pinned reads coalesce (TASK-554)', () => {
  it('answer exactly what one-at-a-time pinned reads answer', async () => {
    const ws = 'wsbatch00001';
    const v = await seed(ws);

    const sequential: WorkspaceReadOutput[] = [];
    for (const path of READ_PATHS) {
      sequential.push(await h.engine.read(ws, { path, version: v }));
    }
    const concurrent = await Promise.all(
      READ_PATHS.map((path) => h.engine.read(ws, { path, version: v })),
    );

    expect(concurrent).toEqual(sequential);
    for (const [i, path] of READ_PATHS.entries()) {
      const r = concurrent[i]!;
      if (path in FILES) {
        expect(r).toEqual({ found: true, bytes: FILES[path], version: v });
      } else {
        expect(r).toEqual({ found: false });
      }
    }
  });

  it('many concurrent pinned reads cost one lookup, not two git processes each', async () => {
    const ws = 'wsbatch00002';
    const v = await seed(ws);
    // Warm the mirror so the count below is lookups only, no fetch.
    await h.engine.read(ws, { path: 'memory/system/agent.md', version: v });

    spawnCalls.length = 0;
    const out = await Promise.all(
      READ_PATHS.map((path) => h.engine.read(ws, { path, version: v })),
    );
    expect(out.filter((r) => r.found)).toHaveLength(Object.keys(FILES).length);
    // One commit probe + one `cat-file --batch`. The unbatched engine spent
    // two per read: READ_PATHS.length * 2 = 78 here.
    expect(catFileSpawns()).toHaveLength(2);
    expect(catFileSpawns().filter((c) => c.includes('--batch'))).toHaveLength(1);
  });

  it('a batch at a locally-held commit never fetches (storage tier unreachable)', async () => {
    const ws = 'wsbatch00003';
    const v = await seed(ws);
    await h.engine.read(ws, { path: 'memory/system/agent.md', version: v });

    const offline = engineFor(DEAD_BASE_URL, h.mirrorCache);
    try {
      // Control: the dead URL really is dead for anything that fetches.
      await expect(offline.read(ws, { path: 'memory/system/agent.md' })).rejects.toThrow(
        /git fetch failed/,
      );
      const out = await Promise.all(
        READ_PATHS.map((path) => offline.read(ws, { path, version: v })),
      );
      expect(out.filter((r) => r.found)).toHaveLength(Object.keys(FILES).length);
    } finally {
      await offline.shutdown();
    }
  });

  it('a batch at a commit this mirror has not fetched yet fetches once and answers', async () => {
    const ws = 'wsbatch00004';
    const v = await seed(ws);
    const cache = createMirrorCache();
    const replica = engineFor(h.baseUrl, cache);
    try {
      spawnCalls.length = 0;
      const out = await Promise.all(
        READ_PATHS.map((path) => replica.read(ws, { path, version: v })),
      );
      for (const [i, path] of READ_PATHS.entries()) {
        expect(out[i]).toEqual(
          path in FILES ? { found: true, bytes: FILES[path], version: v } : { found: false },
        );
      }
      expect(spawnCalls.filter((c) => c.includes('fetch'))).toHaveLength(1);
    } finally {
      await replica.shutdown();
      await cache.shutdown();
    }
  });

  it('a non-blob path fails only its own read, as a lone read of it does', async () => {
    const ws = 'wsbatch00005';
    const v = await seed(ws);
    await expect(h.engine.read(ws, { path: 'memory/docs', version: v })).rejects.toThrow();

    const [dir, file, absent] = await Promise.allSettled([
      h.engine.read(ws, { path: 'memory/docs', version: v }),
      h.engine.read(ws, { path: 'memory/docs/empty.md', version: v }),
      h.engine.read(ws, { path: 'memory/docs/absent.md', version: v }),
    ]);
    expect(dir.status).toBe('rejected');
    expect(file).toEqual({
      status: 'fulfilled',
      value: { found: true, bytes: new Uint8Array(0), version: v },
    });
    expect(absent).toEqual({ status: 'fulfilled', value: { found: false } });
  });

  it('a path with a line break skips the batch and still reads correctly', async () => {
    const ws = 'wsbatch00006';
    const v = await seed(ws);
    const [odd, normal] = await Promise.all([
      // Would split into two `--batch` requests if it went on stdin.
      h.engine.read(ws, { path: 'memory/docs/empty.md\nmemory/docs/big.md', version: v }),
      h.engine.read(ws, { path: 'memory/docs/empty.md', version: v }),
    ]);
    expect(odd).toEqual({ found: false });
    expect(normal).toEqual({ found: true, bytes: new Uint8Array(0), version: v });
  });

  it('reads arriving while a batch runs form the next batch; the queue drains', async () => {
    const ws = 'wsbatch00007';
    const v = await seed(ws);
    spawnCalls.length = 0;
    const first = Promise.all(
      READ_PATHS.slice(0, 10).map((path) => h.engine.read(ws, { path, version: v })),
    );
    // Yield so the first batch has started before the second wave arrives.
    await new Promise((r) => setImmediate(r));
    const second = Promise.all(
      READ_PATHS.slice(10).map((path) => h.engine.read(ws, { path, version: v })),
    );
    const [a, b] = await Promise.all([first, second]);
    expect([...a, ...b].filter((r) => r.found)).toHaveLength(Object.keys(FILES).length);
    expect(catFileSpawns().filter((c) => c.includes('--batch'))).toHaveLength(2);
    // The queue drops a settled tail a few microtasks after its op resolves
    // its waiters; one macrotask is past all of them.
    await new Promise((r) => setImmediate(r));
    expect(h.engine._internalQueueSize()).toBe(0);
  });
});
