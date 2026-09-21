// Guard: the merge gate's Q2 block must take the handoff's `reviewed-sha` as DATA, not
// as shell source -- and must never range from an abbreviation, from a base it cannot
// resolve, from a commit that is not on the branch, or from anything a hostile handoff
// talked it into.
//
// ---------------------------------------------------------------------------------
// WHY THIS EXISTS (TASK-479, then TASK-507).
//
// TASK-479. The merge gate compares two shas. One of them, `HEAD_SHA`, has carried
// `[ ${#HEAD_SHA} -eq 40 ]` since TASK-392. The other, `reviewed-sha`, came straight
// out of the handoff and was spliced into a git range with no assertion at all. Its
// only documented failure mode was "MISSING or `-`" -> fail closed to origin/main.
//
// ABBREVIATED is a third state, and it is the one that actually arrives. Measured
// 2026-09-20, three handoffs in a single auto-ship run:
//
//     TASK-436  reviewed-sha: 79940789   (8 chars)
//     PR #650   reviewed-sha: a46a874f   (8 chars)
//     PR #652   reviewed-sha: 78d43240   (8 chars)
//
// all three under an honest `reviewer: clean`, all three hand-mitigated by the
// orchestrator. Nothing failed, which is precisely the defect: `git log
// 79940789..origin/<branch>` resolves an unambiguous prefix LOCALLY and prints a
// plausible delta, so the gate silently works and no operator looks twice. The two ways
// that stops being harmless fail in opposite directions -- an AMBIGUOUS prefix errors
// about object names (loud, but it reads as a broken command), and one that RESOLVES TO
// THE WRONG COMMIT computes the delta against an off-branch base, which can come back
// EMPTY. An empty delta is this gate's "a reviewer saw the head" answer.
//
// TASK-507. TASK-479 left one residual NAMED rather than fixed, and it is the one that
// matters most: the block spliced the handoff value into `RAW_REVIEWED=<reviewed-sha>`
// RAW. Re-measured here 2026-09-21, bash 3.2 and zsh 5.9, both:
//
//   - `reviewed-sha: $(touch PWNED)` EXECUTES at the assignment line, before
//     `rev-parse` is ever reached. Command execution in the orchestrator's own shell
//     from another agent's output -- invariant 5, straight through.
//   - The quiet one: `reviewed-sha: $(git rev-parse origin/${BRANCH})` executes AND
//     resolves to the head, so the delta comes back EMPTY and the gate reports "fully
//     reviewed". The check that exists to catch unreviewed code is switched off by the
//     input it is checking.
//
// Two fixes look sufficient and are not, and both were measured before this file was
// written, so nobody has to re-derive them:
//
//   - Double-quoting the assignment does NOT help. `$( )` expands inside double quotes.
//     The payload still runs and the line now looks handled.
//   - A quoted-delimiter here-doc (`IFS= read -r RAW_REVIEWED <<'SHA' ... SHA`) is
//     NECESSARY-BUT-NOT-SUFFICIENT. It does neutralise the realistic one-line `$(...)`.
//     It does NOT survive a value carrying an embedded newline plus a line equal to the
//     delimiter: the here-doc closes early and the tail runs as script. Measured in both
//     shells (`touch PWNED_HEREDOC` fired). A here-doc fix is a hole that looks like a
//     fix, which is why `heredoc escape` is one of the payloads below.
//
// The shipped fix is two independent halves, and this file pins both:
//
//   1. TRANSPORT. The value never becomes shell source. The orchestrator writes it
//      verbatim to a file with its file-write tool and the block reads that file with
//      `$(cat -- ...)`. Command-substitution OUTPUT is not re-scanned for expansions,
//      so the bytes land inert whatever they are.
//   2. WHITELIST. `case` accepts hex and nothing else. That rejects whitespace,
//      newlines, `$(`, a backtick, a leading `-`, an empty field, and `HEAD` -- in one
//      arm, identically in bash and zsh.
//
// What neither half closes, stated so no reader credits this file with it: a handoff
// that simply names the head's REAL sha. That is a lie about the past; Q1's `reviewer:`
// check and the independent pass are what cover it.
//
// ---------------------------------------------------------------------------------
// WHY THIS GUARD EXECUTES THE BLOCK INSTEAD OF SCANNING IT.
//
// Its sibling `autoship-review-gate-reviewed-sha.test.js` is a text scan, and rightly
// so -- it pins RULES stated in prose (scope routing, the `fix:`/`new:` labels). This
// file's subject is a BEHAVIOUR: what the documented shell DOES when handed eight
// characters, or `$(touch PWNED)`. A scan for the words "never splice" would pass
// against a doc that says them and branches on nothing -- and this repo has been bitten
// by exactly that shape four times, twice in the last day (TASK-498's discipline scan
// and #640's self-failing grep hint were both satisfiable by a COMMENT quoting the
// call). A comment cannot create a file, and prose cannot resolve a sha.
//
// So the tests below extract the Q2 fenced block from `auto-ship/SKILL.md` and RUN it
// against a REAL throwaway git repository -- real abbreviations, a real ambiguous
// prefix (two commits manufactured to share one), a real off-branch commit, and real
// injection payloads delivered the way a real handoff would deliver them (bytes in the
// file the block reads). `git` on PATH is a tracing shim that records every invocation
// and then execs the real thing, so the assertions are about the ranges the block
// actually hands to git, not about its prose. Only `gh` is stubbed. Nothing reaches the
// network. Every run also sweeps the working directory for canary files, so an
// executing payload is caught even when the range it produced looks fine.
//
// The doc IS the implementation -- there is no second copy in a script to drift from it.
//
// MUTANTS RUN, NOT REASONED ABOUT. Measured 2026-09-21 on git 2.52.0, macOS, bash 3.2
// + zsh 5.9, against the head this file ships with -- baseline 45 here, 52 with the
// sibling text-scan guard collected, which is how the counts below were taken. Every
// mutant still collects 52, so none of them reddened by making the suite smaller.
// (The two earlier tables in this file's history were both wrong in the flattering
// direction, both because they were measured against an INTERMEDIATE state of the patch
// and carried forward unedited. A mutant table is a claim about a specific head. Re-run
// it against the head you ship, or delete it -- a stale table reads as evidence. Every
// number below was re-measured for TASK-507, including the ones inherited from 479, and
// three of them moved.)
//
//   - restore the pre-TASK-507 raw splice: `RAW_REVIEWED=$(cat -- "$f")` becomes
//     `eval "RAW_REVIEWED=$(cat -- "$f")"`, which is byte-for-byte what the orchestrator
//     pasting the value into the assignment did -> 10 red: all five injection cases x
//     both shells. Four redden on the canary sweep (a file appeared on disk) and the
//     fifth, `$(git rev-parse origin/feat)`, reddens on the BASE: it creates no file,
//     resolves to the head, and makes the gate report "fully reviewed" for unreviewed
//     code. Nothing else moves -- the fix changed no behaviour for a well-formed
//     handoff.
//   - replace the transport with a quoted-delimiter here-doc (`IFS= read -r
//     RAW_REVIEWED <<'SHA'` / value / `SHA`, eval'd so the value is spliced between the
//     delimiters the way an operator would splice it) -> 3 red: the newline+delimiter
//     payload x both shells, plus the static here-doc scan.
//     READ THIS ONE BEFORE CHANGING THE TRANSPORT. The one-line `$(...)`, the backtick,
//     the QUIET `$(git rev-parse …)` and the multi-line payloads all stay GREEN under
//     the here-doc, because `read` takes the first line and the rest is inert. A
//     here-doc passes every test you would have thought to write. Exactly one payload
//     in this file separates it from a real fix, and that is why it is here.
//   - delete the hex whitelist arm (`'' | *[!0-9a-fA-F]*)`), keeping the transport ->
//     3 red: the `HEAD` case x both shells, plus the static hex scan. Stated honestly
//     rather than inflated: with the transport in place, `-`, empty, whitespace and the
//     multi-line values all still fail closed, because `rev-parse --verify` cannot
//     resolve them either. What the whitelist uniquely closes is the COMMIT-ISH class
//     -- `HEAD`, a branch name, `origin/feat` -- which resolves, IS an ancestor, and
//     yields an EMPTY delta. That was named as an open residual by TASK-479 and this
//     is the arm that closes it. It is also the layer that survives a future change of
//     transport, which is the other reason it stays.
//   - delete ONLY the `merge-base --is-ancestor` arm -> 2 red: the off-branch case x
//     both shells. Carrying its own property, not decoration on the resolve.
//   - drop the `|| { ... exit 1; }` guard from the `git fetch` line -> 2 red: the
//     failed-fetch case x both shells. The two stale directions are not symmetric, and
//     the one that hides work is the one this gate exists to close.
//   - change both fail-closed arms to `exit 1` instead of widening to origin/main
//     -> 26 red. Recorded because it is the mutant a reader expects to PASS ("halting
//     is also closed"). It is not what the gate is specified to do: Q2's contract is
//     that an unusable reviewed-sha means the whole branch is unreviewed, which keeps
//     the SERIALIZED queue moving through an independent pass instead of stalling every
//     card behind a typo.
//   - swap `--verify --quiet --end-of-options "${RAW_REVIEWED}^{commit}"` for a bare
//     `git rev-parse "${RAW_REVIEWED}"` -> 0 red, unchanged from TASK-479's finding and
//     still worth its line. Bare `rev-parse` echoes back anything sha-shaped at rc 0, so
//     `REVIEWED_SHA` ends up holding a nonexistent object -- which the ancestry arm then
//     rejects, because a nonexistent object is an ancestor of nothing. The arms OVERLAP
//     and ancestry wins. So the flags buy DIAGNOSIS, not the property, and this file
//     does not claim them as load-bearing.
//   - delete the `[ ${#REVIEWED_SHA} -eq 40 ]` assert alone -> 0 red. Same status:
//     belt-and-braces, kept because it is the visible assertion a future edit would have
//     to delete on purpose in order to reintroduce a raw splice.
//   - revert the handoff field line to `reviewed-sha: <sha> | -` -> 1 red (the
//     field-line test).
//
// Lives in scripts/__tests__/, which `pnpm test:scripts` runs unconditionally -- no
// network, no Docker, no build.

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL_PATH = '.claude/skills/auto-ship/SKILL.md';
const TEMPLATES_PATH = '.claude/skills/auto-ship/references/templates.md';
const AUTO_SHIP_DOC = join(REPO_ROOT, SKILL_PATH);
const TEMPLATES_DOC = join(REPO_ROOT, TEMPLATES_PATH);

function binExists(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_ZSH = binExists('zsh');
const SHELLS = HAS_ZSH ? ['bash', 'zsh'] : ['bash'];
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

// ---------------------------------------------------------------------------------
// Extracting the block.
// ---------------------------------------------------------------------------------

/** Every fenced ```bash block in `md`, dedented by the fence's own indent. */
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

/** The lines of `block` that a shell would execute -- comments and blanks dropped. */
function realLines(block) {
  return block.split('\n').filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
}

/**
 * The Q2 post-review-delta block: the one that scans the delta's FILES over a two-dot
 * range ending at the PR's branch.
 *
 * Located by its OUTPUT — the two lines that are the gate's whole product and that no
 * mutant below touches — rather than by any line this file asserts about. That coupling
 * is the trap `autoship-ci-run-lookup-full-sha.test.js` hit and documented: a guard
 * whose extractor keys on the line it is guarding reports "vacuous", not "broken", when
 * that line dies. Measured here, not assumed: an earlier draft keyed on `^REVIEWED_SHA=`
 * and the "fail closed by exiting instead of widening" mutant deleted both of those
 * lines, so the whole file collapsed to one vacuity failure instead of the 16
 * behavioural ones it should report.
 */
function q2Block() {
  const md = readFileSync(AUTO_SHIP_DOC, 'utf8');
  const blocks = bashBlocks(md).filter(
    (b) => /--name-only[^\n]*\.\.(?!\.)/.test(b) && /origin\/\$\{BRANCH\}/.test(b),
  );
  return blocks.length === 1 ? blocks[0] : undefined;
}

const Q2 = q2Block();

/**
 * The block, ready to run. The ONLY substitution is the PR number placeholder.
 *
 * That is the headline change from this file's TASK-479 version, which had to splice
 * the handoff value in (`Q2.replace(/<reviewed-sha>/g, ...)`) because the doc did. The
 * value now arrives out-of-band, through the file the block reads, so every case below
 * exercises the real transport with verbatim bytes instead of this file's quoting
 * deciding the answer.
 */
function q2Script() {
  return Q2.replace(/<n>/g, '123');
}

// ---------------------------------------------------------------------------------
// The fixture: a real repository, and real objects to be wrong about.
// ---------------------------------------------------------------------------------

const WORKDIR = mkdtempSync(join(tmpdir(), 'autoship-reviewed-sha-'));
const STUB_DIR = join(WORKDIR, 'stub');
const CLONE = join(WORKDIR, 'work');
const STALE_CLONE = join(WORKDIR, 'stale');
const TRACE = join(WORKDIR, 'git-trace.log');
const VALUE_FILE = join(WORKDIR, 'reviewed-sha-value');

/**
 * Canary names the injection payloads try to create. Swept from every directory the
 * block could plausibly write into, after every single run -- so a payload that
 * executes is caught even if the delta it produced happens to look right.
 */
const CANARIES = ['PWNED', 'PWNED_HEREDOC', 'PWNED_BACKTICK', 'PWNED_MULTILINE'];
const CANARY_DIRS = () => [CLONE, STALE_CLONE, WORKDIR, process.cwd(), REPO_ROOT];

function sweepCanaries() {
  const found = [];
  for (const dir of CANARY_DIRS()) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (CANARIES.includes(name)) {
        found.push(join(dir, name));
        try {
          unlinkSync(join(dir, name));
        } catch {
          /* best-effort */
        }
      }
    }
  }
  return found;
}

/** Real git, in the fixture clone, never traced. */
function git(...args) {
  return execFileSync(REAL_GIT, args, {
    cwd: CLONE,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim();
}

/**
 * Two real commits whose object ids share their first `n` hex characters, written
 * straight into the object database.
 *
 * Manufactured rather than hoped for: a commit's id is the sha1 of its serialized
 * bytes, so varying the timestamp walks a space of valid commits, and at n=4 (65536
 * buckets) a few thousand candidates collide many times over. Both are well-formed
 * commits over a real tree with a real parent, so `git rev-parse --verify X^{commit}`
 * genuinely has two answers -- which is the state this gate has to fail closed on, and
 * the one state it cannot be handed by accident on demand.
 */
function ambiguousCommitPair(tree, parent, n) {
  const seen = new Map();
  for (let ts = 1_500_000_000; ts < 1_500_006_000; ts++) {
    const body =
      `tree ${tree}\n` +
      `parent ${parent}\n` +
      `author T <t@example.invalid> ${ts} +0000\n` +
      `committer T <t@example.invalid> ${ts} +0000\n` +
      `\nambiguity fixture\n`;
    const raw = Buffer.from(`commit ${Buffer.byteLength(body)}\0${body}`, 'utf8');
    const oid = createHash('sha1').update(raw).digest('hex');
    const key = oid.slice(0, n);
    const prior = seen.get(key);
    if (prior && prior.oid !== oid) return { prefix: key, bodies: [prior.body, body] };
    seen.set(key, { oid, body });
  }
  return undefined;
}

let BASE_SHA; // on main, and on feat
let R1_SHA; // first feat commit -- the sha a well-behaved handoff names
let HEAD_SHA; // origin/feat -- what the quiet payload tries to make the gate range from
let ORIGIN_MAIN_SHA; // what a fail-closed run must range from
let OFF_BRANCH_SHA; // resolves fine, is NOT on feat
let AMBIGUOUS_PREFIX; // resolves to two commits

beforeAll(() => {
  execFileSync(REAL_GIT, ['init', '-q', '--bare', join(WORKDIR, 'origin.git')]);
  execFileSync(REAL_GIT, ['init', '-q', '-b', 'main', CLONE]);

  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'T');
  git('remote', 'add', 'origin', join(WORKDIR, 'origin.git'));

  writeFileSync(join(CLONE, 'f.txt'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  BASE_SHA = git('rev-parse', 'HEAD');
  git('push', '-q', 'origin', 'main');
  ORIGIN_MAIN_SHA = BASE_SHA;

  git('switch', '-qc', 'feat');
  writeFileSync(join(CLONE, 'f.txt'), 'r1\n');
  git('commit', '-qam', 'reviewed work');
  R1_SHA = git('rev-parse', 'HEAD');
  writeFileSync(join(CLONE, 'prod.ts'), 'export const x = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'unreviewed fix');
  HEAD_SHA = git('rev-parse', 'HEAD');
  git('push', '-q', 'origin', 'feat');

  // A commit that resolves but is not on `feat`. This is the dangerous half of the
  // abbreviation story made explicit: a base off the branch yields a delta that can be
  // empty for code nobody read.
  git('switch', '-q', 'main');
  git('switch', '-qc', 'other');
  writeFileSync(join(CLONE, 'g.txt'), 'other\n');
  git('add', '.');
  git('commit', '-qm', 'off-branch');
  OFF_BRANCH_SHA = git('rev-parse', 'HEAD');
  git('switch', '-q', 'feat');

  if (git('rev-parse', '--show-object-format') === 'sha1') {
    const pair = ambiguousCommitPair(git('rev-parse', 'HEAD^{tree}'), BASE_SHA, 4);
    if (pair) {
      for (const body of pair.bodies) {
        execFileSync(REAL_GIT, ['hash-object', '-w', '-t', 'commit', '--stdin'], {
          cwd: CLONE,
          input: body,
          encoding: 'utf8',
        });
      }
      AMBIGUOUS_PREFIX = pair.prefix;
    }
  }

  // A second clone with a dead remote: every ref it holds is real but STALE, which is
  // the state an unguarded `git fetch` leaves behind. Its origin/feat deliberately
  // predates the unreviewed commit, so a block that shrugs off the failed fetch would
  // range over a branch that is missing work -- the under-review direction.
  execFileSync(REAL_GIT, ['clone', '-q', join(WORKDIR, 'origin.git'), STALE_CLONE]);
  execFileSync(REAL_GIT, ['update-ref', 'refs/remotes/origin/feat', R1_SHA], { cwd: STALE_CLONE });
  execFileSync(REAL_GIT, ['remote', 'set-url', 'origin', join(WORKDIR, 'no-such-remote.git')], {
    cwd: STALE_CLONE,
  });

  // The stubs. `gh` answers the one question the block asks it; `git` is a tracing shim
  // in front of the real binary, so every range the block forms is recorded verbatim.
  mkdirSync(STUB_DIR, { recursive: true });
  writeFileSync(
    join(STUB_DIR, 'gh'),
    `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' "$STUB_BRANCH"
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
printf '%s\\n' "$*" >> "$GIT_TRACE_FILE"
exec ${REAL_GIT} "$@"
`,
    { mode: 0o755 },
  );
  chmodSync(join(STUB_DIR, 'git'), 0o755);

  sweepCanaries(); // start from a clean slate
});

afterAll(() => {
  try {
    rmSync(WORKDIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/**
 * Run the extracted block for one `reviewed-sha` value and report what it did.
 *
 * The value is DELIVERED THE WAY THE DOC SAYS TO DELIVER IT: written verbatim to a file
 * with a file-write call (no shell in the path), with the block pointed at that file
 * through `REVIEWED_SHA_FILE`. That is the property under test, so the delivery is not
 * simulated -- passing `{ deliver: 'none' }` removes the file entirely, which is the
 * "handoff declared no review" state.
 *
 * spawnSync, not execFileSync: a non-zero exit is DATA here (the failed-fetch case is
 * specified to halt), and a helper that threw would push that assertion into a
 * try/catch where "it halted" is easy to confuse with "the test crashed".
 */
function runGate(shell, reviewedSha, { cwd = CLONE, deliver = 'file', script = q2Script } = {}) {
  writeFileSync(TRACE, '');
  if (deliver === 'none') rmSync(VALUE_FILE, { force: true });
  else writeFileSync(VALUE_FILE, String(reviewedSha));

  const r = spawnSync(shell, ['-c', script(reviewedSha)], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${STUB_DIR}:${process.env.PATH}`,
      GIT_TRACE_FILE: TRACE,
      REVIEWED_SHA_FILE: VALUE_FILE,
      STUB_BRANCH: 'feat',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  const trace = readFileSync(TRACE, 'utf8').split('\n').filter(Boolean);
  // The left endpoint of every two-dot range the block handed to `git log` / `git diff`
  // -- i.e. every base it actually measured the unreviewed delta from.
  const bases = trace
    .filter((l) => /^(log|diff)\b/.test(l))
    .map((l) => /(\S+)\.\.(?!\.)(\S+)/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
  return { rc: r.status, out: `${r.stdout}${r.stderr}`, trace, bases, fired: sweepCanaries() };
}

const FULL_SHA = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------------

describe('the Q2 block is where this guard thinks it is (TASK-479)', () => {
  it('extracts exactly one post-review-delta block from the skill', () => {
    expect(
      Q2,
      `${SKILL_PATH}: could not find exactly one fenced bash block that scans a two-dot \`--name-only\` range ending at \`origin/\${BRANCH}\`. Every assertion below runs that block, so a broken extraction would pass all of them`,
    ).not.toBeUndefined();
  });

  it('that block really forms both ranges — otherwise there is nothing to be wrong about', () => {
    if (Q2 === undefined) return; // reported above
    expect(
      /git log[^\n]*\.\.(?!\.)/.test(Q2),
      `${SKILL_PATH}: the Q2 block no longer lists the unseen COMMITS`,
    ).toBe(true);
    expect(
      /git diff[^\n]*--name-only[^\n]*\.\.(?!\.)/.test(Q2),
      `${SKILL_PATH}: the Q2 block no longer lists the unseen FILES`,
    ).toBe(true);
  });
});

describe.each(SHELLS)('Q2 gate under %s: the base it ranges from (TASK-479)', (shell) => {
  it('a full 40-char reviewed-sha on the branch is used as-is', () => {
    if (Q2 === undefined) return;
    const { rc, bases } = runGate(shell, R1_SHA);
    expect(rc, 'a well-formed handoff must not halt the gate').toBe(0);
    expect(bases.length, 'the gate formed neither range').toBeGreaterThanOrEqual(2);
    for (const b of bases) expect(b).toBe(R1_SHA);
  });

  it('a trailing newline on the value file is tolerated, not treated as corruption', () => {
    if (Q2 === undefined) return;
    // Most file-write tools end a file with a newline. `$( )` strips trailing newlines,
    // so the happy path must survive that -- otherwise the hex whitelist would fail
    // every honest handoff closed and the gate would re-review every card.
    const { rc, bases } = runGate(shell, `${R1_SHA}\n`);
    expect(rc, 'a trailing newline must not halt the gate').toBe(0);
    expect(bases.length).toBeGreaterThanOrEqual(2);
    for (const b of bases) expect(b).toBe(R1_SHA);
  });

  it('an ABBREVIATED reviewed-sha is resolved to 40 chars before any range is formed', () => {
    if (Q2 === undefined) return;
    const short = R1_SHA.slice(0, 8);
    const { bases } = runGate(shell, short);

    expect(
      bases.length,
      `${SKILL_PATH}: the gate formed no range at all for an abbreviated reviewed-sha`,
    ).toBeGreaterThanOrEqual(2);

    for (const b of bases) {
      expect(
        b,
        `${SKILL_PATH}: the gate ranged from '${b}' — the abbreviation the handoff sent, unresolved. This is the measured 2026-09-20 state (three handoffs, 8 chars each, all "working"): git expands an unambiguous prefix locally, so the wrong-base and ambiguous cases are the only ones that ever surface, and one of them surfaces as an EMPTY delta for unreviewed code`,
      ).toMatch(FULL_SHA);
      expect(b, 'resolved to the wrong commit').toBe(R1_SHA);
    }
  });

  it.each([
    ['-', 'the documented "no review" marker'],
    ['', 'an empty/missing field'],
    ['dead0beefdead0beefdead0beefdead0beefdead', 'a 40-char sha this clone does not have'],
  ])('fails CLOSED to origin/main for %s', (value) => {
    if (Q2 === undefined) return;
    const { bases } = runGate(shell, value);

    expect(
      bases.length,
      `${SKILL_PATH}: the gate formed no usable range for reviewed-sha '${value}'. Fail-closed means ranging from origin/main — treating the whole branch as unreviewed — not skipping the scope test`,
    ).toBeGreaterThanOrEqual(2);

    for (const b of bases) {
      expect(
        b,
        `${SKILL_PATH}: the gate ranged from '${b}' for reviewed-sha '${value}' instead of falling back to origin/main (${ORIGIN_MAIN_SHA})`,
      ).toBe(ORIGIN_MAIN_SHA);
    }
  });

  it('fails CLOSED when the handoff declared no reviewed-sha at all (no value file)', () => {
    if (Q2 === undefined) return;
    const { bases } = runGate(shell, '', { deliver: 'none' });
    expect(
      bases.length,
      `${SKILL_PATH}: with no value delivered the gate formed no range. Absent is not "nothing to check" — it is "nobody reviewed anything"`,
    ).toBeGreaterThanOrEqual(2);
    for (const b of bases) expect(b).toBe(ORIGIN_MAIN_SHA);
  });

  it('fails CLOSED for an AMBIGUOUS abbreviation rather than guessing', () => {
    if (Q2 === undefined) return;
    if (AMBIGUOUS_PREFIX === undefined) {
      // Only reachable on a sha256 repository, where the fixture cannot be manufactured
      // the same way. Say so rather than reporting a green that tested nothing.
      expect(git('rev-parse', '--show-object-format')).not.toBe('sha1');
      return;
    }
    const { bases } = runGate(shell, AMBIGUOUS_PREFIX);
    expect(
      bases.length,
      `${SKILL_PATH}: no range formed for the ambiguous prefix '${AMBIGUOUS_PREFIX}'`,
    ).toBeGreaterThanOrEqual(2);
    for (const b of bases) {
      expect(
        b,
        `${SKILL_PATH}: an ambiguous prefix must fail closed to origin/main, not reach git as '${b}' — where it surfaces as an error about object names rather than as "this PR has no verified review"`,
      ).toBe(ORIGIN_MAIN_SHA);
    }
  });

  it('fails CLOSED when the reviewed-sha resolves to a commit that is not on the branch', () => {
    if (Q2 === undefined) return;
    const { bases } = runGate(shell, OFF_BRANCH_SHA);

    expect(
      bases.length,
      `${SKILL_PATH}: no range formed for an off-branch reviewed-sha`,
    ).toBeGreaterThanOrEqual(2);

    for (const b of bases) {
      expect(
        b,
        `${SKILL_PATH}: the gate measured the delta from ${OFF_BRANCH_SHA}, which is not an ancestor of origin/feat. That is the genuinely dangerous state an abbreviation buys: the range resolves, the delta can come back EMPTY, and an empty delta is this gate's "a reviewer saw the head" answer. Widen to origin/main instead — which is also the right answer for the honest cause of a non-ancestor, a rebase after the review round`,
      ).toBe(ORIGIN_MAIN_SHA);
    }
  });

  it('HALTS rather than ranging over refs a failed fetch could not refresh', () => {
    if (Q2 === undefined) return;
    // In this clone `origin/feat` is one commit behind the real branch and the remote is
    // gone, so a block that shrugs off the fetch failure computes an EMPTY delta for the
    // very commit it exists to notice. The two stale directions are not symmetric: a
    // stale origin/main only widens, a stale branch ref hides work.
    const { rc, out, bases } = runGate(shell, R1_SHA, { cwd: STALE_CLONE });

    expect(
      bases,
      `${SKILL_PATH}: \`git fetch\` failed and the gate ranged anyway — from refs it could not refresh. Here that yields an empty delta for a branch whose head it never saw`,
    ).toEqual([]);
    expect(rc, `${SKILL_PATH}: a failed fetch must halt the card, not produce a delta`).not.toBe(0);
    expect(out, 'the halt must say why').toMatch(/HALT/);
  });
});

// ---------------------------------------------------------------------------------
// The injection payloads (TASK-507).
//
// Each one is a real `reviewed-sha` field value delivered verbatim, and each asserts
// BOTH properties, because they fail independently:
//
//   (a) nothing executed        -- no canary file anywhere the block could write
//   (b) the gate failed CLOSED  -- it ranged from origin/main, i.e. "the whole branch
//                                  is unreviewed", never from the head
//
// (b) is the one that would be missed by a test that only watched for execution. The
// `$(git rev-parse origin/feat)` payload is the whole reason this card exists: under the
// old raw splice it does not just run, it resolves to the HEAD, and a head-based range
// is EMPTY -- the gate then reports "fully reviewed" for code nobody read.
// ---------------------------------------------------------------------------------

const PAYLOADS = [
  [
    'one-line command substitution',
    '$(touch PWNED)',
    'the classic: executes at the assignment line, before rev-parse is reached',
  ],
  [
    'backtick substitution',
    '`touch PWNED_BACKTICK`',
    'the older spelling of the same thing — a blacklist for `$(` alone would miss it',
  ],
  [
    'newline + delimiter (the here-doc escape)',
    'abc\nSHA\ntouch PWNED_HEREDOC\nSHA\n',
    'closes a quoted-delimiter here-doc early and runs the tail — this is why a here-doc is NOT a fix',
  ],
  [
    'multi-line value with a trailing command',
    'deadbeef\ntouch PWNED_MULTILINE',
    'must be rejected whole, never silently truncated to its first line',
  ],
];

describe.each(SHELLS)('Q2 gate under %s: hostile reviewed-sha values (TASK-507)', (shell) => {
  it.each(PAYLOADS)('%s neither executes nor narrows the delta', (_name, payload, why) => {
    if (Q2 === undefined) return;
    const { bases, fired } = runGate(shell, payload);

    expect(
      fired,
      `${SKILL_PATH}: the handoff value ${JSON.stringify(payload)} EXECUTED — ${why}. Files appeared on disk from another agent's text reaching the orchestrator's shell (invariant 5). The value must arrive as DATA: written out-of-band to a file and read with \`$(cat ...)\`, never spliced, never double-quoted, never fed to a here-doc`,
    ).toEqual([]);

    expect(
      bases.length,
      `${SKILL_PATH}: no range formed for ${JSON.stringify(payload)} — fail-closed means ranging from origin/main, not skipping the scope test`,
    ).toBeGreaterThanOrEqual(2);

    for (const b of bases) {
      expect(
        b,
        `${SKILL_PATH}: the gate ranged from '${b}' for ${JSON.stringify(payload)} instead of widening to origin/main (${ORIGIN_MAIN_SHA})`,
      ).toBe(ORIGIN_MAIN_SHA);
    }
  });

  it('the QUIET payload — one that resolves to the head — cannot empty the delta', () => {
    if (Q2 === undefined) return;
    // `$(git rev-parse origin/${BRANCH})`. Under the pre-TASK-507 raw splice this both
    // executes AND yields origin/feat's head, so `git diff HEAD..origin/feat` is EMPTY
    // and the gate concludes "fully reviewed". No file is created, nothing looks wrong,
    // and unreviewed code merges. That is the catastrophic direction.
    const { bases, fired } = runGate(shell, '$(git rev-parse origin/feat)');

    expect(fired, 'the payload executed').toEqual([]);
    expect(bases.length, 'no range formed').toBeGreaterThanOrEqual(2);
    for (const b of bases) {
      expect(
        b,
        `${SKILL_PATH}: the gate ranged from '${b}'. If that is origin/feat's head (${HEAD_SHA}) the delta is EMPTY and this gate has just reported "a reviewer saw everything" about a branch nobody reviewed — the check switched off by the input it is checking`,
      ).toBe(ORIGIN_MAIN_SHA);
      expect(b, 'the gate ranged from the branch head').not.toBe(HEAD_SHA);
    }
  });

  it('a whitespace-bearing value fails CLOSED rather than silently truncating', () => {
    if (Q2 === undefined) return;
    // `<sha> feat`. Under the old raw splice this parsed as a one-shot env assignment
    // and fell into the fail-closed arm by accident. It must now be REJECTED on purpose
    // -- and, just as importantly, must not be truncated to the sha and accepted, which
    // is what a `read`-based or `awk`-based transport would do.
    const { bases, fired } = runGate(shell, `${R1_SHA} feat`);

    expect(fired, 'the value executed').toEqual([]);
    expect(
      bases.length,
      `${SKILL_PATH}: the gate formed no usable range for a whitespace-bearing reviewed-sha`,
    ).toBeGreaterThanOrEqual(2);

    for (const b of bases) {
      expect(
        b,
        `${SKILL_PATH}: a handoff value carrying whitespace must widen to origin/main (${ORIGIN_MAIN_SHA}), not range from '${b}'. Ranging from ${R1_SHA} would mean the transport silently discarded the part of the value it did not like and trusted the rest`,
      ).toBe(ORIGIN_MAIN_SHA);
    }
  });

  it('`HEAD` is rejected by the whitelist before git can resolve it', () => {
    if (Q2 === undefined) return;
    // The other half of the old residual: a commit-ish that is not a sha at all. `HEAD`
    // resolves, IS an ancestor of the branch, and produces an empty delta. The hex
    // whitelist rejects it on the `H`.
    const { bases } = runGate(shell, 'HEAD');
    expect(bases.length).toBeGreaterThanOrEqual(2);
    for (const b of bases) {
      expect(
        b,
        `${SKILL_PATH}: \`HEAD\` reached git as '${b}'. It resolves, it passes the ancestry test, and the delta it produces is EMPTY`,
      ).toBe(ORIGIN_MAIN_SHA);
    }
  });
});

// ---------------------------------------------------------------------------------
// The static half: the doc must not have grown a splice back.
//
// This is a canary, not the property -- the behavioural tests above are the property.
// It exists because the raw splice is a one-line regression that a future editor could
// reintroduce while every behavioural test still passed (they would, because they
// deliver through the file and the spliced line would simply be dead). It scans only
// lines a shell would RUN, and the negative controls prove a comment cannot satisfy it.
// ---------------------------------------------------------------------------------

/**
 * Placeholders the ORCHESTRATOR fills from its own state rather than from a handoff:
 * the PR number it is merging and that PR's branch name, both read back from `gh`.
 * Everything else a `<…>` could stand for in this block is builder-supplied text, and
 * builder-supplied text is what must never be substituted into shell source.
 */
const ORCHESTRATOR_PLACEHOLDERS = /^(?:n|branch)$/;

/** Lines of `block` that assign a variable from a handoff-supplied `<...>` placeholder. */
function splicedPlaceholderLines(block) {
  return realLines(block).filter((l) => {
    const assignment = /^\s*[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(l);
    if (!assignment) return false;
    return [...assignment[1].matchAll(/<([a-zA-Z-]+)>/g)].some(
      (m) => !ORCHESTRATOR_PLACEHOLDERS.test(m[1]),
    );
  });
}

/** Lines of `block` that feed a here-doc. */
function hereDocLines(block) {
  return realLines(block).filter((l) => /<<-?\s*['"]?[A-Za-z_]/.test(l));
}

describe('the Q2 block takes the value as data, not as shell source (TASK-507)', () => {
  it('no runnable line splices a `<placeholder>` into an assignment', () => {
    if (Q2 === undefined) return;
    expect(
      splicedPlaceholderLines(Q2),
      `${SKILL_PATH}: the Q2 block assigns a variable from a \`<…>\` placeholder again. That is the TASK-507 defect verbatim: the orchestrator substitutes semi-trusted handoff text and the shell parses it. Deliver the value out-of-band instead — a file written with the file-write tool, read with \`$(cat -- …)\``,
    ).toEqual([]);
  });

  it('no runnable line feeds the value through a here-doc', () => {
    if (Q2 === undefined) return;
    expect(
      hereDocLines(Q2),
      `${SKILL_PATH}: the Q2 block grew a here-doc. A quoted-delimiter here-doc neutralises the one-line \`$(…)\` and NOT a value carrying an embedded newline plus a line equal to the delimiter — measured in bash and zsh, the tail executes. It is the fix that looks like a fix`,
    ).toEqual([]);
  });

  it('reads the value from a file it opens itself', () => {
    if (Q2 === undefined) return;
    const reads = realLines(Q2).filter((l) => /=\$\(\s*cat\b/.test(l));
    expect(
      reads.length,
      `${SKILL_PATH}: nothing in the Q2 block reads the reviewed-sha from a file. \`$( )\` OUTPUT is not re-scanned for expansions, which is the whole reason the transport works; if the value arrives some other way, re-derive that property before changing this test`,
    ).toBeGreaterThanOrEqual(1);
  });

  it('constrains the value to hex on a runnable line', () => {
    if (Q2 === undefined) return;
    const arms = realLines(Q2).filter((l) => /\[!?\^?0-9a-fA-F\]|\[!?\^?0-9a-f\]/.test(l));
    expect(
      arms.length,
      `${SKILL_PATH}: no runnable line restricts the reviewed-sha to hex. The transport alone keeps a payload inert; the whitelist is what keeps \`HEAD\`, whitespace and an embedded newline from being handed to git at all`,
    ).toBeGreaterThanOrEqual(1);
  });

  it('rejects a block whose protections appear only as comments (negative control)', () => {
    // Prose that says every right thing, over a line that does the wrong one. Each
    // checker above must see through it, or the guard is satisfiable by a comment --
    // the failure shape this repo has hit four times.
    const commented = [
      '# never splice: we read it with $(cat -- "$file") and whitelist [!0-9a-fA-F]',
      '# and we certainly do not use a here-doc <<SHA for it',
      'RAW_REVIEWED=<reviewed-sha>',
    ].join('\n');
    expect(splicedPlaceholderLines(commented)).toHaveLength(1);
    expect(realLines(commented).filter((l) => /=\$\(\s*cat\b/.test(l))).toHaveLength(0);
    expect(
      realLines(commented).filter((l) => /\[!?\^?0-9a-fA-F\]|\[!?\^?0-9a-f\]/.test(l)),
    ).toHaveLength(0);
    expect(hereDocLines(commented)).toEqual([]);
  });

  it('the doc tells the orchestrator how to deliver the value, in prose a skimmer hits', () => {
    // The block's own comment is the detailed version; this pins that the instruction
    // also exists where someone reads before copying the block.
    const md = readFileSync(AUTO_SHIP_DOC, 'utf8');
    const q2Prose = md.slice(md.indexOf('**Q2 —'), md.indexOf('```bash', md.indexOf('**Q2 —')));
    expect(q2Prose.length, `${SKILL_PATH}: could not find the Q2 prose paragraph`).toBeGreaterThan(
      200,
    );
    expect(
      /do not paste|never paste|out-of-band/i.test(q2Prose),
      `${SKILL_PATH}: the Q2 paragraph does not tell the orchestrator to keep the handoff value out of the shell. The block's comment says it, but the paragraph above the block is what gets read first`,
    ).toBe(true);
  });
});

describe('the handoff contract asks for the full sha (TASK-479)', () => {
  const templates = readFileSync(TEMPLATES_DOC, 'utf8');
  // The `> `-quoted builder prompt, dedented.
  const prompt = templates
    .split('\n')
    .filter((l) => l.startsWith('>'))
    .map((l) => l.replace(/^>\s?/, ''))
    .join('\n');

  it('finds the quoted builder prompt — a broken parse would pass everything below', () => {
    expect(prompt.length, `${TEMPLATES_PATH}: no \`> \`-quoted prompt found`).toBeGreaterThan(500);
    expect(
      /^reviewed-sha:/m.test(prompt),
      `${TEMPLATES_PATH}: no \`reviewed-sha:\` field in the handoff block`,
    ).toBe(true);
  });

  it('the `reviewed-sha:` field line says FULL 40 characters, not `<sha>`', () => {
    const line = /^reviewed-sha:[^\n]*/m.exec(prompt)?.[0] ?? '';
    expect(
      /40[-\s]?char/i.test(line),
      `${TEMPLATES_PATH}: the handoff declares \`${line.trim()}\`, which is what three builders read on 2026-09-20 before each returning 8 characters. The placeholder is the contract — spell the width into it`,
    ).toBe(true);
  });

  it('a prompt bullet tells the builder not to abbreviate it', () => {
    const bullets = prompt.split('\n').reduce((acc, line) => {
      if (/^- /.test(line)) acc.push(line);
      else if (acc.length && /^\s+\S/.test(line)) acc[acc.length - 1] += `\n${line}`;
      return acc;
    }, []);
    const instructing = bullets.filter(
      (b) => /reviewed-sha/.test(b) && /40[-\s]?char/i.test(b) && /abbreviat/i.test(b),
    );
    expect(
      instructing.length,
      `${TEMPLATES_PATH}: no bullet in the builder prompt both names \`reviewed-sha\` and forbids abbreviating it. The field comment alone is easy to skim past — the three 8-char handoffs are the evidence`,
    ).toBeGreaterThanOrEqual(1);
  });
});
