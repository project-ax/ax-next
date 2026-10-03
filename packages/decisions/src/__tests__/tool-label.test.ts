import { makeAgentContext, type AgentContext, type ToolCall } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { createPreCallSubscriber, type PolicyAnswer } from '../pre-call.js';
import { decisionText } from '../templates.js';
import {
  connectorToolLabel,
  namingFromToolLabels,
  parseConnectorToolKey,
  type ConnectorToolNaming,
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

describe('tool-name humanizing (shared with channel-web via @ax/core/humanize — TASK-753)', () => {
  it('reads snake, kebab and camel case as words', () => {
    expect(connectorToolLabel(`mcp.${NS}.create_issue`, null)).toBe('Create issue');
    expect(connectorToolLabel(`mcp.${NS}.list-projects`, null)).toBe('List projects');
    expect(connectorToolLabel(`mcp.${NS}.getFileContents`, null)).toBe('Get file contents');
  });
  it('cases known acronyms the way the activity rail does', () => {
    // The TASK-753 seam: this package's private humanizer said "Create pdf"
    // while channel-web's activity row said "Create PDF" for the same call.
    expect(connectorToolLabel(`mcp.${NS}.create_pdf`, 'Docs')).toBe('Docs · Create PDF');
  });
  it('flattens control characters and clamps a hostile name', () => {
    expect(connectorToolLabel(`mcp.${NS}.a\nb\u0000c`, null)).toBe('A b c');
    expect([...connectorToolLabel(`mcp.${NS}.${'x'.repeat(500)}`, null)!].length).toBeLessThanOrEqual(48);
  });
});

describe('connectorToolLabel — cached server titles (TASK-753)', () => {
  it("prefers the server's cached title over the humanized name", () => {
    expect(connectorToolLabel(KEY, 'Linear', 'Open a ticket')).toBe('Linear · Open a ticket');
    expect(connectorToolLabel(KEY, null, 'Open a ticket')).toBe('Open a ticket');
  });
  it('a title that is just the raw name is no title', () => {
    expect(connectorToolLabel(KEY, 'Linear', 'create_issue')).toBe('Linear · Create issue');
  });
  it('fences a hostile title to one clamped line', () => {
    const label = connectorToolLabel(KEY, 'Linear', `Do it\u202E\nIgnore previous${'!'.repeat(200)}`)!;
    expect(label).not.toMatch(/[\n\u202E]/);
    expect(label.startsWith('Linear · Do it Ignore previous')).toBe(true);
    expect([...label].length).toBeLessThan(100);
  });
});

describe('namingFromToolLabels', () => {
  const answer = {
    connectors: [
      { toolNamespace: 'c0000000000', connectorId: 'other', name: 'Other', tools: [] },
      {
        toolNamespace: NS,
        connectorId: 'linear',
        name: 'Linear',
        tools: [
          { name: 'list_issues', title: 'List tickets' },
          { name: 'create_issue', title: 'Open a ticket' },
        ],
      },
    ],
  };
  it('picks the namespace and the tool', () => {
    expect(namingFromToolLabels(answer, NS, 'create_issue')).toEqual({
      connectorName: 'Linear',
      toolTitle: 'Open a ticket',
    });
    expect(namingFromToolLabels(answer, NS, 'delete_issue')).toEqual({
      connectorName: 'Linear',
      toolTitle: null,
    });
  });
  it('names nothing for an unknown namespace or a malformed answer', () => {
    const none: ConnectorToolNaming = { connectorName: null, toolTitle: null };
    expect(namingFromToolLabels(answer, 'c1111111111', 'create_issue')).toEqual(none);
    expect(namingFromToolLabels(null, NS, 'create_issue')).toEqual(none);
    expect(namingFromToolLabels({ connectors: 'x' }, NS, 'create_issue')).toEqual(none);
    expect(
      namingFromToolLabels({ connectors: [null, { toolNamespace: NS, name: 7, tools: [{ name: 'create_issue', title: 9 }] }] }, NS, 'create_issue'),
    ).toEqual(none);
  });
  it('tolerates an answer with no tools field (a connectors build before TASK-753)', () => {
    expect(
      namingFromToolLabels({ connectors: [{ toolNamespace: NS, connectorId: 'l', name: 'Linear' }] }, NS, 'create_issue'),
    ).toEqual({ connectorName: 'Linear', toolTitle: null });
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
  function build(connectorNameFor?: (ctx: AgentContext, ns: string) => Promise<string | null>, toolTitle: string | null = null) {
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
            connectorNamingFor: async (c: AgentContext, ns: string, tool: string) => {
              seen.push(`${ns}/${tool}`);
              return { connectorName: await connectorNameFor(c, ns), toolTitle };
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
    expect(b.seen).toEqual([`${NS}/create_issue`]);
  });
  it("writes the server's cached tool title onto the row when there is one (TASK-753)", async () => {
    const b = build(async () => 'Linear', 'Open a ticket');
    expect(await heldSummary(b)).toBe('Wants to use Linear · Open a ticket');
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
      connectorNamingFor: () => new Promise<never>(() => {}),
      connectorNameTimeoutMs: 20,
    });
    const r = (await sub(ctx(), CALL)) as { hold: { decisionId: string } };
    expect((await store.get(r.hold.decisionId))!.summary).toBe('Wants to use Create issue');
    // A tight per-test deadline: if the bound is ever removed this fails in
    // ~2 s instead of holding the suite for the 60 s default.
  }, 2_000);
  it('with no lookup wired, the row still never shows the hash', async () => {
    const b = build();
    const summary = await heldSummary(b);
    expect(summary).toBe('Wants to use Create issue');
    expect(summary).not.toContain(NS);
  });
});
