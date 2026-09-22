// Guard: auto-ship's triage gate must stamp `[TASK-n]` onto an untagged card through
// the card's DRAFT-ISSUE content id (`DI_…`), not its project-item id (`PVTI_…`).
//
// ---------------------------------------------------------------------------------
// WHY THIS EXISTS (TASK-401).
//
// `.claude/skills/auto-ship/references/github-project.md` §8.2 is the snippet the
// orchestrator runs to give an untagged To Do card a stable ID. It used to read:
//
//     gh project item-edit --id "$ITEM_ID" --title "[TASK-$NEXT] $ORIGINAL_TITLE"
//
// `$ITEM_ID` is the `PVTI_` project-item node id bound in §3/§4. `gh` routes
// `--title`/`--body` to the `updateProjectV2DraftIssue` mutation, which addresses the
// CONTENT node. Probed 2026-09-18 on a throwaway draft-issue card, both ids, then
// deleted:
//
//   - `--id <PVTI_…> --title …` -> refused, in gh's own words:
//     `ID must be the ID of the draft issue content which is prefixed with DI_`.
//     The title did NOT change.
//   - `--id <DI_…>   --title …` -> succeeded; the title changed.
//
// So triage would have failed on ANY untagged card. It went unseen because no untagged
// card arrived between the doc being written and the probe -- the 2026-09-19 run put the
// gate over 17 candidates and every one of them was already tagged. Latency, not health.
//
// ---------------------------------------------------------------------------------
// WHY THIS GUARD EXECUTES THE SNIPPET RATHER THAN GREPPING IT.
//
// TASK-392 paid for this distinction already: a text scan for the right words passes
// against a doc that says them and branches on nothing. "Mentions `DI_`" is satisfied by
// a prose paragraph sitting above an unchanged command. So the tests below extract §8.2's
// fenced block and RUN it, under bash AND zsh, against a `gh` stub that reproduces the
// measured refusal. The doc is the single implementation -- there is no second copy in a
// script for it to drift from.
//
// THE PIPE TRAP, which is why every assertion here keys off the RESULTING TITLE.
// In the original probe `rc` read **0 for the failing call**, because the command was
// piped into `head` and `$?` was `head`'s status. A guard that asserted on a piped exit
// code would pass against the broken form. The stub therefore records what the title
// BECAME, in a file, and the tests read that -- an outcome no pipeline can launder. (The
// two places an exit status matters, `refusal is loud` and `transient lookup failure`,
// key off the FATAL lines the doc prints, which are themselves only reachable because
// the doc's `||`s are unpiped.)
//
// The trap has TWO sites, which is not obvious and was a review finding. The first is
// the edit. The second is the LOOKUP: `DI=$(gh api graphql … | jq …)` throws gh's status
// away just as thoroughly, and the symptom is subtler -- an API blip arrives as an empty
// `$DI`, indistinguishable from a card that genuinely has no draft issue. Those have
// opposite remedies (retry next pass vs. stop trying), so §8.2 keeps the lookup's rc too
// and says which happened. The sibling helper `append_progress` (§6) has always done
// this for its own read; the first version of this fix did not, and the prose claimed
// parity with it.
//
// MUTANTS RUN, NOT REASONED ABOUT (2026-09-19, each applied to the committed text and
// executed, then restored; baseline 17 passed on a machine with zsh and jq). Every
// mutant below still COLLECTS 17, so none of them reddened by making the suite smaller
// -- the number to distrust is a red count that arrives with a shrunken total.
//
// A CORRECTION THAT IS ITSELF THE LESSON. An earlier version of this header claimed the
// piped-lookup mutant reddened **3**. A reviewer re-ran it and measured more. The cause
// was not the suite: my mutant had spliced an artificial `json=x` line in to keep the
// downstream `[ -n "$json" ]` tests true, and no real regression would ever contain that
// line. So I had measured a mutant nobody could write. A mutant's CONSTRUCTION is a
// claim as much as its count is, and "restore the previous version verbatim" is the only
// construction that cannot be argued with. That is what M7 does now. (This repo has the
// sibling lesson on file: `.claude/memory/mistakes.md`, TASK-403, a mutant that landed on
// the wrong one of two identical lines and "survived".)
//
//   M1. Revert §8.2 to the exact pre-fix line, `--id "$ITEM_ID"` with no resolution and
//       no guards, while LEAVING the surrounding prose in place -> 14 red. That is the
//       vacuity scenario stated as a mutant: the section still says "DI_" four times and
//       explains the measurement, and the guard reddens anyway. All 12 behavioural cases
//       (6 scenarios x 2 shells) plus the two `gh api graphql`-dependent structural
//       checks, since the reverted line contains no `gh api graphql` at all. The THIRD
//       structural check (`gh project item-edit … is not piped`) stays GREEN under M1 --
//       the pre-fix line genuinely was not piped; it was pointed at the wrong id. The
//       title file still holds the untagged title -- the production symptom verbatim.
//   M2. Keep the resolution but pass `--id "$ITEM_ID"` to the edit anyway -> 4 red:
//       `assigns the new title` and `preserves the human's title` x both shells, while
//       the `gh api graphql` structural check PASSES. A scan would call this fixed. This
//       is the whole argument for executing over grepping, in one mutant.
//   M3. Delete only the `no draft-issue content` FATAL line -> 2 red, `linked-issue card`
//       x both shells: the block goes quiet on a card it cannot stamp.
//   M4. Delete only the trailing `|| echo "FATAL: item-edit refused …"` -> 2 red,
//       `refusal is loud` x both shells. This is the arm the edit-site pipe trap hides.
//   M5. Swap `sort -n` for a plain `sort` in the NEXT computation -> 4 red, `assigns the
//       new title` and `preserves the human's title` x both shells. The fixture's TASK-99
//       sorts above TASK-401 lexically, so NEXT comes out 100 -- a COLLISION with a live
//       card, not merely a wrong number. Not this card's bug, but it rides in the same
//       block and the guard now holds it.
//   M6. Pipe the EDIT (`… --title "…" | head -1 || echo FATAL`) -> 3 red: the
//       `gh project item-edit … is not piped` check, plus `refusal is loud` x both
//       shells, because `$?` is now `head`'s and the FATAL arm never fires.
//   M7. Restore the round-1 block VERBATIM (`git show 38e85a17`), i.e. the piped lookup
//       this branch actually shipped with before review -> 7 red: the
//       `gh api graphql … is not piped` check, plus `transient lookup failure`,
//       `rc-0 lookup that answers NOTHING` and `linked-issue card`, each x both shells.
//       The four title scenarios all stay GREEN, which is exactly why the piped version
//       passed its own guard and needed a human to catch it.
//   M8. Delete only the `[ -n "$json" ] ||` lookup-FAILED line -> 4 red: `transient
//       lookup failure` AND `rc-0 lookup that answers NOTHING`, x both shells. Both
//       lookup-failure shapes route through that one test, which is the point of testing
//       the OUTPUT rather than the exit code -- an `|| echo` on the assignment alone
//       cannot see an rc-0 empty answer at all.
//
// Lives in scripts/__tests__/, which `pnpm test:scripts` runs unconditionally -- no
// network and no build. The `gh` on PATH is a stub, so nothing here reaches GitHub.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOARD_DOC = join(
  REPO_ROOT,
  '.claude',
  'skills',
  'auto-ship',
  'references',
  'github-project.md',
);

/** Shapes chosen to look like the real thing; only the `DI_`/`PVTI_` prefixes matter. */
const ITEM_ID = 'PVTI_lADOD4dXMc4BYpfZzg7mvDM';
const DRAFT_ID = 'DI_lADOD4dXMc4BYpfZzg7mvDM';
const ORIGINAL_TITLE = 'Make the widget go ping';

/**
 * A board fixture with the highest id at TASK-401 and a decoy TASK-99 that sorts ABOVE
 * it lexically. `sort -n` is what makes the answer 402 rather than 100, and 100 would
 * collide with a live card rather than merely read wrong.
 */
const ITEMS = JSON.stringify({
  items: [
    { id: 'PVTI_a', title: '[TASK-99] an old one', status: 'Done' },
    { id: 'PVTI_b', title: '[TASK-401] the card that found this', status: 'In Progress' },
    { id: ITEM_ID, title: ORIGINAL_TITLE, status: 'To Do' },
  ],
});
const EXPECTED_TITLE = `[TASK-402] ${ORIGINAL_TITLE}`;

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
// Extracting the runnable shell out of the doc.
// ---------------------------------------------------------------------------------

/**
 * Every fenced ```bash block in `md`, dedented by the fence's own indent.
 *
 * Same rule as `autoship-ci-run-lookup-full-sha.test.js` uses, for the same reason: a
 * block nested in a bullet carries leading spaces, and dedenting by the fence's own
 * indent handles nested and top-level blocks with one rule. Duplicated rather than
 * shared because the two files pin different subjects in different docs, and a shared
 * helper module would be a third thing to keep in step with both.
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
 * §8.2's ID-assignment block: the one fenced block in the board doc that runs
 * `gh project item-edit` with `--title`.
 *
 * Deliberately located by `--title`, NOT by `DI_`. Keying on the fix would make the
 * extractor vanish the moment the fix is reverted, and every execution test below would
 * then pass by iterating nothing -- the precise failure the sibling guard's header
 * records as mutant #1. Located this way, the pre-fix text is still found and still run,
 * and it fails on its behaviour.
 */
function idAssignmentBlocks(md) {
  // Matched on ONE LOGICAL LINE, not anywhere in the block. §4's write block contains
  // `gh project item-edit` (field writes) and, separately, `gh project item-create
  // --title` -- a block-wide `&&` enrols it too and the count check then fails pointing
  // at the wrong section.
  return bashBlocks(md).filter((b) =>
    logicalLines(b).some((l) => /gh project item-edit/.test(l) && /--title/.test(l)),
  );
}

/** Remove whole-line comment text before joining continuations; keep its newline. */
function logicalLines(block) {
  return block
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n')
    .replace(/\\\n/g, ' ')
    .split('\n');
}

function expectUnpipedCalls(block, what, needle) {
  const lines = logicalLines(block).filter((line) => needle.test(line));
  expect(lines.length, `no uncommented \`${what}\` line found`).toBeGreaterThan(0);
  for (const line of lines) {
    expect(
      line.replace(/\|\|/g, ''),
      `the \`${what}\` call is piped. \`$?\` then belongs to the pipeline tail, not ` +
        'to gh -- which is exactly how the 2026-09-18 probe first read rc 0 off a ' +
        'refusal, and how a transient API blip would be reported as "this card has ' +
        'no draft issue".',
    ).not.toMatch(/\|/);
  }
}

const BLOCKS = idAssignmentBlocks(readFileSync(BOARD_DOC, 'utf8'));
const BLOCK = BLOCKS.length === 1 ? BLOCKS[0] : undefined;

// ---------------------------------------------------------------------------------
// The stubs.
// ---------------------------------------------------------------------------------

const STUB_DIR = mkdtempSync(join(tmpdir(), 'autoship-triage-stub-'));
const TITLE_FILE = join(STUB_DIR, 'title');

/**
 * `gh`, reduced to the two calls §8.2 makes, with the MEASURED rule for `item-edit`:
 * `--title` is accepted only for a `DI_`-prefixed id, and for anything else it emits
 * gh's own message on stderr, exits 1, and leaves the title alone.
 *
 * The title lives in a FILE rather than in the exit status on purpose -- see the pipe
 * trap in the header. `STUB_TITLE_FILE` is seeded with the untagged title before each
 * run, so "still untagged" and "stamped" are distinguishable outcomes rather than
 * present/absent.
 */
writeFileSync(
  join(STUB_DIR, 'gh'),
  `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  if [ "$STUB_GRAPHQL_FAILS" = "1" ]; then
    # A transient API failure: gh exits non-zero and prints nothing usable on stdout.
    echo "gh: Post \\"https://api.github.com/graphql\\": dial tcp: i/o timeout" >&2
    exit 1
  fi
  if [ "$STUB_GRAPHQL_EMPTY" = "1" ]; then
    # The theoretical one: rc 0 and nothing on stdout. Real gh does not do this, which
    # is exactly why it is worth a test -- it is the state a reader reasons past, and
    # the one where an rc-only guard goes completely silent.
    exit 0
  fi
  id=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-f" ]; then
      case "$2" in i=*) id="\${2#i=}" ;; esac
      shift
    fi
    shift
  done
  if [ "$id" != "$STUB_ITEM_ID" ]; then
    # An id the board never handed out resolves to nothing at all.
    printf '%s\\n' '{"data":{"node":null}}'
    exit 0
  fi
  if [ "$STUB_HAS_DRAFT" = "1" ]; then
    printf '{"data":{"node":{"content":{"id":"%s"}}}}\\n' "$STUB_DRAFT_ID"
  else
    # A card whose content is a linked real issue/PR: no DraftIssue fragment matches.
    printf '%s\\n' '{"data":{"node":{"content":{}}}}'
  fi
  exit 0
fi
if [ "$1" = "project" ] && [ "$2" = "item-edit" ]; then
  id=""
  title=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --id)    id="$2";    shift ;;
      --title) title="$2"; shift ;;
    esac
    shift
  done
  if [ "$STUB_EDIT_FAILS" = "1" ]; then
    echo "failed to update item: something transient" >&2
    exit 1
  fi
  case "$id" in
    DI_*) printf '%s' "$title" > "$STUB_TITLE_FILE"; echo "Edited item \\"$title\\""; exit 0 ;;
  esac
  # Measured 2026-09-18, verbatim: this is what a PVTI_ id gets back.
  echo "ID must be the ID of the draft issue content which is prefixed with DI_" >&2
  exit 1
fi
echo "stub gh: unhandled invocation: $*" >&2
exit 64
`,
  { mode: 0o755 },
);
chmodSync(join(STUB_DIR, 'gh'), 0o755);

afterAll(() => {
  // Two stub files and a scratch title; leaving it would be litter on a long-lived
  // runner but is otherwise harmless, so removal is best-effort.
  try {
    rmSync(STUB_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/**
 * Run the extracted block with the stub first on PATH, and report what the title
 * BECAME alongside the output.
 *
 * spawnSync (not execFileSync) so a non-zero exit is data rather than a throw: the
 * doc's guards print and continue, and a helper that threw would turn "the block
 * refused loudly" into something hard to tell apart from "the test crashed".
 */
function runBlock(
  shell,
  { hasDraft = true, editFails = false, lookupFails = false, lookupEmpty = false } = {},
) {
  writeFileSync(TITLE_FILE, ORIGINAL_TITLE);
  const r = spawnSync(shell, ['-c', BLOCK], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${STUB_DIR}:${process.env.PATH}`,
      ITEMS,
      ITEM_ID,
      ORIGINAL_TITLE,
      STUB_ITEM_ID: ITEM_ID,
      STUB_DRAFT_ID: DRAFT_ID,
      STUB_TITLE_FILE: TITLE_FILE,
      STUB_HAS_DRAFT: hasDraft ? '1' : '0',
      STUB_EDIT_FAILS: editFails ? '1' : '0',
      STUB_GRAPHQL_FAILS: lookupFails ? '1' : '0',
      STUB_GRAPHQL_EMPTY: lookupEmpty ? '1' : '0',
    },
    cwd: REPO_ROOT,
  });
  return {
    code: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    title: readFileSync(TITLE_FILE, 'utf8'),
  };
}

const SHELLS = ['bash', ...(HAS_ZSH ? ['zsh'] : [])];

// ---------------------------------------------------------------------------------

describe('triage guard command scanning', () => {
  it('logicalLines keeps a command after a comment ending in a backslash', () => {
    const command = 'gh project item-edit --id "$DI" --title "$TITLE" | head -1';
    const lines = logicalLines(`# a note \\\n${command}\nx=1`);
    expect(lines).toContain(command);
    expect(lines).toContain('x=1');
    expect(lines.some((line) => /^\s*#/.test(line))).toBe(false);
  });

  it('extracts the title-assignment block after a comment ending in a backslash', () => {
    const block = '# a note \\\ngh project item-edit \\\n  --id "$DI" --title "$TITLE"';
    expect(idAssignmentBlocks('```bash\n' + block + '\n```')).toEqual([block]);
  });

  it('keeps a comment newline between a continued command and the next command', () => {
    const lines = logicalLines('printf first \\\n# a note \\\nprintf second');
    expect(lines.map((line) => line.trim()).filter(Boolean)).toEqual([
      'printf first',
      'printf second',
    ]);
  });

  it('compatibility: joins genuine code continuations', () => {
    const lines = logicalLines('gh project item-edit \\\n  --id "$DI" \\\n  --title "$TITLE" || echo FATAL');
    expect(lines).toHaveLength(1);
    expect(lines[0].replace(/\s+/g, ' ').trim()).toBe(
      'gh project item-edit --id "$DI" --title "$TITLE" || echo FATAL',
    );
  });

  for (const [what, needle, unpiped, piped] of [
    [
      'gh project item-edit',
      /gh project item-edit/,
      'gh project item-edit --id "$DI" --title "$TITLE" || echo FATAL',
      'gh project item-edit --id "$DI" --title "$TITLE" | head -1 || echo FATAL',
    ],
    [
      'gh api graphql draft-issue lookup',
      /gh api graphql/,
      'json=$(gh api graphql -f i="$ITEM_ID") || echo FATAL',
      'json=$(gh api graphql -f i="$ITEM_ID" | head -1) || echo FATAL',
    ],
  ]) {
    it(`${what}: rejects a later piped call after an unpiped call`, () => {
      expect(() => expectUnpipedCalls(`${unpiped}\n${piped}`, what, needle)).toThrow(
        /call is piped/,
      );
    });

    it(`${what}: rejects a later piped call after a backslash-ending comment`, () => {
      expect(() =>
        expectUnpipedCalls(`${unpiped}\n# a note \\\n${piped}`, what, needle),
      ).toThrow(/call is piped/);
    });

    it(`${what}: compatibility: accepts multiple unpiped calls and || guards`, () => {
      expect(() =>
        expectUnpipedCalls(`${unpiped}\n# a note \\\n${unpiped}`, what, needle),
      ).not.toThrow();
    });

    it(`${what}: compatibility: refuses a comment-only match`, () => {
      expect(() => expectUnpipedCalls(`# ${unpiped}`, what, needle)).toThrow(
        /no uncommented/,
      );
    });
  }
});

describe('auto-ship triage: `item-edit --title` gets the DI_ draft-issue content id', () => {
  it('extracts exactly one runnable ID-assignment block (the suite must not be vacuous)', () => {
    // Every execution test below runs BLOCK. If extraction breaks, they would all
    // silently exercise `undefined`, so this failure has to be the loud one.
    expect(
      BLOCKS.length,
      'expected exactly one fenced bash block in ' +
        '.claude/skills/auto-ship/references/github-project.md that runs ' +
        '`gh project item-edit` with `--title` (§8.2). Either the block moved, or a ' +
        'second one appeared and both now need this guard.',
    ).toBe(1);
    expect(BLOCK).toMatch(/gh project item-edit/);
    expect(BLOCK, '§8.2 no longer computes the next TASK-n').toMatch(/TASK-\$NEXT/);
  });

  // BOTH gh calls in §8.2 must keep their own exit status. The execution tests below
  // cover the consequences, but they cannot name the CAUSE: a piped call's title
  // assertion fails too, and a reader chasing it would go looking for a wrong id rather
  // than a discarded `$?`. These two name it directly. (Checked on the logical line,
  // with continuations joined, because both calls are wrapped.)
  for (const [what, needle] of [
    ['gh project item-edit', /gh project item-edit/],
    ['gh api graphql draft-issue lookup', /gh api graphql/],
  ]) {
    it(`enforcement: the ${what} call is not piped, so its status is its own`, () => {
      expectUnpipedCalls(BLOCK, what, needle);
    });
  }

  it('resolves the draft-issue id from $ITEM_ID rather than hardcoding one', () => {
    expect(
      BLOCK,
      '§8.2 must resolve the DraftIssue content id before editing the title.',
    ).toMatch(/gh api graphql/);
    expect(BLOCK).toMatch(/DraftIssue/);
    expect(BLOCK, 'the resolution must be fed the project-item id').toMatch(
      /-f i="\$ITEM_ID"/,
    );
  });

  it('states its shell coverage out loud rather than skipping silently', () => {
    // The Bash tool on the maintainer's machine runs zsh, so §8.2 is executed by zsh in
    // real life; zsh is not guaranteed on a CI runner, so that arm is conditional and
    // this test says which arms exist. jq is NOT conditional: §8.2 needs it for both the
    // NEXT computation and the id extraction, so without it this file has zero execution
    // coverage -- a silent skip there is the very failure mode the card is about.
    expect(SHELLS).toContain('bash');
    expect(SHELLS).toEqual(HAS_ZSH ? ['bash', 'zsh'] : ['bash']);
    expect(
      HAS_JQ,
      'jq is missing, so none of the execution tests in this file can run and the ' +
        'guard would be green for no reason. Install jq (`brew install jq` / ' +
        '`apt-get install jq`); GitHub-hosted runners already have it.',
    ).toBe(true);
  });

  for (const shell of SHELLS) {
    it.runIf(HAS_JQ)(`${shell}: assigns the new title through the DI_ id`, () => {
      const { out, title } = runBlock(shell);
      expect(
        title,
        'the card is still untagged -- `--title` was handed an id the draft-issue ' +
          'mutation refuses (almost certainly $ITEM_ID, the PVTI_ project-item id).',
      ).toBe(EXPECTED_TITLE);
      expect(out, 'a successful assignment must not print FATAL').not.toMatch(/FATAL/);
    });

    it.runIf(HAS_JQ)(`${shell}: preserves the human's title after the tag`, () => {
      // Triage stamps an ID; it never rewrites what the human wrote.
      const { title } = runBlock(shell);
      expect(title.endsWith(ORIGINAL_TITLE), `got: ${title}`).toBe(true);
      expect(title).toMatch(/^\[TASK-402\] /);
    });

    it.runIf(HAS_JQ)(`${shell}: a linked-issue card is refused loudly, not stamped`, () => {
      const { out, title } = runBlock(shell, { hasDraft: false });
      expect(title, 'stamped a card that has no draft-issue content').toBe(
        ORIGINAL_TITLE,
      );
      expect(
        out,
        'the block went quiet on a card it could not resolve a DI_ id for',
      ).toMatch(/FATAL: no draft-issue content/);
    });

    it.runIf(HAS_JQ)(`${shell}: a transient lookup failure is NOT reported as "no draft issue"`, () => {
      // The second pipe trap, and the one a reviewer caught: `DI=$(gh api graphql … |
      // jq …)` throws gh's status away, so an API blip arrives as an empty `$DI` and is
      // indistinguishable from a card that genuinely has no draft issue. Those have
      // different remedies -- retry next pass vs. stop trying -- so the block must say
      // which happened. Same discipline `append_progress` keeps for its own read (§6).
      const { out, title } = runBlock(shell, { lookupFails: true });
      expect(title, 'stamped a card whose id never resolved').toBe(ORIGINAL_TITLE);
      expect(
        out,
        'a failed lookup was not reported as a lookup failure -- almost certainly ' +
          'because gh was piped into jq and its non-zero status was discarded',
      ).toMatch(/FATAL: draft-issue lookup FAILED/);
      expect(
        out,
        'a transient failure was misdiagnosed as "this card has no draft issue"',
      ).not.toMatch(/no draft-issue content/);
    });

    it.runIf(HAS_JQ)(`${shell}: an rc-0 lookup that answers NOTHING is still loud`, () => {
      // The one path an rc-only guard leaves completely silent: gh exits 0 and prints
      // nothing, so the `||` never fires, `$json` is empty, and every downstream test
      // is false. No FATAL, no stamp, no reason -- a card that simply looks untriaged
      // forever, which is the exact symptom this whole card is about. §8.2 therefore
      // tests the OUTPUT for emptiness rather than the exit code alone.
      const { out, title } = runBlock(shell, { lookupEmpty: true });
      expect(title, 'stamped a card off an empty lookup').toBe(ORIGINAL_TITLE);
      expect(
        out,
        'the block said NOTHING about a lookup that returned nothing -- the silent ' +
          'no-op shape. An `|| echo` alone cannot catch this; the guard must test $json.',
      ).toMatch(/FATAL: draft-issue lookup FAILED/);
    });

    it.runIf(HAS_JQ)(`${shell}: a refused item-edit is loud, not swallowed`, () => {
      // The arm the pipe trap hides: gh exits non-zero, nothing is piped, so the `||`
      // fires. If §8.2 ever grows a `| head` here, this is what goes red.
      const { out, title } = runBlock(shell, { editFails: true });
      expect(title).toBe(ORIGINAL_TITLE);
      expect(
        out,
        'gh refused the edit and the block reported success by saying nothing',
      ).toMatch(/FATAL: item-edit refused/);
    });
  }
});
