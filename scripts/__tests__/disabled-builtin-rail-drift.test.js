// Guard: `@ax/tool-policy`'s four `builtins.*` deny rows must stay equal to the
// CROSS-RUNNER INTERSECTION — the tool names the claude-sdk runner disables that
// the aisdk runner also does not give an agent.
//
// Why this exists (TASK-245). `packages/tool-policy/src/rules.ts` hand-copies four
// names, and `rules.test.ts` "guarded" them by comparing them against its own
// literal — a closed loop that reads no runner and therefore notices nothing.
// `packages/agent-claude-sdk-runner/SECURITY.md:33` tells whoever upgrades the
// Claude Agent SDK to extend `DISABLED_BUILTINS` when a new built-in escapes the
// sandbox's intent. Before this guard, doing exactly that left the rail silently
// short a row and every test in the repo green.
//
// Why the rail is an INTERSECTION and not a copy of one runner's list: see
// `rules.ts` (the sandbox-floor comment). The rail is runner-agnostic — it
// describes what the agent may not do in any deployment — so it may only claim a
// deny that holds on every runner we ship. `TodoWrite` is the worked example: the
// aisdk runner does not register it (`tools/builtins.ts`, `builtins.test.ts`), but
// the claude-sdk runner leaves it enabled, so it is NOT a rail deny. Absent on one
// runner is a different fact from denied on both, and only the second belongs here.
//
// Why a SOURCE SCAN rather than importing the constants (TASK-245, decided by
// reading the code):
//
//   1. `DISABLED_BUILTINS` is not reachable from outside its package. The runner's
//      `exports` map is only `"."` -> `dist/main.js`, and `main.ts` re-exports only
//      the two runner-core executors. Importing it would mean adding a re-export or
//      an `exports` subpath — changing another package's public surface to serve a
//      test.
//   2. More decisively, an import CANNOT EXPRESS THIS ASSERTION AT ALL. The aisdk
//      half is not a constant: it is the complement of the `Record<string, Tool>`
//      that `buildBuiltinTools(opts)` returns, which needs a live policy and hold
//      latch. There is nothing importable to intersect against.
//
// A text scan costs zero dependency edges (invariant 2 stays untouched) and matches
// the established guard pattern in this directory, which CI runs unconditionally via
// `pnpm test:scripts` — see the sibling guards and `.claude/memory` patterns.
//
// This guard owns the NAME SET only. Each row's `id` and its human-facing
// `capability` clause are pinned deliberately and by hand — several are asserted
// from OUTSIDE tool-policy (channel-web's rail routes and components, `@ax/decisions`)
// — so nothing here generates or reformats them.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CLAUDE_SDK_TOOL_NAMES = join(
  REPO_ROOT,
  'packages/agent-claude-sdk-runner/src/tool-names.ts',
);
const AISDK_BUILTINS = join(
  REPO_ROOT,
  'packages/agent-aisdk-runner/src/tools/builtins.ts',
);
const RAIL_RULES = join(REPO_ROOT, 'packages/tool-policy/src/rules.ts');

/** Every single-quoted string inside a chunk of source, in order. */
function quotedStrings(chunk) {
  return [...chunk.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

/**
 * The claude-sdk runner's deny list: the `DISABLED_BUILTINS` array literal.
 * Enforced at `main.ts` via `disallowedTools` and refused again at both
 * refusal sites — this is the real enforcement, and the rail only describes it.
 */
function claudeSdkDisabledBuiltins() {
  const src = readFileSync(CLAUDE_SDK_TOOL_NAMES, 'utf8');
  const literal = /export const DISABLED_BUILTINS\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!literal) {
    throw new Error(
      `Could not find the \`export const DISABLED_BUILTINS = [...]\` literal in ` +
        `${CLAUDE_SDK_TOOL_NAMES}. If it was renamed or reshaped, update this guard — ` +
        `do not delete it: it is the only thing that notices the rail falling behind.`,
    );
  }
  return quotedStrings(literal[1]);
}

/**
 * The six sandbox built-ins the aisdk runner registers IN THIS FILE, read from the
 * object `buildBuiltinTools` returns (`    Name: tool({`).
 *
 * NOT the runner's whole tool set, and this guard's one modelling assumption. That
 * runner merges three more sources in `main.ts` — the host catalog, the sandbox
 * catalog, and the `Skill` tool — none of which this scan sees. The assertion below
 * is still sound because it only ever asks about names in the claude-sdk runner's
 * `DISABLED_BUILTINS`, and the catalog tools are ax-native snake_case names that
 * cannot collide with an SDK built-in's PascalCase.
 *
 * `Skill` is the live counterexample, so it is worth naming: it IS PascalCase, it
 * IS registered by that runner (outside this file), and it USED to sit in
 * `DISABLED_BUILTINS`. If it were ever put back, this guard would compute the
 * intersection wrongly and ask for a `builtins.skill` deny row that should not
 * exist. It stays out by a stronger pin than this one — `tool-names.test.ts` and
 * `main.test.ts` assert `Skill` is NOT disabled (I-P0-1) — but a future name
 * registered outside `buildBuiltinTools` would need this scan widened, not trusted.
 */
function aisdkRegisteredBuiltins() {
  const src = readFileSync(AISDK_BUILTINS, 'utf8');
  const names = [...src.matchAll(/^ {4}([A-Z][A-Za-z0-9_]*):\s*tool\(\{/gm)].map((m) => m[1]);
  if (names.length === 0) {
    // Fail here rather than let an empty set through: an empty set collapses the
    // intersection onto the full claude-sdk list, which is what the rail already
    // says. The comparison below would then go GREEN while guarding nothing.
    throw new Error(
      `Found no \`    Name: tool({\` entries in ${AISDK_BUILTINS}. The registered-tool ` +
        `object was reformatted or reshaped — update this guard's parser. Do not delete ` +
        `it: an empty parse here is exactly what would make this guard pass vacuously.`,
    );
  }
  return names;
}

/**
 * The rail's disabled-builtin deny rows: for every rule whose `id` starts
 * `builtins.`, the tool name it matches on.
 */
function railBuiltinDenyToolNames() {
  const src = readFileSync(RAIL_RULES, 'utf8');
  const ids = [...src.matchAll(/id: '(builtins\.[^']+)'/g)];
  return ids.map((match, i) => {
    // The rule object runs from its `id` to the next rule's `id` (or end of file).
    const start = match.index;
    const end = i + 1 < ids.length ? ids[i + 1].index : src.length;
    const block = src.slice(start, end);
    const tool = /\btool: '([^']+)'/.exec(block);
    if (!tool) {
      throw new Error(
        `Rail rule \`${match[1]}\` in ${RAIL_RULES} has no \`tool: '...'\` in its ` +
          `\`match\`. This guard reads the rule table as text; if the table's shape ` +
          `changed, update the parser.`,
      );
    }
    return tool[1];
  });
}

const sorted = (names) => [...new Set(names)].sort();

describe('tool-policy rail vs the runners — disabled-builtin drift', () => {
  // Read once. A parse that silently finds NOTHING is the failure mode that would
  // make this whole guard vacuous (an empty aisdk set makes the intersection equal
  // the claude-sdk list, which is exactly what the rail already says — so the
  // comparison below would pass while guarding nothing). Every parse is therefore
  // proved non-empty before anything is compared.
  const claudeSdkDisabled = claudeSdkDisabledBuiltins();
  const aisdkRegistered = aisdkRegisteredBuiltins();
  const railDenied = railBuiltinDenyToolNames();

  it('parsed real data out of all three files', () => {
    expect(claudeSdkDisabled.length, 'claude-sdk DISABLED_BUILTINS names').toBeGreaterThan(0);
    for (const name of claudeSdkDisabled) {
      expect(name, 'DISABLED_BUILTINS entry').toMatch(/^[A-Z][A-Za-z0-9_]*$/);
    }

    // The aisdk runner registers Bash, Read, Write, Edit, Glob, Grep. Asserted as a
    // floor plus one anchor rather than an exact list, so that runner gaining a
    // seventh tool does not fail HERE — it fails below only if the new tool is one
    // the rail claims is denied everywhere. `builtins.test.ts` owns the exact list.
    expect(aisdkRegistered.length, 'aisdk registered built-ins').toBeGreaterThanOrEqual(6);
    expect(aisdkRegistered, 'aisdk registered built-ins').toContain('Bash');

    expect(railDenied.length, 'rail builtins.* deny rows').toBeGreaterThan(0);
  });

  it('the rail denies exactly the names BOTH runners keep from the agent', () => {
    const registered = new Set(aisdkRegistered);
    const intersection = claudeSdkDisabled.filter((name) => !registered.has(name));

    expect(
      // NOT deduped: two `builtins.*` rows matching the same tool is itself a
      // defect, and `sorted()` would hide it behind a set.
      [...railDenied].sort(),
      'The rail\'s `builtins.*` deny rows have drifted from the runners.\n' +
        'The rail may only deny a tool BOTH runners keep from the agent: a name the ' +
        'claude-sdk runner lists in `DISABLED_BUILTINS` AND the aisdk runner does not ' +
        'register.\n' +
        `  claude-sdk DISABLED_BUILTINS: ${sorted(claudeSdkDisabled).join(', ')}\n` +
        `  aisdk registers:              ${sorted(aisdkRegistered).join(', ')}\n` +
        `  => expected rail deny rows:   ${sorted(intersection).join(', ') || '(none)'}\n` +
        `  actual rail deny rows:        ${[...railDenied].sort().join(', ') || '(none)'}\n` +
        'Fix the RAIL, not this test: add or remove a `builtins.*` row in ' +
        'packages/tool-policy/src/rules.ts, writing its `id` and its human-facing ' +
        '`capability` clause BY HAND (`capability-lint.ts` will reject generated prose, ' +
        'and ids are asserted from outside tool-policy). If a name is disabled on one ' +
        'runner but registered on the other, it does NOT belong on the rail.',
    ).toEqual(sorted(intersection));
  });
});
