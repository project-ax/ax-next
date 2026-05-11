import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus, makeAgentContext, type AgentOutcome, type LlmCallInput, type LlmCallOutput } from '@ax/core';
import { createMemoryStrataPlugin } from '../plugin.js';
import type { Debouncer } from '../debounce.js';
import { systemFile, INBOX_DIR, docFile } from '../paths.js';
import { buildMarkdownFile } from '../frontmatter.js';
import type { MemoryFrontmatter } from '../types.js';

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memory-strata-plugin-'));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

interface AgentRow {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
  visibility: 'personal' | 'team';
  displayName: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
  workspaceRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function fakeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  const now = new Date('2026-05-10T00:00:00Z');
  return {
    id: 'test-agent',
    ownerId: 'test-user',
    ownerType: 'user',
    visibility: 'personal',
    displayName: 'Test Agent',
    systemPrompt: 'You are a friendly research assistant.',
    allowedTools: [],
    mcpConfigIds: [],
    model: 'claude-haiku-4-5-20251001',
    workspaceRef: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildBus(opts: {
  llmText: string;
  agent: AgentRow;
}): HookBus {
  const bus = new HookBus();
  bus.registerService('agents:resolve', 'test-agents', async () => ({ agent: opts.agent }));
  bus.registerService<LlmCallInput, LlmCallOutput>('llm:call:anthropic', 'test-llm', async () => ({
    text: opts.llmText,
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 10 },
  }));
  return bus;
}

function makeCtx(workspace: string) {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId: 'test-user',
    workspace: { rootPath: workspace },
  });
}

async function waitForObserverSettle(): Promise<void> {
  // Observer is fire-and-forget from chat:end; let microtasks + the
  // synchronous fs writes drain before we assert on the inbox.
  await new Promise((r) => setTimeout(r, 50));
}

describe('createMemoryStrataPlugin', () => {
  it('declares a minimal manifest', () => {
    const plugin = createMemoryStrataPlugin();
    expect(plugin.manifest.name).toBe('@ax/memory-strata');
    expect(plugin.manifest.registers).toEqual([]);
    expect(plugin.manifest.subscribes).toEqual(['chat:start', 'chat:end']);
    expect(plugin.manifest.calls).toContain('agents:resolve');
    expect(plugin.manifest.calls).toContain('llm:call:anthropic');
  });

  it('bootstraps the memory tree on chat:start', async () => {
    const bus = buildBus({ llmText: '[]', agent: fakeAgent({ systemPrompt: 'I am Atlas.' }) });
    const plugin = createMemoryStrataPlugin();
    await plugin.init?.({ bus, config: {} });

    await bus.fire('chat:start', makeCtx(workspaceRoot), {});

    const raw = await readFile(join(workspaceRoot, systemFile('agent')), 'utf8');
    expect(raw).toContain('I am Atlas.');
  });

  it('runs the Observer on chat:end and writes to inbox', async () => {
    const bus = buildBus({
      llmText: JSON.stringify([
        { fact: 'User prefers React.', subject: 'user', factType: 'preference', confidence: 0.9 },
      ]),
      agent: fakeAgent(),
    });
    const plugin = createMemoryStrataPlugin();
    await plugin.init?.({ bus, config: {} });

    const outcome: AgentOutcome = {
      kind: 'complete',
      messages: [
        { role: 'user', content: 'I prefer React.' },
        { role: 'assistant', content: 'Noted.' },
      ],
    };
    await bus.fire('chat:end', makeCtx(workspaceRoot), { outcome });
    await waitForObserverSettle();

    const inbox = await readdir(join(workspaceRoot, INBOX_DIR));
    expect(inbox).toHaveLength(1);
    const body = await readFile(join(workspaceRoot, INBOX_DIR, inbox[0]!), 'utf8');
    expect(body).toContain('React');
  });

  it('skips Observer on terminated outcomes (no transcript)', async () => {
    const bus = buildBus({ llmText: '[]', agent: fakeAgent() });
    const plugin = createMemoryStrataPlugin();
    await plugin.init?.({ bus, config: {} });

    const outcome: AgentOutcome = { kind: 'terminated', reason: 'chat:start:vetoed' };
    await bus.fire('chat:end', makeCtx(workspaceRoot), { outcome });
    await waitForObserverSettle();

    // No bootstrap + no Observer = no inbox dir at all.
    await expect(readdir(join(workspaceRoot, INBOX_DIR))).rejects.toThrow();
  });

  it('chat:end returns immediately even when the LLM is slow', async () => {
    const bus = new HookBus();
    bus.registerService('agents:resolve', 'test-agents', async () => ({ agent: fakeAgent() }));
    let llmStarted = false;
    bus.registerService<LlmCallInput, LlmCallOutput>(
      'llm:call:anthropic',
      'slow-llm',
      () =>
        new Promise<LlmCallOutput>((resolve) => {
          llmStarted = true;
          // Resolves only after the fire() has long since returned.
          setTimeout(
            () => resolve({ text: '[]', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }),
            500,
          );
        }),
    );
    const plugin = createMemoryStrataPlugin();
    await plugin.init?.({ bus, config: {} });

    const outcome: AgentOutcome = {
      kind: 'complete',
      messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
    };

    const start = Date.now();
    await bus.fire('chat:end', makeCtx(workspaceRoot), { outcome });
    const elapsed = Date.now() - start;

    // The fire() must NOT block on the 500ms LLM call (I6).
    expect(elapsed).toBeLessThan(200);
    // Let the fire-and-forget chain progress through agents:resolve so
    // we can confirm the LLM call WAS kicked off (just not awaited).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(llmStarted).toBe(true);
  });
});

// ─── Helpers for Consolidator wiring tests ───────────────────────────────────

/**
 * Write a synthetic inbox observation with high confidence so the Consolidator
 * will promote it (confidence >= 0.7). Returns the absolute path written.
 */
async function seedInboxObservation(
  workspaceRoot: string,
  id: string,
  opts: { subject?: string; fact?: string } = {},
): Promise<void> {
  const inboxDir = join(workspaceRoot, INBOX_DIR);
  await mkdir(inboxDir, { recursive: true });
  const fm: MemoryFrontmatter = {
    id,
    type: 'inbox/observation',
    created: new Date().toISOString(),
    confidence: 0.9,
    pinned: false,
    summary: opts.fact ?? 'User prefers TypeScript.',
    subject: opts.subject ?? 'typescript',
    factType: 'preference',
    source_messages: 0,
    event_time: new Date().toISOString(),
    recorded_at: new Date().toISOString(),
  };
  const body = `# Observation\n\n${fm.summary}\n`;
  await writeFile(join(inboxDir, `${id}.md`), buildMarkdownFile(fm, body), 'utf8');
}

describe('Consolidator wiring (chat:end subscriber, I10)', () => {
  it('two chat:end events within debounce window → exactly one consolidation pass (on-disk)', async () => {
    // Arrange: a bus that returns an empty LLM response (Observer writes nothing),
    // but we seed an inbox file manually so the Consolidator has something to process.
    const bus = buildBus({ llmText: '[]', agent: fakeAgent() });
    let capturedDebouncer: Debouncer | undefined;
    const plugin = createMemoryStrataPlugin({
      // Tiny window so the debouncer coalesces quickly without sleeping 5s.
      consolidatorDebounceMs: 100,
      testHooks: {
        onDebouncerCreated(d) { capturedDebouncer = d; },
      },
    });
    await plugin.init?.({ bus, config: {} });

    // Seed a high-confidence inbox observation for the Consolidator to promote.
    await seedInboxObservation(workspaceRoot, 'obs-consolidator-1', {
      subject: 'typescript',
      fact: 'User prefers TypeScript.',
    });

    const outcome: AgentOutcome = {
      kind: 'complete',
      messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
    };
    const ctx = makeCtx(workspaceRoot);

    // Fire chat:end TWICE within the debounce window.
    await bus.fire('chat:end', ctx, { outcome });
    await bus.fire('chat:end', ctx, { outcome });

    // Flush the debouncer via test seam (runs the coalesced pass + awaits it).
    // Plugin.shutdown is resource-release only per @ax/core contract, so we
    // cannot rely on it to drain pending passes in tests.
    await capturedDebouncer!.flush();

    // The Consolidator should have run exactly once, promoting the inbox obs
    // to docs/preference/typescript.md.
    const docPath = join(workspaceRoot, docFile('preference', 'typescript'));
    const raw = await readFile(docPath, 'utf8');
    expect(raw).toContain('typescript');
    // The inbox file should have been deleted (consumed).
    const inboxEntries = await readdir(join(workspaceRoot, INBOX_DIR));
    expect(inboxEntries).toHaveLength(0);
  });

  it('consolidation timeout fires warn log and does not crash (I10 bounded)', async () => {
    // We use a real workspace but seed a high-confidence inbox file AND a
    // consolidatorTimeoutMs that is shorter than any real consolidation pass
    // can complete (10 ms). The raceTimeout fires, plugin swallows the error
    // and emits memory_strata_consolidator_failed — we capture that via a
    // custom logger spy injected through makeAgentContext's logger override.
    const warnEvents: string[] = [];
    const customLogger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string) => { warnEvents.push(msg); },
      error: () => {},
      child: function () { return this; },
    } as unknown as import('@ax/core').Logger;

    const bus = new HookBus();
    bus.registerService('agents:resolve', 'test-agents', async () => ({ agent: fakeAgent() }));
    bus.registerService<LlmCallInput, LlmCallOutput>('llm:call:anthropic', 'test-llm', async () => ({
      text: '[]',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    }));

    let capturedDebouncer: Debouncer | undefined;
    const plugin = createMemoryStrataPlugin({
      consolidatorDebounceMs: 10,   // fire quickly
      consolidatorTimeoutMs: 1,     // vanishingly small so timeout always fires first
      testHooks: {
        onDebouncerCreated(d) { capturedDebouncer = d; },
      },
    });
    await plugin.init?.({ bus, config: {} });

    // Seed a real inbox file so the Consolidator actually tries to do work.
    await seedInboxObservation(workspaceRoot, 'obs-timeout-1');

    const ctxWithLogger = makeAgentContext({
      sessionId: 'test-session',
      agentId: 'test-agent',
      userId: 'test-user',
      workspace: { rootPath: workspaceRoot },
      logger: customLogger,
    });

    const outcome: AgentOutcome = {
      kind: 'complete',
      messages: [{ role: 'user', content: 'test' }, { role: 'assistant', content: 'ok' }],
    };

    await bus.fire('chat:end', ctxWithLogger, { outcome });

    // Wait longer than debounce + timeout window so the Consolidator fires + times out.
    await new Promise((r) => setTimeout(r, 100));

    // Flush via test seam — should complete quickly (nothing left in-flight after
    // the timeout already fired). Plugin.shutdown is resource-release only per
    // @ax/core contract and cannot be used to drain in-flight passes.
    const t0 = Date.now();
    await capturedDebouncer!.flush();
    expect(Date.now() - t0).toBeLessThan(200);

    // The warn log for the consolidator failure must have been emitted.
    expect(warnEvents.some((e) => e.includes('memory_strata_consolidator_failed'))).toBe(true);
  });
});
