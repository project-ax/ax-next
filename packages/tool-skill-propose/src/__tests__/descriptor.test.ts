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

  it('carries the propose-time JIT hint (cap-skill prompts for a key; approve early from My Skills) — TASK-83', () => {
    const d = SKILL_PROPOSE_DESCRIPTOR.description ?? '';
    // The model must tell the user a cap-skill is waiting on their approval / a key.
    expect(d).toMatch(/key/i);
    expect(d).toMatch(/approv/i);
    // And point them at the early-approval affordance in the My Skills panel.
    expect(d).toMatch(/My Skills/);
  });

  it('documents the parser frontmatter contract (name, integer version, capabilities: nesting)', () => {
    // TASK-79: docs must match the skills-parser contract — `name` (NOT `id`),
    // an integer `version`, and capability keys nested under `capabilities:`.
    const d = SKILL_PROPOSE_DESCRIPTOR.description ?? '';
    expect(d).toMatch(/\bname\b/);
    expect(d).toMatch(/NOT "id"/);
    expect(d).toMatch(/INTEGER/);
    expect(d).toMatch(/capabilities:/);
    // The capability keys must be described as nested under capabilities:, not
    // top-level — the exact mismatch that caused the silent capability-loss bug.
    expect(d).toMatch(/nested UNDER capabilities:/i);
    // And it must NOT instruct the model to write a top-level `id` field as the
    // skill identifier (the old broken contract).
    expect(d).not.toMatch(/frontmatter \(id/);
  });
});
