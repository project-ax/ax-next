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
// one place an exit status is asserted, `refusal is loud`, keys off the FATAL line the
// doc prints, which is itself only reachable because the doc's `||` is unpiped.)
//
// MUTANTS RUN, NOT REASONED ABOUT (2026-09-19, each applied to the committed text and
// executed; baseline 12 passed on a machine with zsh and jq). Every mutant below still
// COLLECTS 12, so none of them reddened by making the suite smaller -- the number to
// distrust is a red count that arrives with a shrunken total.
//
//   - Revert §8.2 to the exact pre-fix line, `--id "$ITEM_ID"` with no resolution and no
//     guards, while LEAVING the surrounding prose in place -> 9 red. That is the vacuity
//     scenario stated as a mutant: the section still says "DI_" four times and explains
//     the measurement, and the guard reddens anyway. `assigns the new title`, `preserves
//     the human's title`, `linked-issue card` and `refusal is loud` x both shells, plus
//     the `gh api graphql` structural check. The title file still holds the untagged
//     title -- the production symptom verbatim.
//   - Keep the resolution but pass `--id "$ITEM_ID"` to the edit anyway -> 4 red:
//     `assigns the new title` and `preserves the human's title` x both shells, while the
//     `gh api graphql` structural check PASSES. A scan would call this fixed. This is the
//     whole argument for executing over grepping, in one mutant.
//   - Delete only the `[ -n "$ok" ] ||` FATAL line -> 2 red, `linked-issue card` x both
//     shells: the block goes quiet on a card it cannot stamp.
//   - Delete only the trailing `|| echo "FATAL: item-edit refused …"` -> 2 red,
//     `refusal is loud` x both shells. This is the arm the pipe trap would hide.
//   - Swap `sort -n` for a plain `sort` in the NEXT computation -> 4 red, `assigns the
//     new title` and `preserves the human's title` x both shells. The fixture's TASK-99
//     sorts above TASK-401 lexically, so NEXT comes out 100 -- a COLLISION with a live
//     card, not merely a wrong number. Not this card's bug, but it rides in the same
//     block and the guard now holds it.
//   - Pipe the edit (`… --title "…" | head -1 || echo FATAL`) -> 3 red: the structural
//     `is not piped` check, plus `refusal is loud` x both shells, because `$?` is now
//     `head`'s and the FATAL arm never fires. Both halves of the trap, from one edit.
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

/** A block's lines with `\`-continuations joined and comment lines dropped. */
function logicalLines(block) {
  return block
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l));
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
function runBlock(shell, { hasDraft = true, editFails = false } = {}) {
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

  it('the item-edit call is not piped, so its `||` can see gh’s own status', () => {
    // Structural, and the one thing execution cannot show: with a pipe, the stub's
    // rc 1 would be laundered into the tail's rc 0 and the FATAL arm would never run --
    // but the *title* assertions would still fail, so the reader would be sent after
    // the wrong bug. This names it directly. (Checked on the logical line, with
    // continuations joined, because the call is wrapped.)
    const editLine = logicalLines(BLOCK).find((l) => /gh project item-edit/.test(l));
    expect(editLine, 'no uncommented `gh project item-edit` line found').toBeTruthy();
    expect(
      editLine.replace(/\|\|/g, ''),
      'the `gh project item-edit` call is piped. `$?` then belongs to the pipeline ' +
        'tail, not to gh -- which is exactly how the 2026-09-18 probe first read rc 0 ' +
        'off a refusal.',
    ).not.toMatch(/\|/);
  });

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
      ).toMatch(/FATAL: no draft-issue id/);
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
