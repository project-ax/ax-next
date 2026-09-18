// Pinned outputs for `workspaceIdForOwner`.
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
//     the only mechanism keeping two hand-copied functions honest.
//
// The collision cases are the reason for the JSON encoding rather than a
// separator: on a backend where the id is the tenancy boundary, a collision
// is two users in one tree.

import { describe, it, expect } from 'vitest';
import { workspaceIdForOwner } from '../impl.js';

describe('workspaceIdForOwner', () => {
  it('pins the same outputs as the sharded backend', () => {
    // Copied verbatim from
    // `workspace-git-server/src/client/__tests__/workspace-id.test.ts`.
    const vectors: ReadonlyArray<readonly [string, string, string]> = [
      ['alice', 'agent-1', 'ws-b52f388c1eeab23a'],
      ['bob', 'agent-1', 'ws-caa39e8797572264'],
      ['alice', 'agent-2', 'ws-aed0e26a737ff75c'],
      // The sharded backend pins this pair too. Note what it means there and
      // what it means here: on that backend an identity-less caller gets this
      // shard, which is a shared bucket. Here the derivation agrees, and then
      // `requireOwner` refuses to call it — the id is never reached. Keeping
      // the vector pinned documents that the difference is the GATE, not the
      // formula. (See `tenant-isolation.test.ts`.)
      ['', '', 'ws-439083f38956ba51'],
      ['user-with-/-slash', 'agent-x', 'ws-c9dfda14c01efcac'],
    ];
    for (const [userId, agentId, expected] of vectors) {
      expect(workspaceIdForOwner(userId, agentId)).toBe(expected);
    }
  });

  it('is filesystem-safe: lowercase hex after a fixed prefix', () => {
    for (const [u, a] of [
      ['user/../escape', 'agent'],
      ['user', '../../etc/passwd'],
      ['user\u0000null', 'agent\n'],
      ['\u{1f642}', '\u{1f642}'],
    ] as const) {
      expect(workspaceIdForOwner(u, a)).toMatch(/^ws-[0-9a-f]{16}$/);
    }
  });

  it('does not collide pairs a separator-based encoding would', () => {
    // `userId + '/' + agentId` maps both of these to "a/b/c".
    expect(workspaceIdForOwner('a', 'b/c')).not.toBe(workspaceIdForOwner('a/b', 'c'));
  });

  it('is stable and distinct across the axes that matter', () => {
    expect(workspaceIdForOwner('u', 'a')).toBe(workspaceIdForOwner('u', 'a'));
    expect(workspaceIdForOwner('u', 'a')).not.toBe(workspaceIdForOwner('u', 'b'));
    expect(workspaceIdForOwner('u', 'a')).not.toBe(workspaceIdForOwner('v', 'a'));
  });
});
