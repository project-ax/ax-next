// Guard: the mutation-restore protocol in `yolo-ship` Phase 4 is RUNNABLE and correct,
// and the code-lane dispatch prompt carries it.
//
// ---------------------------------------------------------------------------------
// WHY THIS EXISTS (TASK-468).
//
// Mutation testing is now standard practice on this board — nearly every card dispatched
// asks the builder to "revert the fix, watch it go red, restore". Writing the mutant is
// safe. **Putting the file back is where the damage has happened**, four measured times on
// 2026-09-18/19, across three different restore mechanisms, each reported first-hand by
// the agent it happened to:
//
//   1. A builder restored a mutated file FROM A FILE COPY and silently reverted a fix
//      another agent had COMMITTED to the same worktree in between (TASK-406). Caught only
//      because a checksum moved underneath it; the clobber never reached a commit.
//   2. A REVIEWER SUBAGENT SHARES THE BUILDER'S WORKTREE, and its `git checkout -- <file>`
//      silently reverted SIX of the builder's uncommitted edits. The builder then debugged
//      the reviewer's mutant as its own code. (TASK-471 owns the reviewer-side dispatch
//      protocol; this guard owns the per-role rule underneath it.)
//   3. Two builders, independently, lost work to `git checkout -- <path>` because it
//      reverts the WHOLE FILE, not just the mutation — one a 25-line comment, one its
//      entire uncommitted fix.
//   4. One reviewer, handed the hazard in its brief, restored from its own copy and kept
//      `git status --porcelain` clean before, between and after every mutation.
//
// (1)-(3) are why the remedy prescribed after (1) — "use `git checkout --`" — is only half
// an answer: it is the RECOMMENDED restore for the agent that owns the worktree and
// committed first, and the DESTRUCTIVE one for anyone else sharing the tree. The rule that
// reconciles them is the precondition, not the command:
//
//     `git checkout -- <path>` restores exactly what you mutated and nothing else IF AND
//     ONLY IF that path was committed-clean before you mutated it.
//
// "Commit before you mutate" is how the OWNER satisfies that precondition, and from the
// owner's chair it covers all four incidents. It is the wrong instruction for a subagent in
// a tree it does not own, which may neither commit someone else's work-in-progress nor
// restore over it. Hence two roles, one precondition. (4) shows the behaviour is achievable
// — but it only happened because a human typed it into that brief by hand, which is the
// defect this card fixes: `MEASURED-BY-PROBE` 2026-09-19, the dispatch template contained
// no `git checkout --` text at all, so the rule was reaching builders only as an
// orchestrator habit.
//
// ---------------------------------------------------------------------------------
// WHY THIS GUARD EXECUTES THE BLOCKS RATHER THAN GREPPING THE PROSE.
//
// TASK-392's lesson: a text scan for the right words passes against a doc that says them
// and branches on nothing. It is especially hollow here, because the doc's prose QUOTES
// both dangerous commands on purpose — file copies and bare `git checkout --` — in order
// to explain them. "Mentions `git checkout --`" is satisfied by the broken text.
//
// So the fix is not prose. Phase 4 carries two fenced, runnable blocks, marked
// `# ax-mutation-restore: precondition` and `# ax-mutation-restore: restore`. The tests
// below EXTRACT those blocks and RUN them, under bash AND zsh, against throwaway git
// repositories built to each of the four shapes above. The doc is the single
// implementation; there is no second copy in a script for it to drift from. Modelled on
// `yolo-ship-review-range-origin-main.test.js`, which pins Phase 5's block the same way.
//
// WHAT THIS FILE DOES **NOT** VERIFY, stated rather than implied away:
//
//   - It cannot make a restore protocol safe against a SECOND WRITER touching the path
//     during the mutation window. Nothing can; the fix for that is one writer per window,
//     which is TASK-471's scope. What `scenario 4` below does pin is the part that IS in
//     this card's control: the restore target is HEAD, so a commit that lands during the
//     window survives — and the same fixture run through a file copy loses it.
//   - The templates.md assertions at the bottom are TEXT checks, deliberately weaker than
//     the executable core, and labelled as such. There is no second runnable copy of the
//     block in the dispatch prompt to execute; what the prompt must carry is the pointer
//     and the per-role rule, and text is the only surface that has ever carried those.
//
// MUTANTS RUN, NOT REASONED ABOUT (2026-09-19; each applied to the COMMITTED text and
// restored with `git checkout --` afterwards, per the rule this file is about). Counts are
// recorded in the PR body rather than duplicated here, but the shapes are:
//
//   M1. RESTORED VERBATIM — `git show origin/main:.claude/skills/yolo-ship/SKILL.md >` the
//       file, i.e. the pre-fix text, which carries NEITHER marked block. The extractor
//       finds 0 of each, `runBlock` throws by design naming the reason, and every
//       behavioural case plus the structure checks red out. This is the mutant the card
//       asks for: the guard fails against the skill text as it stands on `main`.
//   M2. CONSTRUCTED, one token: drop the `exit 1` from the precondition block's dirty
//       branch. The plausible regression — someone "softens" a refusal into a warning, and
//       every subagent in someone else's tree proceeds to mutate a dirty file.
//   M3. CONSTRUCTED: replace the restore block's `git checkout -- "$F"` with a file copy.
//       Incident (1) re-introduced, and the one shape the prose alone cannot exclude.
//   M4. CONSTRUCTED: delete the restore block's post-restore `git status --porcelain`
//       check. Without it a restore that silently did nothing reports success.
//   M5. CONSTRUCTED: delete the dispatch-prompt bullet — the templates.md text checks red,
//       and only those, which is the honest scope of a text check.
//   M6. CONSTRUCTED: pipe a git invocation inside a block. A pipe launders git's exit
//       status, so a FAILED status call reads as "clean" — the fail-OPEN direction, and
//       the shape no behavioural test here can see.
//
// Lives in scripts/__tests__/, which `pnpm test:scripts` runs unconditionally — no network,
// no Docker, no build. Every git repository it touches is created under a temp dir and
// removed afterwards; it never runs git against this repository.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const YOLO_SKILL = join(REPO_ROOT, '.claude', 'skills', 'yolo-ship', 'SKILL.md');
const TEMPLATES = join(
  REPO_ROOT,
  '.claude',
  'skills',
  'auto-ship',
  'references',
  'templates.md',
);

const yoloText = readFileSync(YOLO_SKILL, 'utf8');
const templatesText = readFileSync(TEMPLATES, 'utf8');

function binExists(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_ZSH = binExists('zsh');
const SHELLS = ['bash', ...(HAS_ZSH ? ['zsh'] : [])];

// ---------------------------------------------------------------------------------
// Extracting the runnable shell out of the doc.
// ---------------------------------------------------------------------------------

/**
 * Every fenced ```bash block in `md`, dedented by the fence's own indent.
 *
 * Same rule, and the same duplication-rather-than-sharing decision, as the sibling guards
 * that pin other runnable blocks: a block nested in a bullet carries leading spaces, and
 * dedenting by the fence's own indent handles nested and top-level blocks with one rule.
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
 * A block's lines with whole-line comments dropped and `\`-continuations joined.
 *
 * **In that order.** TASK-454 measured the opposite ordering as fail-OPEN in two sibling
 * guards: joining continuations first lets a comment line ending in a backslash absorb the
 * code line below it, the joined result starts with `#`, and the real command DISAPPEARS
 * from the scan — while both bash and zsh happily RUN it, because a `#` comment does not
 * continue across a backslash. Filtering first cannot lose code that way.
 *
 * Pinned by `logicalLines keeps a command a comment tried to swallow` below.
 */
function logicalLines(block) {
  return block
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

const PRECONDITION_MARK = '# ax-mutation-restore: precondition';
const RESTORE_MARK = '# ax-mutation-restore: restore';

/**
 * The single ```bash block carrying `mark`, or `undefined` if it is missing or duplicated.
 *
 * Keyed on an explicit marker comment rather than on any command inside the block. That is
 * deliberate: a sibling guard measured a mutant whose red count was wrong because its
 * extractor was keyed on a command the mutant had edited, so the extractor and the thing
 * under test moved together. A marker is inert — no mutant of the protocol itself touches
 * it — and a mutant that DELETES the block makes this return `undefined`, which `runBlock`
 * turns into a loud failure rather than a skipped test.
 */
function markedBlock(mark) {
  const hits = bashBlocks(yoloText).filter((b) => b.includes(mark));
  return hits.length === 1 ? hits[0] : undefined;
}

const PRECONDITION = markedBlock(PRECONDITION_MARK);
const RESTORE = markedBlock(RESTORE_MARK);

/**
 * Run one extracted block in `cwd` with `F` bound to `file`.
 *
 * The doc's precondition block opens with a placeholder `F="<the file you are about to
 * mutate>"`; that one assignment is the only thing substituted, and the substitution is
 * mechanical (drop every line starting `F=`, prepend the real binding). The structure check
 * below pins that there is exactly one such line, so the substitution cannot silently start
 * meaning something else.
 */
function runBlock(shell, block, { cwd, file, mark }) {
  if (!block) {
    throw new Error(
      `no single \`\`\`bash block in ${YOLO_SKILL} carries "${mark}" — the protocol ` +
        `block is missing, duplicated, or its marker was edited`,
    );
  }
  const body = block
    .split('\n')
    .filter((l) => !/^F=/.test(l))
    .join('\n');
  const script = `F=${JSON.stringify(file)}\n${body}\n`;
  const p = spawnSync(shell, ['-c', script], { cwd, encoding: 'utf8' });
  return { status: p.status, out: `${p.stdout ?? ''}${p.stderr ?? ''}` };
}

// ---------------------------------------------------------------------------------
// Throwaway git repositories.
// ---------------------------------------------------------------------------------

const tmpDirs = [];

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const TARGET = 'guard.js';
const V1 = ['// baseline', 'export const answer = 42;', ''].join('\n');
/** What a concurrent agent commits to the same file mid-window (incident 1). */
const V2 = [
  '// baseline',
  '// SIBLING-FIX: a fix another agent committed',
  'export const answer = 42;',
  '',
].join('\n');
const MUTANT = ['// baseline', 'export const answer = 43;', ''].join('\n');

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ax-mutation-restore-'));
  tmpDirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'guard@example.invalid');
  git(dir, 'config', 'user.name', 'Guard Fixture');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, TARGET), V1);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'baseline');
  return dir;
}

/** A throwaway directory that is NOT a git repository — where a builder's copy would live. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ax-mutation-restore-scratch-'));
  tmpDirs.push(dir);
  return dir;
}

function read(dir, file = TARGET) {
  return readFileSync(join(dir, file), 'utf8');
}

function porcelain(dir) {
  return git(dir, 'status', '--porcelain').trim();
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------
// Behaviour.
// ---------------------------------------------------------------------------------

describe.each(SHELLS)('mutation-restore protocol under %s', (shell) => {
  it('precondition passes on a committed-clean path', () => {
    const dir = makeRepo();

    const r = runBlock(shell, PRECONDITION, {
      cwd: dir,
      file: TARGET,
      mark: PRECONDITION_MARK,
    });

    expect(r.out).toMatch(/committed-clean/);
    expect(r.status).toBe(0);
  });

  it('precondition refuses a path carrying uncommitted work, and names BOTH roles', () => {
    // Incident (3) from the owner's chair and incident (2) from the reviewer's: a file that
    // already carries work nobody has committed. Every restore from here is lossy.
    const dir = makeRepo();
    const dirty = `${V1}// a 25-line comment someone is still writing\n`;
    writeFileSync(join(dir, TARGET), dirty);

    const r = runBlock(shell, PRECONDITION, {
      cwd: dir,
      file: TARGET,
      mark: PRECONDITION_MARK,
    });

    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/REFUSE/);
    // Both roles named, and told DIFFERENT things — "commit first" is the fix for one and
    // forbidden for the other, so a refusal that addresses only the owner ships half the bug.
    expect(r.out).toMatch(/owner of this worktree: commit/i);
    expect(r.out).toMatch(/subagent in someone else's worktree: do NOT commit/i);
    // Fail-CLOSED: the block changed nothing on its way out.
    expect(read(dir)).toBe(dirty);
  });

  it('restore puts back exactly the mutation and leaves the path clean', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, TARGET), MUTANT);

    const r = runBlock(shell, RESTORE, { cwd: dir, file: TARGET, mark: RESTORE_MARK });

    expect(r.status).toBe(0);
    expect(read(dir)).toBe(V1);
    expect(porcelain(dir)).toBe('');
  });

  it('restore keeps a commit that landed during the window — a file copy reverts it', () => {
    // Incident (1), reproduced: the agent takes a copy, mutates, and while its suite runs a
    // sibling in the same worktree commits a fix to the same file.
    const dir = makeRepo();
    // The copy lives OUTSIDE the repo, where a builder's scratchpad copy would.
    writeFileSync(join(scratch(), 'backup.copy'), read(dir));
    writeFileSync(join(dir, TARGET), MUTANT);
    writeFileSync(join(dir, TARGET), V2);
    git(dir, 'add', TARGET);
    git(dir, 'commit', '-q', '-m', 'sibling fix');

    const r = runBlock(shell, RESTORE, { cwd: dir, file: TARGET, mark: RESTORE_MARK });

    expect(r.status).toBe(0);
    expect(read(dir)).toContain('SIBLING-FIX');
    expect(porcelain(dir)).toBe('');

    // CONTROL, so the assertion above is not vacuous: the same fixture restored the way
    // incident (1) restored it loses the sibling's committed fix, silently, exit status 0.
    const control = makeRepo();
    const controlCopy = join(scratch(), 'backup.copy');
    writeFileSync(controlCopy, read(control));
    writeFileSync(join(control, TARGET), V2);
    git(control, 'add', TARGET);
    git(control, 'commit', '-q', '-m', 'sibling fix');
    const cp = spawnSync(shell, ['-c', `cp "${controlCopy}" "${TARGET}"`], {
      cwd: control,
      encoding: 'utf8',
    });
    expect(cp.status).toBe(0);
    expect(read(control)).not.toContain('SIBLING-FIX');
  });

  it('restore refuses when it cannot actually put the path back', () => {
    // A path git does not track: `git checkout --` cannot restore it, and without the
    // post-restore check the block would report success over an untouched mutant.
    const dir = makeRepo();
    writeFileSync(join(dir, 'scratch-guard.js'), MUTANT);

    const r = runBlock(shell, RESTORE, {
      cwd: dir,
      file: 'scratch-guard.js',
      mark: RESTORE_MARK,
    });

    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/still dirty after restore/);
  });
});

// ---------------------------------------------------------------------------------
// Structure of the blocks themselves.
// ---------------------------------------------------------------------------------

describe('the blocks in yolo-ship Phase 4', () => {
  it('are each present exactly once, and carry their marker', () => {
    expect(bashBlocks(yoloText).filter((b) => b.includes(PRECONDITION_MARK))).toHaveLength(1);
    expect(bashBlocks(yoloText).filter((b) => b.includes(RESTORE_MARK))).toHaveLength(1);
  });

  it('bind the target exactly once, in the precondition block', () => {
    expect(PRECONDITION.split('\n').filter((l) => /^F=/.test(l))).toHaveLength(1);
    expect(RESTORE.split('\n').filter((l) => /^F=/.test(l))).toHaveLength(0);
    // The restore block must USE that binding rather than re-derive a path of its own.
    expect(RESTORE).toContain('"$F"');
  });

  it('restore with git, never with a file copy', () => {
    expect(logicalLines(RESTORE).some((l) => /^git checkout -- "\$F"$/.test(l))).toBe(true);
    for (const l of [...logicalLines(PRECONDITION), ...logicalLines(RESTORE)]) {
      expect(l).not.toMatch(/(^|[;&|(]\s*)(cp|rsync|install|mv)\s/);
    }
  });

  it('pipe no git invocation', () => {
    // A pipe launders git's exit status, so a FAILED status call reads as "clean" — the
    // fail-OPEN direction. Every git line is scanned, not just the first: a check that
    // inspects one occurrence is a check on that occurrence, not on the property.
    for (const l of [...logicalLines(PRECONDITION), ...logicalLines(RESTORE)]) {
      if (!/\bgit\b/.test(l)) continue;
      expect(l).not.toMatch(/\|/);
    }
  });

  it('gate on git status --porcelain and exit non-zero on both refusals', () => {
    for (const block of [PRECONDITION, RESTORE]) {
      const lines = logicalLines(block);
      expect(lines.some((l) => l.includes('git status --porcelain'))).toBe(true);
      expect(lines.some((l) => /^exit 1$/.test(l))).toBe(true);
    }
  });

  it('logicalLines keeps a command a comment tried to swallow', () => {
    // The TASK-454 fail-open, pinned one layer down: join-then-filter returns NEITHER line
    // here, so the piped git below would be invisible to every structural check above,
    // while both shells happily run it.
    const swallow = ['# a note \\', 'N=$(git status --porcelain | cat)'].join('\n');
    expect(logicalLines(swallow)).toEqual(['N=$(git status --porcelain | cat)']);
  });
});

// ---------------------------------------------------------------------------------
// The dispatch prompt. TEXT checks, weaker than everything above, and labelled so.
// ---------------------------------------------------------------------------------

/** The body of a `## ` section, up to the next `## ` heading or EOF. */
function sectionBody(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `## ${heading}`);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** The blockquote inside a section, `> ` stripped — the literal text a builder receives. */
function blockquote(body) {
  return body
    .split('\n')
    .filter((l) => l === '>' || l.startsWith('> '))
    .map((l) => l.slice(2))
    .join('\n');
}

/** Top-level `- ` bullets, each carrying its own indented continuation lines. */
function bullets(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (/^- /.test(line)) out.push(line);
    else if (out.length && /^\s+\S/.test(line)) out[out.length - 1] += `\n${line}`;
  }
  return out;
}

describe('the code-lane dispatch prompt (text check — weaker on purpose)', () => {
  // Weaker because there is nothing runnable here to execute: what the prompt must carry is
  // a pointer and the per-role rule, and prose is the only surface that has ever carried
  // those. It is pinned anyway because the rule reached builders for two days ONLY as an
  // orchestrator habit — a habit lives in whoever is driving and disappears the first time
  // a dispatch is generated by someone who does not remember it.
  const section = sectionBody(templatesText, 'Code-lane dispatch prompt');
  const promptBullets = bullets(blockquote(section)).filter((b) => /mutation testing/i.test(b));

  it('carries a mutation-restore bullet inside the builder-facing blockquote', () => {
    expect(promptBullets).toHaveLength(1);
  });

  it('names the commit-first rule, the someone-else case and the file-copy hazard in ONE bullet', () => {
    const [b] = promptBullets;
    expect(b).toBeDefined();
    // All three in the SAME bullet: split across unrelated bullets they read as three
    // separate suggestions rather than one rule with two roles.
    expect(b).toMatch(/commit before you mutate/i);
    expect(b).toMatch(/git checkout -- /);
    expect(b).toMatch(/someone\s+ELSE'S worktree/i);
    expect(b).toMatch(/never from a file\s+copy/i);
    // The pointer to the runnable blocks, which are the part that is actually enforced.
    expect(b).toMatch(/yolo-ship Phase 4/);
  });

  it('keeps the rule in the prompt, not in the orchestrator-facing prose above it', () => {
    // The habit-vs-fix distinction as an assertion: guidance addressed to the orchestrator
    // ("remember to tell builders…") reproduces the exact defect this card fixes.
    const prose = section
      .split('\n')
      .filter((l) => !(l === '>' || l.startsWith('> ')))
      .join('\n');
    expect(prose).not.toMatch(/ax-mutation-restore|mutation testing/i);
  });
});
