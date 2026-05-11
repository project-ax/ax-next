import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { HookBus, makeAgentContext } from '@ax/core';
import { buildMarkdownFile } from '../frontmatter.js';
import { systemFile, recentFile } from '../paths.js';
import type { MemoryFrontmatter } from '../types.js';
import {
  buildMemoryBlock,
  registerInject,
  DEFAULT_MAX_TOKENS,
  approxTokenCount,
} from '../inject.js';
import type { RetrievalResult } from '../retriever.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'inject-test-'));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function makeCtx(workspace = workspaceRoot) {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId: 'test-user',
    workspace: { rootPath: workspace },
  });
}

/** Write a system file (user.md or recent.md) with canonical frontmatter. */
async function writeSystemFile(
  root: string,
  name: 'user' | 'recent',
  body: string,
): Promise<void> {
  const rel = name === 'recent' ? recentFile() : systemFile(name);
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });

  const fm: MemoryFrontmatter = {
    id: name,
    type: name === 'recent' ? 'system/recent' : 'system/user',
    created: '2026-05-11T00:00:00.000Z',
    confidence: 1.0,
    pinned: true,
    summary: `${name} system file`,
    event_time: '2026-05-11T00:00:00.000Z',
    recorded_at: '2026-05-11T00:00:00.000Z',
  };

  const content = buildMarkdownFile(fm, body);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(abs, content, 'utf8');
}

/** Build a stub bus with an optional memory:index:search service. */
function makeStubBus(opts: { searchResults?: RetrievalResult[] } = {}): HookBus {
  const bus = new HookBus();
  if (opts.searchResults !== undefined) {
    const results = opts.searchResults;
    bus.registerService('memory:index:search', 'test-indexer', async () => ({
      results,
    }));
  }
  return bus;
}

// ---------------------------------------------------------------------------
// Case 1: happy path — no lastUserMessage
// ---------------------------------------------------------------------------

describe('buildMemoryBlock — no lastUserMessage', () => {
  it('contains User Profile and Recent sections, no Relevant Documents', async () => {
    await writeSystemFile(workspaceRoot, 'user', '# User\n\nVinay is a software engineer.\n');
    await writeSystemFile(workspaceRoot, 'recent', '# Recent\n\n## Open Threads\n_None._\n');

    const bus = makeStubBus();
    const ctx = makeCtx();
    const block = await buildMemoryBlock(bus, ctx, { workspaceRoot });

    expect(block).toContain('## User Profile');
    expect(block).toContain('Vinay is a software engineer.');
    expect(block).toContain('## Recent');
    expect(block).toContain('Open Threads');
    expect(block).not.toContain('## Relevant Documents');
  });

  it('does not call memory:index:search when lastUserMessage is absent', async () => {
    await writeSystemFile(workspaceRoot, 'user', '# User\n\nProfile body.\n');
    await writeSystemFile(workspaceRoot, 'recent', '# Recent\n\nRecent body.\n');

    let searchCalled = false;
    const bus = new HookBus();
    bus.registerService('memory:index:search', 'test-indexer', async () => {
      searchCalled = true;
      return { results: [] };
    });

    const ctx = makeCtx();
    await buildMemoryBlock(bus, ctx, { workspaceRoot });
    expect(searchCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 2: with lastUserMessage — retriever results appear
// ---------------------------------------------------------------------------

describe('buildMemoryBlock — with lastUserMessage', () => {
  it('includes Relevant Documents section with bullet entries', async () => {
    await writeSystemFile(workspaceRoot, 'user', '# User\n\nProfile body.\n');
    await writeSystemFile(workspaceRoot, 'recent', '# Recent\n\nRecent body.\n');

    const fixtureResults: RetrievalResult[] = [
      { docId: 'preference/react', category: 'preference', slug: 'react', summary: 'User prefers React over Vue', score: 0.9 },
      { docId: 'preference/ts', category: 'preference', slug: 'ts', summary: 'User prefers TypeScript', score: 0.8 },
      { docId: 'entity/company', category: 'entity', slug: 'company', summary: 'Works at Canopy', score: 0.7 },
    ];

    const bus = makeStubBus({ searchResults: fixtureResults });
    const ctx = makeCtx();
    const block = await buildMemoryBlock(bus, ctx, {
      workspaceRoot,
      lastUserMessage: 'react',
    });

    expect(block).toContain('## Relevant Documents');
    expect(block).toContain('- [preference/react] User prefers React over Vue');
    expect(block).toContain('- [preference/ts] User prefers TypeScript');
    expect(block).toContain('- [entity/company] Works at Canopy');
  });

  it('retrieval results are sorted highest-rank first', async () => {
    await writeSystemFile(workspaceRoot, 'user', '# User\n\nProfile.\n');
    await writeSystemFile(workspaceRoot, 'recent', '# Recent\n\nRecent.\n');

    // Provide results in reverse (low→high) score order — builder must sort
    const fixtureResults: RetrievalResult[] = [
      { docId: 'doc-c', category: 'general', slug: 'c', summary: 'C summary', score: 0.3 },
      { docId: 'doc-a', category: 'general', slug: 'a', summary: 'A summary', score: 0.9 },
      { docId: 'doc-b', category: 'general', slug: 'b', summary: 'B summary', score: 0.6 },
    ];

    const bus = makeStubBus({ searchResults: fixtureResults });
    const ctx = makeCtx();
    const block = await buildMemoryBlock(bus, ctx, {
      workspaceRoot,
      lastUserMessage: 'query',
    });

    const aIdx = block.indexOf('[doc-a]');
    const bIdx = block.indexOf('[doc-b]');
    const cIdx = block.indexOf('[doc-c]');
    // Guard against silent indexOf=-1 — a missing doc would otherwise make
    // the ordering checks pass vacuously (since -1 < anything).
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(cIdx).toBeGreaterThanOrEqual(0);
    // highest score first
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
  });
});

// ---------------------------------------------------------------------------
// Case 3: I21 token cap — drops lowest-rank docs first
// ---------------------------------------------------------------------------

describe('I21: token cap — drops docs first', () => {
  it('drops lowest-rank docs to get under cap', async () => {
    await writeSystemFile(workspaceRoot, 'user', 'Profile.\n');
    await writeSystemFile(workspaceRoot, 'recent', 'Recent.\n');

    // 10 fixture results — long summaries to push over the tiny cap
    const fixtureResults: RetrievalResult[] = Array.from({ length: 10 }, (_, i) => ({
      docId: `doc-${i}`,
      category: 'general',
      slug: `slug-${i}`,
      summary: `This is a long summary for document number ${i} and it has many words to take up space in the token budget.`,
      score: 1.0 - i * 0.05, // doc-0 highest rank, doc-9 lowest
    }));

    const bus = makeStubBus({ searchResults: fixtureResults });
    const ctx = makeCtx();

    // Small cap — forces doc drops
    const maxTokens = 200;
    const block = await buildMemoryBlock(bus, ctx, {
      workspaceRoot,
      lastUserMessage: 'query',
      maxTokens,
    });

    // Must be under cap
    expect(approxTokenCount(block)).toBeLessThanOrEqual(maxTokens);

    // The block may still have some docs (high rank ones kept), or none.
    // Either way, if docs are present, they must be the HIGHEST-ranked ones.
    // doc-9 (lowest score) must NOT appear if doc-0 (highest) was also dropped.
    if (block.includes('[doc-0]') === false && block.includes('[doc-9]')) {
      throw new Error(
        'Drop strategy broken: lowest-rank doc present but highest-rank doc was dropped',
      );
    }
  });

  it('100-doc corpus stays under DEFAULT_MAX_TOKENS cap', async () => {
    const profileBody = 'User profile with some details.\n';
    const recentBody = '## Open Threads\n_None._\n\n## Active Projects\n_None._\n';
    await writeSystemFile(workspaceRoot, 'user', profileBody);
    await writeSystemFile(workspaceRoot, 'recent', recentBody);

    const fixtureResults: RetrievalResult[] = Array.from({ length: 100 }, (_, i) => ({
      docId: `doc-${i}`,
      category: 'general',
      slug: `slug-${i}`,
      summary: `Summary for doc ${i}: this document contains information about topic ${i} and provides relevant context.`,
      score: 1.0 - i * 0.009,
    }));

    const bus = makeStubBus({ searchResults: fixtureResults });
    const ctx = makeCtx();

    const block = await buildMemoryBlock(bus, ctx, {
      workspaceRoot,
      lastUserMessage: 'query',
      // Default cap
    });

    expect(approxTokenCount(block)).toBeLessThanOrEqual(DEFAULT_MAX_TOKENS);
  });
});

// ---------------------------------------------------------------------------
// Case 4: I21 — truncates recent body when profile+recent exceeds cap
// ---------------------------------------------------------------------------

describe('I21: truncates recent body when needed', () => {
  it('truncates recent while keeping profile intact', async () => {
    const profileBody = '# User\n\nShort profile.\n';
    // ~10000 char recent body
    const hugeRecent = '# Recent\n\n' + 'X'.repeat(10_000) + '\n';

    await writeSystemFile(workspaceRoot, 'user', profileBody);
    await writeSystemFile(workspaceRoot, 'recent', hugeRecent);

    const bus = makeStubBus();
    const ctx = makeCtx();

    const block = await buildMemoryBlock(bus, ctx, {
      workspaceRoot,
      maxTokens: 200,
    });

    expect(approxTokenCount(block)).toBeLessThanOrEqual(200);
    // Profile body must be present intact (it's short)
    expect(block).toContain('Short profile.');
  });
});

// ---------------------------------------------------------------------------
// Case 5: I21 — truncates profile as last resort
// ---------------------------------------------------------------------------

describe('I21: truncates profile as last resort', () => {
  it('truncates both recent and profile when over cap, never throws', async () => {
    const hugeProfile = '# User\n\n' + 'P'.repeat(5_000) + '\n';
    const hugeRecent = '# Recent\n\n' + 'R'.repeat(5_000) + '\n';

    await writeSystemFile(workspaceRoot, 'user', hugeProfile);
    await writeSystemFile(workspaceRoot, 'recent', hugeRecent);

    const bus = makeStubBus();
    const ctx = makeCtx();

    // Very small cap — must truncate both
    const block = await buildMemoryBlock(bus, ctx, {
      workspaceRoot,
      maxTokens: 100,
    });

    expect(approxTokenCount(block)).toBeLessThanOrEqual(100);
    // Should not throw — just return something under cap
    expect(typeof block).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Case 6: registerInject — returns contributions from the service hook
// ---------------------------------------------------------------------------

describe('registerInject — happy path', () => {
  it('returns contributions with source and non-empty body', async () => {
    await writeSystemFile(workspaceRoot, 'user', '# User\n\nVinay.\n');
    await writeSystemFile(workspaceRoot, 'recent', '# Recent\n\nRecent content.\n');

    const bus = new HookBus();
    registerInject(bus);

    const ctx = makeCtx();
    const result = await bus.call('system-prompt:augment', ctx, {});

    expect(result).toHaveProperty('contributions');
    const { contributions } = result as { contributions: Array<{ source: string; body: string }> };
    expect(contributions).toHaveLength(1);
    expect(contributions[0].source).toBe('@ax/memory-strata');
    expect(contributions[0].body.trim().length).toBeGreaterThan(0);
    expect(contributions[0].body).toContain('## User Profile');
  });
});

// ---------------------------------------------------------------------------
// Case 7: registerInject — returns [] when block is empty (no system files)
// ---------------------------------------------------------------------------

describe('registerInject — empty workspace', () => {
  it('returns empty contributions when no system files exist', async () => {
    const bus = new HookBus();
    registerInject(bus);

    const ctx = makeCtx();
    const result = await bus.call('system-prompt:augment', ctx, {});

    const { contributions } = result as { contributions: unknown[] };
    expect(contributions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case 8: registerInject — degrades gracefully on error
// ---------------------------------------------------------------------------

describe('registerInject — error degradation', () => {
  it('returns empty contributions and logs a warning on fs error', async () => {
    // Write a valid user.md so the directory exists, then make readFile throw
    // by pointing the workspace to a non-existent path that isn't ENOENT-safe.
    // Easiest approach: use a workspace root that exists but whose system/
    // directory does not — except readSystemBody already handles ENOENT.
    // Instead, we patch the fs module's readFile to throw a non-ENOENT error.

    const bus = new HookBus();
    registerInject(bus);

    // Use a workspace root that exists but patch readFile to simulate an error.
    // We do this by using a temp dir but then causing an unexpected error via
    // a non-existent parent directory (permission denied path is OS-specific),
    // so instead mock fs/promises readFile for this specific test.

    // We simulate the error by giving a ctx with a workspace.rootPath that has
    // an unusual character that causes a path error. The cleanest approach is
    // to use vi.spyOn on the fs module imported by inject.ts.
    // However, since inject.ts imports readFile at the top, we need to spy
    // via the module cache. Use a custom workspace path that triggers ENOTDIR
    // by making a *file* at the path we're trying to treat as a directory.
    const { writeFile } = await import('node:fs/promises');

    // Create a file at permanent/memory/system so readdir on it fails
    const systemDir = join(workspaceRoot, 'permanent', 'memory');
    await mkdir(systemDir, { recursive: true });
    // Write a FILE named 'system' — accessing system/user.md will get ENOTDIR
    await writeFile(join(systemDir, 'system'), 'not a directory');

    const warnings: string[] = [];
    const stubLogger = {
      debug: () => {},
      info: () => {},
      warn: (event: string) => { warnings.push(event); },
      error: () => {},
      child: () => stubLogger,
    };
    const ctx = makeAgentContext({
      sessionId: 'test-session',
      agentId: 'test-agent',
      userId: 'test-user',
      workspace: { rootPath: workspaceRoot },
      logger: stubLogger,
    });

    const result = await bus.call('system-prompt:augment', ctx, {});
    const { contributions } = result as { contributions: unknown[] };
    expect(contributions).toEqual([]);
    expect(warnings).toContain('memory_strata_inject_failed');
  });
});
