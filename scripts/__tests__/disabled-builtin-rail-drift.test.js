// Guard: every SDK built-in that BOTH runners keep from the agent is accounted
// for on `@ax/tool-policy`'s rail. Each one is either a `builtins.*` deny row in
// `packages/tool-policy/src/rules.ts`, or an `OFF_RAIL` entry below with a
// written reason it has no row. Never both, never neither.
//
// WHY THIS EXISTS (TASK-245). `rules.ts` writes its deny rows by hand, and
// `rules.test.ts` used to "guard" them by comparing them with its own literal:
// a closed loop that read no runner and so noticed nothing. Extending the
// runner's denied list left the rail silently short a row, with every test in
// the repo green.
//
// WHY IT WAS WIDENED (TASK-1207). Until then this guard compared the rail with
// `DISABLED_BUILTINS`, the claude-sdk runner's four named denials. TASK-1200
// turned that runner into an allowlist: it keeps every SDK built-in outside
// `ALLOWED_SDK_BUILTINS` from the agent, about twenty more names, and this guard
// saw none of them. It now reads the whole denied set, recomputed the way
// `DENIED_SDK_BUILTINS` computes it. That constant is an expression, not a
// literal, so it cannot be read as text; the three literals it is built from
// can.
//
// WHY SOME DENIED NAMES GET NO ROW. A deny row renders as "Cannot <clause>", and
// that sentence has to be true. For some denied built-ins it would not be:
// Monitor, TaskOutput and TaskStop are denied, but Bash and Read still do the
// same jobs; NotebookEdit is denied, but Edit and Write still change a notebook.
// A "Cannot" there understates reach, the one direction design H4 forbids.
// The same standard sets the wording of the row a name DOES get. The scheduling
// row says "Cannot schedule things with its built-in timer instead of a
// routine", not "Cannot schedule work for later" or "Cannot set itself to run
// again later". Bash `run_in_background` stays, and the task-notification it
// sends when the command finishes wakes the model for another turn while the
// runner is still warm; a shell `(sleep N; ...) &` and a connector's own API
// can still start work that runs later too. What is gone is the CLI's built-in
// scheduler: its tools (CronCreate, CronDelete, CronList, ScheduleWakeup,
// RemoteTrigger) are off the allowlist, and its headless cron loop, which would
// otherwise run prompts planted in `<cwd>/.claude/scheduled_tasks.json` with no
// tool call, is switched off by CLAUDE_CODE_DISABLE_CRON in the claude-sdk
// runner's env floor (`bundled-skills-env.ts`). This guard sees only the first
// half; the runner's `cron-scheduler-real-sdk.e2e.test.ts` pins the second.
// Others are aliases or companions of a row that already says it (`Agent` is
// `Task` on the wire; CronList lists entries in the CLI scheduler's task file,
// which is off), a UI mode
// with no reach (plan mode), inert in an AX session (PushNotification), or
// plumbing the rail has no word for (the MCP resource readers). A row also has
// to be worth a person's attention: rows for plumbing would bury the ones that
// matter. So a name gets a row only where "Cannot X" is true and a person would
// look for it, and every other denied name gets a written reason in `OFF_RAIL`.
// This guard makes that choice compulsory: a newly denied name stays RED until
// someone makes it.
//
// THE TASK-245 CROSS-RUNNER RULES STILL HOLD. The rail is runner-agnostic: it
// describes what the agent may not do in any deployment, so it may only claim a
// deny that holds on every runner we ship. The names this guard accounts for are
// the claude-sdk runner's denied set MINUS the names the aisdk runner registers.
// `TodoWrite` is the worked example the other way round: the aisdk runner does
// not register it, but the claude-sdk runner allows it, so it is not denied on
// both and is none of the rail's business. Absent on one runner is a different
// fact from denied on both, and only the second belongs here.
//
// WHY A SOURCE SCAN rather than importing the constants (TASK-245, decided by
// reading the code):
//
//   1. None of the claude-sdk runner's constants is reachable from outside its
//      package. Its `exports` map is only `"."` -> `dist/main.js`, and `main.ts`
//      re-exports only the two runner-core executors. Importing them would mean
//      changing another package's public surface to serve a test.
//   2. More decisively, an import CANNOT EXPRESS THIS ASSERTION AT ALL. The aisdk
//      half is not a constant: it is the complement of the `Record<string, Tool>`
//      that `buildBuiltinTools(opts)` returns, which needs a live policy and hold
//      latch. There is nothing importable to intersect against.
//
// A text scan costs zero dependency edges (invariant 2 stays untouched) and
// matches the established guard pattern in this directory, which CI runs
// unconditionally via `pnpm test:scripts`.
//
// This guard owns the NAME SETS and the `OFF_RAIL` reasons, nothing else. Each
// row's `id` and its human-facing `capability` clause are written and pinned by
// hand (`rules.test.ts`; `@ax/decisions`' canary builds on the first deny row),
// so nothing here generates or reformats them.

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

/**
 * Denied built-ins with NO rail row, each with the reason it has none.
 *
 *   - `coveredBy`: the `builtins.*` row that already says it. The name is an
 *     alias or a companion of that row's tool, so a row of its own would only
 *     repeat it.
 *   - `why`: the reason, in a line. Required, `coveredBy` or not.
 *
 * Before adding a name here, ask whether a person deciding whether to trust
 * the agent would want to read "Cannot <clause>" about it, and whether that
 * sentence is true. If both, write the row instead.
 */
const OFF_RAIL = Object.freeze({
  Agent: {
    coveredBy: 'builtins.task',
    why: "Task's name on the wire; the Task row already says it",
  },
  TeamCreate: { coveredBy: 'builtins.task', why: 'starts a team of helper agents' },
  TeamDelete: {
    coveredBy: 'builtins.task',
    why: 'disbands a team only TeamCreate could start',
  },
  SendMessage: {
    coveredBy: 'builtins.task',
    why: 'messages helper agents only Agent or TeamCreate could start',
  },
  CronDelete: {
    coveredBy: 'builtins.cron-create',
    why: "cancels an entry in the CLI scheduler's task file, and that scheduler is off",
  },
  CronList: {
    coveredBy: 'builtins.cron-create',
    why: "lists entries in the CLI scheduler's task file, and that scheduler is off",
  },
  ScheduleWakeup: {
    coveredBy: 'builtins.cron-create',
    why: "a timer that wakes this session later: part of the CLI's built-in scheduler",
  },
  RemoteTrigger: {
    coveredBy: 'builtins.cron-create',
    why:
      "schedules agent runs on Anthropic's cloud: part of the CLI's built-in " +
      'scheduler, outside routines',
  },
  Monitor: {
    why:
      'watches a background command; Bash run_in_background plus Read can still watch ' +
      'one, so a Cannot row would understate reach (H4). Monitor is not the only thing ' +
      'that wakes the model later either: a finished Bash run_in_background command ' +
      'sends a task-notification that does too, so "Cannot be woken by a background ' +
      'command" would be false as well',
  },
  TaskOutput: { why: "reads a background task's output; Read still can" },
  TaskStop: { why: 'stops a background task; Bash still can' },
  NotebookEdit: { why: 'edits notebook cells; Edit and Write still can' },
  EnterWorktree: {
    why:
      'makes a git worktree and moves the session into it; Bash can still make one, ' +
      'and moving the session is no reach',
  },
  ExitWorktree: { why: 'leaves a worktree session; no reach' },
  EnterPlanMode: { why: 'a read-only planning mode; no reach' },
  ExitPlanMode: { why: 'leaves plan mode; no reach' },
  PushNotification: {
    why:
      "notifies through the CLI's terminal and a paired Claude app; a headless " +
      'API-key session has neither',
  },
  ListMcpResourcesTool: {
    why: 'lists MCP resources; the rail describes a connection by its tools, which have their own rows',
  },
  ReadMcpResourceTool: {
    why: 'reads MCP resources; the rail describes a connection by its tools, which have their own rows',
  },
});

const HOW_TO_ACCOUNT =
  'To account for a name: write a `builtins.*` deny row in ' +
  'packages/tool-policy/src/rules.ts BY HAND (`capability-lint.ts` checks the clause) ' +
  'only if "Cannot <clause>" is true and a person would look for it. Otherwise add the ' +
  'name to OFF_RAIL in scripts/__tests__/disabled-builtin-rail-drift.test.js, with the ' +
  'reason it gets no row.';

/** Every single-quoted string inside a chunk of source, in order. */
function quotedStrings(chunk) {
  return [...chunk.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

/**
 * The names in `export const <name> = [ ... ] as const` in `file`.
 *
 * THROWS when the literal is missing, and when it holds anything besides
 * single-quoted names and comments: a spread, an identifier, a double-quoted
 * entry. Each of those would hand back a short list, and a short list here is a
 * quiet pass, because a name the parse misses is a denied name nobody has to
 * account for.
 */
function arrayLiteral(src, name, file) {
  const literal = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(
    src,
  );
  if (!literal) {
    throw new Error(
      `Could not find the \`export const ${name} = [...] as const\` literal in ${file}. ` +
        'If it was renamed or reshaped, update this guard. Do not delete it: it is the ' +
        'only thing that notices the rail falling behind the runners.',
    );
  }
  const body = literal[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const leftover = body.replace(/'[^']*'/g, '').replace(/[\s,]/g, '');
  if (leftover !== '') {
    throw new Error(
      `\`${name}\` in ${file} holds something besides single-quoted names ` +
        `(${JSON.stringify(leftover.slice(0, 40))}). This guard reads it as text and would ` +
        'miss those names, so update its parser. Do not delete it.',
    );
  }
  return quotedStrings(body);
}

/**
 * The claude-sdk runner's three name literals, and the set it keeps from the
 * agent. `denied` is recomputed the way `DENIED_SDK_BUILTINS` is: the four
 * named denials (`DISABLED_BUILTINS`, refused whatever the allowlist says)
 * plus every known built-in outside `ALLOWED_SDK_BUILTINS`.
 */
function claudeSdkBuiltins() {
  const src = readFileSync(CLAUDE_SDK_TOOL_NAMES, 'utf8');
  const known = arrayLiteral(src, 'KNOWN_SDK_BUILTINS', CLAUDE_SDK_TOOL_NAMES);
  const allowed = arrayLiteral(src, 'ALLOWED_SDK_BUILTINS', CLAUDE_SDK_TOOL_NAMES);
  const disabled = arrayLiteral(src, 'DISABLED_BUILTINS', CLAUDE_SDK_TOOL_NAMES);
  const allow = new Set(allowed);
  const denied = [...new Set([...disabled, ...known.filter((name) => !allow.has(name))])];
  return { known, allowed, denied };
}

/**
 * The six sandbox built-ins the aisdk runner registers IN THIS FILE, read from the
 * object `buildBuiltinTools` returns (`    Name: tool({`).
 *
 * NOT the runner's whole tool set, and this guard's one modelling assumption. That
 * runner merges three more sources in `main.ts` — the host catalog, the sandbox
 * catalog, and the `Skill` tool — none of which this scan sees. The accounting
 * below is still sound because it only ever asks about names the claude-sdk
 * runner denies, and the catalog tools are ax-native snake_case names that
 * cannot collide with an SDK built-in's PascalCase.
 *
 * `Skill` is the live counterexample, so it is worth naming: it IS PascalCase, it
 * IS registered by that runner (outside this file), and it USED to sit in
 * `DISABLED_BUILTINS`. If the claude-sdk runner ever denied it again, this guard
 * would count it as denied on both runners and ask for a `builtins.skill` row or
 * an OFF_RAIL reason, when the true answer is that the aisdk runner has it. It
 * stays allowed by a stronger pin than this one — `tool-names.test.ts` and
 * `main.test.ts` assert `Skill` is allowed (I-P0-1) — but a future name
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
 * The rail's `builtins.*` rows as `{ id, tool }`, in table order. A rule's text
 * runs from its `id:` to the next rule's `id:`, whatever that rule is, so a row
 * with no `tool:` of its own throws instead of borrowing the next rule's.
 */
function railBuiltinDenyRows() {
  const src = readFileSync(RAIL_RULES, 'utf8');
  const ids = [...src.matchAll(/\bid: '([^']+)'/g)];
  const rows = [];
  ids.forEach((match, i) => {
    if (!match[1].startsWith('builtins.')) return;
    const end = i + 1 < ids.length ? ids[i + 1].index : src.length;
    const tool = /\btool: '([^']+)'/.exec(src.slice(match.index, end));
    if (!tool) {
      throw new Error(
        `Rail rule \`${match[1]}\` in ${RAIL_RULES} has no \`tool: '...'\` in its ` +
          '`match`. This guard reads the rule table as text; if the table\'s shape ' +
          'changed, update the parser.',
      );
    }
    rows.push({ id: match[1], tool: tool[1] });
  });
  return rows;
}

const sorted = (names) => [...new Set(names)].sort();

describe('tool-policy rail vs the runners — every denied built-in accounted for', () => {
  // Read once. A parse that silently finds too LITTLE is the failure mode that
  // would make this guard vacuous: a short denied set has fewer names to
  // account for, and an empty aisdk set makes "denied on both" equal the
  // claude-sdk list. Every parse is therefore proved real before anything is
  // compared.
  const sdk = claudeSdkBuiltins();
  const aisdkRegistered = aisdkRegisteredBuiltins();
  const railRows = railBuiltinDenyRows();

  const registered = new Set(aisdkRegistered);
  // The only names the rail may speak for: denied on BOTH runners.
  const deniedOnBoth = sdk.denied.filter((name) => !registered.has(name));
  const keptOnBoth = new Set(deniedOnBoth);
  const railTools = railRows.map((row) => row.tool);
  const railIds = new Set(railRows.map((row) => row.id));

  const context =
    `\n  denied on both runners: ${sorted(deniedOnBoth).join(', ') || '(none)'}` +
    `\n  aisdk registers:        ${sorted(aisdkRegistered).join(', ')}` +
    `\n  rail builtins.* rows:   ${railRows.map((r) => `${r.id} (${r.tool})`).join(', ') || '(none)'}` +
    `\n  OFF_RAIL:               ${sorted(Object.keys(OFF_RAIL)).join(', ')}`;

  it('parsed real data out of all three files', () => {
    // All three runner literals live in `tool-names.ts`. Floors plus anchors,
    // not exact lists: `tool-names.test.ts` owns the exact sets, and a parse
    // that came back short would fail here instead of passing quietly below.
    expect(sdk.denied.length, 'claude-sdk denied built-ins').toBeGreaterThanOrEqual(20);
    expect(sdk.denied, 'claude-sdk denied built-ins').toContain('CronCreate');
    expect(sdk.known, 'KNOWN_SDK_BUILTINS').toContain('Bash');
    expect(sdk.allowed, 'ALLOWED_SDK_BUILTINS').toContain('Bash');
    for (const name of [...sdk.known, ...sdk.allowed, ...sdk.denied]) {
      expect(name, 'claude-sdk built-in name').toMatch(/^[A-Z][A-Za-z0-9_]*$/);
    }

    // The aisdk runner registers Bash, Read, Write, Edit, Glob, Grep. Asserted as a
    // floor plus one anchor rather than an exact list, so that runner gaining a
    // seventh tool does not fail HERE — it fails below only if the new tool is one
    // the rail claims is denied everywhere. `builtins.test.ts` owns the exact list.
    expect(aisdkRegistered.length, 'aisdk registered built-ins').toBeGreaterThanOrEqual(6);
    expect(aisdkRegistered, 'aisdk registered built-ins').toContain('Bash');

    expect(railRows.length, 'rail builtins.* deny rows').toBeGreaterThan(0);
  });

  it('every rail deny names a tool BOTH runners keep from the agent', () => {
    expect(
      railRows.filter((row) => !keptOnBoth.has(row.tool)).map((row) => `${row.id} (${row.tool})`),
      'These `builtins.*` rows deny a tool that is not denied on BOTH runners. The rail ' +
        'may only deny a tool the claude-sdk runner keeps out (off ALLOWED_SDK_BUILTINS, ' +
        'or in DISABLED_BUILTINS) AND the aisdk runner does not register. A tool one ' +
        'runner still has does NOT belong on the rail: remove the row from ' +
        `packages/tool-policy/src/rules.ts.${context}`,
    ).toEqual([]);
    // Compared un-deduped: two rows for one tool is a defect of its own (the
    // second is dead in the evaluator and the rail says it twice), and a set
    // would hide it.
    expect(
      railTools.filter((tool, i) => railTools.indexOf(tool) !== i),
      `Two \`builtins.*\` rows match the same tool. Keep one.${context}`,
    ).toEqual([]);
  });

  it('every denied built-in is a rail row or has a written reason in OFF_RAIL — never both, never neither', () => {
    const onRail = new Set(railTools);
    const offRail = (name) => Object.hasOwn(OFF_RAIL, name);
    expect(
      deniedOnBoth.filter((name) => !onRail.has(name) && !offRail(name)),
      `These built-ins are denied on both runners, and nothing says so or says why not. ${HOW_TO_ACCOUNT}${context}`,
    ).toEqual([]);
    expect(
      deniedOnBoth.filter((name) => onRail.has(name) && offRail(name)),
      'These names have a rail row AND an OFF_RAIL reason for having none. Keep one: ' +
        `if the row is right, delete the OFF_RAIL entry.${context}`,
    ).toEqual([]);
  });

  it('OFF_RAIL holds no stale names, and every coveredBy names a real rail row', () => {
    expect(
      Object.keys(OFF_RAIL).filter((name) => !keptOnBoth.has(name)),
      'OFF_RAIL explains names that are no longer denied on both runners. Delete those ' +
        `entries: a reason for a denial that no longer exists is a claim nothing checks.${context}`,
    ).toEqual([]);
    expect(
      Object.entries(OFF_RAIL)
        .filter(([, entry]) => entry.coveredBy !== undefined && !railIds.has(entry.coveredBy))
        .map(([name, entry]) => `${name} -> ${entry.coveredBy}`),
      'An OFF_RAIL `coveredBy` must name a `builtins.*` row in ' +
        `packages/tool-policy/src/rules.ts. Point it at a row that exists, or write the row.${context}`,
    ).toEqual([]);
    expect(
      Object.entries(OFF_RAIL)
        .filter(
          ([, entry]) =>
            typeof entry.why !== 'string' ||
            entry.why.trim() === '' ||
            Object.keys(entry).some((key) => key !== 'why' && key !== 'coveredBy'),
        )
        .map(([name]) => name),
      'Every OFF_RAIL entry needs a non-empty `why`, and no keys besides `why` and `coveredBy`.',
    ).toEqual([]);
  });
});
