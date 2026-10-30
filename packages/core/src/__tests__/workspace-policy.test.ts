import { describe, it, expect } from 'vitest';
import * as core from '../index.js';
import {
  filterToPolicy,
  POLICY_EXACT_PATHS,
  POLICY_PREFIXES,
} from '../workspace-policy.js';
import type { FileChange } from '../workspace.js';

const put = (path: string): FileChange => ({
  path,
  kind: 'put',
  content: new Uint8Array([1]),
});

describe('workspace-policy', () => {
  it('filterToPolicy drops a write under the old facts-export path', () => {
    // Not policy-visible, and no longer guarded either: since TASK-991 the
    // host writes the facts export only to the read-only `/memory` volume, so
    // `permanent/memory/facts/**` in a workspace is an ordinary agent path.
    expect(filterToPolicy([put('permanent/memory/facts/profile.md')])).toEqual([]);
  });

  it('the policy-visible set is unchanged', () => {
    // Pinned because widening it has blast radius far outside the pre-apply
    // hook: @ax/agent-runner-core's `governed-paths.ts` re-roots every path
    // matching these constants into `/agent`.
    expect([...POLICY_PREFIXES]).toEqual(['.ax/', '.claude/']);
    expect([...POLICY_EXACT_PATHS].sort()).toEqual([
      'CLAUDE.local.md',
      'CLAUDE.md',
    ]);
  });

  it('the runner-immutable guard is gone, not kept empty (TASK-989, TASK-991)', () => {
    // Both paths it guarded left the workspace (the Rules file, then the facts
    // export). A check that can never fire is half-wired code, so the kernel
    // exports none of it.
    expect(core).not.toHaveProperty('findRunnerImmutableViolations');
    expect(core).not.toHaveProperty('RUNNER_IMMUTABLE_PREFIXES');
    expect(core).not.toHaveProperty('RUNNER_IMMUTABLE_PATHS');
  });

  it('the facts-export layout constant lives in @ax/sandbox-protocol only (TASK-991)', () => {
    // One literal, one home (invariant 4): the volume writer and the mount
    // resolvers import it from @ax/sandbox-protocol.
    expect(core).not.toHaveProperty('MEMORY_FACTS_EXPORT_ROOT');
  });
});
