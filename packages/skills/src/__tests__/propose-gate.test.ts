import { describe, it, expect } from 'vitest';
import { classifyProposal } from '../propose-gate.js';

// TASK-100 — a skill manifest declares no capabilities (reach lives on the
// connectors it references), so the gate keys only on origin + scan. The old
// `hasAnyCapability` helper + capability-proposal axis were removed.

describe('classifyProposal — the materialization gate (origin + scan)', () => {
  it('FREE: clean + authored → active', () => {
    expect(classifyProposal({ origin: 'authored', scanClean: true })).toBe('active');
  });

  it('GATED: a non-authored origin → pending (provenance gate)', () => {
    expect(classifyProposal({ origin: 'imported', scanClean: true })).toBe('pending');
    expect(classifyProposal({ origin: 'attached', scanClean: true })).toBe('pending');
  });

  it('QUARANTINE: a scan hit quarantines regardless of provenance', () => {
    expect(classifyProposal({ origin: 'authored', scanClean: false })).toBe('quarantined');
    expect(classifyProposal({ origin: 'imported', scanClean: false })).toBe('quarantined');
  });
});
