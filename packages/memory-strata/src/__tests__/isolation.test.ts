import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus, makeAgentContext, type AgentOutcome, type LlmCallInput, type LlmCallOutput } from '@ax/core';
import { createMemoryStrataPlugin } from '../plugin.js';
import { systemFile, INBOX_DIR } from '../paths.js';

// I8: per-agent isolation. Two agents are configured with their own
// workspace roots — their memory trees must NOT cross-contaminate.
// Workspace isolation is the source-of-truth: we just verify that the
// plugin honors `ctx.workspace.rootPath` end-to-end and never reaches
// out to a sibling root.

let rootA: string;
let rootB: string;

beforeEach(async () => {
  rootA = await mkdtemp(join(tmpdir(), 'memory-strata-iso-A-'));
  rootB = await mkdtemp(join(tmpdir(), 'memory-strata-iso-B-'));
});

afterEach(async () => {
  await rm(rootA, { recursive: true, force: true });
  await rm(rootB, { recursive: true, force: true });
});

interface AgentSpec {
  id: string;
  systemPrompt: string;
  model: string;
}

function buildBus(agents: Record<string, AgentSpec>, llmText: string): HookBus {
  const bus = new HookBus();
  bus.registerService<{ agentId: string; userId: string }, { agent: { systemPrompt: string; model: string } }>(
    'agents:resolve',
    'test-agents',
    async (_ctx, input) => {
      const a = agents[input.agentId];
      if (!a) throw new Error(`unknown agent ${input.agentId}`);
      return { agent: { systemPrompt: a.systemPrompt, model: a.model } };
    },
  );
  bus.registerService<LlmCallInput, LlmCallOutput>('llm:call:anthropic', 'test-llm', async () => ({
    text: llmText,
    stopReason: 'end_turn',
    usage: { inputTokens: 5, outputTokens: 5 },
  }));
  // Stub tool:register — required by plugin.init() for memory_search registration.
  bus.registerService('tool:register', 'test-tool-dispatcher', async () => ({ ok: true as const }));
  return bus;
}

function ctxFor(agentId: string, root: string) {
  return makeAgentContext({
    sessionId: `${agentId}-session`,
    agentId,
    userId: 'test-user',
    workspace: { rootPath: root },
  });
}

const drainObserver = (): Promise<void> =>
  new Promise((r) => setTimeout(r, 50));

describe('per-agent memory isolation (I8)', () => {
  it('keeps each agent\'s memory tree confined to its own workspace root', async () => {
    const bus = buildBus(
      {
        atlas: { id: 'atlas', systemPrompt: 'I am Atlas.', model: 'claude-haiku-4-5-20251001' },
        zephyr: { id: 'zephyr', systemPrompt: 'I am Zephyr.', model: 'claude-haiku-4-5-20251001' },
      },
      JSON.stringify([
        { fact: 'User prefers atlas-only fact.', subject: 'user', factType: 'preference', confidence: 0.9 },
      ]),
    );

    const plugin = createMemoryStrataPlugin();
    await plugin.init?.({ bus, config: {} });

    // Agent atlas runs a chat in rootA.
    await bus.fire('chat:start', ctxFor('atlas', rootA), {});
    const outcome: AgentOutcome = {
      kind: 'complete',
      messages: [
        { role: 'user', content: 'Hi Atlas.' },
        { role: 'assistant', content: 'Hello!' },
      ],
    };
    await bus.fire('chat:end', ctxFor('atlas', rootA), { outcome });
    await drainObserver();

    // Agent zephyr runs a chat in rootB.
    await bus.fire('chat:start', ctxFor('zephyr', rootB), {});
    await bus.fire('chat:end', ctxFor('zephyr', rootB), { outcome });
    await drainObserver();

    // Each agent has its own bootstrapped persona file.
    const atlasAgentMd = await readFile(join(rootA, systemFile('agent')), 'utf8');
    expect(atlasAgentMd).toContain('I am Atlas.');
    expect(atlasAgentMd).not.toContain('I am Zephyr.');

    const zephyrAgentMd = await readFile(join(rootB, systemFile('agent')), 'utf8');
    expect(zephyrAgentMd).toContain('I am Zephyr.');
    expect(zephyrAgentMd).not.toContain('I am Atlas.');

    // Each agent's inbox lives only under its own workspace root.
    const inboxA = await readdir(join(rootA, INBOX_DIR));
    const inboxB = await readdir(join(rootB, INBOX_DIR));
    expect(inboxA.length).toBeGreaterThan(0);
    expect(inboxB.length).toBeGreaterThan(0);

    // Cross-check: rootA has no zephyr memory directory and vice versa.
    // Workspace plugin enforces the ground truth here; we just verify our
    // path convention respects it (no `agentId` baked into the path that
    // could cross workspaces).
    for (const root of [rootA, rootB]) {
      const fileSet = new Set(await readdir(join(root, INBOX_DIR)));
      // No file from the OTHER root should appear here.
      const other = root === rootA ? inboxB : inboxA;
      for (const name of other) {
        expect(fileSet.has(name)).toBe(false);
      }
    }
  });
});
