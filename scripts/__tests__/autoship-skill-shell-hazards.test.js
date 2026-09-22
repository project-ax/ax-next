// Guard: the auto-ship skill's runnable shell blocks must survive being run by zsh,
// and must not go blind on a board bigger than their --limit.
//
// Why this exists (TASK-298). The auto-ship orchestrator regenerates
// `.claude/auto-ship-board.sh` from the fenced code blocks in
// `.claude/skills/auto-ship/references/github-project.md` at every run start. Those
// blocks are DATA to this repo -- no linter, type checker or test ever looked at
// them -- so two defects lived in them for months and were re-created, byte for
// byte, on every single run:
//
//   1. ZSH MODIFIER EATS THE ALIAS. The Bash tool runs zsh on this machine, and zsh
//      applies history-style modifiers to a bare `$var:x`. The helper built its
//      GraphQL aliases as `a$i:updateProjectV2ItemFieldValue`; zsh read the `:u` as
//      the *upcase* modifier and ATE THE `u`, producing
//      `a1pdateProjectV2ItemFieldValue`. GitHub rejected it as `undefinedField`, the
//      helper swallowed stderr, and the operator saw only "board_batch: FAILED" --
//      so every batched board write silently degraded to nothing. `${i}` fixes it;
//      `bash -c` is NOT required. (`:I` / `:S` are not modifiers, so `$it$i:ID!` was
//      never the bug -- the card that filed this blamed exactly that line.)
//
//   1b. ZSH DOES NOT WORD-SPLIT (TASK-310). Same root cause as (1) -- the Bash tool
//      runs zsh -- different mechanism. bash splits an unquoted `$VAR` on IFS; zsh
//      does NOT (that is what `${=VAR}` is for). So the documented forward-learning
//      loop, `for id in $IDS; do append_learnings "$id" ...; done`, iterated exactly
//      ONCE with all ids concatenated into one string. `append_learnings` then read a
//      bogus node id and printed `learnings: skip (read)` -- the line the operator
//      actually saw, and (measured) the ONLY line a malformed id could produce. An
//      earlier version of this comment hedged that `skip (not a draft-issue card)`
//      was reachable from the same bad id. It is not: that branch needs `gh` to exit
//      0 with an EMPTY content id, i.e. a *resolvable* node of the wrong type (a
//      repository id gives exactly that). An unresolvable or garbage id always
//      errors rc=1 + NOT_FOUND, 4/4 against live GitHub. An orchestrator correctly
//      reads that as "rate-limit blip, best-effort, ignore" rather than "your loop
//      is broken" -- which is why TASK-315 gave the malformed case its own loud
//      MALFORMED-ID line, pinned further down this file. Observed live 2026-08-23/24: 3
//      output lines where 12 were expected, caught only because the count was
//      visibly wrong. Note the asymmetry that makes this easy to get wrong: an
//      unquoted *command substitution* in a `for` list DOES split under zsh, so
//      `for b in $(git branch --list ...)` in §7 was never affected. Only the bare
//      parameter expansion is.
//
//   2. TRUNCATED BOARD READ. `board_snapshot` used `--limit 200` against a board
//      holding 300+ items, and guarded only `length > 0` -- which passes happily on
//      a truncated array. The orchestrator then derived its ready set, dependency
//      review and crash reconciliation from half a board. This is the same class
//      a9343fd9 ("paginate board items so it never goes blind past 100") already
//      fixed once in the poller, regressed into the snapshot helper.
//
// Both were found by hand, twice, after the fact. This test is the thing that would
// have caught them the first time, and it is what stops the docs from regenerating
// the bugs again.
//
// Lives in scripts/__tests__/, which CI's `pnpm test:scripts` runs UNCONDITIONALLY
// (same pattern as no-raw-nul-bytes.test.js) -- no network, no build.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, it, expect } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills');
const GITHUB_PROJECT_MD = join(
  SKILLS_DIR,
  'auto-ship',
  'references',
  'github-project.md',
);

/** Every tracked markdown file under .claude/skills/. */
function skillDocs() {
  const out = execFileSync('git', ['ls-files', '-z', '.claude/skills'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter((f) => f.endsWith('.md'));
}

// zsh's history-modifier letters. A bare `$var:` followed by one of these is
// rewritten by zsh and left alone by bash -- i.e. the same script means two
// different things depending on which shell sourced it. `:I` and `:S` are
// deliberately absent: they are NOT modifiers, which is why `$it$i:ID!` and
// `$v$i:String!` were always safe and bracing them is belt-and-braces only.
// `P` (absolute-path modifier, zsh 5.9) belongs here: nothing in the doc uses `$var:P`
// today, but a future one would slip a scan that omits it. The set over-includes a few
// letters that are not modifiers -- that direction only costs a false positive on a
// string nobody writes, whereas omitting a real modifier costs a silent miscompile.
const ZSH_MODIFIERS = 'aAcefghlpPqQrstuUwWxX';

/**
 * Find `$name:` (unbraced) immediately followed by a zsh modifier letter.
 * `${name}:` is safe and must NOT match -- the brace terminates the parameter
 * name, so zsh never treats what follows the colon as a modifier.
 */
function findZshModifierHazards(text) {
  const re = new RegExp(
    String.raw`\$[A-Za-z_][A-Za-z0-9_]*:[` + ZSH_MODIFIERS + `]`,
    'g',
  );
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // A `#`-leading line is a shell comment (or a markdown heading) -- inert either
    // way, and this very doc has to be able to WRITE the broken form in order to
    // explain it. Only executable lines can actually mis-parse.
    if (/^\s*#/.test(lines[i])) continue;
    for (const m of lines[i].matchAll(re)) {
      hits.push({ line: i + 1, match: m[0], text: lines[i].trim() });
    }
  }
  return hits;
}

/**
 * Find `for x in $VAR` / `for x in ${VAR}` -- a `for` list that is a bare parameter
 * expansion. bash word-splits it; zsh does not, so the loop runs once over the whole
 * concatenated value.
 *
 * Positional parameters are included (`$1` … `$9`) because they behave the same way:
 * measured `f(){ for x in $1; …; }; f "a b c"` at 3 iterations under bash and 1 under
 * zsh. Every entry below was measured, not reasoned about:
 *
 *   - `for x in "$@"` / `for x in "${arr[@]}"` -- quoted; both shells expand element-wise.
 *   - `for f in a b c`                         -- a literal word list.
 *   - `for b in $(cmd)`                        -- command substitution; zsh DOES split
 *                                                 this (3 iterations in both shells).
 *                                                 The `$` here is followed by `(`, which
 *                                                 the pattern excludes.
 *   - `for x in $@` / `for x in $*`            -- SAFE: zsh expands both as arrays, so
 *                                                 both shells give 3. Excluded on
 *                                                 purpose -- flagging them would be a
 *                                                 false positive.
 *
 * TWO KNOWN LIMITS, so a green scan is not mistaken for "no split hazard possible":
 *   1. It is LINE-ORIENTED. A `for` list continued onto the next line with a trailing
 *      `\` would evade it. Nothing in the docs does that today.
 *   2. It only sees a *parameter expansion* as the first list token. An arithmetic or
 *      array-subscript form would need its own pattern.
 * The one block that actually matters is independently shape-pinned below, which is
 * what covers those gaps for the load-bearing snippet.
 */
function findUnquotedForSplitHazards(text) {
  // `\$\{?[A-Za-z_0-9]` matches `$VAR`, `${VAR}`, `$1`, `${1}` -- and deliberately not
  // `$(`, `$@`, `$*`, or a quoted `"$…`.
  const re = /\bfor\s+[A-Za-z_][A-Za-z0-9_]*\s+in\s+\$\{?[A-Za-z_0-9]/g;
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // As above: a `#`-leading line is an inert comment or markdown heading, and the
    // doc must be able to WRITE the broken form in order to warn about it.
    if (/^\s*#/.test(lines[i])) continue;
    for (const m of lines[i].matchAll(re)) {
      hits.push({ line: i + 1, match: m[0], text: lines[i].trim() });
    }
  }
  return hits;
}

/** Pull the body of every `cat >|>> <path> <<'SH' … SH` heredoc out of a doc. */
function extractHeredocs(md, targetPath) {
  const re = new RegExp(
    '^cat >>? ' +
      targetPath.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`) +
      String.raw` <<'SH'\n([\s\S]*?)\nSH$`,
    'gm',
  );
  return [...md.matchAll(re)].map((m) => m[1]);
}

/** `command -v <name>` — true when the binary is on PATH. */
function commandExists(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function shellExists(shell) {
  return commandExists(shell);
}

describe('auto-ship skill docs: no zsh-modifier hazard in any runnable snippet', () => {
  const docs = skillDocs();

  it('finds skill docs to scan (the scan must not be vacuous)', () => {
    expect(docs.length).toBeGreaterThan(5);
    expect(docs).toContain('.claude/skills/auto-ship/references/github-project.md');
  });

  it('never writes an unbraced `$var:` before a zsh modifier letter', () => {
    const offenders = [];
    for (const rel of docs) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      for (const hit of findZshModifierHazards(text)) {
        offenders.push(`${rel}:${hit.line}  ${hit.match}  -- ${hit.text}`);
      }
    }
    expect(
      offenders,
      'These skill-doc snippets contain `$var:` followed by a zsh history-modifier ' +
        'letter. The Bash tool runs zsh, so zsh will rewrite the expansion and the ' +
        'snippet will mean something different than it does under bash -- silently. ' +
        'This is how `a$i:updateProjectV2ItemFieldValue` became ' +
        '`a1pdateProjectV2ItemFieldValue` and broke every batched board write. ' +
        'Fix: brace the parameter -- `${var}:` -- which is a no-op under bash.',
    ).toEqual([]);
  });
});

describe('auto-ship skill docs: no unquoted-`$VAR` `for` list in any runnable snippet', () => {
  const docs = skillDocs();

  it('finds skill docs to scan (the scan must not be vacuous)', () => {
    expect(docs.length).toBeGreaterThan(5);
    expect(docs).toContain('.claude/skills/auto-ship/references/github-project.md');
  });

  it('never iterates a `for` loop over a bare parameter expansion', () => {
    const offenders = [];
    for (const rel of docs) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      for (const hit of findUnquotedForSplitHazards(text)) {
        offenders.push(`${rel}:${hit.line}  ${hit.match}  -- ${hit.text}`);
      }
    }
    expect(
      offenders,
      'These skill-doc snippets iterate a `for` loop over an unquoted parameter ' +
        'expansion. The Bash tool runs zsh, and zsh does NOT word-split one, so the ' +
        'loop runs exactly ONCE over the whole concatenated value while the same ' +
        'line does the right thing under bash. This is how the forward-learning loop ' +
        '`for id in $IDS` fed one bogus node id to append_learnings and printed ' +
        '`learnings: skip (read)`, which at the time was indistinguishable from a ' +
        'rate-limit blip (a malformed id is loud since TASK-315, but do not lean on ' +
        'that -- just write the portable loop). ' +
        'Fix: `printf \'%s\\n\' "$VAR" | while IFS= read -r x; do …; done`, which is ' +
        'byte-identical under both shells. (`${=VAR}` also splits, but only in zsh.) ' +
        'Note: `for x in $(cmd)` is NOT this bug -- command substitution does split ' +
        'under zsh.',
    ).toEqual([]);
  });

  it("§4's forward-learning loop reaches append_learnings via `read -r`", () => {
    // Pin the shape, not just the absence of the bug: the block is regenerated into a
    // live orchestrator run at every merge, and it is the only place `append_learnings`
    // is called in a loop. A rewrite that reintroduces any splitting-dependent form
    // should fail here even if it dodges the scan above.
    const md = readFileSync(GITHUB_PROJECT_MD, 'utf8');
    // NOT anchored to start-of-line on purpose. An earlier draft used
    // `/^\s*append_learnings "\$id"/m`, which would have matched 0 blocks if someone
    // collapsed the fix back to the equally-correct one-liner
    // `printf … | while IFS= read -r id; do append_learnings "$id" …; done` -- failing
    // red with the misleading "gone vacuous" message for a change that is actually
    // fine. Matching anywhere in the block still yields exactly one hit (no other
    // `bash` block contains this substring; the definition reads `append_learnings() {`).
    const blocks = [...md.matchAll(/```bash\n([\s\S]*?)\n```/g)]
      .map((m) => m[1])
      .filter((b) => /append_learnings "\$id"/.test(b));
    expect(
      blocks.length,
      'expected github-project.md to still ship a fenced bash block that calls ' +
        'append_learnings per item id. Zero matches means this guard has gone vacuous.',
    ).toBe(1);
    expect(blocks[0]).toMatch(/while IFS= read -r id/);
  });
});

// The mechanism itself, so the scan above is never dismissed as pedantry. These two
// shapes are the before and after of the fix.
describe('zsh vs bash word-splitting (the TASK-310 mechanism)', () => {
  const count = (shell, script) =>
    execFileSync(shell, ['-c', script], { encoding: 'utf8' }).trim();

  const BROKEN = 'IDS="a b c"; n=0; for id in $IDS; do n=$((n+1)); done; echo "$n"';
  const FIXED =
    'IDS="a\nb\nc"; printf \'%s\\n\' "$IDS" | { n=0; while IFS= read -r id; do ' +
    '[ -n "$id" ] || continue; n=$((n+1)); done; echo "$n"; }';

  it('bash splits an unquoted $VAR in a for list', () => {
    expect(count('bash', BROKEN)).toBe('3');
  });

  it.skipIf(!shellExists('zsh'))('zsh does NOT -- this is the whole bug', () => {
    expect(count('zsh', BROKEN)).toBe('1');
  });

  it('the `read -r` form the doc now uses agrees in both shells', () => {
    expect(count('bash', FIXED)).toBe('3');
    if (shellExists('zsh')) expect(count('zsh', FIXED)).toBe('3');
  });

  // These two pin the detector's INCLUSION and EXCLUSION boundaries to measured
  // behaviour rather than to my reading of the manuals. If a future zsh changes either,
  // this fails and the pattern above should be revisited -- not the other way round.
  const POSITIONAL = 'f(){ n=0; for x in $1; do n=$((n+1)); done; echo "$n"; }; f "a b c"';
  const AT = 'set -- a b c; n=0; for x in $@; do n=$((n+1)); done; echo "$n"';

  it('a positional parameter splits under bash but not zsh (so it IS flagged)', () => {
    expect(count('bash', POSITIONAL)).toBe('3');
    if (shellExists('zsh')) expect(count('zsh', POSITIONAL)).toBe('1');
  });

  it('unquoted $@ splits under BOTH (so it is NOT flagged)', () => {
    expect(count('bash', AT)).toBe('3');
    if (shellExists('zsh')) expect(count('zsh', AT)).toBe('3');
  });
});

describe('board_batch generates the same GraphQL under bash and zsh', () => {
  const md = readFileSync(GITHUB_PROJECT_MD, 'utf8');
  const blocks = extractHeredocs(md, '.claude/auto-ship-board.sh');

  it('the doc still ships a .claude/auto-ship-board.sh heredoc', () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('exposes board_batch_query_preview so the parity check can run offline', () => {
    expect(blocks.join('\n')).toContain('board_batch_query_preview()');
  });

  const parityDir = mkdtempSync(join(tmpdir(), 'autoship-parity-'));
  const helperPath = (() => {
    const f = join(parityDir, 'board.sh');
    writeFileSync(f, blocks.join('\n') + '\n');
    return f;
  })();
  afterAll(() => rmSync(parityDir, { recursive: true, force: true }));

  const preview = (shell) =>
    execFileSync(shell, ['-c', `. ${helperPath} && board_batch_query_preview 3`], {
      encoding: 'utf8',
    });

  it('bash produces well-formed aliases', () => {
    const out = preview('bash');
    expect(out).toContain(' a1:updateProjectV2ItemFieldValue');
    expect(out).toContain(' a3:updateProjectV2ItemFieldValue');
    expect(out).not.toContain('a1pdateProjectV2ItemFieldValue');
  });

  // zsh is the shell the Bash tool actually uses on the dev machine. CI runners may
  // not have it; the static scan above is the unconditional guard, this is the
  // end-to-end proof when the shell is available.
  it.skipIf(!shellExists('zsh'))('zsh produces byte-identical output to bash', () => {
    expect(preview('zsh')).toEqual(preview('bash'));
  });

  it.skipIf(!shellExists('zsh'))('zsh does not eat the alias `u`', () => {
    expect(preview('zsh')).toContain(' a1:updateProjectV2ItemFieldValue');
  });
});

describe('board reads assert non-truncation, not non-emptiness', () => {
  const md = readFileSync(GITHUB_PROJECT_MD, 'utf8');

  // Headroom over the live board (300+ items as of 2026-08). Raise BOTH this and the
  // doc when the board approaches it -- a truncated snapshot makes the orchestrator
  // derive its ready set from a partial board, which is invisible until a card is
  // mysteriously never dispatched.
  const MIN_LIMIT = 700;

  it('every board-read limit in the doc is >= 700', () => {
    // Two shapes count: a literal `item-list … --limit 250`, and the `BOARD_LIMIT=250`
    // assignment the call sites interpolate. Following only one of them lets the other
    // regress -- and the doc has moved between the two forms once already.
    const literals = [...md.matchAll(/item-list[^\n]*--limit (\d+)/g)].map((m) => Number(m[1]));
    const vars = [...md.matchAll(/^BOARD_LIMIT=(\d+)/gm)].map((m) => Number(m[1]));
    const limits = [...literals, ...vars];
    expect(
      limits.length,
      'expected the doc to still declare a board-read limit, as a literal --limit or ' +
        'a BOARD_LIMIT= assignment. Zero matches means this guard has gone vacuous -- ' +
        'the doc changed shape and the regex no longer follows it.',
    ).toBeGreaterThan(0);
    // Every interpolated `--limit "$BOARD_LIMIT"` must resolve to a checked variable.
    const interpolated = [...md.matchAll(/item-list[^\n]*--limit "\$([A-Z_]+)"/g)].map((m) => m[1]);
    for (const name of interpolated) {
      expect(vars.length, `${name} is interpolated but never assigned a literal`).toBeGreaterThan(0);
      expect(name).toBe('BOARD_LIMIT');
    }
    const tooSmall = limits.filter((n) => n < MIN_LIMIT);
    expect(
      tooSmall,
      `A --limit below ${MIN_LIMIT} silently truncates the board read. The board ` +
        'held 300+ items while the helper shipped --limit 200, so the orchestrator ' +
        'derived its ready set, dep review and crash reconciliation from half a ' +
        'board. If the board has genuinely outgrown this, raise BOTH the doc and ' +
        'MIN_LIMIT in this test -- do not lower the guard.',
    ).toEqual([]);
  });

  it('board_snapshot fails fatally when the read HITS the limit', () => {
    // A length>0 check passes on a truncated array, so the guard must compare
    // against the limit itself -- hitting it exactly is indistinguishable from
    // being cut off.
    const [snapshot] = extractHeredocs(md, '.claude/auto-ship-board.sh');
    expect(snapshot).toMatch(/-ge "\$BOARD_LIMIT"/);
    expect(snapshot).toContain('board truncated');
    expect(
      snapshot,
      'board_snapshot must not go back to guarding only `length>0` -- that is the ' +
        'check that passed happily on a truncated board.',
    ).not.toContain('type=="array" and length>0');
  });
});

describe('the progress-helper completeness guard names all three functions', () => {
  const md = readFileSync(GITHUB_PROJECT_MD, 'utf8');
  const helper = extractHeredocs(md, '.claude/auto-ship-progress.sh').join('\n');

  // A stale on-disk helper that predates a function has already caused one real
  // regression: the triage agent's set_needs_input call silently no-op'd and it
  // hand-rolled a mangled Q&A block. The doc must keep defining all three, and the
  // run-start guard must keep checking for all three.
  for (const fn of ['append_progress', 'set_needs_input', 'append_learnings']) {
    it(`defines ${fn}`, () => {
      expect(helper).toContain(`${fn}() {`);
    });
    it(`run-start guard checks for ${fn}`, () => {
      expect(md).toMatch(
        new RegExp(String.raw`for f in .*\b` + fn + String.raw`\b.*; do`),
      );
    });
  }
});

// TASK-315: a malformed item id must be LOUD, and must never borrow the transient
// message. `learnings: skip (read)` means "rate limit / blip / best-effort, ignore me".
// It used to also be what a caller saw after handing the helper a garbage node id --
// so the operator read a caller bug as background noise. The shape gate below is a
// zero-API-call positive signal (project item ids are `PVTI_`-prefixed and hold no
// whitespace) that keeps the two channels disjoint.
//
// Everything here runs offline: the malformed path returns before the helper ever
// calls `gh`, and the transient path uses a `gh` stub that just fails. No network,
// no jq, no board.
describe('progress helpers: a malformed id is loud, a transient failure stays quiet', () => {
  const md = readFileSync(GITHUB_PROJECT_MD, 'utf8');
  const helperBlocks = extractHeredocs(md, '.claude/auto-ship-progress.sh');
  const hbBlocks = extractHeredocs(md, '.claude/auto-ship-hb.sh');

  const FNS = [
    { fn: 'append_progress', label: 'progress' },
    { fn: 'append_learnings', label: 'learnings' },
    { fn: 'set_needs_input', label: 'needs-input' },
  ];

  it('the doc still ships all three helper heredocs plus the wrapper', () => {
    // Guards against this whole describe going vacuous if the doc changes shape.
    expect(helperBlocks.length).toBe(3);
    expect(hbBlocks.length).toBe(1);
  });

  it('each helper gates the id shape BEFORE its GraphQL read', () => {
    // Order is the invariant, not mere presence: a gate placed after the read still
    // burns an API call and still lets the read's own failure fire first.
    const all = helperBlocks.join('\n');
    for (const { fn } of FNS) {
      const body = all.slice(all.indexOf(`${fn}() {`));
      const gate = body.indexOf('MALFORMED-ID');
      const read = body.indexOf('gh api graphql');
      expect(gate, `${fn} has no MALFORMED-ID path`).toBeGreaterThan(-1);
      expect(read, `${fn} no longer reads via gh api graphql`).toBeGreaterThan(-1);
      expect(gate, `${fn}'s shape gate must precede its GraphQL read`).toBeLessThan(read);
    }
  });

  // A run start writes the helper and the wrapper side by side; lay them out the same
  // way so the wrapper's own-location helper resolution is exercised for real.
  const tempDirs = [];
  afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  });
  const dir = mkdtempSync(join(tmpdir(), 'autoship-malformed-'));
  tempDirs.push(dir);
  const helper = join(dir, 'auto-ship-progress.sh');
  const hb = join(dir, 'auto-ship-hb.sh');
  const binDir = join(dir, 'bin');
  const ghLog = join(dir, 'gh-invoked.log');
  writeFileSync(helper, helperBlocks.join('\n') + '\n');
  writeFileSync(hb, hbBlocks.join('\n') + '\n', { mode: 0o755 });
  mkdirSync(binDir);
  // A `gh` that records that it ran and then fails -- i.e. the TRANSIENT case. Its log
  // is also how we prove the malformed path never reaches the API at all.
  writeFileSync(join(binDir, 'gh'), `#!/bin/sh\necho ran >> ${JSON.stringify(ghLog)}\nexit 1\n`, {
    mode: 0o755,
  });

  const run = (file, args) => {
    const opts = {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    };
    try {
      return { code: 0, out: execFileSync(file, args, opts) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };
  const sourceAndCall = (shell, script) => run(shell, ['-c', script]);

  // zsh is the shell the Bash tool actually runs, so it is the one that matters most;
  // CI runners may not have it, hence the conditional. bash is unconditional.
  const SHELLS = ['bash', ...(shellExists('zsh') ? ['zsh'] : [])];

  // Every one of these was rejected by live GitHub with rc=1 + NOT_FOUND, i.e. every
  // one of them used to print the transient line.
  const MALFORMED = [
    ['PVTI_a PVTI_b', 'the TASK-310 concatenation of two ids into one argument'],
    ['PVTX_lADOsomething', 'a wrong prefix'],
    ['not-an-id', 'plain garbage'],
    ['', 'an empty argument'],
    ['<ITEM-ID>', 'an unsubstituted dispatch-template placeholder'],
  ];

  for (const shell of SHELLS) {
    for (const { fn, label } of FNS) {
      for (const [value, why] of MALFORMED) {
        it(`${shell}: ${fn} is loud and nonzero for ${why}`, () => {
          rmSync(ghLog, { force: true });
          const r = sourceAndCall(shell, `. ${JSON.stringify(helper)} && ${fn} '${value}' 'a line'`);
          expect(r.out).toContain(`${label}: MALFORMED-ID`);
          expect(
            r.code,
            'a caller bug must return nonzero -- returning 0 makes it silent success',
          ).not.toBe(0);
          expect(
            r.out,
            'the loud message must not also carry the transient wording',
          ).not.toContain('skip (');
          expect(
            existsSync(ghLog),
            'the shape gate must return before the helper spends an API call',
          ).toBe(false);
        });
      }

      it(`${shell}: ${fn} stays quiet and returns 0 when the read genuinely fails`, () => {
        // Best-effort must stay best-effort: a rate limit or blip on a well-shaped id
        // is still a quiet `skip (read)` with return 0, and must never block a ship.
        rmSync(ghLog, { force: true });
        const r = sourceAndCall(
          shell,
          `. ${JSON.stringify(helper)} && ${fn} 'PVTI_lADOAAtestonly' 'a line'`,
        );
        expect(r.code).toBe(0);
        expect(r.out).toContain(`${label}: skip (read)`);
        expect(r.out).not.toContain('MALFORMED-ID');
        expect(existsSync(ghLog), 'a well-shaped id must actually reach the API').toBe(true);
      });
    }
  }

  // The wrapper is the layer an agent actually calls, and it relabels ANY nonzero
  // return as `HEARTBEAT-FAILED(transient)` -- which would recreate the exact same
  // confusion one hop up. It needs its own third class.
  it('the wrapper reports a caller bug as its own class, not as transient', () => {
    rmSync(ghLog, { force: true });
    const r = run('bash', [hb, 'PVTI_a PVTI_b', 'a line']);
    expect(r.out).toContain('MALFORMED-ID');
    expect(r.out).toContain('HEARTBEAT-FAILED(caller)');
    expect(r.out).not.toContain('HEARTBEAT-FAILED(transient)');
    expect(r.code).toBe(6);
    expect(existsSync(ghLog)).toBe(false);
  });

  it('the wrapper still reports a genuine read failure as transient', () => {
    rmSync(ghLog, { force: true });
    const r = run('bash', [hb, 'PVTI_lADOAAtestonly', 'a line']);
    expect(r.out).toContain('HEARTBEAT-FAILED(transient)');
    expect(r.out).not.toContain('HEARTBEAT-FAILED(caller)');
    expect(r.code).toBe(1);
  });

  // Review finding, and it is this card's own bug class one layer up: if the wrapper
  // decided the caller class by grepping $out for `MALFORMED-ID`, then a SUCCESSFUL
  // write whose progress line merely CONTAINS that string would be reported as a
  // non-retryable caller bug. auto-ship ships changes to this very file, so a
  // progress line mentioning MALFORMED-ID is not hypothetical. The wrapper therefore
  // classifies on the RETURN CODE. Driven through a FAKE helper so the wrapper's
  // classification is isolated from `gh`, `jq` and the network entirely.
  const withFakeHelper = (body) => {
    const d = mkdtempSync(join(tmpdir(), 'autoship-hbclass-'));
    tempDirs.push(d);
    writeFileSync(join(d, 'auto-ship-progress.sh'), `append_progress() {\n${body}\n}\n`);
    const w = join(d, 'auto-ship-hb.sh');
    writeFileSync(w, hbBlocks.join('\n') + '\n', { mode: 0o755 });
    return run('bash', [w, 'PVTI_lADOAAtestonly', 'a line']);
  };

  it('does not call a successful write a caller bug because its text says MALFORMED-ID', () => {
    const r = withFakeHelper(
      '  echo "progress: - 12:34 fixed the MALFORMED-ID gate"; return 0',
    );
    expect(r.out).not.toContain('HEARTBEAT-FAILED');
    expect(r.code).toBe(0);
  });

  it('does not call a successful write transient because its text says skip (', () => {
    // Same collision, pre-existing shape: the transient match is anchored to the
    // leading `<label>: ` so a caller-supplied line cannot trip it.
    const r = withFakeHelper('  echo "progress: - 12:34 made it skip (nothing)"; return 0');
    expect(r.out).not.toContain('HEARTBEAT-FAILED');
    expect(r.code).toBe(0);
  });

  it('keys the caller class to the gate return code 2', () => {
    const r = withFakeHelper('  echo "progress: MALFORMED-ID junk"; return 2');
    expect(r.out).toContain('HEARTBEAT-FAILED(caller)');
    expect(r.code).toBe(6);
  });

  it('still calls a genuine quiet skip transient', () => {
    const r = withFakeHelper('  echo "progress: skip (read)"; return 0');
    expect(r.out).toContain('HEARTBEAT-FAILED(transient)');
    expect(r.code).toBe(1);
  });

  it('the wrapper header comment enumerates all three failure classes', () => {
    // The header is what an operator reads to interpret an exit code. It enumerated
    // two classes while the script had three, which is how the doc goes stale.
    const wrapper = hbBlocks[0];
    expect(wrapper).toMatch(/malformed|caller/i);
    expect(wrapper).toContain('exit 6');
  });
});

// ---------------------------------------------------------------------------
// TASK-470: a MULTI-LINE entry must land intact, and a helper must never write a
// body it did not successfully construct.
//
// What happened (observed first-hand by the orchestrator, 2026-09-19). All three
// helpers spliced their entry with `awk -v e="$entry" … '$0==end{print e} {print}'`.
// An awk `-v` assignment CANNOT carry a literal newline: awk aborts with
// `newline in string`, prints nothing to stdout, and exits 2. Nothing checked that
// exit status, so `nb` was the empty string -- and the helper handed that to
// updateProjectV2DraftIssue as the ENTIRE card body and then printed its normal
// `learnings: - …` SUCCESS line. A real card (TASK-463) was reduced to 1 byte.
//
// The reason it hid for so long is the branch structure: the FIRST multi-line append
// to a card takes the `printf` arm (there is no block to splice into yet) and works
// fine. Only the SECOND-or-later one reaches awk. Ten sibling cards audited the same
// day were intact -- each had received exactly one multi-line append. So a
// single-append test PASSES against the bug; the reproduction below is deliberately
// two appends.
//
// This describe is BEHAVIOURAL, not a doc scan: it extracts the helper heredocs the
// orchestrator actually regenerates, runs them under bash and zsh against a `gh` stub
// that round-trips a real body through a state file, and asserts on the body that was
// stored. The static assertions live in the sibling describe below so that the
// `awk -v` shape stays banned even where jq is unavailable.
//
// KNOW WHERE THE TEETH ARE ON EACH PLATFORM. The multi-line-append tests here catch a
// reintroduced `awk -v` splice only on an awk that rejects a newline -- macOS's, which
// is the platform auto-ship runs on and where the card was destroyed. gawk/mawk accept
// it, so on a Linux runner those same tests would go GREEN against the buggy helper.
// What holds the line there is unconditional and structural: the `awk -v` ban and the
// "refusal reachable before the mutation" check in the sibling describe, plus the
// REFUSED / wrapper-class cases here, none of which depend on the awk implementation.
// Do not "simplify" the static pair away because the behavioural ones look sufficient
// locally -- locally is the only place they are.
describe('progress helpers carry a multi-line entry without destroying the body', () => {
  const md = readFileSync(GITHUB_PROJECT_MD, 'utf8');
  const helperBlocks = extractHeredocs(md, '.claude/auto-ship-progress.sh');
  const hbBlocks = extractHeredocs(md, '.claude/auto-ship-hb.sh');

  const HUMAN = 'human-authored description\n\nsecond paragraph a person typed';
  const ITEM = 'PVTI_lADOAAtestonly';

  // Single-quote for the shell. NOT JSON.stringify: that renders a real newline as the
  // two characters `\` `n`, which a double-quoted shell word keeps literal -- so the
  // "multi-line" test would have passed a single-line string and proved nothing. (It
  // did, on the first run of this suite.)
  const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

  const dirs = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  // A `gh` that behaves like the real one for the two calls the helpers make: the
  // node query returns the current body, the mutation stores whatever body it is
  // handed. The stored file IS the card, so "what did the helper write" is directly
  // observable -- including writing an empty body, which is the bug.
  function makeEnv() {
    const dir = mkdtempSync(join(tmpdir(), 'autoship-multiline-'));
    dirs.push(dir);
    const helper = join(dir, 'auto-ship-progress.sh');
    writeFileSync(helper, helperBlocks.join('\n') + '\n');
    writeFileSync(join(dir, 'auto-ship-hb.sh'), hbBlocks.join('\n') + '\n', { mode: 0o755 });
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const state = join(dir, 'body.txt');
    writeFileSync(state, HUMAN);
    writeFileSync(
      join(binDir, 'gh'),
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        'const args = process.argv.slice(2);',
        'const f = {};',
        'for (let i = 0; i < args.length; i++) {',
        "  if (args[i] !== '-f') continue;",
        "  const s = args[++i] ?? '';",
        "  const j = s.indexOf('=');",
        '  f[s.slice(0, j)] = s.slice(j + 1);',
        '}',
        'const STATE = process.env.AUTOSHIP_STUB_BODY;',
        "if (/^\\s*mutation/.test(f.query || '')) {",
        "  fs.writeFileSync(STATE, f.b ?? '');",
        "  process.stdout.write(JSON.stringify({ data: { updateProjectV2DraftIssue: { draftIssue: { id: f.d } } } }));",
        '} else {',
        "  const body = fs.readFileSync(STATE, 'utf8');",
        "  process.stdout.write(JSON.stringify({ data: { node: { content: { id: 'DI_stub', body } } } }));",
        '}',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return { dir, helper, hb: join(dir, 'auto-ship-hb.sh'), binDir, state };
  }

  const runIn = (env, shell, script) => {
    const opts = {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${env.binDir}:${process.env.PATH}`,
        AUTOSHIP_STUB_BODY: env.state,
      },
    };
    try {
      return { code: 0, out: execFileSync(shell, ['-c', script], opts) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };

  // The stub `gh` is node; the helpers pipe its JSON through jq. jq ships on
  // ubuntu-latest and on the dev machine. If it is ever missing these skip, which is
  // why the static bans below are a SEPARATE, unconditional describe -- a green run
  // with these skipped still cannot let `awk -v e="$entry"` back in.
  const canRun = commandExists('jq') && commandExists('node');
  const SHELLS = ['bash', ...(shellExists('zsh') ? ['zsh'] : [])];

  it('has jq + node available for the behavioural reproduction', () => {
    // Not skipped: if this ever goes false the reader should know the proof below was
    // not executed, rather than reading a green suite as coverage.
    expect(
      canRun,
      'jq and node are required to run the helper end to end; the behavioural ' +
        'reproduction below was SKIPPED. The static bans still ran.',
    ).toBe(true);
  });

  for (const shell of SHELLS) {
    for (const [fn, label, heading] of [
      ['append_progress', 'progress', '### Progress'],
      ['append_learnings', 'learnings', '### Predecessor learnings'],
    ]) {
      it.skipIf(!canRun)(
        `${shell}: ${fn} survives TWO multi-line appends (the exact TASK-470 sequence)`,
        () => {
          const env = makeEnv();
          const one = 'first entry line one\n  first entry line two';
          const two = 'second entry line one\n  second entry line two';
          const call = (e) =>
            runIn(
              env,
              shell,
              `. ${JSON.stringify(env.helper)} && ${fn} ${shq(ITEM)} ${shq(e)}`,
            );

          const r1 = call(one);
          expect(r1.code, `first append failed: ${r1.out}`).toBe(0);
          const afterFirst = readFileSync(env.state, 'utf8');
          expect(afterFirst).toContain('human-authored description');
          expect(afterFirst).toContain(heading);

          // THE BUG. Against the old `awk -v e="$entry"` splice this call printed a
          // success line and stored an EMPTY body.
          const r2 = call(two);
          expect(r2.code, `second append failed: ${r2.out}`).toBe(0);
          const afterSecond = readFileSync(env.state, 'utf8');

          expect(
            afterSecond.length,
            'the second multi-line append truncated the card body -- this is the ' +
              'TASK-470 data loss: awk -v cannot carry a newline, it emitted nothing, ' +
              'and the empty result was written back as the whole body.',
          ).toBeGreaterThan(afterFirst.length);
          expect(afterSecond, 'human-authored text outside the markers must survive')
            .toContain('human-authored description');
          expect(afterSecond).toContain('second paragraph a person typed');
          // Both entries, with their newlines, verbatim.
          expect(afterSecond).toContain('first entry line one\n  first entry line two');
          expect(afterSecond).toContain('second entry line one\n  second entry line two');
          // Exactly one block, still fenced.
          expect(afterSecond.split(`<!-- AUTOSHIP-${label === 'progress' ? 'PROGRESS' : 'LEARNINGS'}:START -->`))
            .toHaveLength(2);
          expect(r2.out).not.toContain('REFUSED');
        },
      );

      it.skipIf(!canRun)(
        `${shell}: ${fn} splices at the FIRST END marker and leaves human text after it alone`,
        () => {
          // The shell splice takes `${body%%"$END"*}` / `${body#*"$END"}`, i.e. the
          // FIRST occurrence. A human note that quotes the end marker -- or a body that
          // somehow carries two -- must not move the insertion point or lose the text
          // after the block. (awk inserted before EVERY line equal to the marker, which
          // would have duplicated the entry here.)
          const env = makeEnv();
          const S = `<!-- AUTOSHIP-${label === 'progress' ? 'PROGRESS' : 'LEARNINGS'}:START -->`;
          const E = `<!-- AUTOSHIP-${label === 'progress' ? 'PROGRESS' : 'LEARNINGS'}:END -->`;
          writeFileSync(
            env.state,
            `${HUMAN}\n\n${S}\n${heading}\n- 10:00 a\n${E}\n\na human note quoting ${E} inline\n`,
          );
          const r = runIn(
            env,
            shell,
            `. ${JSON.stringify(env.helper)} && ${fn} ${shq(ITEM)} ${shq('multi\nline')}`,
          );
          expect(r.code, r.out).toBe(0);
          const stored = readFileSync(env.state, 'utf8');
          expect(stored).toContain('a human note quoting');
          expect(stored).toContain('human-authored description');
          expect(stored).toContain('multi\nline');
          // Inserted once, not once per marker occurrence.
          expect(stored.split('multi\nline')).toHaveLength(2);
        },
      );

      it.skipIf(!canRun)(
        `${shell}: ${fn} anchors the END to the START, so a marker quoted ABOVE the block cannot capture the splice`,
        () => {
          // Review finding on this PR, and it is this PR's own failure direction: a
          // plain `${body%%"$END"*}` takes the FIRST end marker ANYWHERE, so a human
          // description that merely quotes the marker above the block captured the
          // splice -- the entry landed in the human prose, the length-and-markers gate
          // passed, and the helper printed success. `awk '$0==end'` matched whole lines
          // and never did this, so it was a regression the gate could not see. The END
          // is now taken from after the START.
          const env = makeEnv();
          const S = `<!-- AUTOSHIP-${label === 'progress' ? 'PROGRESS' : 'LEARNINGS'}:START -->`;
          const E = `<!-- AUTOSHIP-${label === 'progress' ? 'PROGRESS' : 'LEARNINGS'}:END -->`;
          const desc = `the card explains the ${E} marker inline, above the block`;
          writeFileSync(env.state, `${desc}\n\n${S}\n${heading}\n- 10:00 a\n${E}\n`);
          const r = runIn(
            env,
            shell,
            `. ${JSON.stringify(env.helper)} && ${fn} ${shq(ITEM)} ${shq('landed')}`,
          );
          expect(r.code, r.out).toBe(0);
          const stored = readFileSync(env.state, 'utf8');
          expect(stored, 'the human description must come back byte-identical').toContain(
            `${desc}\n`,
          );
          // The entry belongs inside the block, after the existing one -- never in the
          // prose above the START.
          expect(stored.indexOf('landed')).toBeGreaterThan(stored.indexOf(S));
          expect(stored.indexOf('landed')).toBeGreaterThan(stored.indexOf('- 10:00 a'));
        },
      );

      it.skipIf(!canRun)(
        `${shell}: ${fn} REFUSES an entry that carries a block marker`,
        () => {
          // Such an entry would plant a second END inside the block and move every
          // later splice. auto-ship ships changes to this very file, so a progress line
          // about these markers is not hypothetical.
          const env = makeEnv();
          const S = `<!-- AUTOSHIP-${label === 'progress' ? 'PROGRESS' : 'LEARNINGS'}:START -->`;
          const E = `<!-- AUTOSHIP-${label === 'progress' ? 'PROGRESS' : 'LEARNINGS'}:END -->`;
          const before = `${HUMAN}\n\n${S}\n${heading}\n- 10:00 a\n${E}\n`;
          writeFileSync(env.state, before);
          for (const marker of [S, E]) {
            writeFileSync(env.state, before);
            const r = runIn(
              env,
              shell,
              `. ${JSON.stringify(env.helper)} && ${fn} ${shq(ITEM)} ${shq(`sneaky ${marker} tail`)}`,
            );
            expect(r.out).toContain(`${label}: REFUSED`);
            expect(r.out).not.toContain('skip (');
            expect(r.code).not.toBe(0);
            expect(readFileSync(env.state, 'utf8'), 'nothing may be written').toBe(before);
          }
        },
      );

      it.skipIf(!canRun)(
        `${shell}: ${fn} still accepts the literal backslash-n separator`,
        () => {
          // Back-compat, not a new feature: the old `awk -v` splice expanded escapes,
          // so a caller writing "a\nb" in a double-quoted string got two lines. That
          // form must keep working -- dropping it would be a silent regression for
          // every caller that used it, and it is the convention set_needs_input has
          // documented all along. Two appends, so the splice path is the one tested.
          const env = makeEnv();
          const call = (e) =>
            runIn(env, shell, `. ${JSON.stringify(env.helper)} && ${fn} ${shq(ITEM)} ${shq(e)}`);
          expect(call(String.raw`alpha\nbeta`).code).toBe(0);
          expect(call(String.raw`gamma\ndelta`).code).toBe(0);
          const stored = readFileSync(env.state, 'utf8');
          expect(stored).toContain('alpha\nbeta');
          expect(stored).toContain('gamma\ndelta');
          expect(stored).toContain('human-authored description');
        },
      );

      it.skipIf(!canRun)(
        `${shell}: ${fn} REFUSES loudly and writes nothing when the block is corrupt`,
        () => {
          // The direction of failure is the whole point. Old code: destroy + report
          // success. New code: write nothing + say so + return nonzero.
          const env = makeEnv();
          const start = `<!-- AUTOSHIP-${label === 'progress' ? 'PROGRESS' : 'LEARNINGS'}:START -->`;
          const corrupt = `${HUMAN}\n\n${start}\n${heading}\n- 10:00 an entry\n`;
          writeFileSync(env.state, corrupt);
          const r = runIn(
            env,
            shell,
            `. ${JSON.stringify(env.helper)} && ${fn} ${shq(ITEM)} ${shq('x\ny')}`,
          );
          expect(r.out).toContain(`${label}: REFUSED`);
          expect(r.out, 'a refusal must not borrow the transient wording').not.toContain('skip (');
          expect(r.code, 'a refusal must be nonzero -- return 0 makes it silent').not.toBe(0);
          expect(
            readFileSync(env.state, 'utf8'),
            'a REFUSED helper must not have written anything at all',
          ).toBe(corrupt);
        },
      );
    }

    it.skipIf(!canRun)(
      `${shell}: set_needs_input keeps the human body across a re-set`,
      () => {
        const env = makeEnv();
        const call = (q) =>
          runIn(
            env,
            shell,
            `. ${JSON.stringify(env.helper)} && set_needs_input ${shq(ITEM)} ${shq(q)}`,
          );
        const r1 = call('first question?\nsecond question?');
        expect(r1.code, r1.out).toBe(0);
        const afterFirst = readFileSync(env.state, 'utf8');
        expect(afterFirst).toContain('human-authored description');
        expect(afterFirst).toContain('**Q1.** first question?');
        expect(afterFirst).toContain('**Q2.** second question?');

        const r2 = call('replacement question?');
        expect(r2.code, r2.out).toBe(0);
        const afterSecond = readFileSync(env.state, 'utf8');
        expect(afterSecond).toContain('human-authored description');
        expect(afterSecond).toContain('second paragraph a person typed');
        expect(afterSecond).toContain('**Q1.** replacement question?');
        expect(afterSecond).not.toContain('first question?');
        // Replaced, never duplicated.
        expect(afterSecond.split('<!-- AUTOSHIP-NEEDS-INPUT:START -->')).toHaveLength(2);
      },
    );

    it.skipIf(!canRun)(`${shell}: set_needs_input refuses an empty question set`, () => {
      const env = makeEnv();
      const r = runIn(
        env,
        shell,
        `. ${JSON.stringify(env.helper)} && set_needs_input ${shq(ITEM)} '   '`,
      );
      expect(r.out).toContain('needs-input: REFUSED');
      expect(r.code).not.toBe(0);
      expect(readFileSync(env.state, 'utf8')).toBe(HUMAN);
    });
  }

  it.skipIf(!canRun)('the wrapper reports a REFUSED write as its own class', () => {
    // rc 3 must not fall through to the transient catch-all: nothing was written and
    // nothing was lost, so calling it a rate-limit blip is the same mislabelling the
    // caller class exists to prevent.
    const env = makeEnv();
    const corrupt = `${HUMAN}\n\n<!-- AUTOSHIP-PROGRESS:START -->\n### Progress\n- 10:00 e\n`;
    writeFileSync(env.state, corrupt);
    const opts = {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${env.binDir}:${process.env.PATH}`,
        AUTOSHIP_STUB_BODY: env.state,
      },
    };
    let r;
    try {
      r = { code: 0, out: execFileSync(env.hb, [ITEM, 'a\nb'], opts) };
    } catch (e) {
      r = { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
    expect(r.out).toContain('HEARTBEAT-FAILED(refused)');
    expect(r.out).not.toContain('HEARTBEAT-FAILED(transient)');
    expect(r.out).not.toContain('HEARTBEAT-FAILED(caller)');
    expect(r.code).toBe(7);
    expect(readFileSync(env.state, 'utf8')).toBe(corrupt);
  });

  it.skipIf(!canRun)('a landed multi-line write is not mislabelled transient', () => {
    // The helper echoes its confirmation on ONE line even though the entry has
    // newlines, because the wrapper matches `^<label>: skip (` line-wise. A second
    // line of caller text saying `foo: skip (x)` would otherwise relabel a successful
    // write as a rate-limit blip.
    const env = makeEnv();
    const opts = {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${env.binDir}:${process.env.PATH}`,
        AUTOSHIP_STUB_BODY: env.state,
      },
    };
    const call = (line) => {
      try {
        return { code: 0, out: execFileSync(env.hb, [ITEM, line], opts) };
      } catch (e) {
        return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    };
    expect(call('one\ntwo').code).toBe(0); // first append -- creates the block
    const r = call('real text\nfoo: skip (a decoy in the caller text)');
    expect(r.out, r.out).not.toContain('HEARTBEAT-FAILED');
    expect(r.code).toBe(0);
    const stored = readFileSync(env.state, 'utf8');
    expect(stored).toContain('human-authored description');
    expect(stored).toContain('real text\nfoo: skip (a decoy in the caller text)');
  });
});

// The mechanism, measured rather than reasoned about -- and the static bans, which
// run even where jq/zsh are unavailable.
describe('awk -v cannot be trusted with caller text (the TASK-470 mechanism)', () => {
  // MEASURED CORRECTION to the card, and it matters. `awk -v name=value` with a
  // LITERAL NEWLINE is implementation-defined, not universally fatal:
  //
  //   * the one-true-awk that ships with macOS -- the platform auto-ship runs on, and
  //     the one the incident happened on -- aborts with `newline in string`, prints
  //     NOTHING and exits 2. That empty stdout is what the helper wrote back as the
  //     whole card body.
  //   * gawk / mawk on ubuntu-latest accept it and print the value.
  //
  // So CI would never have reproduced the card-destroying failure, and the first draft
  // of this test asserted the macOS behaviour unconditionally and went red on the
  // runner. Both branches are pinned below, because the split IS the argument: a
  // helper whose data-safety depends on which awk happens to be installed is broken
  // even on the machines where it happens to work.
  const awkNewline = (() => {
    try {
      return {
        code: 0,
        out: execFileSync(
          'bash',
          [
            '-c',
            `entry=$'a\\nb'; printf 'x\\nEND\\n' | awk -v e="$entry" -v end=END '$0==end{print e} {print}'`,
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ),
      };
    } catch (e) {
      return { code: e.status, out: e.stdout ?? '' };
    }
  })();

  it('a literal newline in awk -v is implementation-defined -- and where it fails, it emits NOTHING', () => {
    if (awkNewline.code !== 0) {
      // The destructive branch. The old helper did not check this rc, so `nb` became
      // the empty string and was written back as the entire card body.
      expect(
        awkNewline.out,
        'awk failed -- and emitted nothing, which is the data-loss precondition',
      ).toBe('');
    } else {
      // The permissive branch. Still not a reason to keep `-v`: see the escape test.
      expect(awkNewline.out, 'awk accepted the newline, so it must have printed it').toContain(
        'a\nb',
      );
    }
  });

  it.skipIf(process.platform !== 'darwin')(
    'on darwin -- the platform auto-ship actually runs on -- it is the destructive branch',
    () => {
      expect(awkNewline.code, 'macOS awk must abort on a newline in -v').not.toBe(0);
      expect(awkNewline.out).toBe('');
    },
  );

  it('awk -v silently rewrites caller text on EVERY awk: it expands escapes', () => {
    // Portable, and a second reason the old splice could not be trusted with caller
    // text: `-v` runs the value through escape processing, so a progress line
    // mentioning a Windows path or a tab sequence came out altered on every platform.
    // It is also why the fixed helpers keep an explicit `\n` -> newline substitution:
    // callers may have relied on that expansion, and only that part of it is kept.
    const out = execFileSync(
      'bash',
      ['-c', String.raw`printf 'END\n' | awk -v e='a\tb C:\next' -v end=END '$0==end{print e}'`],
      { encoding: 'utf8' },
    );
    expect(out, 'awk -v expanded the escapes rather than passing them through').not.toContain(
      String.raw`\t`,
    );
    expect(out).not.toContain(String.raw`\n`);
  });

  it('the shell splice that replaced it is byte-identical under bash and zsh', () => {
    const script =
      `body=$'head\\nEND\\ntail'; END=END; entry=$'one\\n  two'; ` +
      `nb="\${body%%"$END"*}\${entry}"$'\\n'"\${END}\${body#*"$END"}"; printf '%s' "$nb"`;
    const bash = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(bash).toBe('head\none\n  two\nEND\ntail');
    if (shellExists('zsh')) {
      expect(execFileSync('zsh', ['-c', script], { encoding: 'utf8' })).toBe(bash);
    }
  });

  it('no helper passes caller text through an awk -v assignment', () => {
    // The ban, not just the fix: `-v` is fine for the fixed marker constants, and
    // fatal for anything the caller supplies. Unconditional -- no jq, no zsh, no gh.
    const md = readFileSync(GITHUB_PROJECT_MD, 'utf8');
    const helper = extractHeredocs(md, '.claude/auto-ship-progress.sh').join('\n');
    expect(helper.length, 'the helper heredocs vanished -- this guard is vacuous').toBeGreaterThan(
      500,
    );
    // Line-oriented, and `#`-leading lines are skipped -- same rule the two scanners
    // above use, and for the same reason: the helper has to be able to WRITE the
    // broken form in a comment in order to explain why it is banned.
    const offenders = [];
    for (const line of helper.split('\n')) {
      if (/^\s*#/.test(line)) continue;
      for (const m of line.matchAll(/awk[^\n]*?-v\s+[A-Za-z_][A-Za-z0-9_]*="\$(\w+)"/g)) {
        if (!['START', 'END'].includes(m[1].toUpperCase())) offenders.push(m[1]);
      }
    }
    expect(
      offenders,
      'These awk `-v` assignments carry caller-supplied text. An awk -v assignment ' +
        'cannot hold a literal newline: awk aborts, emits nothing, and the helper ' +
        'used to write that empty result back as the entire card body while printing ' +
        'its success line (TASK-470 -- a real card went to 1 byte). Splice in shell, ' +
        'or feed the text to awk on STDIN. `-v` is only for the fixed markers.',
    ).toEqual([]);
  });

  it('every helper gates its write on a body it verified', () => {
    // Each helper must refuse rather than write an unverified body, and must say so.
    const md = readFileSync(GITHUB_PROJECT_MD, 'utf8');
    const blocks = extractHeredocs(md, '.claude/auto-ship-progress.sh');
    const all = blocks.join('\n');
    for (const fn of ['append_progress', 'append_learnings', 'set_needs_input']) {
      const start = all.indexOf(`${fn}() {`);
      expect(start, `${fn} is no longer defined -- this guard is vacuous`).toBeGreaterThan(-1);
      const rest = all.slice(start);
      // The closing `}` is at column 0. The LAST function in the file has no trailing
      // newline after it, so match on `\n}` and fall back to the end of the slice --
      // an earlier draft looked for `\n}\n` and silently produced an EMPTY body for
      // set_needs_input, i.e. a guard that asserted nothing about the last helper.
      const end = rest.indexOf('\n}');
      const fnBody = end === -1 ? rest : rest.slice(0, end);
      expect(fnBody.length, `${fn} body came back empty`).toBeGreaterThan(200);
      expect(fnBody, `${fn} has no REFUSED path`).toContain('REFUSED');
      expect(fnBody, `${fn}'s refusal must return 3, the wrapper's own class`).toMatch(
        /return 3/,
      );
      const refuse = fnBody.indexOf('REFUSED');
      const write = fnBody.indexOf('updateProjectV2DraftIssue');
      expect(write, `${fn} no longer writes`).toBeGreaterThan(-1);
      expect(
        refuse,
        `${fn}'s refusal must be reachable BEFORE the mutation -- a guard after the ` +
          'write guards nothing',
      ).toBeLessThan(write);
    }
  });

  it('the wrapper keeps a distinct exit code for a refused write', () => {
    const md = readFileSync(GITHUB_PROJECT_MD, 'utf8');
    const wrapper = extractHeredocs(md, '.claude/auto-ship-hb.sh')[0];
    expect(wrapper).toMatch(/rc -eq 3/);
    expect(wrapper).toContain('exit 7');
    expect(wrapper, 'the header an operator reads must name the class').toMatch(/refused/i);
  });
});

/** Sanity: the hazard detector itself does the right thing. */
describe('findZshModifierHazards', () => {
  it('flags the real bug', () => {
    expect(findZshModifierHazards('sel+=" a$i:updateProjectV2ItemFieldValue("')).toHaveLength(1);
  });

  it('does not flag the braced fix', () => {
    expect(findZshModifierHazards('sel+=" a${i}:updateProjectV2ItemFieldValue("')).toEqual([]);
  });

  it('flags the `:P` absolute-path modifier (zsh 5.9)', () => {
    expect(findZshModifierHazards('echo $dir:Pa')).toHaveLength(1);
  });

  it('does not flag a colon followed by a non-modifier letter', () => {
    // `:I` and `:S` are not zsh modifiers -- these lines were always safe, and the
    // TASK-298 card originally blamed exactly this one.
    expect(findZshModifierHazards(String.raw`decl+=",\$it$i:ID!,\$v$i:String!"`)).toEqual([]);
  });

  it('does not flag a GraphQL variable declaration like $p:ID!', () => {
    expect(findZshModifierHazards('mutation($p:ID!)')).toEqual([]);
  });

  it('reports the line number so the offender is findable', () => {
    const hits = findZshModifierHazards('ok\nok\nfoo $x:up bar\n');
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
  });
});

/** Sanity: the splitting detector too. */
describe('findUnquotedForSplitHazards', () => {
  it('flags the real bug', () => {
    expect(
      findUnquotedForSplitHazards('for id in $IDS; do append_learnings "$id" "x"; done'),
    ).toHaveLength(1);
  });

  it('flags the braced-but-still-unsplit form', () => {
    // Braces fix the *modifier* hazard; they do nothing for splitting.
    expect(findUnquotedForSplitHazards('for id in ${IDS}; do :; done')).toHaveLength(1);
  });

  it('does not flag a command substitution -- zsh splits those', () => {
    expect(
      findUnquotedForSplitHazards(
        `for b in $(git branch --list "auto-ship/$TASK_ID-*"); do :; done`,
      ),
    ).toEqual([]);
  });

  it('does not flag a quoted expansion', () => {
    expect(findUnquotedForSplitHazards('for op in "$@"; do :; done')).toEqual([]);
    expect(findUnquotedForSplitHazards('for x in "${arr[@]}"; do :; done')).toEqual([]);
  });

  it('flags a positional parameter -- it splits under bash but not zsh', () => {
    // Measured: `f(){ for x in $1; …; }; f "a b c"` gives 3 under bash, 1 under zsh.
    expect(findUnquotedForSplitHazards('for x in $1; do :; done')).toHaveLength(1);
    expect(findUnquotedForSplitHazards('for x in ${1}; do :; done')).toHaveLength(1);
  });

  it('does not flag unquoted $@ / $* -- zsh expands those as arrays', () => {
    // Measured 3 iterations in BOTH shells, so flagging these would be a false positive.
    expect(findUnquotedForSplitHazards('for x in $@; do :; done')).toEqual([]);
    expect(findUnquotedForSplitHazards('for x in $*; do :; done')).toEqual([]);
  });

  it('does not flag a literal word list', () => {
    expect(
      findUnquotedForSplitHazards(
        'for f in append_progress set_needs_input append_learnings; do :; done',
      ),
    ).toEqual([]);
  });

  it('does not flag the `while read` replacement', () => {
    expect(
      findUnquotedForSplitHazards(
        `printf '%s\\n' "$IDS" | while IFS= read -r id; do :; done`,
      ),
    ).toEqual([]);
  });

  it('ignores a commented-out example so the doc can warn about the bug', () => {
    expect(findUnquotedForSplitHazards('# NOT this: for id in $IDS; do :; done')).toEqual(
      [],
    );
  });

  it('reports the line number so the offender is findable', () => {
    const hits = findUnquotedForSplitHazards('ok\nok\nfor id in $IDS; do :; done\n');
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
  });
});

describe('the poller is reaped, not just relaunched', () => {
  const md = readFileSync(GITHUB_PROJECT_MD, 'utf8');
  const POLLER = 'auto-ship-board-poll.sh';

  // A non-board wake can leave the previous watcher alive; a board-change
  // watcher exits by itself. Reap discipline still matters, but the old
  // raw process-match report did not establish independent launch roots.
  // TASK-456's executable verifier guard distinguishes roots from descendants.
  //
  // This is the mistakes.md TASK-298 lesson applied to itself: a doc code-block that is the
  // source of a runtime artifact is code, so the reap discipline gets a tracked test on
  // the DOC rather than a sentence nobody executes.

  it('the doc still ships the poller (the scan must not be vacuous)', () => {
    expect(
      md,
      `expected ${POLLER} to still be written by this doc. If the poller was renamed ` +
        'or moved, update this guard -- do not delete it.',
    ).toContain(POLLER);
  });

  it('tells the operator to pkill the predecessor before relaunching', () => {
    expect(
      md,
      'A previous watcher can still be alive on a non-board wake. Keep the ' +
        `\`pkill -f ${POLLER}\` instruction before relaunch so an extra root does ` +
        'not continue polling after the run ends.',
      // A literal pattern, not one built from POLLER: escaping a filename into a
      // regex by replacing only `.` is incomplete escaping (CodeQL
      // js/incomplete-sanitization, and it is right -- `-` and `$` would survive).
      // The name is a constant, so there is nothing to gain from constructing it.
    ).toMatch(/pkill\s+-f\s+auto-ship-board-poll\.sh/);
  });

  it('requires the reap at run end too, not only between passes', () => {
    // A watcher can remain alive when a run ends without a board-change wake.
    // Keep cleanup at normal and abnormal run ends.
    const pkillIndex = md.search(/pkill\s+-f\s+auto-ship-board-poll/);
    expect(pkillIndex, 'no pkill guidance found at all').toBeGreaterThan(-1);
    const section = md.slice(pkillIndex - 1200, pkillIndex + 1200);
    expect(
      section,
      'The reap must be documented for RUN END as well as between passes, ' +
        'because a final watcher can remain alive.',
    ).toMatch(/run end|ends|end of the run/i);
  });

  it('points at the executable parentage verifier', () => {
    expect(md).toContain('node scripts/auto-ship-poller-roots.mjs');
  });
});

// ---------------------------------------------------------------------------
// Guard: the merge gates must assert the ci.yml RUN EXISTS, not merely that the
// checks they can see are green.
//
// Why this exists (session 8, 2026-08-24). CI created NO ci.yml run at all for one
// branch at its original sha. The PR still reported SIX checks -- all CodeQL/Analyze
// -- every one of them genuinely SUCCESS. `gh pr checks` exits 0 on that. The
// statusCheckRollup is all-green on that. Both merge gates would have merged a head
// whose build and tests NEVER EXECUTED.
//
// The failure mode is NOT "zero checks", which is easy to spot and which `gh pr
// checks` already refuses. It is a PARTIAL check set: the security scanners ran, the
// build/test workflow did not, and nothing in the reported data distinguishes that
// from a healthy PR. A/B on that same branch, same workflow config: 6 checks and no
// `test` job before a rebase push, 11 including `test` after. ci.yml ran normally for
// sibling auto-ship branches the same day, so run creation is nondeterministic -- and
// a memory-only commit DID trigger one, which rules out "small diffs skip CI".
//
// So the only sound gate is an EXISTENCE check against the workflow, keyed to the
// exact head. This test does not (and cannot) reproduce GitHub's scheduling; it pins
// the documented remedy so it cannot quietly evaporate from the skills the way the
// TASK-315 fixes evaporated from the on-disk helpers.
//
// KNOW WHAT THESE TESTS ARE. They assert the rule's PRESENCE in prose, never its
// CORRECTNESS: nothing here executes the guard, so weakening `-ge 1` to `-ge 0`
// (which neuters it -- every count then passes) would leave them green. That limit is
// inherent to a doc-scan and is written down so nobody mistakes these for behavioural
// coverage of the shell. The shell itself was verified by hand under zsh -- the shell
// the Bash tool actually runs -- where an empty `runs` (gh errored), "0", a
// non-numeric value and a multiline value all HALT, while "1" and "3" proceed.
describe('merge gates assert the ci.yml run EXISTS for the head', () => {
  const GATE_DOCS = [
    join(SKILLS_DIR, 'auto-ship', 'SKILL.md'),
    join(SKILLS_DIR, 'yolo-ship', 'SKILL.md'),
  ];

  it('finds both gate docs to scan (the scan must not be vacuous)', () => {
    for (const p of GATE_DOCS) {
      expect(existsSync(p), `${p} is missing -- the scan below proves nothing`).toBe(
        true,
      );
    }
  });

  for (const p of GATE_DOCS) {
    const name = p.split('/').slice(-2).join('/');

    it(`${name} queries workflow runs for a specific commit`, () => {
      const md = readFileSync(p, 'utf8');
      // The load-bearing shape: ask the WORKFLOW whether it ran for THIS sha.
      // Reading `statusCheckRollup` / `gh pr checks` alone is what the trap defeats.
      // Order-independent, and accepts the short flags. The earlier version demanded
      // `--workflow ... ci.yml ... --commit` in that order on one line, which a
      // perfectly correct reword (short `-w`/`-c`, reordered flags) would have broken
      // -- a doc test that forbids valid rewrites is a maintenance tax.
      const line = md
        .split('\n')
        .find(
          (l) =>
            /gh run list/.test(l) &&
            /(--workflow|\s-w\s)/.test(l) &&
            /ci\.yml/.test(l) &&
            /(--commit|\s-c\s)/.test(l),
        );
      expect(
        line,
        'The gate must query workflow runs FOR A SPECIFIC COMMIT (e.g. `gh run list ' +
          '--workflow ci.yml --commit <sha>`). Reading check conclusions alone ' +
          'returns "green" on a head where ci.yml never ran.',
      ).toBeDefined();
    });

    it(`${name} treats an absent run as NOT green`, () => {
      const md = readFileSync(p, 'utf8');
      // Locate the query with the SAME order-independent matcher the presence test
      // uses. An order-dependent locator here would fail on a legitimate reword to
      // short/reordered flags while the presence test passed -- and it would say "no
      // per-commit ci.yml query found at all", which would be false and would send the
      // reader hunting for a missing rule that is actually present. Half-applying the
      // order-independence fix is its own defect class.
      const queryLine = md
        .split('\n')
        .find(
          (l) =>
            /gh run list/.test(l) &&
            /(--workflow|\s-w\s)/.test(l) &&
            /ci\.yml/.test(l) &&
            /(--commit|\s-c\s)/.test(l),
        );
      expect(
        queryLine,
        'no per-commit ci.yml query found (in any flag order or short form)',
      ).toBeDefined();
      const idx = md.indexOf(queryLine);
      const near = md.slice(idx, idx + 700);
      // Require a HALTING token, not merely a mention of the empty case. The earlier
      // version also accepted the words "no ci.yml run", which a WRONG fix would
      // contain -- e.g. "no ci.yml run just means CI is still starting, wait" matches
      // that phrasing while halting nothing. Only a comparison that rejects 0, or an
      // explicit abort, proves the empty result is actually acted on.
      expect(
        near,
        'Right after the run query, the doc must ACT on an empty result: a `-ge 1` ' +
          'test, an `exit 1`, or a HALT. Mentioning the empty case in prose is not ' +
          'acting on it -- a query nobody branches on is decoration.',
      ).toMatch(/-ge 1|exit 1|HALT/);
    });
  }

  // This test replaces a VACUOUS predecessor, and the story is worth keeping because
  // it is the exact defect this whole guard exists to prevent. The first version
  // matched /CodeQL/ against the two gate docs JOINED into one blob -- but
  // yolo-ship/SKILL.md already contained "CodeQL" at two unrelated lines BEFORE the
  // rule was added ("CodeRabbit + CodeQL + semgrep + gitleaks"). So it passed even
  // with the entire rationale deleted from both files: a check that cannot fail,
  // wearing the costume of a guard, shipped in the PR that added the vacuity rule.
  // Two things fixed it: match a phrase THIS rule introduced, and check EACH FILE
  // separately so one file's incidental text cannot satisfy the other's requirement.
  for (const p of GATE_DOCS) {
    const name = p.split('/').slice(-2).join('/');
    it(`${name} keeps WHY the check exists (a partial check set, not zero checks)`, () => {
      const md = readFileSync(p, 'utf8');
      expect(
        md,
        'Keep the reason next to the rule in THIS file: the failure mode is a ' +
          'PARTIAL check set (scanners ran, build/test did not), which is why ' +
          '`gh pr checks` exiting 0 proves nothing. Without the reason the check ' +
          'reads as paranoia and gets simplified away.',
      ).toMatch(/partial\s+check\s+set/i);
    });
  }
});
