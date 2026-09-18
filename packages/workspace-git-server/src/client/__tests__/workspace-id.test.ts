import { describe, it, expect } from 'vitest';
import { workspaceIdFor } from '../workspace-id.js';
import { WORKSPACE_ID_REGEX } from '../../shared/workspace-id.js';

// 100 hand-chosen (userId, agentId) pairs covering ASCII, unicode, very long,
// empty-ish, and adversarial-looking inputs. All must produce a workspaceId
// that satisfies WORKSPACE_ID_REGEX.
//
// Since TASK-257 only the agentId is hashed, so what these mainly exercise is
// 100 adversarial AGENT ids. The userId column is retained because it keeps
// the userId-invariance cases below honest: every pair is also a case where a
// wildly different userId must not move the answer.
const REGEX_CASES: Array<readonly [string, string]> = [
  ['', ''],
  ['a', ''],
  ['', 'a'],
  ['a', 'a'],
  ['alice', 'agent-1'],
  ['bob', 'agent-2'],
  ['user_1', 'agent_1'],
  ['user-1', 'agent-1'],
  ['USER', 'AGENT'],
  ['1', '2'],
  ['0', '0'],
  ['00000000', '00000000'],
  ['user@example.com', 'agent.zero'],
  ['user+tag@example.com', 'agent/sub'],
  ['user with spaces', 'agent with spaces'],
  ['user\twith\ttabs', 'agent\twith\ttabs'],
  ['user\nwith\nnewlines', 'agent\nwith\nnewlines'],
  ['user\rwith\rcr', 'agent\rwith\rcr'],
  ['user\x00with\x00nul', 'agent\x00with\x00nul'],
  ['user/with/slash', 'agent/with/slash'],
  ['user\\with\\backslash', 'agent\\with\\backslash'],
  ['user.with.dots', 'agent.with.dots'],
  ['user..parent', 'agent..parent'],
  ['../etc/passwd', '../../etc/shadow'],
  ['user;rm -rf /', 'agent;reboot'],
  ['user`whoami`', 'agent$(id)'],
  ['user${PATH}', 'agent${HOME}'],
  ['user|pipe', 'agent|pipe'],
  ['user&amp;', 'agent&lt;'],
  ['user<script>', 'agent</script>'],
  ['user​zwsp', 'agent​zwsp'],
  ['user﻿bom', 'agent﻿bom'],
  ['ünïcødé', 'âgéñt'],
  ['日本語ユーザー', 'エージェント'],
  ['用户', '智能体'],
  ['пользователь', 'агент'],
  ['🦀nervous-crab🦀', '🤖agent🤖'],
  ['👨‍👩‍👧‍👦family', '🏳️‍🌈agent'],
  ['user\u{1f4a9}', 'agent\u{1f4a9}'],
  ['Ω', 'π'],
  ['ß', 'ẞ'],
  ['İstanbul', 'ankara'],
  ['α'.repeat(10), 'β'.repeat(10)],
  ['a'.repeat(100), 'b'.repeat(100)],
  ['a'.repeat(1000), 'b'.repeat(1000)],
  ['a'.repeat(10_000), 'b'.repeat(10_000)],
  ['x'.repeat(64), 'y'.repeat(64)],
  ['x'.repeat(63), 'y'.repeat(63)],
  ['x'.repeat(65), 'y'.repeat(65)],
  ['user-' + 'a'.repeat(50), 'agent-' + 'b'.repeat(50)],
  ['leading space', 'trailing space '],
  ['  doubled  ', '  doubled  '],
  ['CamelCase', 'kebab-case'],
  ['snake_case', 'PascalCase'],
  ['SCREAMING_SNAKE', 'lower_snake'],
  ['mixed-Case_With.Stuff', 'another_Mixed-thing'],
  ['email+tag@example.co.uk', 'agent.v1.0.0'],
  ['v1.2.3-beta', 'v0.0.0-alpha+build.1'],
  ['user.with.many.dots.indeed', 'agent.with.many.dots.indeed'],
  ['user~tilde', 'agent~tilde'],
  ['user!bang', 'agent!bang'],
  ['user?q=1', 'agent?q=2'],
  ['user#hash', 'agent#hash'],
  ['user[bracket]', 'agent[bracket]'],
  ['user{brace}', 'agent{brace}'],
  ['user(paren)', 'agent(paren)'],
  ['user,comma', 'agent,comma'],
  ['user:colon', 'agent:colon'],
  ['user=equals', 'agent=equals'],
  ['user"quote', 'agent"quote'],
  ["user'apos", "agent'apos"],
  ['user%20', 'agent%2F'],
  ['file:///etc/passwd', 'http://evil.example/'],
  ['javascript:alert(1)', 'data:text/html,<x>'],
  ['\u0000', '\u0000'],
  ['', ''],
  ['', ''],
  ['', ''],
  ['￿', '￿'],
  ['\u{10ffff}', '\u{10ffff}'],
  ['surrogate-\ud83d-only', 'surrogate-\ude00-only'],
  ['null-literal', 'undefined-literal'],
  ['true', 'false'],
  ['{"json":"object"}', '[1,2,3]'],
  ['<xml/>', '</xml>'],
  ['SELECT * FROM users', "DROP TABLE agents;--"],
  ['user OR 1=1', "agent' OR '1'='1"],
  ['~root', '/proc/self/environ'],
  ['/dev/null', '/dev/zero'],
  ['$SHELL', '$IFS'],
  ['user.id', 'agent.id'],
  ['localhost', '127.0.0.1'],
  ['::1', 'fe80::1'],
  ['user:443', 'agent:8080'],
  ['uuid-' + 'f'.repeat(32), 'uuid-' + '0'.repeat(32)],
  ['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
  ['anon', 'agent-anon'],
  ['svc-account@project.iam.gserviceaccount.com', 'agent-prod'],
  ['org/team/user', 'agent/group/sub'],
  ['🌟', '✨'],
];

describe('workspaceIdFor — determinism', () => {
  it('returns the same value across 1000 calls', () => {
    const first = workspaceIdFor({ agentId: 'a' });
    for (let i = 0; i < 1000; i++) {
      expect(workspaceIdFor({ agentId: 'a' })).toBe(first);
    }
  });
});

describe('workspaceIdFor — regex match', () => {
  it('all 100 hand-chosen pairs produce a value matching WORKSPACE_ID_REGEX', () => {
    expect(REGEX_CASES.length).toBe(100);
    for (const [userId, agentId] of REGEX_CASES) {
      const id = workspaceIdFor({ agentId, userId } as { agentId: string });
      expect(WORKSPACE_ID_REGEX.test(id)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// TASK-257: the workspaceId partitions on agentId ALONE.
//
// This block replaces a case that asserted the OPPOSITE — "different userId
// with same agentId yields different workspaceIds". That was the bug: a team
// agent's files were invisible to every teammate, because each caller hashed
// into their own empty shard. One agent, one workspace.
//
// Every assertion here FAILS against the pre-TASK-257 derivation
// `sha256(JSON.stringify([userId, agentId]))`, which is what makes them worth
// having.
// ---------------------------------------------------------------------------
describe('workspaceIdFor — partitions on agentId alone', () => {
  it('two different users on the same agent get the SAME workspaceId', () => {
    expect(workspaceIdFor({ agentId: 'a', userId: 'u1' } as { agentId: string })).toBe(
      workspaceIdFor({ agentId: 'a', userId: 'u2' } as { agentId: string }),
    );
  });

  it('the userId field is unread, not merely collided', () => {
    // Same answer as a ctx that has no userId property at all — so the field
    // is not participating in the digest by any route.
    const bare = workspaceIdFor({ agentId: 'a' });
    expect(workspaceIdFor({ agentId: 'a', userId: 'u1' } as { agentId: string })).toBe(bare);
  });

  it('a hostile userId cannot steer a caller to another workspace', () => {
    // Under the old derivation each of these produced a DIFFERENT repo.
    const expected = workspaceIdFor({ agentId: 'agent-1' });
    for (const userId of ['', '../../etc/passwd', 'a","b', '🦀', 'x'.repeat(10_000)]) {
      expect(workspaceIdFor({ agentId: 'agent-1', userId } as { agentId: string })).toBe(expected);
    }
  });

  it('every one of the 100 adversarial pairs is userId-invariant', () => {
    for (const [userId, agentId] of REGEX_CASES) {
      expect(workspaceIdFor({ agentId, userId } as { agentId: string })).toBe(
        workspaceIdFor({ agentId }),
      );
    }
  });
});

describe('workspaceIdFor — distinct', () => {
  it('different agentId yields different workspaceIds', () => {
    expect(workspaceIdFor({ agentId: 'a1' })).not.toBe(workspaceIdFor({ agentId: 'a2' }));
  });

  it('agentIds differing only by a separator-shaped character do not collide', () => {
    // The old two-field encoding needed JSON.stringify to stop (a, b/c) and
    // (a/b, c) hashing alike. With one field there is no pair to confuse, but
    // distinct agentIds must still land in distinct repos — including ones
    // whose difference is entirely punctuation.
    const ids = ['a/b', 'a//b', 'a\\b', 'a"b', 'a","b', 'a', 'ab'].map((agentId) =>
      workspaceIdFor({ agentId }),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('workspaceIdFor — pinned outputs', () => {
  // These are the load-bearing test cases. They pin the exact derivation:
  //   ws- + first 16 hex chars of sha256(JSON.stringify([agentId]))
  // If SHA-256 ever changes, or the encoding changes, or the prefix/length
  // changes, these will fail loudly. That's the point — silent drift would
  // orphan every existing workspace's bare repo on the storage tier. (The
  // TASK-257 repartition orphaned them ON PURPOSE, once, on 2026-09-17; see
  // the docstring on `workspaceIdFor`. Stability is load-bearing again now.)
  //
  // ⚠ LOCKSTEP: the 16 hex chars after `ws-` are the SAME strings, over the
  // same agentIds, as the pins in
  //   packages/memory-strata-index-sqlite/src/__tests__/agent-scope-key.test.ts
  //   packages/memory-strata-index-postgres/src/__tests__/agent-scope-key.test.ts
  // because the memory index must partition exactly like the file tier and
  // Invariant 2 forbids sharing the code. Editing any one of the three copies
  // fails that copy's pins, which is the only thing that actually keeps them
  // together.
  it.each([
    ['agent-1', 'ws-e2dfc6a213659c6f'],
    ['agent-2', 'ws-98cfa09d216999cc'],
    ['', 'ws-055539df4a0b804c'],
    ['agent-x', 'ws-f5a359a686fb6b08'],
    ['agent/with/slash', 'ws-5aea3d88f975c33b'],
    ['a","b', 'ws-3cd4f3fa4db91d4b'],
  ])('workspaceIdFor({agentId: %j}) === %j', (agentId, expected) => {
    expect(workspaceIdFor({ agentId })).toBe(expected);
  });
});
