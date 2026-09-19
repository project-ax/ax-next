import { describe, it, expect } from 'vitest';
import { PENDING_SLOT as CONTRACT_PENDING_SLOT } from '@ax/memory-facts-contract';
import { PENDING_SLOT } from '../pending.js';

// `src/pending.ts` re-declares `PENDING_SLOT` instead of importing it, because
// `@ax/memory-facts-contract` ships the shared vitest suite and therefore
// depends on `vitest` at runtime — importing the CONSTANT from it would pull a
// test runner into this plugin's production graph, where `import type` costs
// nothing. That duplication is only safe if something notices when the two
// drift apart, which is what this file is.
//
// If it ever fails: the two backends have split-brained on the sentinel. One
// would write `pending` rows the other's drain cannot see, and `degraded`
// would read `[]` for a tenant that is very much degraded. Change both.
describe('PENDING_SLOT', () => {
  it('is spelled exactly as the contract spells it (Invariant 4)', () => {
    expect(PENDING_SLOT).toBe(CONTRACT_PENDING_SLOT);
  });
});
