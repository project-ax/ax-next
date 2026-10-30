import { describe, it, expect } from 'vitest';
import {
  filterToPolicy,
  findRunnerImmutableViolations,
  MEMORY_FACTS_EXPORT_ROOT,
  POLICY_EXACT_PATHS,
  POLICY_PREFIXES,
  RUNNER_IMMUTABLE_PREFIXES,
} from '../workspace-policy.js';
import type { FileChange } from '../workspace.js';

const put = (path: string): FileChange => ({
  path,
  kind: 'put',
  content: new Uint8Array([1]),
});
const del = (path: string): FileChange => ({ path, kind: 'delete' });

// ---------------------------------------------------------------------------
// These two lists answer different questions and must not be conflated:
// `filterToPolicy` decides what pre-apply subscribers SEE,
// `findRunnerImmutableViolations` decides what a runner-originated apply may
// CONTAIN. The first test below is the one that explains why the second list
// has to exist at all.
// ---------------------------------------------------------------------------

describe('workspace-policy — the facts export is NOT policy-visible', () => {
  it('filterToPolicy drops a write under the facts-export root', () => {
    // No `workspace:pre-apply` subscriber is ever handed this path, so no
    // subscriber can veto it — which is why the guard lives in the commit
    // handler and not in a validator plugin. If this assertion ever flips,
    // revisit whether the separate guard is still the right shape.
    expect(filterToPolicy([put('permanent/memory/facts/profile.md')])).toEqual([]);
  });

  it('the policy-visible set is unchanged by this card', () => {
    // Pinned because widening it has blast radius far outside the pre-apply
    // hook: @ax/agent-runner-core's `governed-paths.ts` re-roots every path
    // matching these constants into `/agent`.
    expect([...POLICY_PREFIXES]).toEqual(['.ax/', '.claude/']);
    expect([...POLICY_EXACT_PATHS].sort()).toEqual([
      'CLAUDE.local.md',
      'CLAUDE.md',
    ]);
  });
});

describe('findRunnerImmutableViolations', () => {
  it('returns nothing for an ordinary turn', () => {
    expect(
      findRunnerImmutableViolations([put('src/main.ts'), put('.ax/notes/a.md')]),
    ).toEqual([]);
  });

  it('leaves the agent-owned memory files alone', () => {
    // These are the agent's own files. Guarding `memory/**` wholesale would
    // refuse ordinary writes the runner ships.
    expect(
      findRunnerImmutableViolations([
        put('memory/system/user.md'),
        put('memory/system/recent.md'),
        put('memory/system/map.md'),
        put('memory/docs/entity/acme.md'),
        put('memory/inbox/2026-09-20.md'),
      ]),
    ).toEqual([]);
  });

  it('memory/system/rules.md is an ordinary path now (TASK-989)', () => {
    // Nothing reads the old Rules file any more: the people's Instructions
    // live in @ax/agents and reach the runner frozen in its session config,
    // so a runner write here is just a file, not a standing prompt line.
    const content = new Uint8Array([1]);
    expect(
      findRunnerImmutableViolations([
        { path: 'memory/system/rules.md', kind: 'put', content },
      ]),
    ).toEqual([]);
    expect(findRunnerImmutableViolations([del('memory/system/rules.md')])).toEqual([]);
  });

  it('de-duplicates and sorts, so discardPaths is stable', () => {
    expect(
      findRunnerImmutableViolations([
        put('permanent/memory/facts/user/b.md'),
        put('permanent/memory/facts/a.md'),
        del('permanent/memory/facts/user/b.md'),
      ]),
    ).toEqual(['permanent/memory/facts/a.md', 'permanent/memory/facts/user/b.md']);
  });
});

describe('runner-immutable facts-export subtree (TASK-494)', () => {
  it('names a put under the export root', () => {
    expect(
      findRunnerImmutableViolations([put('permanent/memory/facts/profile.md')]),
    ).toEqual(['permanent/memory/facts/profile.md']);
  });

  it('names a delete under the export root', () => {
    expect(
      findRunnerImmutableViolations([del('permanent/memory/facts/user/2026-09.md')]),
    ).toEqual(['permanent/memory/facts/user/2026-09.md']);
  });

  it('names a write that replaces the bare root itself', () => {
    expect(
      findRunnerImmutableViolations([put(MEMORY_FACTS_EXPORT_ROOT)]),
    ).toEqual([MEMORY_FACTS_EXPORT_ROOT]);
  });

  it('names puts and deletes that would replace a reserved ancestor directory', () => {
    expect(
      findRunnerImmutableViolations([
        put('permanent'),
        del('permanent/memory'),
        put('permanent/memory'),
      ]),
    ).toEqual(['permanent', 'permanent/memory']);
    expect(findRunnerImmutableViolations([put('permanent/other.md')])).toEqual([]);
  });

  it('leaves sibling subtrees alone', () => {
    expect(
      findRunnerImmutableViolations([
        put('permanent/memory/facts-backup/profile.md'),
        put('permanent/memory/system/user.md'),
        put('permanent/memory/factsx/x.md'),
      ]),
    ).toEqual([]);
  });

  it('still allows legitimate workspace writes alongside the root', () => {
    expect(
      findRunnerImmutableViolations([
        put('src/main.ts'),
        put('memory/system/user.md'),
      ]),
    ).toEqual([]);
  });

  it('exports the constants so consumers share one literal', () => {
    expect(MEMORY_FACTS_EXPORT_ROOT).toBe('permanent/memory/facts');
    expect([...RUNNER_IMMUTABLE_PREFIXES]).toEqual(['permanent/memory/facts/']);
  });
});
