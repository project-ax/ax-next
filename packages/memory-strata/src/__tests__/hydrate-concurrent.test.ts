import { access } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HookBus,
  asWorkspaceVersion,
  makeAgentContext,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
} from '@ax/core';

// ---------------------------------------------------------------------------
// TASK-554: the full hydrate (observer, consolidator, memory_note) reads every
// `memory/**` file. It used to await each read before starting the next, so
// its cost was N serial round-trips (MEASURED 2.3 s at 100 docs, 7 s at 300 on
// the git-server backend). Now only the reads up to the first FOUND one run
// alone — that read names the snapshot — and the rest, pinned to it, run
// concurrently under a bound, so a backend can answer them together.
// ---------------------------------------------------------------------------

const createdTemps: string[] = [];
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const wrapped = {
    ...real,
    mkdtemp: (async (...args: Parameters<typeof real.mkdtemp>) => {
      const dir = await real.mkdtemp(...args);
      createdTemps.push(String(dir));
      return dir;
    }) as typeof real.mkdtemp,
  };
  return { ...wrapped, default: wrapped };
});

const { hydrateAgentTier, HYDRATE_READ_CONCURRENCY } = await import('../agent-tier-sync.js');

const V = asWorkspaceVersion('v-snap');
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Backend {
  bus: HookBus;
  reads: WorkspaceReadInput[];
  maxInFlight: () => number;
}

/** A tier whose reads each take `delayFor(path)` ms and report how many were
 *  in flight at once. `absent` paths are listed but not found (a listed path
 *  the pinned snapshot lacks); `fail` throws. */
function backend(opts: {
  paths: string[];
  absent?: Set<string>;
  fail?: string;
  delayFor?: (path: string) => number;
}): Backend {
  const bus = new HookBus();
  const reads: WorkspaceReadInput[] = [];
  let inFlight = 0;
  let max = 0;
  bus.registerService<WorkspaceListInput, WorkspaceListOutput>(
    'workspace:list',
    'test-tier',
    async () => ({ paths: opts.paths }),
  );
  bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(
    'workspace:read',
    'test-tier',
    async (_ctx, input) => {
      reads.push(input);
      inFlight++;
      max = Math.max(max, inFlight);
      try {
        await tick(opts.delayFor?.(input.path) ?? 1);
        if (input.path === opts.fail) throw new Error('storage backend blip');
        if (opts.absent?.has(input.path)) return { found: false };
        return { found: true, bytes: enc(`body of ${input.path}`), version: V };
      } finally {
        inFlight--;
      }
    },
  );
  return { bus, reads, maxInFlight: () => max };
}

const ctx = makeAgentContext({
  sessionId: 's',
  agentId: 'agent-1',
  userId: 'user-1',
  workspace: { rootPath: '/opt/ax-next/host' },
});

const docs = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `memory/docs/entity/doc-${i}.md`);

beforeEach(() => {
  createdTemps.length = 0;
});

describe('hydrateAgentTier reads concurrently after the pin (TASK-554)', () => {
  it('reads after the first found one overlap, never past the bound', async () => {
    const paths = docs(HYDRATE_READ_CONCURRENCY * 2 + 5);
    const b = backend({ paths });

    const hydrated = await hydrateAgentTier(b.bus, ctx);
    try {
      expect(hydrated.baseline.size).toBe(paths.length);
      // Serial code never has two reads in flight.
      expect(b.maxInFlight()).toBeGreaterThan(1);
      expect(b.maxInFlight()).toBeLessThanOrEqual(HYDRATE_READ_CONCURRENCY);
    } finally {
      await hydrated.dispose();
    }
  });

  it('reads alone until one is found, then pins every later read to its version', async () => {
    const paths = docs(20);
    const absent = new Set([paths[0]!, paths[1]!]);
    let inFlightAtEarlyRead = 0;
    const b = backend({ paths, absent });
    // Wrap the backend to see whether anything overlapped the first 3 reads.
    const inner = b.bus;
    const bus = new HookBus();
    let inFlight = 0;
    bus.registerService<WorkspaceListInput, WorkspaceListOutput>('workspace:list', 't', (c, i) =>
      inner.call('workspace:list', c, i),
    );
    bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      't',
      async (c, input) => {
        inFlight++;
        if (paths.indexOf(input.path) < 3) {
          inFlightAtEarlyRead = Math.max(inFlightAtEarlyRead, inFlight);
        }
        try {
          return await inner.call('workspace:read', c, input);
        } finally {
          inFlight--;
        }
      },
    );

    const hydrated = await hydrateAgentTier(bus, ctx);
    try {
      expect(inFlightAtEarlyRead).toBe(1);
      const byPath = new Map(b.reads.map((r) => [r.path, r]));
      // The two misses and the first hit ran unpinned, in order.
      expect(b.reads.slice(0, 3).map((r) => r.path)).toEqual(paths.slice(0, 3));
      for (const p of paths.slice(0, 3)) expect(byPath.get(p)!.version).toBeUndefined();
      // Everything after is pinned to the version the first hit returned.
      for (const p of paths.slice(3)) expect(byPath.get(p)!.version).toBe(V);
      expect(b.reads).toHaveLength(paths.length);
      expect(hydrated.baseVersion).toBe(V);
      expect(hydrated.baseline.size).toBe(paths.length - 2);
    } finally {
      await hydrated.dispose();
    }
  });

  it('a pin is never latched once reads overlap: the snapshot cannot tear', async () => {
    // First found read carries no version; later ones do. A latch during the
    // concurrent phase would pin some in-flight reads and not others.
    const paths = docs(40);
    const bus = new HookBus();
    const reads: WorkspaceReadInput[] = [];
    bus.registerService<WorkspaceListInput, WorkspaceListOutput>('workspace:list', 't', async () => ({
      paths,
    }));
    bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>('workspace:read', 't', async (_c, input) => {
      reads.push(input);
      await tick(1);
      const bytes = enc(`body of ${input.path}`);
      return input.path === paths[0] ? { found: true, bytes } : { found: true, bytes, version: V };
    });

    const hydrated = await hydrateAgentTier(bus, ctx);
    try {
      expect(reads).toHaveLength(paths.length);
      expect(reads.filter((r) => r.version !== undefined)).toEqual([]);
      expect(hydrated.baseVersion).toBeNull();
    } finally {
      await hydrated.dispose();
    }
  });

  it('the baseline keeps list order and the right bytes when reads finish out of order', async () => {
    const paths = docs(30);
    // Later paths finish first.
    const b = backend({ paths, delayFor: (p) => 40 - paths.indexOf(p) });

    const hydrated = await hydrateAgentTier(b.bus, ctx);
    try {
      expect([...hydrated.baseline.keys()]).toEqual(paths);
      for (const [p, bytes] of hydrated.baseline) expect(dec(bytes)).toBe(`body of ${p}`);
    } finally {
      await hydrated.dispose();
    }
  });

  it('a failed read rejects only after in-flight reads settle, and leaves no scratch dir behind', async () => {
    const paths = docs(HYDRATE_READ_CONCURRENCY * 3);
    // One read fails fast; its neighbours are still writing into the scratch.
    const b = backend({
      paths,
      fail: paths[5]!,
      delayFor: (p) => (p === paths[5] ? 1 : 30),
    });

    await expect(hydrateAgentTier(b.bus, ctx)).rejects.toThrow('storage backend blip');
    const readsAtReject = b.reads.length;

    expect(createdTemps).toHaveLength(1);
    // Past every read that could still have been in flight.
    await tick(80);
    expect(await exists(createdTemps[0]!)).toBe(false);
    // No new read started after the failure was seen.
    expect(b.reads.length).toBe(readsAtReject);
    expect(readsAtReject).toBeLessThan(paths.length);
  });
});
