// `memory:rules:read` / `memory:rules:write` / `memory:learned:read`, plus the
// injection behaviour the human tier is for (TASK-234 / plan task AW-13).
//
// What these prove:
//   - a rules write under a git tier goes out through `workspace:apply` and
//     does NOT write the file itself,
//   - a rules write in the CLI preset (no workspace backend) lands on the
//     agent's own workspace root, because that IS canonical there,
//   - the hooks refuse a payload whose `agentId` disagrees with the calling
//     ctx — the regression where a wrong ctx lands a write in the wrong
//     agent's workspace,
//   - the rules are injected FIRST, verbatim (no frontmatter stripping), and
//     are the LAST thing a tight budget cuts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import type {
  FileChange,
  WorkspaceApplyInput,
  WorkspaceListOutput,
  WorkspaceReadInput,
  WorkspaceReadOutput,
} from '@ax/core';
import { buildMemoryBlock } from '../inject.js';
import { HUMAN_TIER_TIER_PATHS } from '../human-tier.js';
import { buildMarkdownFile } from '../frontmatter.js';
import { mapFile, recentFile, rulesFile, systemFile } from '../paths.js';
import { registerRulesHooks, MAX_RULES_BYTES } from '../rules-hooks.js';
import type {
  MemoryLearnedReadOutput,
  MemoryRulesReadInput,
  MemoryRulesReadOutput,
  MemoryRulesWriteInput,
  MemoryRulesWriteOutput,
} from '../rules-hooks.js';
import type { MemoryFrontmatter } from '../types.js';

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memstr-rules-'));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function makeCtx(agentId = 'atlas') {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId,
    userId: 'u1',
    workspace: { rootPath: workspaceRoot },
  });
}

async function writeFileAt(rel: string, contents: string): Promise<void> {
  const abs = join(workspaceRoot, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, contents, 'utf8');
}

function fm(id: string, type: MemoryFrontmatter['type']): MemoryFrontmatter {
  const iso = '2026-05-11T00:00:00.000Z';
  return {
    id,
    type,
    created: iso,
    confidence: 1,
    pinned: true,
    summary: `${id} system file`,
    event_time: iso,
    recorded_at: iso,
  };
}

/** The CLI preset: no workspace backend, so nothing to register. */
function cliBus(): HookBus {
  const bus = new HookBus();
  registerRulesHooks(bus);
  return bus;
}

/** The k8s preset: the three workspace hooks, backed by a Map. */
function tierBus(seed: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>();
  for (const [p, text] of Object.entries(seed)) {
    files.set(p, new TextEncoder().encode(text));
  }
  const applied: Array<{ changes: FileChange[]; reason: string | undefined }> = [];
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
      applied.push({ changes: input.changes as FileChange[], reason: input.reason });
      for (const c of input.changes) {
        if (c.kind === 'delete') files.delete(c.path);
        else files.set(c.path, c.content as Uint8Array);
      }
      return { version: 'v2' };
    },
  );
  registerRulesHooks(bus);
  return { bus, files, applied };
}

const read = (bus: HookBus, ctx: ReturnType<typeof makeCtx>, agentId: string) =>
  bus.call<MemoryRulesReadInput, MemoryRulesReadOutput>('memory:rules:read', ctx, {
    agentId,
  });

const write = (
  bus: HookBus,
  ctx: ReturnType<typeof makeCtx>,
  input: MemoryRulesWriteInput,
) => bus.call<MemoryRulesWriteInput, MemoryRulesWriteOutput>('memory:rules:write', ctx, input);

// ---------------------------------------------------------------------------

describe('memory:rules:write — the git-tier path', () => {
  it('applies through workspace:apply and never writes the file itself', async () => {
    const { bus, files, applied } = tierBus();
    const ctx = makeCtx();

    const out = await write(bus, ctx, { agentId: 'atlas', body: '- Always cc Priya' });

    expect(out.written).toBe(true);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.reason).toBe('memory:rules:write');
    expect(applied[0]!.changes).toEqual([
      {
        path: HUMAN_TIER_TIER_PATHS[0],
        kind: 'put',
        content: new TextEncoder().encode('- Always cc Priya\n'),
      },
    ]);
    // The host filesystem is a shared directory in this preset; a write there
    // would be invisible to every runner. Nothing landed on it.
    await expect(readFile(join(workspaceRoot, rulesFile()), 'utf8')).rejects.toThrow(
      /ENOENT/u,
    );
    expect(new TextDecoder().decode(files.get(HUMAN_TIER_TIER_PATHS[0]!)!)).toBe(
      '- Always cc Priya\n',
    );
  });

  it('round-trips through memory:rules:read', async () => {
    const { bus } = tierBus();
    const ctx = makeCtx();
    expect((await read(bus, ctx, 'atlas')).body).toBe('');
    await write(bus, ctx, { agentId: 'atlas', body: '- one\n- two' });
    expect((await read(bus, ctx, 'atlas')).body).toBe('- one\n- two\n');
  });
});

describe('memory:rules:write — the CLI path', () => {
  it('writes the agent workspace root when no workspace backend is loaded', async () => {
    const bus = cliBus();
    const ctx = makeCtx();
    await write(bus, ctx, { agentId: 'atlas', body: '- Always cc Priya' });
    expect(await readFile(join(workspaceRoot, rulesFile()), 'utf8')).toBe(
      '- Always cc Priya\n',
    );
    expect((await read(bus, ctx, 'atlas')).body).toBe('- Always cc Priya\n');
  });

  it('reads an unwritten tier as empty rather than throwing', async () => {
    expect((await read(cliBus(), makeCtx(), 'atlas')).body).toBe('');
  });
});

describe('the hooks refuse a ctx that routes somewhere else', () => {
  it('rejects a payload agentId that disagrees with the calling context', async () => {
    const { bus, applied } = tierBus();
    const ctx = makeCtx('atlas');
    // `workspace:apply` routes by (userId, agentId) off the CTX. A caller that
    // asks about zephyr while holding atlas's ctx would silently write atlas's
    // workspace — the exact regression this check exists for.
    await expect(write(bus, ctx, { agentId: 'zephyr', body: 'x' })).rejects.toThrow(
      PluginError,
    );
    await expect(read(bus, ctx, 'zephyr')).rejects.toThrow(PluginError);
    await expect(
      bus.call<MemoryRulesReadInput, MemoryLearnedReadOutput>(
        'memory:learned:read',
        ctx,
        { agentId: 'zephyr' },
      ),
    ).rejects.toThrow(PluginError);
    expect(applied).toEqual([]);
  });

  it('rejects a missing agentId and an over-long body', async () => {
    const { bus, applied } = tierBus();
    const ctx = makeCtx();
    await expect(write(bus, ctx, { agentId: '', body: 'x' })).rejects.toThrow(PluginError);
    await expect(
      write(bus, ctx, { agentId: 'atlas', body: 'x'.repeat(MAX_RULES_BYTES + 1) }),
    ).rejects.toThrow(/characters or fewer/u);
    expect(applied).toEqual([]);
  });
});

describe('memory:learned:read', () => {
  it('returns the agent-written docs that exist, and no headings over nothing', async () => {
    const bus = cliBus();
    const ctx = makeCtx();
    expect((await bus.call<MemoryRulesReadInput, MemoryLearnedReadOutput>(
      'memory:learned:read', ctx, { agentId: 'atlas' },
    )).docs).toEqual([]);

    await writeFileAt(systemFile('user'), buildMarkdownFile(fm('user', 'system/user'), '# User\n\nLikes oat milk.\n'));
    await writeFileAt(mapFile(), buildMarkdownFile(fm('map', 'system/map'), '# Memory Map\n\n- entity/priya\n'));

    const out = await bus.call<MemoryRulesReadInput, MemoryLearnedReadOutput>(
      'memory:learned:read', ctx, { agentId: 'atlas' },
    );
    expect(out.docs.map((d) => d.name)).toEqual([
      'What it knows about you',
      'Index of everything it remembers',
    ]);
    expect(out.docs[0]!.body).toContain('Likes oat milk.');
  });

  it('does not surface the human tier under the agent\'s own heading', async () => {
    const bus = cliBus();
    const ctx = makeCtx();
    await write(bus, ctx, { agentId: 'atlas', body: '- Always cc Priya' });
    const out = await bus.call<MemoryRulesReadInput, MemoryLearnedReadOutput>(
      'memory:learned:read', ctx, { agentId: 'atlas' },
    );
    expect(JSON.stringify(out.docs)).not.toContain('Priya');
  });
});

// ---------------------------------------------------------------------------
// Injection: first in, last out
// ---------------------------------------------------------------------------

describe('injection puts the human first', () => {
  it('renders the rules section before anything the agent wrote', async () => {
    const bus = cliBus();
    const ctx = makeCtx();
    await write(bus, ctx, { agentId: 'atlas', body: '- Always cc Priya' });
    await writeFileAt(systemFile('user'), buildMarkdownFile(fm('user', 'system/user'), '# User\n\nLikes oat milk.\n'));
    await writeFileAt(recentFile(), buildMarkdownFile(fm('recent', 'system/recent'), '# Recent\n\nShipped the thing.\n'));

    const block = await buildMemoryBlock(bus, ctx, { workspaceRoot });

    expect(block).toContain('## Rules From Your User');
    expect(block).toContain('Always cc Priya');
    expect(block.indexOf('## Rules From Your User')).toBeLessThan(
      block.indexOf('## User Profile'),
    );
    expect(block.indexOf('## User Profile')).toBeLessThan(block.indexOf('## Recent'));
  });

  it('keeps the rules verbatim — a leading --- is the user\'s text, not frontmatter', async () => {
    const bus = cliBus();
    const ctx = makeCtx();
    // The machine-written files open with a `---` frontmatter fence, and the
    // readers strip it. The human tier has none, so a user whose first line is
    // a horizontal rule must not watch the top of their own rules vanish.
    await write(bus, ctx, { agentId: 'atlas', body: '---\n- Always cc Priya\n---\n- And Sam' });
    const block = await buildMemoryBlock(bus, ctx, { workspaceRoot });
    expect(block).toContain('Always cc Priya');
    expect(block).toContain('And Sam');
  });

  it('cuts the agent\'s sections before it cuts one word of the human\'s', async () => {
    const bus = cliBus();
    const ctx = makeCtx();
    await write(bus, ctx, { agentId: 'atlas', body: '- Always cc Priya on customer email' });
    await writeFileAt(
      systemFile('user'),
      buildMarkdownFile(fm('user', 'system/user'), `# User\n\n${'profile filler. '.repeat(400)}\n`),
    );
    await writeFileAt(
      recentFile(),
      buildMarkdownFile(fm('recent', 'system/recent'), `# Recent\n\n${'recent filler. '.repeat(400)}\n`),
    );

    // A budget far too small for everything: ~120 chars of content.
    const block = await buildMemoryBlock(bus, ctx, { workspaceRoot, maxTokens: 40 });

    expect(block.length).toBeLessThanOrEqual(40 * 4);
    expect(block).toContain('Always cc Priya on customer email');
    expect(block).not.toContain('recent filler');
  });

  it('emits no rules section when the human has written nothing', async () => {
    const bus = cliBus();
    const ctx = makeCtx();
    await writeFileAt(systemFile('user'), buildMarkdownFile(fm('user', 'system/user'), '# User\n\nLikes oat milk.\n'));
    const block = await buildMemoryBlock(bus, ctx, { workspaceRoot });
    expect(block).not.toContain('## Rules From Your User');
    expect(block).toContain('## User Profile');
  });
});
