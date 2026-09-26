// Guard: allocating a `[TASK-n]` board id must be safe when several sessions do it at
// once. Two cards must never keep the same id.
//
// ---------------------------------------------------------------------------------
// WHY THIS EXISTS (TASK-426).
//
// Assigning a Task ID was a read-modify-write with no atomicity:
//
//     NEXT=$(printf '%s' "$ITEMS" | jq -r '…capture("\\[TASK-(?<n>[0-9]+)\\]").n…' \
//             | sort -n | tail -1); NEXT=$(( ${NEXT:-0} + 1 ))
//
// `$ITEMS` is a per-pass board snapshot, bound once at the top of the pass (§3 tells the
// orchestrator not to re-read it). The comment above that line claimed "computed from the
// already-bound `$ITEMS` so there's no race", and within ONE orchestrator pass that is
// true. Across sessions it is false, and the ax-next board has several writers.
//
// MEASURED 2026-09-19: two sessions each created TASK-420 and TASK-421 within minutes.
// Caught by a later `jq` noticing two ids for one number, not by any guard. The same day
// a third session landed on a `[TASK-454]` another session had just taken. Task IDs are
// the board's only stable handle — `Depends on`, the journal, dispatch prompts and
// `.claude/memory` rows all key on them — so a duplicate corrupts four things silently.
//
// ---------------------------------------------------------------------------------
// WHAT IS AND IS NOT ACHIEVABLE, STATED HONESTLY.
//
// GitHub Projects v2 offers no atomic counter and no uniqueness constraint on a card
// title. So "two concurrent creators cannot receive the same id" is NOT achievable by
// construction through this API, and this suite does not pretend to test that. What is
// achievable, and what is tested here, is that a collision cannot SURVIVE: claim
// optimistically, verify against a fresh read, and have exactly one party yield.
//
// The yield rule is deterministic rather than randomized, which is what keeps two racers
// from ping-ponging: the colliding card with the LOWEST item node id keeps the number,
// every other one renumbers ITSELF. A process never renames another session's card —
// that invariant is what makes two settles running at once safe, and `the loser renames
// only its own card` below pins it.
//
// ---------------------------------------------------------------------------------
// WHY THIS SUITE RUNS THE SCRIPT INSTEAD OF READING IT.
//
// The card's acceptance says it in as many words: "construct that state and run it, do
// not reason about it". So `duplicate state` below builds a board that genuinely holds
// two `[TASK-420]` cards and runs the guard against it, and `two concurrent claimers`
// starts two real `claim` processes against one shared board, rendezvoused on a barrier
// so that both are PROVEN to compute the same max — the collision is injected, not hoped
// for. A test that merely started two processes and found different ids would mostly be
// measuring that the race is narrow.
//
// The `gh` on PATH is a stub (`node`, in a temp dir), so nothing here reaches GitHub.
// Its board is a directory of one JSON file per card, which models the real thing in the
// one way that matters: `item-create` has no idea whether the title it is given is
// already taken.
//
// MUTANTS RUN, NOT REASONED ABOUT (2026-09-19; each applied to the committed script and
// executed, then restored with `git checkout --`). Counts below are the RE-MEASURED ones
// against the post-review script: baseline 25 collected, 25 passed at the time of that
// battery, and every mutant still COLLECTED 25 — the number to distrust is a red count
// that arrives with a shrunken total. The file has grown since (the doc-branching guard
// and the cross-prefix case landed after), so a rerun today collects MORE than 25; the
// per-mutant red counts below are the ones that were measured, not re-derived.
//
// A WARNING THAT COST ME AN HOUR, AND IS NOT ABOUT MUTANTS AT ALL. Restoring a mutant
// with `git checkout HEAD -- scripts/board-task-id.sh` (HEAD, not the bare form — that reads
// the index, so a staged mutant comes back; TASK-508) is correct for whoever is running the
// battery and DESTRUCTIVE to anyone else editing that file at the same moment. The
// yolo-ship reviewer is dispatched WITHOUT its own worktree, so it shares the builder's
// tree. Mine ran this same battery while I was applying its findings: my six edits
// vanished, and the failing run I then spent a detour debugging was executing ITS mutant
// — a deterministic keeper branch that provably could not behave the way I was seeing.
// `git diff --stat` disagreeing with what you just wrote is the tell. Commit before
// anyone else touches the tree.
//
//   M1. `board_or_die` reduced to a bare `read_board` — the naive version anyone writes
//       first, with no guards at all -> 3 red: `a failed board read is not a pass`,
//       `a malformed board read is not a pass`, `an empty board is not a pass`. This is
//       the direction that matters: a guard that exits 0 because it could not look is
//       worse than no guard, and all three of those exit 0 without it.
//   M2. Keep the read-failure guard, drop only the empty-board check -> 1 red,
//       `an empty board is not a pass`. The subtler half: `gh` exits 0, the JSON parses,
//       and the answer is `[]`. A `length > 0` test is the only thing between that and
//       "no cards, therefore no duplicates".
//   M3. `settle` exits as soon as its rename succeeds, instead of looping to re-verify
//       -> 2 red. THIS ONE SURVIVED THE FIRST VERSION OF THIS FILE — 0 red across every
//       other test here, because with TWO parties it is genuinely enough: the
//       deterministic keeper means only one of them renames, and it renames to a free
//       number. It is wrong only with three, where two non-keepers compute the same
//       `max+1` and swap one duplicate for another. `a three-way collision resolves` was
//       written for exactly that. A suite that stops at the headline scenario grades the
//       easy case.
//   M4. `settle` always yields (the deterministic keeper branch removed) -> 3 red:
//       `the keeper keeps its number`, `two concurrent claimers` and `a three-way
//       collision resolves`. Note the middle one: both parties move, both land on the
//       same `max+1`, and they collide AGAIN. A randomized backoff is what this mutant
//       amounts to, and it is why the keeper rule is deterministic instead.
//   M5. `settle` renames through the `PVTI_` item id instead of the `DI_` content id ->
//       5 red, every test that makes a card actually move. The stub refuses exactly as
//       real `gh` was measured to in TASK-401.
//   M6. `next_num` compares lexically instead of numerically -> 1 red, `next is numeric,
//       not lexical`. The fixture's TASK-99 sorts above TASK-401 as a string, so the
//       answer becomes 100 — a number a live card already holds. Not a wrong number, a
//       COLLISION, manufactured by the allocator itself.
//   M7. `read_board` stops after the first page -> 1 red, `pagination reaches the last
//       page`. The board passed 300 items in Aug 2026 and Done cards never leave, so a
//       lone `first:100` computes the max from the OLDEST cards.
//   M8. `next_num` restricted to the `TASK` prefix -> 1 red, `next counts every prefix`.
//       A REVIEWER FOUND THIS ONE SURVIVING all 23 tests of the previous version. The
//       script documents one counter across every prefix and nothing held it, because no
//       test had ever put a non-`TASK` card at the board maximum. Worth noticing that
//       `check` would not have flagged the drift either — `ARCH-500` and `TASK-500` are
//       genuinely different ids, so the damage is a human misreading rather than a
//       detectable duplicate. Documented behaviour with no test is a preference, not a
//       property.
//
// Lives in scripts/__tests__/, which `pnpm test:scripts` runs unconditionally — no
// network, no build.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'board-task-id.sh');

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
// The `gh` stub and its board.
// ---------------------------------------------------------------------------------

const STUB_DIR = mkdtempSync(join(tmpdir(), 'board-task-id-stub-'));

/**
 * `gh`, reduced to the three calls the script makes, over a board that is a directory of
 * per-card JSON files.
 *
 * One file per card is not an implementation convenience — it is the fidelity that makes
 * the concurrency test meaningful. Two processes creating cards at the same time write
 * two different files and neither blocks the other, exactly as GitHub accepts two
 * `item-create`s with the same title.
 *
 * `item-edit --title` mirrors the behaviour measured in TASK-401: accepted only for a
 * `DI_`-prefixed content id, refused for the `PVTI_` item id with gh's own wording.
 */
writeFileSync(
  join(STUB_DIR, 'gh'),
  `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = process.env.STUB_BOARD_DIR;
const argv = process.argv.slice(2);

function cards() {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      // A concurrent creator may be mid-write; an unreadable/partial file is simply not
      // on the board yet, which is what a real eventually-consistent read looks like.
      try {
        return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
}

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Rendezvous: hold every participant at its FIRST board read until STUB_BARRIER_N of
 * them have arrived, so they all compute the same max. Only the first read of each
 * process waits (a marker file per process), so the settle loop afterwards is free to
 * run at its own pace.
 */
function barrier() {
  const file = process.env.STUB_BARRIER;
  if (!file) return;
  const mine = file + '.' + process.env.STUB_PARTY;
  if (fs.existsSync(mine)) return;
  fs.writeFileSync(mine, 'x');
  fs.appendFileSync(file, process.env.STUB_PARTY + '\\n');
  const want = Number(process.env.STUB_BARRIER_N || '2');
  const deadline = Date.now() + 15000;
  for (;;) {
    const n = fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean).length;
    if (n >= want) return;
    if (Date.now() > deadline) return;
    // Busy-wait on purpose: this stub has no event loop to yield to and the window is
    // milliseconds. Atomics.wait would need a SharedArrayBuffer these processes cannot share.
    const t = Date.now() + 5;
    while (Date.now() < t) { /* spin */ }
  }
}

if (argv[0] === 'api' && argv[1] === 'graphql') {
  if (process.env.STUB_READ_FAILS === '1') {
    process.stderr.write('gh: Post "https://api.github.com/graphql": dial tcp: i/o timeout\\n');
    process.exit(1);
  }
  if (process.env.STUB_READ_MALFORMED === '1') {
    process.stdout.write('<html>502 Bad Gateway</html>\\n');
    process.exit(0);
  }
  barrier();
  const all = process.env.STUB_READ_EMPTY === '1' ? [] : cards();
  const size = Number(process.env.STUB_PAGE_SIZE || '100');
  let after = undefined;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '-f' || argv[i] === '-F') && String(argv[i + 1]).startsWith('after=')) {
      const v = String(argv[i + 1]).slice('after='.length);
      after = v === 'null' ? undefined : v;
    }
  }
  const start = after === undefined ? 0 : all.findIndex((c) => c.item === after) + 1;
  const page = all.slice(start, start + size);
  const hasNext = start + size < all.length;
  process.stdout.write(
    JSON.stringify({
      data: {
        organization: {
          projectV2: {
            items: {
              pageInfo: {
                hasNextPage: hasNext,
                endCursor: page.length ? page[page.length - 1].item : null,
              },
              nodes: page.map((c) => ({ id: c.item, content: { id: c.draft, title: c.title } })),
            },
          },
        },
      },
    }) + '\\n',
  );
  process.exit(0);
}

if (argv[0] === 'project' && argv[1] === 'item-create') {
  if (process.env.STUB_CREATE_FAILS === '1') {
    process.stderr.write('failed to create item: something transient\\n');
    process.exit(1);
  }
  const suffix = String(process.env.STUB_PARTY || 'x') + '_' + process.pid + '_' + Date.now();
  const card = { item: 'PVTI_' + suffix, draft: 'DI_' + suffix, title: flag('--title') };
  fs.writeFileSync(path.join(DIR, card.item + '.json'), JSON.stringify(card));
  process.stdout.write(JSON.stringify({ id: card.item }) + '\\n');
  process.exit(0);
}

if (argv[0] === 'project' && argv[1] === 'item-edit') {
  const id = flag('--id');
  const title = flag('--title');
  if (!String(id).startsWith('DI_')) {
    // Measured verbatim, TASK-401.
    process.stderr.write('ID must be the ID of the draft issue content which is prefixed with DI_\\n');
    process.exit(1);
  }
  const found = cards().find((c) => c.draft === id);
  if (!found) { process.stderr.write('no such draft issue\\n'); process.exit(1); }
  found.title = title;
  fs.writeFileSync(path.join(DIR, found.item + '.json'), JSON.stringify(found));
  process.stdout.write('Edited item "' + title + '"\\n');
  process.exit(0);
}

process.stderr.write('stub gh: unhandled invocation: ' + argv.join(' ') + '\\n');
process.exit(64);
`,
  { mode: 0o755 },
);

afterAll(() => {
  try {
    rmSync(STUB_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

let boardDir;

beforeEach(() => {
  boardDir = mkdtempSync(join(tmpdir(), 'board-task-id-board-'));
});

/** Put a card on the fake board. `item` doubles as the file name and the sort key. */
function seed(item, title) {
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(
    join(boardDir, `${item}.json`),
    JSON.stringify({ item, draft: item.replace(/^PVTI_/, 'DI_'), title }),
  );
}

function boardTitles() {
  return readdirSync(boardDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(boardDir, f), 'utf8')).title)
    .sort();
}

function run(args, { shell = 'bash', env = {} } = {}) {
  const r = spawnSync(shell, ['-c', `"$0" "$@"`, SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${STUB_DIR}:${process.env.PATH}`,
      STUB_BOARD_DIR: boardDir,
      BOARD_TASK_ID_BACKOFF_MS: '30',
      ...env,
    },
    cwd: REPO_ROOT,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const SHELLS = ['bash', ...(HAS_ZSH ? ['zsh'] : [])];

// ---------------------------------------------------------------------------------
// The doc-wiring scanner, as PURE functions (TASK-472).
//
// These used to live inline in the wiring test below, which meant the only input they
// ever saw was the real docs. The review pass on #625 measured what that costs: revert
// the exemption from the marker back to the old shape rule and the wiring test stays
// GREEN (`calls=4`), because the real docs happen to carry a correctly-spelled marker.
// No automated test could catch a regression of the fix itself. Factored out, the same
// code the wiring test runs is fed hostile fence bodies by the table in the
// `allocator-call scanner` suite at the bottom of this file.
// ---------------------------------------------------------------------------------

const REFERENCE_LISTING_MARKER = /#\s*board-task-id:\s*reference listing\b/;
const ALLOCATOR_CALL = /scripts\/board-task-id\.sh\s+(claim|settle)\b/;
const VACUITY_FLOOR = 2;

// Only ```bash FENCES, not "everything between fences" — a naive split enrols the
// prose paragraphs too, and a sentence that merely names `scripts/board-task-id.sh`
// in backticks then reads as an unguarded call site. (Measured: my first version of
// this test failed on §4's design-intake PARAGRAPH.)
function bashFences(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```bash\s*$/.test(lines[i])) continue;
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !/^\s*```\s*$/.test(lines[j]); j++) body.push(lines[j]);
    blocks.push(body.join('\n'));
    i = j;
  }
  return blocks;
}

/**
 * One fence body in, the decision out: is the fence exempt, and which allocator call
 * lines does it contribute? Checked on LOGICAL lines, with `\`-continuations joined.
 */
function scanFence(body) {
  const code = body
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((l) => l.trim() && !/^\s*#/.test(l));
  // The exemption is an EXPLICIT MARKER, not an inference from the block's shape.
  //
  // It used to be "every non-comment line is a bare `scripts/board-task-id.sh …`
  // invocation, so nothing depends on the result". That reasoning is fine and the
  // rule built from it was worthless, in the specific way that matters: a lone bare
  // call in its own fence satisfies `every(...)` trivially — and a lone bare call IS
  // the regression. MEASURED: with the shape rule in place, reverting SKILL.md's
  // fenced `if TASK_ID=$(… settle …)` back to the bare form produced **0 red across
  // 26**. The guard could not catch the exact bug it was written for, because the
  // mutant deleted the very lines that disqualified the block from being exempt.
  // Every additional line you remove makes an unsafe block *more* exempt. That is a
  // rule whose strength runs backwards.
  //
  // So: default CHECKED, opt out on purpose and in writing. A doc that genuinely
  // lists the CLI says so in the fence, and the marker is greppable, reviewable, and
  // impossible to arrive at by deletion.
  //
  // THE RESIDUAL, MEASURED RATHER THAN REASONED. An opt-out opts out: adding a real
  // board write inside the MARKED block is 0 red, and removing the marker from that
  // same block is 1 red. So the marker can still hide a call site — what changed is
  // the direction of the mistake. Under the shape rule you became exempt by DELETING
  // the lines that made you safe, silently, while shrinking a block. Here you become
  // exempt only by ADDING a line that says "this is not a call site", in a diff, next
  // to a comment telling you to delete it if that stops being true. A wrong marker is
  // a visible claim someone can disagree with; the old rule made no claim at all.
  // Tested against the RAW block, not `code` — the marker IS a comment, and `code`
  // has already dropped every comment line.
  if (REFERENCE_LISTING_MARKER.test(body)) return { exempt: true, calls: [] };
  return { exempt: false, calls: code.filter((l) => ALLOCATOR_CALL.test(l)).map((l) => l.trim()) };
}

/** Every counted allocator call line across a set of doc texts. */
function allocatorCalls(docTexts) {
  return docTexts.flatMap(bashFences).flatMap((b) => scanFence(b).calls);
}

/** What the wiring test fails on; `[]` means the docs are sound. */
function wiringProblems(calls) {
  const problems = [];
  // Vacuity guard: if the extractor stops matching, every assertion below passes by
  // iterating nothing — the precise way a doc-scanning test goes quietly useless.
  if (calls.length < VACUITY_FLOOR) {
    problems.push(
      'found fewer than 2 `scripts/board-task-id.sh claim|settle` calls across the ' +
        'auto-ship docs — either the wiring was removed or this extractor stopped ' +
        'matching it, and in the second case every assertion below passes on an empty ' +
        'list',
    );
  }
  for (const line of calls) {
    if (!line.startsWith('if ')) {
      problems.push(
        `this allocator call does not branch on failure:\n    ${line}\n` +
          'Put the writes that depend on it inside `if …; then … else <FATAL> fi`. A ' +
          '`|| echo "FATAL…"` prints and then continues, which is how a duplicate id ' +
          'gets routed into `Depends on` one line after being told not to.',
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------

describe('board-task-id.sh — Task-ID allocation under concurrency', () => {
  it('states its coverage out loud rather than skipping silently', () => {
    expect(SHELLS).toContain('bash');
    expect(SHELLS).toEqual(HAS_ZSH ? ['bash', 'zsh'] : ['bash']);
    expect(
      HAS_JQ,
      'jq is missing, so every execution test in this file would be skipped and the ' +
        'guard would be green for no reason. `brew install jq` / `apt-get install jq`; ' +
        'GitHub-hosted runners already have it.',
    ).toBe(true);
  });

  // -------------------------------------------------------------------------------
  // Acceptance #1: CONSTRUCT the duplicate state and run the guard against it.
  // -------------------------------------------------------------------------------

  it.runIf(HAS_JQ)('FAILS on a board where two cards share a [TASK-n] prefix', () => {
    seed('PVTI_a', '[TASK-420] dem-first design doc: drop the graph channel');
    seed('PVTI_b', '[TASK-420] An attached image leaves no trace in the transcript');
    seed('PVTI_c', '[TASK-421] memory-facts contract + sqlite engine');
    const { code, out } = run(['check']);
    expect(code, 'the guard passed a board that holds two TASK-420 cards').not.toBe(0);
    expect(out).toMatch(/TASK-420/);
    expect(out, 'the duplicate must name the cards, not just the number').toMatch(
      /PVTI_a[\s\S]*PVTI_b|PVTI_b[\s\S]*PVTI_a/,
    );
    expect(out, 'TASK-421 is held by one card and must not be reported').not.toMatch(
      /TASK-421/,
    );
  });

  it.runIf(HAS_JQ)('passes a board where every [TASK-n] is held once', () => {
    seed('PVTI_a', '[TASK-420] one');
    seed('PVTI_b', '[TASK-421] two');
    seed('PVTI_c', 'an untagged card a human just dropped in');
    const { code, out } = run(['check']);
    expect(out).not.toMatch(/FATAL/);
    expect(code).toBe(0);
  });

  it.runIf(HAS_JQ)('counts prefixes separately — ARCH-4 and TASK-4 are different ids', () => {
    seed('PVTI_a', '[ARCH-4] the kernel');
    seed('PVTI_b', '[TASK-4] something else');
    expect(run(['check']).code).toBe(0);
  });

  // -------------------------------------------------------------------------------
  // Guard direction. Every one of these must be NON-zero: a check that cannot see the
  // board has not checked it.
  // -------------------------------------------------------------------------------

  it.runIf(HAS_JQ)('a failed board read is not a pass', () => {
    seed('PVTI_a', '[TASK-420] one');
    const { code, out } = run(['check'], { env: { STUB_READ_FAILS: '1' } });
    expect(code, 'exited 0 on a board it never read').not.toBe(0);
    expect(out).toMatch(/FATAL/);
  });

  it.runIf(HAS_JQ)('a malformed board read is not a pass', () => {
    seed('PVTI_a', '[TASK-420] one');
    const { code, out } = run(['check'], { env: { STUB_READ_MALFORMED: '1' } });
    expect(code, 'exited 0 on a board that came back as HTML').not.toBe(0);
    expect(out).toMatch(/FATAL/);
  });

  it.runIf(HAS_JQ)('an empty board is not a pass', () => {
    // A truncated or garbled read that still parses is indistinguishable from a board
    // with nothing on it. The ax-next board has never been empty, so "empty" is the
    // signature of a read that failed quietly — and "no cards, therefore no duplicates"
    // is precisely the fail-open shape this card exists to remove.
    seed('PVTI_a', '[TASK-420] one');
    const { code, out } = run(['check'], { env: { STUB_READ_EMPTY: '1' } });
    expect(code, 'exited 0 on an empty answer').not.toBe(0);
    expect(out).toMatch(/FATAL/);
  });

  it.runIf(HAS_JQ)('a board jq cannot analyse is not a pass either', () => {
    // The third fail-open shape, and the quietest: `gh` succeeded, the JSON parsed, and
    // the ANALYSIS is what fails. jq writes its errors to stderr and nothing to stdout,
    // so an unchecked `dups=$(… | jq …)` comes back empty — byte-identical to "no
    // duplicates found". A non-string title is the cheapest way to construct it: jq's
    // `capture` refuses a number.
    const f = join(boardDir, 'hostile.json');
    writeFileSync(
      f,
      JSON.stringify([
        { item: 'PVTI_a', draft: 'DI_a', title: 123 },
        { item: 'PVTI_b', draft: 'DI_b', title: '[TASK-420] fine' },
      ]),
    );
    const { code, out } = run(['check', '--board', f]);
    expect(code, 'reported a clean board it could not actually analyse').not.toBe(0);
    expect(out).toMatch(/FATAL/);
  });

  it.runIf(HAS_JQ)('--board reads a normalized board without touching gh', () => {
    // Also the offline entry point: `check` and `next` need no network at all this way.
    const f = join(boardDir, 'offline.json');
    writeFileSync(
      f,
      JSON.stringify([
        { item: 'PVTI_a', draft: 'DI_a', title: '[TASK-420] one' },
        { item: 'PVTI_b', draft: 'DI_b', title: '[TASK-420] two' },
      ]),
    );
    const { code, out } = run(['check', '--board', f], { env: { STUB_READ_FAILS: '1' } });
    expect(code, 'gh was consulted despite --board').not.toBe(0);
    expect(out, 'the duplicate came from the file, not from a failed gh read').toMatch(
      /TASK-420 is held by 2 cards/,
    );
  });

  // -------------------------------------------------------------------------------
  // `next`.
  // -------------------------------------------------------------------------------

  it.runIf(HAS_JQ)('next refuses to answer rather than answering nothing', () => {
    // An unchecked `$(next_num …)` is the empty string when jq fails, and `[TASK-$NEXT]`
    // then stamps the literal title `[TASK-] …` — a card with no id, which every
    // consumer reads as "untagged" and which the duplicate guard would never flag.
    const f = join(boardDir, 'hostile.json');
    writeFileSync(f, JSON.stringify([{ item: 'PVTI_a', draft: 'DI_a', title: 99 }]));
    const { code, out } = run(['next', '--board', f]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/FATAL/);
    expect(out, 'printed something that would be stamped onto a card').not.toMatch(
      /^\s*\d+\s*$/m,
    );
  });

  it.runIf(HAS_JQ)('next is numeric, not lexical', () => {
    // TASK-99 sorts ABOVE TASK-401 lexically, so a plain `sort` answers 100 — a number
    // a live card already holds. The same decoy the TASK-401 guard uses.
    seed('PVTI_a', '[TASK-99] an old one');
    seed('PVTI_b', '[TASK-401] the card that found this');
    seed('PVTI_c', '[TASK-100] a live card that 100 would collide with');
    const { code, out } = run(['next']);
    expect(code).toBe(0);
    expect(out.trim()).toBe('402');
  });

  it.runIf(HAS_JQ)('next counts every prefix, not just TASK', () => {
    // One counter across ARCH/CLI/SYNC/FAULTA/TASK, which the script documents and
    // nothing pinned: a reviewer applied `select(.prefix == "TASK")` to `next_num` and
    // all 23 tests stayed green. `ARCH-500` and `TASK-500` really are different ids, so
    // `check` would not flag the drift either — handing out a fresh `TASK-500` next to a
    // historical `ARCH-500` is a human misreading waiting to happen, which is the same
    // failure this card is about one level up.
    seed('PVTI_a', '[ARCH-500] the highest number on the board');
    seed('PVTI_b', '[TASK-100] the highest TASK');
    const { code, out } = run(['next']);
    expect(code).toBe(0);
    expect(out.trim(), 'the max was taken from the TASK prefix alone').toBe('501');
  });

  it.runIf(HAS_JQ)('pagination reaches the last page', () => {
    // The board passed 300 items in Aug 2026 and Done cards never leave. A lone
    // `first:100` reads the OLDEST cards and computes a max that is already taken.
    // Item ids sort ascending in the stub, so PVTI_z001 is on the last page.
    for (let i = 1; i <= 12; i++) {
      seed(`PVTI_a${String(i).padStart(3, '0')}`, `[TASK-${i}] filler ${i}`);
    }
    seed('PVTI_z001', '[TASK-900] the newest card');
    const { code, out } = run(['next'], { env: { STUB_PAGE_SIZE: '5' } });
    expect(code).toBe(0);
    expect(out.trim(), 'the max came from an early page — pagination stopped short').toBe(
      '901',
    );
  });

  // -------------------------------------------------------------------------------
  // `settle`.
  // -------------------------------------------------------------------------------

  it.runIf(HAS_JQ)('settle is a no-op on a card whose id is unique', () => {
    seed('PVTI_a', '[TASK-420] mine');
    seed('PVTI_b', '[TASK-421] theirs');
    const { code, out } = run(['settle', '--item', 'PVTI_a']);
    expect(code).toBe(0);
    expect(boardTitles()).toEqual(['[TASK-420] mine', '[TASK-421] theirs']);
    expect(out).not.toMatch(/FATAL/);
  });

  it.runIf(HAS_JQ)('the loser renames only its own card', () => {
    // PVTI_b is not the lowest item id in the cohort, so it must yield — and PVTI_a,
    // which may belong to another session mid-build with a branch and a PR title, must
    // come back untouched. This invariant is what makes two settles safe at once.
    seed('PVTI_a', '[TASK-420] theirs, and possibly already referenced');
    seed('PVTI_b', '[TASK-420] mine, created seconds ago');
    seed('PVTI_c', '[TASK-421] unrelated');
    const { code, out } = run(['settle', '--item', 'PVTI_b']);
    expect(code, out).toBe(0);
    expect(boardTitles()).toEqual([
      '[TASK-420] theirs, and possibly already referenced',
      '[TASK-421] unrelated',
      '[TASK-422] mine, created seconds ago',
    ]);
  });

  it.runIf(HAS_JQ)('the keeper keeps its number', () => {
    // The other half of the same rule. If both parties yielded, the board would still be
    // consistent but every collision would burn a number and leave a hole — and, worse,
    // two yielders can pick the same next number and collide again.
    seed('PVTI_a', '[TASK-420] mine, and I hold the lowest item id');
    seed('PVTI_b', '[TASK-420] theirs');
    const { code, out } = run(['settle', '--item', 'PVTI_a'], {
      env: { BOARD_TASK_ID_MAX_ATTEMPTS: '2' },
    });
    // The other party never yields here, so this must end LOUD rather than pretend.
    expect(code, 'an unresolved duplicate exited 0').not.toBe(0);
    expect(out).toMatch(/FATAL/);
    expect(out, 'the failure must name both cards so a human can repair it').toMatch(
      /PVTI_a[\s\S]*PVTI_b|PVTI_b[\s\S]*PVTI_a/,
    );
    expect(
      boardTitles().filter((t) => t.startsWith('[TASK-420]')).length,
      'the keeper renamed itself instead of holding its number',
    ).toBe(2);
  });

  it.runIf(HAS_JQ)('settle prints the SURVIVING id on stdout, prose on stderr', () => {
    // The caller's `$TASK_ID` is stale the moment its card yields. If the surviving id
    // were only mentioned inside a sentence on stdout, every later use of it — the
    // dispatch prompt, the journal row, the `Depends on` field — would name a number
    // this card no longer carries. Silent id drift, which is what this whole card is
    // about, reintroduced one level up by the repair.
    seed('PVTI_a', '[TASK-420] theirs');
    seed('PVTI_b', '[TASK-420] mine');
    const r = spawnSync('bash', ['-c', `"$0" settle --item PVTI_b 2>/dev/null`, SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${STUB_DIR}:${process.env.PATH}`,
        STUB_BOARD_DIR: boardDir,
        BOARD_TASK_ID_BACKOFF_MS: '30',
      },
      cwd: REPO_ROOT,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(
      r.stdout.trim(),
      'stdout must be exactly the id that survived — it is what the caller carries forward',
    ).toBe('TASK-421');
    expect(boardTitles()).toContain('[TASK-421] mine');
  });

  it.runIf(HAS_JQ)('renames through the draft-issue content id', () => {
    // TASK-401's measurement: `gh` routes `--title` to `updateProjectV2DraftIssue`, which
    // addresses the CONTENT node, and refuses a `PVTI_` id outright. A settle that
    // renamed through the item id would fail on every real collision.
    seed('PVTI_a', '[TASK-420] theirs');
    seed('PVTI_b', '[TASK-420] mine');
    const { code, out } = run(['settle', '--item', 'PVTI_b']);
    expect(out, 'the rename was sent to the PVTI_ item id').not.toMatch(
      /prefixed with DI_/,
    );
    expect(code, out).toBe(0);
  });

  it.runIf(HAS_JQ)('refuses an item id that is not on the board', () => {
    seed('PVTI_a', '[TASK-420] one');
    const { code, out } = run(['settle', '--item', 'PVTI_nope']);
    expect(code).not.toBe(0);
    expect(out).toMatch(/FATAL/);
  });

  it.runIf(HAS_JQ)('refuses a card that carries no [PREFIX-n] at all', () => {
    seed('PVTI_a', 'an untagged card');
    const { code, out } = run(['settle', '--item', 'PVTI_a']);
    expect(code).not.toBe(0);
    expect(out).toMatch(/FATAL/);
  });

  // -------------------------------------------------------------------------------
  // Acceptance #2: two concurrent creators.
  // -------------------------------------------------------------------------------

  it.runIf(HAS_JQ)(
    'two concurrent claimers that provably compute the same max end up with different ids',
    async () => {
      seed('PVTI_a001', '[TASK-420] a card that already exists');
      seed('PVTI_a002', '[TASK-421] and another');

      const barrierFile = join(boardDir, '..', `barrier-${process.pid}-${Date.now()}`);
      writeFileSync(barrierFile, '');

      /**
       * Both processes block inside the stub's FIRST board read until both have arrived,
       * so both provably see the same board and compute the same `max+1`. The collision
       * is constructed, not waited for.
       */
      const party = (name) =>
        new Promise((resolve) => {
          const p = spawn(SCRIPT, ['claim', '--title', `card from ${name}`, '--body', 'x'], {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${STUB_DIR}:${process.env.PATH}`,
              STUB_BOARD_DIR: boardDir,
              STUB_BARRIER: barrierFile,
              STUB_BARRIER_N: '2',
              STUB_PARTY: name,
              BOARD_TASK_ID_BACKOFF_MS: '50',
            },
            cwd: REPO_ROOT,
          });
          let out = '';
          p.stdout.on('data', (d) => (out += d));
          p.stderr.on('data', (d) => (out += d));
          p.on('close', (code) => resolve({ code, out }));
        });

      const [one, two] = await Promise.all([party('one'), party('two')]);

      expect(one.code, `claimer one failed:\n${one.out}`).toBe(0);
      expect(two.code, `claimer two failed:\n${two.out}`).toBe(0);

      const titles = boardTitles();
      expect(titles.length, 'both claimers must have created a card').toBe(4);

      const ids = titles
        .map((t) => /^\[(TASK-\d+)\]/.exec(t))
        .filter(Boolean)
        .map((m) => m[1]);
      expect(ids.length, `some card lost its id prefix: ${JSON.stringify(titles)}`).toBe(4);
      expect(
        new Set(ids).size,
        `two cards kept the same id: ${JSON.stringify(titles)}`,
      ).toBe(4);

      // And the pre-existing cards were not touched by either claimer.
      expect(titles).toContain('[TASK-420] a card that already exists');
      expect(titles).toContain('[TASK-421] and another');
    },
    30_000,
  );

  it.runIf(HAS_JQ)(
    'a three-way collision resolves: two yielders that pick the same number re-verify',
    async () => {
      // This is the case that makes the re-verify LOOP load-bearing rather than
      // decorative, and it is here because a mutant proved the point: "exit as soon as
      // the rename succeeds" passed every other test in this file. With two parties it
      // is genuinely enough — only one of them renames. With three it is not.
      //
      // All three cards hold TASK-420. PVTI_a is the keeper and is not settling (its
      // session has already moved on). The other two settle at once, rendezvoused so
      // both compute the same `max+1`, so both rename themselves to TASK-421 — and a
      // settle that stopped there would have swapped one duplicate for another.
      seed('PVTI_a', '[TASK-420] the keeper, whose session has moved on');
      seed('PVTI_b', '[TASK-420] second');
      seed('PVTI_c', '[TASK-420] third');

      const barrierFile = join(boardDir, '..', `barrier3-${process.pid}-${Date.now()}`);
      writeFileSync(barrierFile, '');

      const party = (name, item) =>
        new Promise((resolve) => {
          const p = spawn(SCRIPT, ['settle', '--item', item], {
            env: {
              ...process.env,
              PATH: `${STUB_DIR}:${process.env.PATH}`,
              STUB_BOARD_DIR: boardDir,
              STUB_BARRIER: barrierFile,
              STUB_BARRIER_N: '2',
              STUB_PARTY: name,
              BOARD_TASK_ID_BACKOFF_MS: '50',
            },
            cwd: REPO_ROOT,
          });
          let out = '';
          p.stdout.on('data', (d) => (out += d));
          p.stderr.on('data', (d) => (out += d));
          p.on('close', (code) => resolve({ code, out }));
        });

      const [b, c] = await Promise.all([party('b', 'PVTI_b'), party('c', 'PVTI_c')]);
      expect(b.code, `settle on PVTI_b failed:\n${b.out}`).toBe(0);
      expect(c.code, `settle on PVTI_c failed:\n${c.out}`).toBe(0);

      const titles = boardTitles();
      const ids = titles.map((t) => /^\[(TASK-\d+)\]/.exec(t)?.[1]);
      expect(ids.filter(Boolean).length, `a card lost its id: ${JSON.stringify(titles)}`).toBe(3);
      expect(
        new Set(ids).size,
        `two cards still share an id after settling: ${JSON.stringify(titles)}`,
      ).toBe(3);
      // The keeper never moved: it holds the lowest item id and nobody renames another
      // session's card.
      expect(titles).toContain('[TASK-420] the keeper, whose session has moved on');
    },
    30_000,
  );

  // -------------------------------------------------------------------------------
  // WHAT THE zsh ARM ACTUALLY COVERS, stated precisely because a reviewer caught the
  // looser version overselling it.
  //
  // `board-task-id.sh` has a bash shebang and is always EXECUTED, never sourced, so its
  // body runs under bash no matter who calls it. These cases therefore do NOT test the
  // script's own syntax under zsh — they test the CALLER's side: that a zsh caller hands
  // the arguments over intact and reads the answer back the same way. That is the real
  // exposure, because the Bash tool on the maintainer's machine is zsh and every
  // documented call site in the auto-ship docs is typed into it. Worth having, worth not
  // claiming more than it is.
  // -------------------------------------------------------------------------------

  for (const shell of SHELLS) {
    it.runIf(HAS_JQ)(`${shell}: check reports a duplicate the same way`, () => {
      seed('PVTI_a', '[TASK-420] one');
      seed('PVTI_b', '[TASK-420] two');
      const { code, out } = run(['check'], { shell });
      expect(code).not.toBe(0);
      expect(out).toMatch(/TASK-420/);
    });
  }

  // -------------------------------------------------------------------------------
  // Wiring (CLAUDE.md invariant 3 — a guard nobody calls is not wired in).
  // -------------------------------------------------------------------------------

  it('every documented allocator call BRANCHES on failure, never `|| echo` and onward', () => {
    // This one exists because the same mistake landed TWICE in this file, thirty lines
    // apart, and a reviewer caught both. The shape:
    //
    //     TASK_ID=$(scripts/board-task-id.sh settle --item "$ITEM_ID") \
    //       || echo "FATAL: … do not write deps for $ITEM_ID" >&2
    //     gh project item-edit … --field-id "$DEPS_FIELD_ID" --text "$DEPS"
    //
    // `|| echo` captures the status correctly and then falls straight through, so the
    // FATAL line announces the corruption and the next line performs it. `settle` exits
    // non-zero precisely when the id is STILL a duplicate, so routing anyway wires a
    // duplicate-numbered card into `Depends on` and into readiness — exactly what this
    // card was filed to stop. A FATAL followed by carrying on is not a guard, it is a
    // comment.
    //
    // So: every call to the allocator in the doc must sit in an `if`, where the failure
    // path is a branch rather than a line of prose. Checked on LOGICAL lines, with
    // `\`-continuations joined, because both real call sites wrap.
    // ALL THREE auto-ship docs, not just the one the bug was found in. A reviewer found
    // the bare form surviving in SKILL.md precisely because the first version of this
    // guard read `github-project.md` alone — the rule was enforced where I had already
    // looked, which is the least useful place to enforce a rule.
    //
    // THE FENCE IS THE ENFORCEMENT SURFACE, and that is why SKILL.md's triage call now
    // lives in one. This list was widened first and the call was left in prose, which
    // read as coverage and was not: a reviewer reverted the prose to the bare form and
    // the whole suite stayed GREEN — 0 red across 26. The widening bought nothing for
    // the file it shipped with.
    //
    // The two obvious answers were both wrong. Scanning prose is what made an earlier
    // version of this test fail on a paragraph that merely named the script in
    // backticks. Grepping the prose for the right words is the TASK-392 mistake:
    // satisfied by a sentence that says them and branches on nothing. The third option
    // is to stop asking the guard to read prose and put the canonical call in a fence,
    // where it is both the instruction an orchestrator executes AND a thing a machine
    // can check. Documented behaviour with no test is a preference; a fenced block is a
    // property.
    //
    // It also fixes a concentration: before this, SKILL.md and templates.md contributed
    // ZERO fenced allocator calls, so the `>= 2` vacuity floor below rested entirely on
    // github-project.md — one file's refactor away from this whole test passing on an
    // empty list.
    const DOCS = [
      ['.claude', 'skills', 'auto-ship', 'SKILL.md'],
      ['.claude', 'skills', 'auto-ship', 'references', 'github-project.md'],
      ['.claude', 'skills', 'auto-ship', 'references', 'templates.md'],
    ].map((parts) => join(REPO_ROOT, ...parts));

    const problems = wiringProblems(
      allocatorCalls(DOCS.map((docPath) => readFileSync(docPath, 'utf8'))),
    );
    expect(problems, problems.join('\n\n')).toEqual([]);
  });

  it('is called from every documented card-creation path', () => {
    const doc = readFileSync(
      join(REPO_ROOT, '.claude', 'skills', 'auto-ship', 'references', 'github-project.md'),
      'utf8',
    );
    const templates = readFileSync(
      join(REPO_ROOT, '.claude', 'skills', 'auto-ship', 'references', 'templates.md'),
      'utf8',
    );
    expect(doc, '§4 create / §8.2 stamp must route through the allocator').toMatch(
      /scripts\/board-task-id\.sh/,
    );
    expect(
      templates,
      'the decomposition agent creates cards too, and it numbered them from a stale ' +
        '<BASE-N> handed over in its prompt — the longest-lived stale read on the board',
    ).toMatch(/scripts\/board-task-id\.sh/);
  });
});

// ---------------------------------------------------------------------------------
// The scanner's OWN safety direction (TASK-472), executable instead of asserted.
//
// The wiring test above only ever feeds the scanner the real docs, and the real docs
// are correct — so it cannot tell a correct exemption from a broken one. MEASURED on
// #625's review pass: reverting `scanFence`'s exemption to the old shape rule ("every
// non-comment line is a bare `scripts/board-task-id.sh …` call") left it GREEN,
// `calls=4`. This table is the hostile input the real docs never are. Each row is a
// doc; `exempt` is the per-fence decision, `flagged` the non-branching calls it must
// report, `vacuous` whether the `>= 2` floor must trip.
//
// Every row carries two correctly-branched fences (`GOOD`) unless it says otherwise, so
// the floor is satisfied and the row isolates the one fence it is about.
//
// MUTANTS RUN, NOT REASONED ABOUT (2026-09-26, committed first, restored with
// `git checkout --`). Baseline 38 collected, 38 passed; every mutant still COLLECTED 38.
//
//   S1. `scanFence`'s marker test replaced by the old shape rule —
//           code.length > 0 &&
//             code.every((l) => /^\s*scripts\/board-task-id\.sh\b/.test(l))
//       -> 8 red, exactly the 8 predicted before running it: the lone bare call, only
//       its own fence, misspelled, pluralized, wrong-case, marker in prose, the
//       residual, and the vacuity floor. The three rows it leaves green (`|| echo`,
//       branched, valid marker) are ones the shape rule genuinely gets right. And the
//       real-docs wiring test stayed GREEN under it, reproducing #625's measurement —
//       which is the whole reason this table exists.
//   S2. Marker regex made case-insensitive (`/i`) -> 1 red, `a wrong-case marker`.
//   S3. Marker regex loses its trailing `\b` -> 1 red, `a pluralized marker`.
// ---------------------------------------------------------------------------------

const fence = (...lines) => ['```bash', ...lines, '```'].join('\n');
const MARKER_LINE = '# board-task-id: reference listing';
const BRANCHED_SETTLE = fence(
  'if TASK_ID=$(scripts/board-task-id.sh settle --item "$ITEM_ID"); then',
  '  gh project item-edit --id "$ITEM_ID" --field-id "$DEPS_FIELD_ID" --text "$DEPS"',
  'else',
  '  echo "FATAL: $ITEM_ID still shares its id" >&2',
  'fi',
);
const BRANCHED_CLAIM = fence(
  'if NEW=$(scripts/board-task-id.sh claim --title "$T" --body "$B"); then',
  '  echo "created $NEW"',
  'fi',
);
const GOOD = [BRANCHED_SETTLE, BRANCHED_CLAIM];
const BARE_SETTLE = 'scripts/board-task-id.sh settle --item "$ITEM_ID"';

const doc = (...parts) => parts.join('\n\nSome prose between fences.\n\n');

const SCANNER_TABLE = [
  {
    name: 'a lone bare call with no marker is flagged — the regression itself',
    text: doc(fence(BARE_SETTLE), ...GOOD),
    exempt: [false, false, false],
    flagged: 1,
  },
  {
    name: 'a bare call behind `|| echo FATAL` and onward is flagged',
    text: doc(
      fence(
        `TASK_ID=$(${BARE_SETTLE}) \\`,
        '  || echo "FATAL: do not write deps for $ITEM_ID" >&2',
        'gh project item-edit --id "$ITEM_ID" --text "$DEPS"',
      ),
      ...GOOD,
    ),
    exempt: [false, false, false],
    flagged: 1,
  },
  {
    name: 'a branched call is counted and passes',
    text: doc(...GOOD),
    exempt: [false, false],
    flagged: 0,
  },
  {
    name: 'a valid marker exempts its fence',
    text: doc(
      fence(MARKER_LINE, 'scripts/board-task-id.sh check', 'scripts/board-task-id.sh claim --title x'),
      ...GOOD,
    ),
    exempt: [true, false, false],
    flagged: 0,
  },
  {
    name: 'a valid marker exempts ONLY its own fence, not the bare one after it',
    text: doc(
      fence(MARKER_LINE, 'scripts/board-task-id.sh next'),
      fence(BARE_SETTLE),
      ...GOOD,
    ),
    exempt: [true, false, false, false],
    flagged: 1,
  },
  {
    name: 'a misspelled marker falls back to CHECKED',
    text: doc(fence('# board-task-id: refrence listing', BARE_SETTLE), ...GOOD),
    exempt: [false, false, false],
    flagged: 1,
  },
  {
    name: 'a pluralized marker falls back to CHECKED',
    text: doc(fence('# board-task-id: reference listings', BARE_SETTLE), ...GOOD),
    exempt: [false, false, false],
    flagged: 1,
  },
  {
    name: 'a wrong-case marker falls back to CHECKED',
    text: doc(fence('# Board-Task-Id: Reference Listing', BARE_SETTLE), ...GOOD),
    exempt: [false, false, false],
    flagged: 1,
  },
  {
    name: 'the marker in PROSE, outside the fence, exempts nothing',
    text: doc(`${MARKER_LINE}\n\n${fence(BARE_SETTLE)}`, ...GOOD),
    exempt: [false, false, false],
    flagged: 1,
  },
  {
    // The accepted residual, pinned so that CHANGING it is a decision rather than a
    // drift: an opt-out opts out. See THE RESIDUAL in `scanFence`.
    name: 'a real unbranched call inside a MARKED fence is exempt (the accepted residual)',
    text: doc(
      fence(MARKER_LINE, BARE_SETTLE, 'gh project item-edit --id "$ITEM_ID" --text "$DEPS"'),
      ...GOOD,
    ),
    exempt: [true, false, false],
    flagged: 0,
  },
  {
    name: 'marking every fence trips the vacuity floor',
    text: doc(...GOOD.map((f) => f.replace('```bash\n', '```bash\n' + MARKER_LINE + '\n'))),
    exempt: [true, true],
    flagged: 0,
    vacuous: true,
  },
];

describe('allocator-call scanner — the exemption fails CLOSED', () => {
  it('the table is not empty and every row is well-formed', () => {
    // A mutant that removes rows rather than reddening them is the failure mode this
    // file tripped once; the row count is part of what the table asserts.
    expect(SCANNER_TABLE.length).toBe(11);
    for (const row of SCANNER_TABLE) {
      expect(bashFences(row.text).length, row.name).toBe(row.exempt.length);
    }
  });

  it.each(SCANNER_TABLE)('$name', ({ text, exempt, flagged, vacuous = false }) => {
    const decisions = bashFences(text).map(scanFence);
    expect(decisions.map((d) => d.exempt)).toEqual(exempt);

    const problems = wiringProblems(allocatorCalls([text]));
    expect(
      problems.filter((p) => p.startsWith('this allocator call does not branch')).length,
      problems.join('\n\n'),
    ).toBe(flagged);
    expect(
      problems.some((p) => p.startsWith('found fewer than 2')),
      problems.join('\n\n'),
    ).toBe(vacuous);
  });
});
