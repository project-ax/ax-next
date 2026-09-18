import { describe, it, expect } from 'vitest';
import { agentScopeKey } from '../agent-scope-key.js';

// ---------------------------------------------------------------------------
// The lockstep tripwire (TASK-257).
//
// Three files in three packages carry the SAME derivation, because Invariant 2
// (no cross-plugin imports) forbids sharing the code:
//
//   packages/workspace-git-server/src/client/workspace-id.ts      (file tier)
//   packages/memory-strata-index-sqlite/src/agent-scope-key.ts    (this one)
//   packages/memory-strata-index-postgres/src/agent-scope-key.ts
//
// If they drift, the file tier and the index tier point at different
// partitions and an agent's memory stops lining up with its files.
//
// The docstring used to claim `runIndexContract`'s isolation case caught that
// drift. It did not, and we measured it: swapping this derivation for a
// completely different one left all 35 tests green, because that case varies
// userId AND agentId together and so passes under any partition containing
// either field.
//
// These pins are the enforcement that actually works. The VECTORS BELOW ARE
// IDENTICAL, input and digest, to the ones in the sibling packages' pin tests
// (`workspace-git-server`'s carry the `ws-` prefix; the digest after it is the
// same string). Change one copy of the derivation and its own pins go red, so
// nobody can move one file and leave the other two behind quietly.
// ---------------------------------------------------------------------------

/** `[agentId, expectedDigest]` — shared verbatim with the sibling packages. */
const PINNED: Array<readonly [string, string]> = [
  ['agent-1', 'e2dfc6a213659c6f'],
  ['agent-2', '98cfa09d216999cc'],
  ['', '055539df4a0b804c'],
  ['agent-x', 'f5a359a686fb6b08'],
  ['agent/with/slash', '5aea3d88f975c33b'],
  ['a","b', '3cd4f3fa4db91d4b'],
];

describe('agentScopeKey — pinned outputs (lockstep with the file tier)', () => {
  it.each(PINNED)('agentScopeKey({agentId: %j}) === %j', (agentId, expected) => {
    expect(agentScopeKey({ agentId })).toBe(expected);
  });
});

describe('agentScopeKey — partitions on agentId ALONE', () => {
  // The TASK-257 property, stated as an assertion rather than a comment.
  // Against the pre-TASK-257 derivation (`sha256([userId, agentId])`) this
  // FAILS: the two keys differed, which is exactly the bug — a teammate read
  // their own empty shard of a shared agent.
  it('ignores userId entirely: two callers on one agent share a partition', () => {
    const alice = agentScopeKey({ agentId: 'agent-1', userId: 'alice' } as {
      agentId: string;
    });
    const bob = agentScopeKey({ agentId: 'agent-1', userId: 'bob' } as {
      agentId: string;
    });
    expect(alice).toBe(bob);
    // And it is the same key a ctx with no userId at all produces — proof the
    // field is unread, not merely hashed to the same place by luck.
    expect(alice).toBe(agentScopeKey({ agentId: 'agent-1' }));
  });

  it('a hostile userId cannot move a caller into another partition', () => {
    // If userId still participated, any of these would key somewhere else.
    for (const userId of ['', '../../etc/passwd', 'a","b', '🦀', 'x'.repeat(1000)]) {
      expect(agentScopeKey({ agentId: 'agent-1', userId } as { agentId: string })).toBe(
        'e2dfc6a213659c6f',
      );
    }
  });

  it('still separates different agents', () => {
    expect(agentScopeKey({ agentId: 'agent-1' })).not.toBe(agentScopeKey({ agentId: 'agent-2' }));
  });

  it('is 16 lowercase hex chars', () => {
    for (const [agentId] of PINNED) {
      expect(agentScopeKey({ agentId })).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
