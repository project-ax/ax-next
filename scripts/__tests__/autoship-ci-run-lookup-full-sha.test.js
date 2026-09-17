// Guard: every CI-status read in the ship skills must pin the thing it is asking
// about -- the COMMIT (as a full 40-char sha) and the WORKFLOW (`CI`).
//
// ---------------------------------------------------------------------------------
// WHY THIS EXISTS (TASK-392). Two independent traps, both measured, both silent.
//
// TRAP 1 -- `gh run list --commit` needs the FULL 40-char sha.
// Given an abbreviation it matches NOTHING and exits 0. Reproduced 2026-09-17 on two
// heads of this repo:
//
//     $ gh run list --workflow ci.yml --commit 519b781a4c49845c05f918ab50bcc8ff09e86080 \
//         --json databaseId --jq 'length'
//     1
//     $ gh run list --workflow ci.yml --commit 519b781a --json databaseId --jq 'length'
//     0
//
// ...and identically on 3e1c0915a434e3b40ad38f4d0fddf145e6a8d4ec. rc=0 in all four
// calls -- nothing on stderr, nothing to catch.
//
// That is the ENTIRE cause of the "the existence check returns zero for a run that
// exists" report. The card that filed it guessed "head_sha indexing lag on a freshly
// created run" and labelled the guess INFERRED; the guess is false. The skills'
// documented snippets were never broken -- they bind `HEAD_SHA` from
// `gh pr view --json headRefOid`, which is full. The caller that actually failed was a
// gitignored orchestrator helper that truncated to 8 chars. So the fix is not a retry
// and not a fallback to the branch listing: it is making truncation impossible to get
// away with.
//
// The reason a bare "use the full sha" comment is not enough, and this file asserts a
// runtime check instead: the two failure modes are INDISTINGUISHABLE downstream. A
// truncated sha and a genuinely absent run both surface as `runs=0`, and the gate's
// remedy for the absent case -- rebase-push to create a run -- is a wasted CI cycle and
// a wasted builder round-trip when the run was there all along. A length assertion
// splits them, and converts a silent wrong answer into a loud one.
//
// TRAP 2 -- a CI read that does not pin the workflow answers about a different one.
// `gh run list --branch main --limit 1` returns whichever run sorts first. Measured
// 2026-09-17 against live GitHub on main head 3e1c0915:
//
//     --limit 1        -> {"workflowName":"CodeQL - Code Quality","conclusion":"success"}
//     --limit 6 (same head, same moment):
//                         {"workflowName":"CodeQL - Code Quality","conclusion":"success"}
//                         {"workflowName":"CI",                   "conclusion":"failure"}
//                         {"workflowName":"CodeQL",               "conclusion":"success"}
//
// The convenience query reported SUCCESS for a head whose CI had FAILED. This is the
// backstop that exists to stop exactly that, so a false green here is the worst of the
// available bugs. The twin, on the other axis, is already in `.claude/memory/
// mistakes.md` (2026-09-16): `--branch main --workflow ci.yml --limit 1` returned a
// re-run of an unrelated four-month-old commit and produced a false RED. One pin is
// never enough -- pin workflow AND commit.
//
// ---------------------------------------------------------------------------------
// WHY THIS GUARD EXECUTES THE SNIPPETS RATHER THAN GREPPING THEM.
//
// The sibling guards over these files (`autoship-dispatch-scratch-scoping`,
// `autoship-review-gate-reviewed-sha`, and the ci.yml-existence block inside
// `autoship-skill-shell-hazards`) are text scans, and for their subjects that is the
// right instrument -- they pin RULES stated in prose. This card's subject is not a
// rule, it is a BEHAVIOUR: what the documented shell does when `gh` answers `0`. A scan
// for the string "full 40-char sha" would pass against a doc that says the words and
// branches on nothing, which is precisely the shape the earlier version had.
//
// So the tests below extract the fenced blocks from the skill docs and RUN them against
// a `gh` stub that reproduces the measured matching rule: `--commit` matches only on the
// exact 40-char sha, and returns an empty list (rc=0) for anything shorter. The doc IS
// the implementation -- there is no second copy in a script to drift from it.
//
// MUTANTS RUN, NOT REASONED ABOUT (2026-09-17, against the committed text; baseline
// 33 passed, and every mutant below still reports 33 tests, so none of them reddened by
// making the suite smaller):
//   - delete the `[ ${#HEAD_SHA} -eq 40 ]` assertion -> 7 red, and exactly the right 7:
//     the truncating-caller test at all three gate sites x both shells, plus the
//     doc-note test. The gate falls through to the NO-RUN message, which is the false
//     diagnosis this whole card is about.
//   - `[ "${runs:-0}" -ge 1 ]` -> `-ge 0` (fail-OPEN, guard clause still present) -> 6
//     red, exactly the fail-closed test at every site x shell.
//   - `select(.workflowName == "CI")` -> `select(true)` in the backstop filter, i.e.
//     `--limit 1` behaviour -> the CodeQL-first test goes red: the block reports GREEN
//     off a CodeQL row while CI had failed on that same head.
//   - point the backstop's wait arm at the green message -> exactly the in-progress
//     test goes red.
//   - move the `completed*` arm below the catch-all -> exactly the completed-with-empty-
//     conclusion test goes red (it spins instead of halting).
//
// TWO MUTANTS THAT FIRST CAME BACK WRONG, RECORDED BECAUSE THEY CHANGED THE DESIGN:
//   1. Deleting the `-ge 1` halt outright did not redden the fail-closed test -- it
//      reddened the VACUITY test, because the extractor keyed its cut on the literal
//      `-ge 1` and so returned nothing. The suite silently shrank 33 -> 14 and the
//      fail-closed assertion never ran. A guard whose extractor depends on the line it
//      is guarding cannot prove that line does anything. `existenceGate` now cuts on the
//      structural `|| {` guard clause instead, and the mutant above is the fail-OPEN
//      edit, which keeps the extraction intact.
//   2. An earlier version of the doc computed the conclusion word with an explicit
//      empty-string test, and an earlier version of this test asserted that word. The
//      mutant that removed it PASSED: both spellings land in the same case arm, because
//      the verdict keys off `status`. The claim was true but not load-bearing, so the
//      filter was simplified and the test now asserts the arm, which is.
//
// Lives in scripts/__tests__/, which `pnpm test:scripts` runs unconditionally -- no
// network and no build. The `gh` and `git` on PATH are stubs, so nothing here reaches
// GitHub.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills');

const AUTO_SHIP_DOC = join(SKILLS_DIR, 'auto-ship', 'SKILL.md');
const YOLO_SHIP_DOC = join(SKILLS_DIR, 'yolo-ship', 'SKILL.md');

/** A real head of this repo, used verbatim because the measurement used it. */
const FULL_SHA = '519b781a4c49845c05f918ab50bcc8ff09e86080';
/** What the buggy caller passed. `${FULL_SHA:0:8}`, spelled out so nobody re-derives it. */
const SHORT_SHA = '519b781a';

function binExists(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_ZSH = binExists('zsh');
const HAS_JQ = binExists('jq');

// ---------------------------------------------------------------------------------
// Extracting the runnable shell out of the docs.
// ---------------------------------------------------------------------------------

/**
 * Every fenced ```bash block in `md`, dedented by the fence's own indent.
 *
 * The indent matters: yolo-ship's Phase 6 block is nested inside a bullet, so its
 * fence and body carry two leading spaces. Dedenting by the fence's indent (rather
 * than a fixed amount) handles both nested and top-level blocks with one rule.
 */
function bashBlocks(md) {
  const out = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)```bash\s*$/.exec(lines[i]);
    if (!open) continue;
    const indent = open[1];
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (new RegExp(`^${indent}\`\`\`\\s*$`).test(lines[j])) break;
      body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j]);
    }
    out.push(body.join('\n'));
    i = j;
  }
  return out;
}

/**
 * The part of a merge/CI gate block that decides whether a ci.yml run exists, i.e.
 * everything up to and INCLUDING the `-ge 1` halt.
 *
 * Truncating there is not cosmetic. What follows in two of the three blocks is
 * `gh pr merge` / branch deletion; running those, even against stubs, would be
 * modelling the wrong thing. The existence decision is self-contained and is the
 * whole subject of this card.
 *
 * `<n>` is substituted because bash reads a bare `<n>` as a redirection, not as the
 * placeholder a reader sees. The orchestrator substitutes it for a PR number too, so
 * this runs the same text an operator would.
 *
 * The cut is found STRUCTURALLY -- the first `|| { … }` guard clause after the run
 * query -- and deliberately not by matching `-ge 1`. An earlier version keyed on the
 * literal comparison, which coupled the extractor to the very assertion the fail-closed
 * test exists to check: mutating `-ge 1` away made the extraction return nothing, so the
 * suite shrank from 32 tests to 14 and the fail-closed assertion was never evaluated at
 * all. It went red on the vacuity check instead, which looks like a pass for the wrong
 * reason. Decoupled, the fail-open mutant (`-ge 1` → `-ge 0`) now reddens exactly the
 * fail-closed test, which is what proves it is not vacuous.
 */
function existenceGate(block) {
  const lines = block.split('\n');
  const query = lines.findIndex(
    (l) => /gh run list/.test(l) && /ci\.yml/.test(l) && /--commit/.test(l),
  );
  if (query === -1) return undefined;
  const halt = lines.findIndex((l, i) => i > query && /\|\|\s*\{/.test(l));
  if (halt === -1) return undefined;
  return lines
    .slice(0, halt + 1)
    .join('\n')
    .replace(/<n>/g, '123');
}

/** The gate blocks across both ship skills, keyed by a human-readable site name. */
function gateSites() {
  const sites = [];
  for (const [label, path] of [
    ['auto-ship/SKILL.md', AUTO_SHIP_DOC],
    ['yolo-ship/SKILL.md', YOLO_SHIP_DOC],
  ]) {
    const md = readFileSync(path, 'utf8');
    const blocks = bashBlocks(md).filter(
      (b) =>
        /gh run list/.test(b) && /ci\.yml/.test(b) && /--commit/.test(b),
    );
    blocks.forEach((b, i) => {
      const gate = existenceGate(b);
      if (gate) sites.push({ name: `${label} [gate ${i + 1}]`, script: gate });
    });
  }
  return sites;
}

/** The cross-package backstop block: the one that selects the CI workflow by name. */
function backstopBlock() {
  const md = readFileSync(AUTO_SHIP_DOC, 'utf8');
  const blocks = bashBlocks(md).filter((b) => /workflowName == "CI"/.test(b));
  return blocks.length === 1 ? blocks[0] : undefined;
}

// ---------------------------------------------------------------------------------
// The stubs.
// ---------------------------------------------------------------------------------

const STUB_DIR = mkdtempSync(join(tmpdir(), 'autoship-ci-stub-'));

/**
 * `gh`, reduced to the two subcommands the blocks call, with the MEASURED matching
 * rule for `--commit`: it matches on the exact 40-char sha and on nothing else.
 *
 * `--jq 'length'` is answered from STUB_ROW_COUNT so the gate tests need no external
 * jq. Any other filter is evaluated by real jq over STUB_ROWS -- otherwise the
 * backstop test would be asserting against a canned answer rather than against the
 * filter the doc actually ships, which is the definition of vacuous.
 */
writeFileSync(
  join(STUB_DIR, 'gh'),
  `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' "$STUB_HEAD_SHA"
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  commit=""
  filter=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --commit) commit="$2"; shift ;;
      --jq)     filter="$2"; shift ;;
    esac
    shift
  done
  if [ "$commit" != "$STUB_FULL_SHA" ]; then
    # Measured: an abbreviated (or simply non-matching) sha yields an empty list, rc 0.
    if [ "$filter" = "length" ]; then echo 0; else printf '%s\\n' "none"; fi
    exit 0
  fi
  if [ "$filter" = "length" ]; then
    printf '%s\\n' "$STUB_ROW_COUNT"
    exit 0
  fi
  printf '%s' "$STUB_ROWS" | jq -r "$filter"
  exit 0
fi
echo "stub gh: unhandled invocation: $*" >&2
exit 64
`,
  { mode: 0o755 },
);
chmodSync(join(STUB_DIR, 'gh'), 0o755);

writeFileSync(
  join(STUB_DIR, 'git'),
  `#!/bin/sh
case "$1 $2" in
  "rev-parse HEAD") printf '%s\\n' "$STUB_MAIN_SHA"; exit 0 ;;
  "fetch origin")   exit 0 ;;
esac
echo "stub git: unhandled invocation: $*" >&2
exit 64
`,
  { mode: 0o755 },
);
chmodSync(join(STUB_DIR, 'git'), 0o755);

afterAll(() => {
  // The temp dir holds two stub scripts and nothing else; leaving it would be litter
  // in a long-lived CI runner but is otherwise harmless, so removal is best-effort.
  try {
    rmSync(STUB_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/**
 * Run an extracted block with the stubs first on PATH.
 *
 * spawnSync (not execFileSync) so a non-zero exit is DATA rather than a throw -- the
 * halting direction is half of what this file asserts, and a helper that threw on it
 * would push every fail-closed assertion into a try/catch where "it threw" is easy to
 * confuse with "the test crashed".
 */
function runBlock(shell, script, env) {
  const r = spawnSync(shell, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${STUB_DIR}:${process.env.PATH}`, ...env },
    cwd: REPO_ROOT,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const SHELLS = ['bash', ...(HAS_ZSH ? ['zsh'] : [])];

// ---------------------------------------------------------------------------------

describe('CI-run existence gates: `--commit` gets the full 40-char sha', () => {
  const sites = gateSites();

  it('finds every gate block to run (the suite below must not be vacuous)', () => {
    // Three known sites: auto-ship's merge queue, yolo-ship Phase 6 (CI check) and
    // yolo-ship Phase 7 (standalone auto-merge). A refactor that merges two of them is
    // fine; one that drops the extraction on the floor must be loud, because every
    // assertion below is a for-loop over this array and an empty array passes them all.
    expect(
      sites.map((s) => s.name),
      'no runnable ci.yml-existence block was extracted from the skill docs -- ' +
        'either the fenced blocks moved or bashBlocks() stopped matching them. ' +
        'Every test in this describe iterates this list, so zero sites = zero coverage.',
    ).toHaveLength(3);
    for (const s of sites) {
      expect(s.script, `${s.name} lost its \`gh run list\` call`).toMatch(/gh run list/);
    }
  });

  it('the zsh pass is not silently skipped without saying so', () => {
    // The Bash tool on the maintainer's machine runs zsh, so these blocks are executed
    // by zsh in real life. zsh is not guaranteed on a CI runner, so the runs below are
    // conditional -- this test states the condition out loud rather than leaving a
    // silent gap.
    expect(SHELLS).toContain('bash');
    if (!HAS_ZSH) {
      expect(SHELLS).toEqual(['bash']);
    } else {
      expect(SHELLS).toEqual(['bash', 'zsh']);
    }
  });

  for (const { name, script } of sites) {
    for (const shell of SHELLS) {
      it(`${name} (${shell}): a full sha with a run present does NOT report NO-RUN`, () => {
        // The control. `gh pr view --json headRefOid` gives a full sha, the run exists,
        // the gate must fall through to the rest of the merge sequence.
        const { code, out } = runBlock(shell, script, {
          STUB_HEAD_SHA: FULL_SHA,
          STUB_FULL_SHA: FULL_SHA,
          STUB_ROW_COUNT: '1',
        });
        expect(out, `${name}: gate halted on a head whose run exists`).not.toMatch(
          /no ci\.yml run|NO ci\.yml RUN|not a full 40-char sha/i,
        );
        expect(code, `${name}: expected the gate to pass, got rc=${code}\n${out}`).toBe(0);
      });

      it(`${name} (${shell}): a TRUNCATED sha halts on the truncation, not as "no run"`, () => {
        // The regression. A caller that hands the gate an 8-char sha gets an empty list
        // back from `gh`, rc 0 -- exactly what a genuinely missing run looks like. The
        // gate must name the real problem. If it instead prints the NO-RUN message, the
        // orchestrator sends a builder to rebase-push a head whose run already exists,
        // which is the failure this card was filed for.
        const { code, out } = runBlock(shell, script, {
          STUB_HEAD_SHA: SHORT_SHA,
          STUB_FULL_SHA: FULL_SHA,
          STUB_ROW_COUNT: '1',
        });
        expect(
          code,
          `${name}: a truncated sha must HALT, not proceed. rc=${code}\n${out}`,
        ).not.toBe(0);
        expect(
          out,
          `${name}: the halt must diagnose the TRUNCATION. Without a length check the ` +
            'gate says "no ci.yml run" instead -- a false diagnosis that costs a CI ' +
            'cycle and a builder round-trip on a run that was there all along.',
        ).toMatch(/full 40-char sha/);
        expect(
          out,
          `${name}: a truncated sha must NOT be reported as a missing run, and must ` +
            'not recommend rebase-push -- there is nothing to create.',
        ).not.toMatch(/rebase-push/);
      });

      it(`${name} (${shell}): a genuinely absent run still HALTS (fail-closed)`, () => {
        // The direction most easily written vacuously, so it is mutated rather than
        // assumed: deleting the `-ge 1` halt from the doc turns exactly this red.
        const { code, out } = runBlock(shell, script, {
          STUB_HEAD_SHA: FULL_SHA,
          STUB_FULL_SHA: FULL_SHA,
          STUB_ROW_COUNT: '0',
        });
        expect(
          code,
          `${name}: an absent ci.yml run MUST halt the gate. Fail-open here means a ` +
            `head whose build and tests never ran reads as green. rc=${code}\n${out}`,
        ).not.toBe(0);
        expect(out, `${name}: the halt must say the run is missing`).toMatch(
          /no ci\.yml run/i,
        );
        expect(
          out,
          `${name}: with a full sha the halt must NOT blame truncation -- that would ` +
            'send the reader after the wrong cause.',
        ).not.toMatch(/full 40-char sha/);
      });
    }
  }

  it('no site abbreviates a sha on its way to `--commit`', () => {
    // Belt to the runtime check's braces, and the part that reaches beyond the three
    // executable sites: the same mistake written into any future snippet. The two
    // spellings are the ones that actually occurred -- the gitignored helper used the
    // first; `%h`/`--short` are the obvious next reach for anyone wanting a tidy log
    // line. Comment lines are exempt because the docs must be able to WRITE the broken
    // form in order to warn about it.
    const offenders = [];
    for (const [label, path] of [
      ['auto-ship/SKILL.md', AUTO_SHIP_DOC],
      ['yolo-ship/SKILL.md', YOLO_SHIP_DOC],
    ]) {
      const md = readFileSync(path, 'utf8');
      md.split('\n').forEach((line, i) => {
        if (/^\s*#/.test(line)) return;
        if (!/--commit/.test(line)) return;
        if (/:\d+:\d+\}|rev-parse --short|--short HEAD|%h/.test(line)) {
          offenders.push(`${label}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      '`gh run list --commit` matches only a full 40-char sha; an abbreviation ' +
        'matches nothing and exits 0.',
    ).toEqual([]);
  });
});

describe('cross-package backstop: pins the CI workflow, not whichever run sorts first', () => {
  const block = backstopBlock();

  it('finds exactly one backstop block (the scan must not be vacuous)', () => {
    expect(
      block,
      'expected exactly one fenced bash block in auto-ship/SKILL.md that selects ' +
        '`workflowName == "CI"`. Zero means the backstop stopped pinning the ' +
        'workflow; more than one means two copies that can drift.',
    ).toBeDefined();
  });

  it('never reads the main run with a bare `--limit 1`', () => {
    // Measured 2026-09-17: on main head 3e1c0915 that call returned
    // "CodeQL - Code Quality" success while CI on the same head was failure.
    const md = readFileSync(AUTO_SHIP_DOC, 'utf8');
    const offenders = md
      .split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => !/^\s*#/.test(l))
      .filter(([, l]) => /gh run list/.test(l) && /--branch/.test(l) && /--limit 1\b/.test(l));
    expect(
      offenders.map(([n, l]) => `${n}: ${l.trim()}`),
      '`gh run list --branch <b> --limit 1` returns whichever run sorts first, not ' +
        'the CI run. Reading a conclusion from it is a false green on a workflow ' +
        'that tested nothing.',
    ).toEqual([]);
  });

  it('pins both axes -- the workflow and the commit', () => {
    expect(block).toMatch(/workflowName == "CI"/);
    expect(block).toMatch(/--commit "\$MAIN_SHA"/);
  });

  // The behavioural half. Real jq, because the doc ships a real jq filter and a canned
  // answer would assert nothing about it -- the filter IS the fix. jq is not guaranteed
  // on a runner, so these are conditional in the same shape the sibling hazards guard
  // uses for zsh; the three text assertions above run unconditionally, so the workflow
  // pin is never left entirely unguarded.
  const jqIt = it.skipIf(!HAS_JQ);

  const MAIN_SHA = '3e1c0915a434e3b40ad38f4d0fddf145e6a8d4ec';

  /** Verbatim shape of a live `gh run list` row set, from the 2026-09-17 measurement. */
  const rows = (...entries) =>
    JSON.stringify(
      entries.map(([workflowName, status, conclusion]) => ({
        workflowName,
        status,
        conclusion,
      })),
    );

  const runBackstop = (rowsJson) =>
    runBlock('bash', block, {
      STUB_MAIN_SHA: MAIN_SHA,
      STUB_FULL_SHA: MAIN_SHA,
      STUB_ROWS: rowsJson,
    });

  jqIt('reads RED when CI failed, even though a CodeQL success sorts first', () => {
    // These are the exact three rows live GitHub returned for main head 3e1c0915.
    const { code, out } = runBackstop(
      rows(
        ['CodeQL - Code Quality', 'completed', 'success'],
        ['CI', 'completed', 'failure'],
        ['CodeQL', 'completed', 'success'],
      ),
    );
    expect(
      out,
      'the backstop read the first row (CodeQL) instead of CI -- a false green on a ' +
        'head whose tests failed',
    ).not.toMatch(/main green/);
    expect(out).toMatch(/RED/);
    expect(code, `expected a halt, rc=${code}\n${out}`).not.toBe(0);
  });

  jqIt('halts fail-closed when no CI run exists, however many other runs do', () => {
    const { code, out } = runBackstop(
      rows(
        ['CodeQL - Code Quality', 'completed', 'success'],
        ['CodeQL', 'completed', 'success'],
      ),
    );
    expect(out).toMatch(/no CI run/);
    expect(out).not.toMatch(/main green/);
    expect(code, `an absent CI run must halt, rc=${code}\n${out}`).not.toBe(0);
  });

  jqIt('an in-progress run (conclusion "") is never green', () => {
    // Measured: a live in-progress run carries `"conclusion": ""`, not null. That is
    // the trap the block sidesteps by keying the verdict on `status` first -- any rule
    // reading the conclusion first inherits it, because jq's `//` falls through on null
    // and false only, so `.conclusion // "pending"` yields "" rather than "pending".
    //
    // An earlier version of this test asserted the pending WORD and was vacuous: with
    // `status` deciding the arm, both spellings of the filter produced the same verdict
    // and the mutant passed. What is actually load-bearing is the arm this lands in, so
    // that is what is asserted; the mutant that reddens it points the wait arm at the
    // green message.
    const { code, out } = runBackstop(rows(['CI', 'in_progress', '']));
    expect(out, 'an in-progress run is not a green main').not.toMatch(/main green/);
    expect(out).toMatch(/still running/);
    // Not terminal, so not a halt -- the orchestrator waits rather than reporting.
    expect(code, `pending must not halt, rc=${code}\n${out}`).toBe(0);
  });

  jqIt('a completed run with an empty conclusion HALTS rather than spinning', () => {
    // The arm-order property: `completed*` sits above the catch-all, so a terminal run
    // whose conclusion is a shape nobody anticipated is treated as red, not as "still
    // running". Fail-closed beats a wait loop that never ends.
    const { code, out } = runBackstop(rows(['CI', 'completed', '']));
    expect(out).not.toMatch(/main green|still running/);
    expect(code, `rc=${code}\n${out}`).not.toBe(0);
  });

  jqIt('reads GREEN on a completed, successful CI run (so the above are not vacuous)', () => {
    // Without this control a block that halted unconditionally would pass every
    // negative test in this describe.
    const { code, out } = runBackstop(
      rows(
        ['CodeQL - Code Quality', 'completed', 'success'],
        ['CI', 'completed', 'success'],
      ),
    );
    expect(out, `expected a green verdict\n${out}`).toMatch(/main green/);
    expect(code).toBe(0);
  });
});

describe('the docs record the measurement, not just the rule', () => {
  it('states the full-sha requirement at every gate site', () => {
    // A future reader meeting `runs=0` needs the cause at the command, not three
    // sections away. Each of the three gate blocks carries it; this asserts the count
    // so deleting one copy is caught.
    const withNote = gateSites().filter(({ script }) =>
      /FULL 40-CHAR SHA|full 40-char sha/.test(script),
    );
    expect(
      withNote.map((s) => s.name),
      'every ci.yml existence gate must say, at the command, that `--commit` needs ' +
        'the full sha',
    ).toHaveLength(3);
  });

  it('does not restate the refuted head_sha-indexing-lag cause as settled', () => {
    // The original card blamed indexing lag, labelled it INFERRED, and was wrong. The
    // docs may mention it only to mark it false; an unqualified restatement would send
    // the next reader to add a retry loop for a race that does not exist.
    //
    // The window is 300 chars rather than the line, because the refutation naturally
    // wraps onto the following line in a comment block -- a line-scoped check here
    // would fail on correct text, which is how a guard trains people to delete it.
    for (const path of [AUTO_SHIP_DOC, YOLO_SHIP_DOC]) {
      const md = readFileSync(path, 'utf8');
      for (const m of md.matchAll(/indexing lag/g)) {
        const near = md.slice(m.index, m.index + 300);
        expect(
          near,
          `${path}: "indexing lag" appears without being marked false nearby. It was ` +
            'an inference and it is wrong; stating it unqualified sends the next ' +
            `reader after a race that does not exist.\n---\n${near}`,
        ).toMatch(/FALSE|false|not the cause|refuted/);
      }
    }
  });
});

// A last, separate check that the file it guards is where it thinks it is. Cheap, and
// it has caught a package move before (see feedback_diff_review_misses_moved_paths).
describe('guarded paths exist', () => {
  for (const p of [AUTO_SHIP_DOC, YOLO_SHIP_DOC]) {
    it(`${p.replace(REPO_ROOT, '.')} is present`, () => {
      expect(existsSync(p), `${p} is missing -- every scan above proves nothing`).toBe(
        true,
      );
    });
  }
});
