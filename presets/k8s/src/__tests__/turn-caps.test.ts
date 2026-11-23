import { describe, expect, it } from 'vitest';
import { checkNodeFit, checkTurnCaps } from '../turn-caps.js';

describe('checkTurnCaps', () => {
  it('refuses a turn cap within 20 min of the pod ceiling', () => {
    // 6 h pod: 120 min + 20 min is fine; 340 min + 20 min is exactly the ceiling.
    expect(() => checkTurnCaps({ maxTurnMinutes: 120, activeDeadlineSeconds: 21600 })).not.toThrow();
    expect(() => checkTurnCaps({ maxTurnMinutes: 340, activeDeadlineSeconds: 21600 })).not.toThrow();
    expect(() => checkTurnCaps({ maxTurnMinutes: 341, activeDeadlineSeconds: 21600 })).toThrow(
      /maxTurnMinutes=341/,
    );
    expect(() => checkTurnCaps({ maxTurnMinutes: 120, activeDeadlineSeconds: 7200 })).toThrow(/20 minutes/);
  });
});

describe('checkNodeFit', () => {
  it('node-fit warns when runner max plus a service set exceeds the node', () => {
    const w = checkNodeFit({ runnerMaxMiB: 16384, largestServiceSetMiB: 3072, nodeAllocatableMiB: 12000 });
    expect(w).toMatch(/19456 MiB/);
    expect(w).toMatch(/12000 MiB/);
  });
  it('is quiet when it fits, or when the node size is unknown', () => {
    expect(checkNodeFit({ runnerMaxMiB: 8192, largestServiceSetMiB: 3072, nodeAllocatableMiB: 12000 })).toBeNull();
    expect(checkNodeFit({ runnerMaxMiB: 16384, largestServiceSetMiB: 3072 })).toBeNull();
  });
});
