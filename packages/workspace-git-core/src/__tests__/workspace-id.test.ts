// Pinned outputs for `workspaceIdForAgent`.
//
// Two things are load-bearing about this derivation and neither is obvious
// from reading it:
//
//  1. It NAMES A DIRECTORY ON DISK. Change the formula and every existing
//     deployment's workspaces are orphaned — each agent silently starts from
//     an empty tree, with its history still sitting in a directory nothing
//     looks at any more. The pinned values below are what make that show up
//     as a failing test rather than as a support ticket.
//
//  2. It is a byte-for-byte copy of `@ax/workspace-git-server`'s
//     `workspaceIdFor` (Invariant 2 forbids importing it). The vectors in
//     `pins the same outputs as the sharded backend` below are copied
//     verbatim from `workspace-git-server/src/client/__tests__/workspace-id.test.ts`,
//     so if either derivation drifts, one of the two suites goes red. That is
//     the only mechanism keeping two hand-copied functions honest. The same
//     vectors are pinned a third and fourth time by the `agent-scope-key`
//     suites in `@ax/memory-strata-index-{sqlite,postgres}`.

import { describe, it, expect } from 'vitest';
import { workspaceIdForAgent } from '../impl.js';

describe('workspaceIdForAgent', () => {
  it('pins the same outputs as the sharded backend', () => {
    // Copied verbatim from
    // `workspace-git-server/src/client/__tests__/workspace-id.test.ts`.
    const vectors: ReadonlyArray<readonly [string, string]> = [
      ['agent-1', 'ws-e2dfc6a213659c6f'],
      ['agent-2', 'ws-98cfa09d216999cc'],
      // The sharded backend pins the empty agentId too. Note what it means
      // there and what it means here: on that backend an identity-less caller
      // would land on this id. Here the derivation agrees, and then
      // `requireAgent` refuses to call it at all — the id is unreachable from
      // any hook. Keeping the vector pinned documents that the difference is
      // the GATE, not the formula. (See `tenant-isolation.test.ts`.)
      ['', 'ws-055539df4a0b804c'],
      ['agent-x', 'ws-f5a359a686fb6b08'],
      ['agent/with/slash', 'ws-5aea3d88f975c33b'],
      ['a","b', 'ws-3cd4f3fa4db91d4b'],
    ];
    for (const [agentId, expected] of vectors) {
      expect(workspaceIdForAgent(agentId)).toBe(expected);
    }
  });

  it('is filesystem-safe: lowercase hex after a fixed prefix', () => {
    for (const agentId of [
      'agent/../escape',
      '../../etc/passwd',
      'agent\u0000null',
      'agent\n',
      '\u{1f642}',
      'a'.repeat(10_000),
    ]) {
      expect(workspaceIdForAgent(agentId)).toMatch(/^ws-[0-9a-f]{16}$/);
    }
  });

  it('does not collide agentIds a naive encoding would', () => {
    // The JSON encoding is what keeps quote- and bracket-shaped agentIds from
    // bleeding into each other's keys. On this backend a collision is two
    // agents sharing a tree, which is the bug this package just fixed.
    expect(workspaceIdForAgent('a')).not.toBe(workspaceIdForAgent('"a"'));
    expect(workspaceIdForAgent('ab')).not.toBe(workspaceIdForAgent('a","b'));
  });

  it('is stable, and keyed on agentId ALONE', () => {
    expect(workspaceIdForAgent('a')).toBe(workspaceIdForAgent('a'));
    expect(workspaceIdForAgent('a')).not.toBe(workspaceIdForAgent('b'));
    // There is no userId axis to vary — that is the TASK-257 policy, restated
    // here so a future edit that re-introduces one fails a test rather than
    // quietly diverging from `@ax/workspace-git-server`.
    expect(workspaceIdForAgent.length).toBe(1);
  });
});
