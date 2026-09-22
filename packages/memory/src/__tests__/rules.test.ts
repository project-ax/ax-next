import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookBus, MEMORY_RULES_PATH, PluginError, makeAgentContext } from '@ax/core';
import { createWorkspaceGitPlugin } from '@ax/workspace-git';

import { MEMORY_NOTE_TOOL_HOOK } from '../note-tool.js';
import { MAX_RULES_CHARS, RULES_WRITE_HOOK } from '../rules.js';
import { RULES_READ_HOOK } from '../augment.js';
import { MEMORY_EXPORT_FLUSH_HOOK } from '../exporter.js';
import {
  ALICE,
  BOB,
  makeMemoryHarness,
  type MemoryHarness,
} from './harness.js';

let harness: MemoryHarness | undefined;
const dirs: string[] = [];
const harnesses: MemoryHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.teardown();
  await harness?.teardown();
  harness = undefined;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function withWorkspace(
  config: Parameters<typeof makeMemoryHarness>[0] = { rules: true },
  options: Parameters<typeof makeMemoryHarness>[1] = {},
): Promise<MemoryHarness> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'ax-rules-ws-'));
  dirs.push(repoRoot);
  const h = await makeMemoryHarness(config, options);
  harnesses.push(h);
  const ws = createWorkspaceGitPlugin({ repoRoot });
  await ws.init({ bus: h.bus });
  return h;
}

function readRules(h: MemoryHarness, ctx = h.ctx()): Promise<{ body: string }> {
  return h.bus.call(RULES_READ_HOOK, ctx, { agentId: ctx.agentId });
}

function writeRules(
  h: MemoryHarness,
  body: string,
  ctx = h.ctx(),
): Promise<{ written: boolean; body: string }> {
  return h.bus.call(RULES_WRITE_HOOK, ctx, { agentId: ctx.agentId, body });
}

async function workspaceRead(h: MemoryHarness, ctx = h.ctx()) {
  return h.bus.call<{ path: string }, { found: boolean; bytes?: Uint8Array }>(
    'workspace:read',
    ctx,
    { path: MEMORY_RULES_PATH },
  );
}

describe('memory:rules — gated off by default', () => {
  it('a default config registers no rules hooks and claims no workspace calls', async () => {
    harness = await makeMemoryHarness();
    const plugin = harness.memoryPlugin;
    expect(plugin.manifest.registers).not.toContain(RULES_READ_HOOK);
    expect(plugin.manifest.registers).not.toContain(RULES_WRITE_HOOK);
    expect(plugin.manifest.calls).not.toContain('workspace:read');
    expect(plugin.manifest.calls).not.toContain('workspace:apply');
    expect(harness.bus.hasService(RULES_READ_HOOK)).toBe(false);
    expect(harness.bus.hasService(RULES_WRITE_HOOK)).toBe(false);
  });

  it('a rules-enabled plugin declares the hooks and the workspace calls', async () => {
    const h = await withWorkspace();
    expect(h.memoryPlugin.manifest.registers).toEqual(
      expect.arrayContaining([RULES_READ_HOOK, RULES_WRITE_HOOK]),
    );
    expect(h.memoryPlugin.manifest.calls).toEqual(
      expect.arrayContaining(['workspace:read', 'workspace:apply']),
    );
  });

  it('rejects a non-boolean rules flag and a non-object exports block at construction', async () => {
    const { createMemoryPlugin } = await import('../plugin.js');
    expect(() => createMemoryPlugin({ rules: 'yes' as never })).toThrowError(/rules/);
    expect(() => createMemoryPlugin({ exports: 'on' as never })).toThrowError(/exports/);
    expect(() => createMemoryPlugin({ exports: [] as never })).toThrowError(/exports/);
    expect(() => createMemoryPlugin({ exports: null as never })).toThrowError(/exports/);
  });
});

describe('memory:rules:read', () => {
  it('answers an empty body for a never-written file, without writing anything', async () => {
    const h = await withWorkspace();
    expect(await readRules(h)).toEqual({ body: '' });
    const out = await workspaceRead(h);
    expect(out.found).toBe(false);
  });

  it('propagates a workspace failure instead of answering empty', async () => {
    const bus = new HookBus();
    bus.registerService('tool:register', 'stub', async () => ({ ok: true }));
    bus.registerService('agents:resolve', 'stub', async (_c, i) => ({
      agent: {
        id: (i as { agentId: string }).agentId,
        ownerId: (i as { userId: string }).userId,
        ownerType: 'user',
        visibility: 'personal',
      },
    }));
    bus.registerService('memory:facts:recall', 'stub', async () => ({ statements: [] }));
    bus.registerService('memory:facts:record', 'stub', async () => ({ records: [] }));
    bus.registerService('memory:facts:supersede', 'stub', async () => ({ superseded: [] }));
    bus.registerService('workspace:read', 'stub', async () => {
      throw new PluginError({ code: 'unavailable', plugin: 'ws', message: 'store down' });
    });
    bus.registerService('workspace:apply', 'stub', async () => {
      throw new Error('unreachable');
    });
    const { createMemoryPlugin } = await import('../plugin.js');
    await createMemoryPlugin({ rules: true }).init({ bus, config: {} });
    const ctx = makeAgentContext({
      sessionId: 's',
      agentId: 'agent-1',
      userId: ALICE,
      workspace: { rootPath: '/tmp' },
    });
    await expect(
      bus.call(RULES_READ_HOOK, ctx, { agentId: 'agent-1' }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rejects a malformed read reply instead of answering empty', async () => {
    const bus = new HookBus();
    bus.registerService('tool:register', 'stub', async () => ({ ok: true }));
    bus.registerService('agents:resolve', 'stub', async (_c, i) => ({
      agent: {
        id: (i as { agentId: string }).agentId,
        ownerId: (i as { userId: string }).userId,
        ownerType: 'user',
        visibility: 'personal',
      },
    }));
    bus.registerService('memory:facts:recall', 'stub', async () => ({ statements: [] }));
    bus.registerService('memory:facts:record', 'stub', async () => ({ records: [] }));
    bus.registerService('memory:facts:supersede', 'stub', async () => ({ superseded: [] }));
    bus.registerService('workspace:read', 'stub', async () => ({ found: 'yes' }));
    bus.registerService('workspace:apply', 'stub', async () => {
      throw new Error('unreachable');
    });
    const { createMemoryPlugin } = await import('../plugin.js');
    await createMemoryPlugin({ rules: true }).init({ bus, config: {} });
    const ctx = makeAgentContext({
      sessionId: 's',
      agentId: 'agent-1',
      userId: ALICE,
      workspace: { rootPath: '/tmp' },
    });
    await expect(
      bus.call(RULES_READ_HOOK, ctx, { agentId: 'agent-1' }),
    ).rejects.toMatchObject({ code: 'invalid-return' });
  });

  it.each([
    ['a null input', null],
    ['an array input', []],
    ['a missing agentId', {}],
    ['a blank agentId', { agentId: '  ' }],
    ['a smuggled field', { agentId: 'agent-1', path: '../etc' }],
  ])('refuses %s', async (_label, input) => {
    const h = await withWorkspace();
    await expect(
      h.bus.call(RULES_READ_HOOK, h.ctx(), input as never),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('refuses an agentId that does not match the calling ctx', async () => {
    const h = await withWorkspace();
    await expect(
      h.bus.call(RULES_READ_HOOK, h.ctx(), { agentId: 'other-agent' }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });
});

describe('memory:rules:write', () => {
  it('stores the normalized body and reports it back verbatim', async () => {
    const h = await withWorkspace();
    const result = await writeRules(h, 'Always cite sources.\n\n\n  ');
    expect(result).toEqual({ written: true, body: 'Always cite sources.\n' });
    expect(await readRules(h)).toEqual({ body: 'Always cite sources.\n' });
    const out = await workspaceRead(h);
    expect(Buffer.from(out.bytes!).toString('utf-8')).toBe('Always cite sources.\n');
  });

  it('a byte-identical save is a no-op, not an empty commit', async () => {
    const h = await withWorkspace();
    expect((await writeRules(h, 'Be brief.')).written).toBe(true);
    const second = await writeRules(h, 'Be brief.   \n');
    expect(second).toEqual({ written: false, body: 'Be brief.\n' });
  });

  it('enforces the cap and the type on body', async () => {
    const h = await withWorkspace();
    await expect(writeRules(h, 'x'.repeat(MAX_RULES_CHARS + 1))).rejects.toMatchObject({
      code: 'invalid-payload',
    });
    expect((await writeRules(h, 'x'.repeat(MAX_RULES_CHARS))).written).toBe(true);
    await expect(
      h.bus.call(RULES_WRITE_HOOK, h.ctx(), { agentId: h.ctx().agentId, body: 42 } as never),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('denies a foreign personal caller before any workspace call', async () => {
    const h = await withWorkspace();
    const spy = vi.spyOn(h.bus, 'call');
    const foreign = h.ctx({ userId: BOB });
    await expect(
      h.bus.call(RULES_WRITE_HOOK, foreign, { agentId: foreign.agentId, body: 'x' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      h.bus.call(RULES_READ_HOOK, foreign, { agentId: foreign.agentId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    for (const called of spy.mock.calls.map((c) => c[0])) {
      expect(called).not.toBe('workspace:read');
      expect(called).not.toBe('workspace:apply');
    }
    spy.mockRestore();
  });

  it('lets a team member write and read, denies an outsider', async () => {
    const h = await withWorkspace({ rules: true }, { agent: { visibility: 'team' } });
    const bob = h.ctx({ userId: BOB });
    expect((await writeRules(h, 'Shared house rules.', bob)).written).toBe(true);
    expect(await readRules(h, bob)).toEqual({ body: 'Shared house rules.\n' });
    expect(await readRules(h, h.ctx({ userId: ALICE }))).toEqual({
      body: 'Shared house rules.\n',
    });
    const outsider = h.ctx({ userId: 'carol-outsider' });
    await expect(
      h.bus.call(RULES_WRITE_HOOK, outsider, { agentId: outsider.agentId, body: 'x' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('retries on a parent-mismatch using the reported actualParent', async () => {
    const h = await withWorkspace();
    await h.bus.call('workspace:apply', h.ctx(), {
      changes: [{ path: 'seed.txt', kind: 'put', content: new TextEncoder().encode('s') }],
      parent: null,
      reason: 'test-seed',
    });
    const head = await h.bus.call<{ path: string }, { found: boolean; version?: string }>(
      'workspace:read',
      h.ctx(),
      { path: 'seed.txt' },
    );
    expect(head.found).toBe(true);

    let tripped = 0;
    const original = h.bus.call.bind(h.bus);
    vi.spyOn(h.bus, 'call').mockImplementation((async (
      hook: string,
      ctx: never,
      input: never,
    ) => {
      if (hook === 'workspace:apply' && tripped === 0) {
        tripped += 1;
        throw new PluginError({
          code: 'parent-mismatch',
          plugin: 'ws',
          message: 'head moved',
          cause: { actualParent: head.version ?? null },
        });
      }
      return original(hook, ctx, input);
    }) as never);

    const result = await writeRules(h, 'Retried save.');
    expect(result.written).toBe(true);
    expect(tripped).toBe(1);
    expect(await readRules(h)).toEqual({ body: 'Retried save.\n' });
    vi.restoreAllMocks();
  });

  it('propagates a malformed actualParent hint rather than retrying on garbage', async () => {
    const h = await withWorkspace();
    const original = h.bus.call.bind(h.bus);
    vi.spyOn(h.bus, 'call').mockImplementation((async (
      hook: string,
      ctx: never,
      input: never,
    ) => {
      if (hook === 'workspace:apply') {
        throw new PluginError({
          code: 'parent-mismatch',
          plugin: 'ws',
          message: 'head moved',
          cause: { actualParent: 42 },
        });
      }
      return original(hook, ctx, input);
    }) as never);
    await expect(writeRules(h, 'x')).rejects.toMatchObject({ code: 'parent-mismatch' });
    vi.restoreAllMocks();
  });
});

describe('the rules file is outside every automatic writer', () => {
  it('a note, an observer turn and an export leave the stored bytes untouched', async () => {
    const h = await withWorkspace(
      { rules: true, exports: { debounceMs: 5 } },
      {
        llm: () => ({
          text: JSON.stringify({
            facts: [
              {
                subject: 'user',
                predicate: 'visited',
                object: 'Kyoto',
                validStart: '2023-01-15T09:00:00Z',
              },
            ],
          }),
          stopReason: 'end_turn' as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      },
    );
    await writeRules(h, 'Never guess.');

    const note = await h.bus.call<
      { input: { about: string; relation: string; value: string } },
      { ok?: boolean }
    >(MEMORY_NOTE_TOOL_HOOK, h.ctx(), {
      input: { about: 'user', relation: 'lives in', value: 'Osaka' },
    });
    expect(note.ok).toBe(true);

    await h.bus.fire('chat:end', h.ctx({ conversationId: 'rules-conv' }), {
      outcome: {
        kind: 'complete',
        messages: [
          { role: 'user', content: 'I visited Kyoto' },
          { role: 'assistant', content: 'nice' },
        ],
      },
    });
    await h.settleObserver();

    const scan = await h.bus.call<
      Record<string, unknown>,
      { statements: Array<{ value: string }> }
    >('memory:facts:scan', h.ctx(), {});
    const values = scan.statements.map((s) => s.value);
    expect(values).toContain('Osaka');
    expect(values).toContain('Kyoto');

    await h.bus.call(MEMORY_EXPORT_FLUSH_HOOK, h.ctx(), {});
    const out = await workspaceRead(h);
    expect(out.found).toBe(true);
    expect(Buffer.from(out.bytes!).toString('utf-8')).toBe('Never guess.\n');
  });

  it('the injected block carries the rules text under its heading', async () => {
    const h = await withWorkspace();
    await writeRules(h, 'Never guess.');
    const block = await h.bus.call<
      Record<string, never>,
      { contributions: Array<{ source: string; body: string }> }
    >('system-prompt:augment', h.ctx(), {});
    const text = block.contributions.map((c) => c.body).join('\n\n');
    expect(text).toContain('## Rules From Your User');
    expect(text).toContain('Never guess.');
  });
});
