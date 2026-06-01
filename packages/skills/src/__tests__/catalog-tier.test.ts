import { describe, it, expect } from 'vitest';
import { classifyTier } from '../catalog-tier.js';

describe('classifyTier', () => {
  it("a skill is always instruction-only ('inert') — TASK-100 removed the skill capability block", () => {
    // A skill manifest no longer declares any capabilities (its reach is the
    // connectors it references), so a skill's supply-chain tier is always inert.
    // The bounded/registry tiers now describe a CONNECTOR's reach, not a skill's.
    expect(classifyTier()).toBe('inert');
  });
});
