import { describe, it, expect } from 'vitest';
import type { ToolDescriptor } from '@ax/core';
import { ToolListOutputSchema, ToolRegisterOutputSchema } from '../tool-dispatcher-plugin.js';

// ARCH-13 drift guard for the tool-dispatcher's `tool:register` / `tool:list`
// returns schemas. A fully-populated ToolDescriptor must round-trip without
// losing a field (the descriptor schema mirrors @ax/core's interface).

const descriptor: ToolDescriptor = {
  name: 'github__search',
  description: 'search GitHub',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  executesIn: 'sandbox',
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
});
