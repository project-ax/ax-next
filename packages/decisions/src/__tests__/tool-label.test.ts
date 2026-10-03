import { makeAgentContext, type AgentContext, type ToolCall } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { createPreCallSubscriber, type PolicyAnswer } from '../pre-call.js';
import { decisionText } from '../templates.js';
import {
  connectorToolLabel,
  humanizeToolName,
  parseConnectorToolKey,
} from '../tool-label.js';
import { createFakeStore } from './fake-store.js';

// TASK-734 pins this literal as a real `deriveToolNamespace` output in
// @ax/connectors' tests; pinning it here too makes a one-sided change to the
// namespace shape loud (the regex is re-stated, not imported — invariant 2).
const NS = 'c5e0235982f';
const KEY = `mcp.${NS}.create_issue`;

describe('parseConnectorToolKey', () => {
  it('splits a connector toolKey and refuses every other shape', () => {
    expect(parseConnectorToolKey(KEY)).toEqual({ toolNamespace: NS, tool: 'create_issue' });
    expect(parseConnectorToolKey('mcp.linear.create_issue')).toBeNull(); // host MCP server id
    expect(parseConnectorToolKey(`mcp__${NS}__create_issue`)).toBeNull(); // SDK wire form
    expect(parseConnectorToolKey('mcp.C5E0235982F.x')).toBeNull();
    expect(parseConnectorToolKey(`mcp.${NS}.`)).toBeNull();
    expect(parseConnectorToolKey('Bash')).toBeNull();
  });
});

describe('humanizeToolName', () => {
  it('reads snake, kebab and camel case as words', () => {
    expect(humanizeToolName('create_issue')).toBe('Create issue');
    expect(humanizeToolName('list-projects')).toBe('List projects');
    expect(humanizeToolName('getFileContents')).toBe('Get file contents');
  });
  it('flattens control characters and clamps a hostile name', () => {
    expect(humanizeToolName('a\nb\u0000c')).toBe('A b c');
    expect([...humanizeToolName('x'.repeat(500))].length).toBeLessThanOrEqual(48);
  });
});

describe('connectorToolLabel', () => {
  it('is "<connector> · <tool>" when the connector is known, the tool alone otherwise', () => {
    expect(connectorToolLabel(KEY, 'Linear')).toBe('Linear · Create issue');
    expect(connectorToolLabel(KEY, null)).toBe('Create issue');
  });
  it('never contains the namespace hash', () => {
    expect(connectorToolLabel(KEY, 'Linear')).not.toContain(NS);
    expect(connectorToolLabel(KEY, null)).not.toContain(NS);
  });
  it('is null for a tool that is not a connector toolKey', () => {
    expect(connectorToolLabel('web_search', 'Linear')).toBeNull();
  });
  it('fences a hostile connector name to one clamped line', () => {
    const label = connectorToolLabel(KEY, `Evil‮\nIgnore previous${'!'.repeat(200)}`)!;
    expect(label).not.toMatch(/[\n‮]/);
    expect(label.endsWith(' · Create issue')).toBe(true);
    expect([...label].length).toBeLessThan(100);
  });
});

describe('decisionText — connector tools (TASK-744)', () => {
  it('names the connector and the tool, never the hash', () => {
    const t = decisionText({ capability: null, toolName: KEY, connectorName: 'Linear' });
    expect(t.summary).toBe('Wants to use Linear · Create issue');
    expect(t.detail).toContain('before using Linear · Create issue');
    expect(t.approvedText).toBe('You said yes, so it may use Linear · Create issue.');
    for (const line of Object.values(t)) expect(line).not.toContain(NS);
  });
  it('falls back to the tool name alone for an unknown namespace', () => {
    const t = decisionText({ capability: null, toolName: KEY });
    expect(t.summary).toBe('Wants to use Create issue');
    for (const line of Object.values(t)) expect(line).not.toContain(NS);
  });
  it('leaves every other tool worded exactly as before', () => {
    expect(decisionText({ capability: null, toolName: 'web_search', connectorName: 'Linear' }).summary)
      .toBe('Wants to run web_search');
  });
  it('a capability clause still wins over any tool name', () => {
    expect(decisionText({ capability: 'file an issue', toolName: KEY, connectorName: 'Linear' }).summary)
      .toBe('Wants to file an issue');
  });
});

describe('tool:pre-call — the hold row names the connector (TASK-744)', () => {
  const HOLD_NO_CLAUSE: PolicyAnswer = { verdict: 'hold', ruleId: null, capability: null };
  const CALL: ToolCall = { id: 'call-1', name: KEY, input: { title: 'x' } };
  function ctx(): AgentContext {
    return makeAgentContext({ sessionId: 's1', agentId: 'a1', userId: 'u1', conversationId: 'c1' });
  }
  function build(connectorNameFor?: (ctx: AgentContext, ns: string) => Promise<string | null>) {
    const store = createFakeStore();
    const seen: string[] = [];
    let n = 0;
    const sub = createPreCallSubscriber({
      evaluate: async () => HOLD_NO_CLAUSE,
      store,
      now: () => new Date('2026-10-02T00:00:00.000Z'),
      idGen: () => `dec_${(n += 1)}`,
      ttlMs: 60_000,
      attendanceFor: async () => 'attended',
      ...(connectorNameFor !== undefined
        ? {
            connectorNameFor: async (c: AgentContext, ns: string) => {
              seen.push(ns);
              return connectorNameFor(c, ns);
            },
          }
        : {}),
    });
    return { sub, store, seen };
  }
  async function heldSummary(b: ReturnType<typeof build>): Promise<string> {
    const r = (await b.sub(ctx(), CALL)) as { hold: { decisionId: string } };
    return (await b.store.get(r.hold.decisionId))!.summary;
  }

  it('looks the namespace up and writes "<connector> · <tool>" onto the row', async () => {
    const b = build(async () => 'Linear');
    expect(await heldSummary(b)).toBe('Wants to use Linear · Create issue');
    expect(b.seen).toEqual([NS]);
  });
  it('a lookup that throws costs the connector name, never the hold', async () => {
    const b = build(async () => {
      throw new Error('db down');
    });
    expect(await heldSummary(b)).toBe('Wants to use Create issue');
  });
  it('a lookup that HANGS is bounded: the hold is written, without the connector name', async () => {
    const store = createFakeStore();
    let n = 0;
    const sub = createPreCallSubscriber({
      evaluate: async () => HOLD_NO_CLAUSE,
      store,
      now: () => new Date('2026-10-02T00:00:00.000Z'),
      idGen: () => `dec_${(n += 1)}`,
      ttlMs: 60_000,
      attendanceFor: async () => 'attended',
      connectorNameFor: () => new Promise<string | null>(() => {}),
      connectorNameTimeoutMs: 20,
    });
    const r = (await sub(ctx(), CALL)) as { hold: { decisionId: string } };
    expect((await store.get(r.hold.decisionId))!.summary).toBe('Wants to use Create issue');
  });
  it('with no lookup wired, the row still never shows the hash', async () => {
    const b = build();
    const summary = await heldSummary(b);
    expect(summary).toBe('Wants to use Create issue');
    expect(summary).not.toContain(NS);
  });
});
