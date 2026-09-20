import { describe, it, expect } from 'vitest';
import { agentScopeKey } from '../agent-scope-key.js';

// ---------------------------------------------------------------------------
// The lockstep tripwire (TASK-257 pattern, applied to TASK-423).
//
// This derivation is byte-for-byte identical to the sibling copies in:
//
//   packages/workspace-git-server/src/client/workspace-id.ts      (file tier)
//   packages/memory-strata-index-sqlite/src/agent-scope-key.ts    (index tier)
//   packages/memory-strata-index-postgres/src/agent-scope-key.ts
//   packages/memory-facts-sqlite/src/agent-scope-key.ts           (this engine's twin)
//
// because Invariant 2 (no cross-plugin imports) forbids sharing the code. If
// they drift, this engine's partition stops lining up with the index/file
// tiers for the same agent — and, worse for THIS backend, with its own sqlite
// twin, so a deployment that moved from the CLI to k8s would read an empty
// memory rather than its own.
//
// The VECTORS BELOW ARE IDENTICAL, input and digest, to the ones in the
// sibling packages' pin tests. Change this copy of the derivation and its
// own pins go red, so nobody can move one file and leave the others behind
// quietly.
//
// Why pins and not the contract: `runFactsContract`'s isolation cases vary
// userId AND agentId together, so they pass under ANY partition containing
// either field. That was measured on TASK-257 — replacing the derivation
// wholesale left every contract case green. The pins are the only thing here
// that can fail on derivation drift.
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

describe('agentScopeKey — pinned outputs (lockstep with the sqlite twin and the index/file tiers)', () => {
  it.each(PINNED)('agentScopeKey({agentId: %j}) === %j', (agentId, expected) => {
    expect(agentScopeKey({ agentId })).toBe(expected);
  });
});

describe('agentScopeKey — partitions on agentId ALONE', () => {
  it('ignores userId entirely: two callers on one agent share a partition', () => {
    const alice = agentScopeKey({ agentId: 'agent-1', userId: 'alice' } as {
      agentId: string;
    });
    const bob = agentScopeKey({ agentId: 'agent-1', userId: 'bob' } as {
      agentId: string;
    });
    expect(alice).toBe(bob);
    expect(alice).toBe(agentScopeKey({ agentId: 'agent-1' }));
  });

  it('a hostile userId cannot move a caller into another partition', () => {
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
