import { describe, it, expect } from 'vitest';
import {
  filterToPolicy,
  findRunnerImmutableViolations,
  POLICY_EXACT_PATHS,
  POLICY_PREFIXES,
  RUNNER_IMMUTABLE_PATHS,
} from '../workspace-policy.js';
import type { FileChange } from '../workspace.js';

const put = (path: string): FileChange => ({
  path,
  kind: 'put',
  content: new Uint8Array([1]),
});
const del = (path: string): FileChange => ({ path, kind: 'delete' });

// ---------------------------------------------------------------------------
// TASK-486. These two lists answer different questions and must not be
// conflated: `filterToPolicy` decides what pre-apply subscribers SEE,
// `findRunnerImmutableViolations` decides what a runner-originated apply may
// CONTAIN. The first test below is the one that explains why the second list
// has to exist at all.
// ---------------------------------------------------------------------------

describe('workspace-policy — the human memory tier is NOT policy-visible', () => {
  it('filterToPolicy drops memory/system/rules.md', () => {
    // This is the hole. No `workspace:pre-apply` subscriber is ever handed
    // this path, so no subscriber can veto it — which is why the guard lives
    // in the commit handler and not in a validator plugin. If this assertion
    // ever flips, revisit whether the separate guard is still the right shape.
    expect(filterToPolicy([put('memory/system/rules.md')])).toEqual([]);
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
  it('names the human tier on a put', () => {
    expect(findRunnerImmutableViolations([put('memory/system/rules.md')])).toEqual([
      'memory/system/rules.md',
    ]);
  });

  it('names it on a delete as well', () => {
    expect(findRunnerImmutableViolations([del('memory/system/rules.md')])).toEqual([
      'memory/system/rules.md',
    ]);
  });

  it('returns nothing for an ordinary turn', () => {
    expect(
      findRunnerImmutableViolations([put('src/main.ts'), put('.ax/notes/a.md')]),
    ).toEqual([]);
  });

  it('leaves the agent-owned memory files alone', () => {
    // The consolidator rewrites these every pass; they are the agent's own
    // memory, not the human's. Guarding `memory/**` wholesale would refuse
    // every consolidation the runner ships.
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

  it('matches the exact path only — no prefix or suffix near-misses', () => {
    // `walkBundleChanges` emits canonical repo-relative posix paths, so an
    // exact-set match is the whole comparison. These neighbours are ordinary
    // files and must not be refused.
    expect(
      findRunnerImmutableViolations([
        put('memory/system/rules.md.bak'),
        put('memory/system/rules.mdx'),
        put('docs/memory/system/rules.md'),
        put('memory/system/rules'),
      ]),
    ).toEqual([]);
  });

  it('de-duplicates and sorts, so discardPaths is stable', () => {
    expect(
      findRunnerImmutableViolations([
        put('memory/system/rules.md'),
        del('memory/system/rules.md'),
      ]),
    ).toEqual(['memory/system/rules.md']);
  });

  it('exports the list so @ax/memory-strata can share the literal', () => {
    expect([...RUNNER_IMMUTABLE_PATHS]).toEqual(['memory/system/rules.md']);
  });
});
