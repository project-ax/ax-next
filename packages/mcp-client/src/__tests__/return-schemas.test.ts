import { describe, it, expect } from 'vitest';
import type { ToolDescriptor } from '@ax/core';
import { ToolListOutputSchema, ToolRegisterOutputSchema } from '../tool-dispatcher-plugin.js';
import { ConnectorCallToolResultOutputSchema } from '../connector-inventory/types.js';

// ARCH-13 drift guard for the tool-dispatcher's `tool:register` / `tool:list`
// returns schemas. A fully-populated ToolDescriptor must round-trip without
// losing a field (the descriptor schema mirrors @ax/core's interface).

const descriptor: ToolDescriptor = {
  name: 'github__search',
  description: 'search GitHub',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  executesIn: 'host',
  // TASK-229 T1: keep every optional field in the "fully-populated" descriptor
  // so the round-trip test below catches a strip. The bus validates tool:list
  // output against ToolListOutputSchema, so a field absent from that schema is
  // dropped before it reaches the wire (BUG-W2: how a descriptor field once
  // went missing).
  activityPhrase: 'Reading email',
  countable: 'messages',
};

describe('tool-dispatcher return schemas', () => {
  it('tool:register round-trips { ok: true }', () => {
    expect(ToolRegisterOutputSchema.parse({ ok: true })).toEqual({ ok: true });
  });

  it('tool:register rejects { ok: false }', () => {
    expect(ToolRegisterOutputSchema.safeParse({ ok: false }).success).toBe(false);
  });

  it('tool:list round-trips a fully-populated ToolDescriptor', () => {
    const full = { tools: [descriptor] };
    expect(ToolListOutputSchema.parse(full)).toEqual(full);
  });

  it('tool:list round-trips a descriptor without the optional description', () => {
    const { description: _omit, ...rest } = descriptor;
    const full = { tools: [rest] };
    expect(ToolListOutputSchema.parse(full)).toEqual(full);
  });

  it('tool:list accepts an empty tools array', () => {
    expect(ToolListOutputSchema.parse({ tools: [] })).toEqual({ tools: [] });
  });

  it('tool:list rejects an invalid executesIn', () => {
    expect(
      ToolListOutputSchema.safeParse({ tools: [{ ...descriptor, executesIn: 'remote' }] }).success,
    ).toBe(false);
  });

  it('tool:list rejects a missing inputSchema', () => {
    const { inputSchema: _omit, ...rest } = descriptor;
    expect(ToolListOutputSchema.safeParse({ tools: [rest] }).success).toBe(false);
  });

  it('tool:list strips the retired flushWorkspaceBeforeCall (TASK-995)', () => {
    // Nothing honours the flag since the git workspace tier went away, so it
    // must not reach the wire claiming a flush that no runner performs.
    const parsed = ToolListOutputSchema.parse({
      tools: [{ ...descriptor, flushWorkspaceBeforeCall: true }],
    });
    expect(parsed).toEqual({ tools: [descriptor] });
  });
});

// `connectors:call-tool-result`: the content blocks are opaque, so a block's
// extra keys survive the bus; only `type` is required.
describe('connectors:call-tool-result return schema', () => {
  it('keeps extra block keys', () => {
    const answer = {
      outcome: 'succeeded',
      content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png', annotations: { audience: ['user'] } }],
    };
    expect(ConnectorCallToolResultOutputSchema.parse(answer)).toEqual(answer);
  });

  it('rejects a block with no type', () => {
    expect(ConnectorCallToolResultOutputSchema.safeParse({ outcome: 'succeeded', content: [{ text: 'x' }] }).success).toBe(
      false,
    );
  });

  it('rejects an unknown outcome with a failed reason', () => {
    expect(ConnectorCallToolResultOutputSchema.safeParse({ outcome: 'unknown', reason: 'tool-error' }).success).toBe(false);
  });
});
