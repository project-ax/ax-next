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
//      actually saw. (The helper has a second best-effort exit,
//      `skip (not a draft-issue card)`, reachable from the same bad id depending on
//      whether GitHub answers with a GraphQL error or a null node; which one fires is
//      NOT pinned, and it does not matter -- both look transient.) An orchestrator
//      correctly reads either as "rate-limit blip, best-effort, ignore" rather than
//      "your loop is broken". Observed live 2026-08-23/24: 3
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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

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

function shellExists(shell) {
  try {
    execFileSync('sh', ['-c', `command -v ${shell}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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
        '`learnings: skip (read)` -- indistinguishable from a rate-limit blip. ' +
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

  const helperPath = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'autoship-parity-'));
    const f = join(dir, 'board.sh');
    writeFileSync(f, blocks.join('\n') + '\n');
    return f;
  })();

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
