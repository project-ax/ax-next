// The boundary IS the feature (TASK-234 / plan task AW-13).
//
// `permanent/memory/system/rules.md` is written by a human and by nobody else.
// These tests are what makes that a property of the code rather than a
// sentence in a comment:
//
//   1. The consolidation pass — decay, promotion, dedup, rollup, map rebuild —
//      leaves the file byte-identical, INCLUDING at +400 days, when every
//      retention window in the system has long since expired.
//   2. The guard refuses an automatic write, whatever shape of path it is
//      handed.
//   3. A STATIC canary: every module in this package that mutates the memory
//      tree must be registered in AUTOMATIC_WRITERS. A new writer added later
//      either registers — and inherits the guard — or fails here.
//   4. The `/agent` tier flush never emits a put or a delete for the file, so
//      a scratch that lost it cannot propagate that loss.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import type { FileChange, WorkspaceApplyInput, WorkspaceListOutput, WorkspaceReadInput, WorkspaceReadOutput } from '@ax/core';
import { runConsolidation, type ConsolidationLogger } from '../consolidator.js';
import { buildMarkdownFile } from '../frontmatter.js';
import {
  AUTOMATIC_WRITERS,
  HUMAN_TIER_PATHS,
  HUMAN_TIER_TIER_PATHS,
  guardAutomaticWrite,
  isHumanTierPath,
  normalizeRulesBody,
  stripHumanTierChanges,
} from '../human-tier.js';
import { flushAgentTier, hydrateAgentTier } from '../agent-tier-sync.js';
import { INBOX_DIR, MEMORY_ROOT, docFile, rulesFile, systemFile } from '../paths.js';
import type { MemoryFrontmatter } from '../types.js';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const RULES_TEXT = [
  '- Always cc Priya on customer email',
  '- Never touch the billing spreadsheet without asking',
  '',
].join('\n');

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memstr-human-tier-'));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

async function writeRulesFixture(root = workspaceRoot, text = RULES_TEXT): Promise<void> {
  const abs = join(root, rulesFile());
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, text, 'utf8');
}

async function readRulesFixture(root = workspaceRoot): Promise<string> {
  return readFile(join(root, rulesFile()), 'utf8');
}

/** A low-confidence inbox observation, `ageDays` old, so the pass has work to do. */
async function writeInboxFixture(now: Date, ageDays: number, id: string): Promise<void> {
  const created = new Date(now.getTime() - ageDays * 86_400_000).toISOString();
  const fm: MemoryFrontmatter = {
    id,
    type: 'inbox/observation',
    created,
    confidence: 0.5,
    pinned: false,
    summary: `observation ${id}`,
    subject: `subject-${id}`,
    factType: 'general',
    event_time: created,
    recorded_at: created,
  };
  const dir = join(workspaceRoot, INBOX_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}.md`),
    buildMarkdownFile(fm, `# Observation\n\nSomething the agent noticed (${id}).\n`),
    'utf8',
  );
}

const silentLogger: ConsolidationLogger = { info() {}, warn() {} };

// ---------------------------------------------------------------------------
// 1. The pass may not touch it — not now, and not in a year
// ---------------------------------------------------------------------------

describe('the rollup never rewrites the human tier', () => {
  it('leaves rules.md byte-identical across a full consolidation pass', async () => {
    await writeRulesFixture();
    const now = new Date('2026-05-10T12:00:00.000Z');
    await writeInboxFixture(now, 1, 'obs-fresh');
    await writeInboxFixture(now, 20, 'obs-aged');

    const before = await readRulesFixture();
    const result = await runConsolidation({ workspaceRoot, now, logger: silentLogger });

    // The pass really ran — otherwise this test proves nothing.
    expect(result.decayed).toBe(1);
    expect(await readRulesFixture()).toBe(before);
  });

  it('GC never deletes the human tier, even when it is stale and unreferenced', async () => {
    await writeRulesFixture();
    const seeded = new Date('2026-05-10T12:00:00.000Z');
    await writeInboxFixture(seeded, 1, 'obs-one');
    await writeInboxFixture(seeded, 2, 'obs-two');

    // +400 days. Every retention window in the strata — the 14-day inbox decay,
    // the rollup GC — has expired several times over, and nothing has referred
    // to the human's rules since the day they were typed.
    const plus400 = new Date(seeded.getTime() + 400 * 86_400_000);
    await runConsolidation({ workspaceRoot, now: plus400, logger: silentLogger });

    const survived = await readRulesFixture();
    expect(survived).toContain('Always cc Priya');
    expect(survived).toBe(RULES_TEXT);

    // And the inbox really was emptied by that pass, so "it survived" is a
    // statement about the human tier, not about a pass that did nothing.
    const inboxLeft = await readdir(join(workspaceRoot, INBOX_DIR)).catch(() => []);
    expect(inboxLeft.filter((f) => f.endsWith('.md'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. The enumeration, and the guard behind it
// ---------------------------------------------------------------------------

describe('every automatic writer excludes the human tier', () => {
  it('lists the exclusion on every registered writer', () => {
    // Enumerated rather than asserted per-writer: a NEW writer added later must
    // either appear in this list or fail the canary below. A comment would not
    // have caught it.
    expect(AUTOMATIC_WRITERS.length).toBeGreaterThan(0);
    for (const write of AUTOMATIC_WRITERS) {
      expect(write.excludes).toContain(systemFile('rules'));
    }
  });

  it('refuses an automatic write however the path is shaped', () => {
    const shapes = [
      rulesFile(), // workspace-relative
      HUMAN_TIER_TIER_PATHS[0]!, // /agent tier
      join('/tmp/scratch-abc', rulesFile()), // absolute, as a low-level FS helper sees it
    ];
    for (const path of shapes) {
      expect(isHumanTierPath(path)).toBe(true);
      expect(() => guardAutomaticWrite('rollup', path)).toThrow(PluginError);
    }
    try {
      guardAutomaticWrite('rollup', rulesFile());
      expect.unreachable('guard did not throw');
    } catch (err) {
      expect((err as PluginError).code).toBe('human-tier-readonly');
    }
  });

  it('lets every other memory path through', () => {
    for (const path of [
      systemFile('user'),
      systemFile('agent'),
      docFile('entity', 'priya'),
      `${INBOX_DIR}/2026-05-10T12-00-00.000Z.md`,
      // A near-miss that must NOT be treated as the human tier.
      `${MEMORY_ROOT}/docs/general/rules.md`,
      'permanent/memory/system/rules.md.bak',
    ]) {
      expect(isHumanTierPath(path)).toBe(false);
      expect(() => guardAutomaticWrite('doc-store', path)).not.toThrow();
    }
  });

  it('registers every module in this package that mutates the memory tree', async () => {
    // THE CANARY. Scan the package's own source for filesystem mutations and
    // for `workspace:apply` deltas; each module that performs one must be on
    // the list — and therefore must have gone past `guardAutomaticWrite`.
    const MUTATORS = /\b(?:writeFile|unlink|rename)\s*\(|kind:\s*'(?:put|delete)'/u;
    const registered = new Set(AUTOMATIC_WRITERS.map((w) => w.module));
    // The sanctioned human write path and the guard itself are, by definition,
    // not automatic writers. Every other mutating module must register.
    const EXEMPT = new Set(['rules-store.ts', 'human-tier.ts']);

    const files = (await readdir(SRC_DIR, { withFileTypes: true, recursive: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => join(e.parentPath ?? SRC_DIR, e.name))
      .filter((p) => !p.includes('__tests__'));
    expect(files.length).toBeGreaterThan(10);

    const unregistered: string[] = [];
    for (const abs of files) {
      const rel = abs.slice(SRC_DIR.length + 1);
      const base = rel.split('/').pop()!;
      if (EXEMPT.has(rel)) continue;
      const src = await readFile(abs, 'utf8');
      if (!MUTATORS.test(src)) continue;
      if (!registered.has(base) && !registered.has(rel)) unregistered.push(rel);
    }

    expect(
      unregistered,
      'These modules mutate the memory tree but are not in AUTOMATIC_WRITERS. ' +
        'Add them there and call guardAutomaticWrite() at the write site — the ' +
        "human's rules.md must stay the one file no machine rewrites.",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. The /agent tier flush
// ---------------------------------------------------------------------------

/**
 * A minimal in-memory `/agent` tier: the three workspace hooks
 * `agentTierAvailable` probes, backed by a Map. Records every applied change
 * so a test can assert on what the flush actually shipped.
 */
function makeTierBus(seed: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>();
  for (const [p, text] of Object.entries(seed)) {
    files.set(p, new TextEncoder().encode(text));
  }
  const applied: FileChange[][] = [];
  const bus = new HookBus();
  bus.registerService<{ pathGlob?: string }, WorkspaceListOutput>(
    'workspace:list',
    'test-workspace',
    async () => ({ paths: [...files.keys()], version: 'v1' as never }),
  );
  bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(
    'workspace:read',
    'test-workspace',
    async (_ctx, input) => {
      const bytes = files.get(input.path);
      if (bytes === undefined) return { found: false } as WorkspaceReadOutput;
      return { found: true, bytes, version: 'v1' as never } as WorkspaceReadOutput;
    },
  );
  bus.registerService<WorkspaceApplyInput, { version: string }>(
    'workspace:apply',
    'test-workspace',
    async (_ctx, input) => {
      applied.push(input.changes as FileChange[]);
      for (const c of input.changes) {
        if (c.kind === 'delete') files.delete(c.path);
        else files.set(c.path, c.content as Uint8Array);
      }
      return { version: 'v2' };
    },
  );
  return { bus, files, applied };
}

describe('the /agent tier flush never carries the human tier', () => {
  it('drops a delete the whole-subtree diff would otherwise emit', async () => {
    const tierRulesPath = HUMAN_TIER_TIER_PATHS[0]!;
    const { bus, files, applied } = makeTierBus({
      [tierRulesPath]: RULES_TEXT,
      'memory/system/user.md': '# User\n',
    });
    const ctx = makeAgentContext({ agentId: 'atlas', userId: 'u1' });

    const hydrated = await hydrateAgentTier(bus, ctx);
    try {
      // The pipeline "loses" the human tier from the scratch — exactly what a
      // future writer with a rebuild-the-world habit would do.
      await rm(join(hydrated.scratchRoot, ...rulesFile().split('/')));
      // ...and changes something it legitimately owns, so the flush has a
      // reason to run at all.
      await writeFile(
        join(hydrated.scratchRoot, ...`${MEMORY_ROOT}/system/user.md`.split('/')),
        '# User\n\nLikes oat milk.\n',
        'utf8',
      );

      const flushed = await flushAgentTier(bus, ctx, hydrated, 'test');
      expect(flushed).toBe(true);
    } finally {
      await hydrated.dispose();
    }

    const allChanges = applied.flat();
    expect(allChanges.some((c) => c.path === tierRulesPath)).toBe(false);
    expect(allChanges.map((c) => c.path)).toContain('memory/system/user.md');
    // The bytes are still in the tier, untouched.
    expect(new TextDecoder().decode(files.get(tierRulesPath)!)).toBe(RULES_TEXT);
  });

  it('returns false rather than applying a delta that was only the human tier', async () => {
    const tierRulesPath = HUMAN_TIER_TIER_PATHS[0]!;
    const { bus, applied } = makeTierBus({ [tierRulesPath]: RULES_TEXT });
    const ctx = makeAgentContext({ agentId: 'atlas', userId: 'u1' });

    const hydrated = await hydrateAgentTier(bus, ctx);
    try {
      await writeFile(
        join(hydrated.scratchRoot, ...rulesFile().split('/')),
        'the strata rewrote your rules\n',
        'utf8',
      );
      expect(await flushAgentTier(bus, ctx, hydrated, 'test')).toBe(false);
    } finally {
      await hydrated.dispose();
    }
    expect(applied).toEqual([]);
  });

  it('stripHumanTierChanges keeps everything else', () => {
    const changes = [
      { path: HUMAN_TIER_TIER_PATHS[0]!, kind: 'delete' },
      { path: 'memory/system/recent.md', kind: 'put' },
      { path: rulesFile(), kind: 'put' },
    ];
    expect(stripHumanTierChanges(changes).map((c) => c.path)).toEqual([
      'memory/system/recent.md',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Verbatim means verbatim
// ---------------------------------------------------------------------------

describe('normalizeRulesBody', () => {
  it('keeps the text as typed, with exactly one trailing newline', () => {
    expect(normalizeRulesBody('- one\n- two')).toBe('- one\n- two\n');
    expect(normalizeRulesBody('- one\n- two\n\n\n')).toBe('- one\n- two\n');
    // Leading whitespace is the user's; we do not tidy it.
    expect(normalizeRulesBody('  indented rule')).toBe('  indented rule\n');
    expect(normalizeRulesBody('   \n  ')).toBe('');
  });

  it('is idempotent, so two saves of the same text produce the same bytes', () => {
    const once = normalizeRulesBody('- always cc Priya');
    expect(normalizeRulesBody(once)).toBe(once);
  });
});

describe('HUMAN_TIER_PATHS', () => {
  it('names the file the design promises', () => {
    expect(HUMAN_TIER_PATHS).toEqual(['permanent/memory/system/rules.md']);
    expect(HUMAN_TIER_TIER_PATHS).toEqual(['memory/system/rules.md']);
  });
});
