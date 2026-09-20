// Guard: the merge gate's Q2 block must RESOLVE the handoff's `reviewed-sha` before it
// ranges over it -- and must never range from an abbreviation, from a base it cannot
// resolve, or from a commit that is not on the branch.
//
// ---------------------------------------------------------------------------------
// WHY THIS EXISTS (TASK-479).
//
// The merge gate compares two shas. One of them, `HEAD_SHA`, has carried
// `[ ${#HEAD_SHA} -eq 40 ]` since TASK-392, with a long note about why `gh run list
// --commit` needs the full 40 characters. The other, `reviewed-sha`, came straight out
// of the handoff and was spliced into a git range with no assertion at all. Its only
// documented failure mode was "MISSING or `-`" -> fail closed to origin/main.
//
// ABBREVIATED is a third state, and it is the one that actually arrives. Measured
// 2026-09-20, three handoffs in a single auto-ship run:
//
//     TASK-436  reviewed-sha: 79940789   (8 chars)
//     PR #650   reviewed-sha: a46a874f   (8 chars)
//     PR #652   reviewed-sha: 78d43240   (8 chars)
//
// all three under an honest `reviewer: clean`, and all three hand-mitigated by the
// orchestrator with `git rev-parse`. Nothing failed, which is precisely the defect:
// `git log 79940789..origin/<branch>` resolves an unambiguous prefix LOCALLY and prints
// a plausible delta, so the gate silently works and no operator looks twice.
//
// The two ways that stops being harmless fail in opposite directions:
//
//   - AMBIGUOUS prefix -> git errors about object names. Loud, but it reads as a broken
//     command rather than as "this PR has no verified review", and the obvious repair
//     (re-run it with a longer prefix) is the wrong instinct.
//   - RESOLVES TO THE WRONG COMMIT -> the delta is computed against a base that is not
//     on the branch. That can come back EMPTY, and an empty delta is this gate's
//     "a reviewer saw the head" answer. The gate then merges unreviewed code while
//     reporting that it checked.
//
// ---------------------------------------------------------------------------------
// WHY THIS GUARD EXECUTES THE BLOCK INSTEAD OF SCANNING IT.
//
// Its sibling `autoship-review-gate-reviewed-sha.test.js` is a text scan, and rightly
// so -- it pins RULES stated in prose (scope routing, the `fix:`/`new:` labels). This
// card's subject is not a rule, it is a BEHAVIOUR: what the documented shell does when
// handed eight characters. A scan for the words "full 40-char sha" would pass against a
// doc that says them and branches on nothing, which is the shape the block had.
//
// So the tests below extract the Q2 fenced block from `auto-ship/SKILL.md` and RUN it,
// with `<reviewed-sha>` substituted, against a REAL throwaway git repository -- real
// abbreviations, a real ambiguous prefix (two commits manufactured to share one), a real
// off-branch commit. `git` on PATH is a tracing shim that records every invocation and
// then execs the real thing, so the assertions are about the ranges the block actually
// hands to git, not about its prose. Only `gh` is stubbed. Nothing reaches the network.
//
// The doc IS the implementation -- there is no second copy in a script to drift from it.
//
// MUTANTS RUN, NOT REASONED ABOUT (2026-09-20, macOS, bash 3.2 + zsh 5.9; baseline
// 22 passed with both shells present):
//
//   - revert the whole Q2 block to its pre-TASK-479 text (`REVIEWED_SHA=<reviewed-sha>`
//     spliced straight into the two ranges) -> 10 red: abbreviation, `-`, empty,
//     unknown-sha and off-branch, x both shells. The full-sha and vacuity cases stay
//     green, which is the point -- the fix changed no behaviour for a well-formed
//     handoff.
//   - delete ONLY the `merge-base --is-ancestor` arm (keep resolution + the 40-char
//     assert) -> 2 red: the off-branch case x both shells. Nothing else moves, so that
//     arm is carrying its own property and is not decoration on the resolve.
//   - change the fail-closed arm to `exit 1` instead of falling back to origin/main
//     -> 8 red (`-`, empty, unknown, ambiguous x 2 shells). Recorded because it is the
//     mutant a reader expects to PASS: "halting is also closed". It is not what the
//     gate is specified to do -- Q2's contract is that an unusable reviewed-sha means
//     the whole branch is unreviewed, which keeps the queue moving through an
//     independent pass instead of stalling it on a typo.
//   - swap `--verify --quiet` for a bare `git rev-parse` -> 4 red (unknown + ambiguous
//     x 2 shells): bare `rev-parse` echoes the unresolvable string back on stdout and
//     exits 0-ish, so `REVIEWED_SHA` ends up holding the garbage it was handed.
//   - delete the `[ ${#REVIEWED_SHA} -eq 40 ]` assert alone -> 0 red. Recorded because
//     a passing mutant is data too: with resolution in place that assert is genuinely
//     belt-and-braces, and it is kept because it is the line that stops a future edit
//     from reintroducing a raw splice without also deleting a visible assertion. This
//     file does not claim it as load-bearing.
//
// Lives in scripts/__tests__/, which `pnpm test:scripts` runs unconditionally -- no
// network, no Docker, no build.

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * The Q2 post-review-delta block: the one that substitutes the handoff's
 * `<reviewed-sha>` placeholder and scans the delta's FILES.
 *
 * Located structurally (placeholder + `--name-only` over a two-dot range) rather than
 * by any line this file is asserting about, so that mutating the assertions under test
 * cannot make the extraction return nothing. That coupling is the trap its sibling
 * `autoship-ci-run-lookup-full-sha.test.js` hit and documented: a guard whose extractor
 * keys on the line it is guarding reports "vacuous", not "broken", when that line dies.
 */
function q2Block() {
  const md = readFileSync(AUTO_SHIP_DOC, 'utf8');
  const blocks = bashBlocks(md).filter(
    (b) => /<reviewed-sha>/.test(b) && /--name-only[^\n]*\.\.(?!\.)/.test(b),
  );
  return blocks.length === 1 ? blocks[0] : undefined;
}

const Q2 = q2Block();

/** The block with its two placeholders filled, ready to run. */
function q2Script(reviewedSha) {
  // Single-quoted so an empty value, a bare `-`, or anything else the handoff might
  // carry reaches the block as ONE word -- the same way an operator pasting a field
  // value would, and without this file's substitution deciding the answer.
  const quoted = `'${String(reviewedSha).replace(/'/g, `'\\''`)}'`;
  return Q2.replace(/<reviewed-sha>/g, quoted).replace(/<n>/g, '123');
}

// ---------------------------------------------------------------------------------
// The fixture: a real repository, and real objects to be wrong about.
// ---------------------------------------------------------------------------------

const WORKDIR = mkdtempSync(join(tmpdir(), 'autoship-reviewed-sha-'));
const STUB_DIR = join(WORKDIR, 'stub');
const CLONE = join(WORKDIR, 'work');
const TRACE = join(WORKDIR, 'git-trace.log');

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

  // The stubs. `gh` answers the one question the block asks it; `git` is a tracing shim
  // in front of the real binary, so every range the block forms is recorded verbatim.
  execFileSync('mkdir', ['-p', STUB_DIR]);
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
 * spawnSync, not execFileSync: a non-zero exit is DATA here (the off-branch case is
 * specified to halt), and a helper that threw would push that assertion into a
 * try/catch where "it halted" is easy to confuse with "the test crashed".
 */
function runGate(shell, reviewedSha) {
  writeFileSync(TRACE, '');
  const r = spawnSync(shell, ['-c', q2Script(reviewedSha)], {
    cwd: CLONE,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${STUB_DIR}:${process.env.PATH}`,
      GIT_TRACE_FILE: TRACE,
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
  return { rc: r.status, out: `${r.stdout}${r.stderr}`, trace, bases };
}

const FULL_SHA = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------------

describe('the Q2 block is where this guard thinks it is (TASK-479)', () => {
  it('extracts exactly one post-review-delta block from the skill', () => {
    expect(
      Q2,
      `${SKILL_PATH}: could not find exactly one fenced bash block that substitutes \`<reviewed-sha>\` and scans a two-dot range with \`--name-only\`. Every assertion below runs that block, so a broken extraction would pass all of them`,
    ).not.toBeUndefined();
  });

  it('that block really forms both ranges — otherwise there is nothing to be wrong about', () => {
    if (Q2 === undefined) return; // reported above
    expect(/git log[^\n]*\.\.(?!\.)/.test(Q2), `${SKILL_PATH}: the Q2 block no longer lists the unseen COMMITS`).toBe(true);
    expect(/git diff[^\n]*--name-only[^\n]*\.\.(?!\.)/.test(Q2), `${SKILL_PATH}: the Q2 block no longer lists the unseen FILES`).toBe(true);
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

  it('HALTS when the reviewed-sha resolves to a commit that is not on the branch', () => {
    if (Q2 === undefined) return;
    const { rc, out, bases } = runGate(shell, OFF_BRANCH_SHA);

    expect(
      bases,
      `${SKILL_PATH}: the gate measured the delta from ${OFF_BRANCH_SHA}, which is not an ancestor of origin/feat. That is the genuinely dangerous state an abbreviation buys: the range resolves, the delta can come back EMPTY, and an empty delta is this gate's "a reviewer saw the head" answer`,
    ).toEqual([]);

    expect(rc, `${SKILL_PATH}: an off-branch reviewed-sha must halt this card, not fall back and merge`).not.toBe(0);
    expect(out, 'the halt must say why').toMatch(/HALT/);
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
    expect(/^reviewed-sha:/m.test(prompt), `${TEMPLATES_PATH}: no \`reviewed-sha:\` field in the handoff block`).toBe(true);
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
