import { describe, it, expect } from 'vitest';
import { SKILL_PROPOSE_DESCRIPTOR, SKILL_PROPOSE_TOOL_NAME } from '../descriptor.js';

describe('SKILL_PROPOSE_DESCRIPTOR', () => {
  it('is a sandbox tool named skill_propose with a path input', () => {
    expect(SKILL_PROPOSE_DESCRIPTOR.name).toBe(SKILL_PROPOSE_TOOL_NAME);
    expect(SKILL_PROPOSE_TOOL_NAME).toBe('skill_propose');
    expect(SKILL_PROPOSE_DESCRIPTOR.executesIn).toBe('sandbox');
    const props = SKILL_PROPOSE_DESCRIPTOR.inputSchema.properties as Record<string, unknown>;
    expect(props.path).toBeDefined();
    expect(SKILL_PROPOSE_DESCRIPTOR.inputSchema.required).toContain('path');
  });

  it('carries the spawn-time-discovery guidance (next-turn availability, do not invoke now)', () => {
    const d = SKILL_PROPOSE_DESCRIPTOR.description ?? '';
    expect(d).toMatch(/next turn|next message/i);
    expect(d).toMatch(/not.*invoke it now|Do not try to invoke it now/i);
  });

  it('carries the propose-time JIT hint (reach comes from connectors; approval/key)', () => {
    const d = SKILL_PROPOSE_DESCRIPTOR.description ?? '';
    // The model must tell the user about approval / a key when reach is involved.
    expect(d).toMatch(/key/i);
    expect(d).toMatch(/approv/i);
  });

  it('documents the cap-free frontmatter contract (name, integer version, connectors[]; NO capabilities block) — TASK-100', () => {
    const d = SKILL_PROPOSE_DESCRIPTOR.description ?? '';
    expect(d).toMatch(/\bname\b/);
    expect(d).toMatch(/NOT "id"/);
    expect(d).toMatch(/INTEGER/);
    // The model references connectors, not a capabilities block.
    expect(d).toMatch(/connectors:/);
    expect(d).toMatch(/connector_propose|ax-connector-creator/);
    // It must STEER AWAY from writing a capabilities block (rejected now).
    expect(d).toMatch(/not write a "?capabilities"? block|REJECTED/i);
  });
});
