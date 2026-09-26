// Guard: yolo-ship Phase 5's review-window blocks are RUNNABLE and refuse the states that
// let a reviewer's restore eat a builder's work (TASK-471).
//
// ---------------------------------------------------------------------------------
// WHY THIS EXISTS.
//
// `MEASURED-BY-PROBE` 2026-09-19 (TASK-426 / PR #625, reported first-hand by the builder):
// an ax-code-reviewer runs in the BUILDER's worktree, mutated a file to prove a test
// non-vacuous, and restored it with `git checkout -- <file>`. That is the recommended
// restore for an owner who committed first (TASK-468, yolo-ship Phase 4) and the
// destructive one for everybody else in the tree: it reverted six of the builder's
// UNCOMMITTED edits, and the builder then debugged the reviewer's mutant as its own code.
//
// Phase 4 already tells a subagent not to mutate a tree it does not own. That is the
// reviewer's half, and it is advice — the reviewer has `Bash`. This file pins the OWNER's
// half, which is checkable: open each review round committed-clean (so a restore has
// nothing uncommitted to eat) and close it by confirming HEAD did not move and nothing was
// left behind (so a leftover mutant is loud instead of debugged as your own code).
//
// Same shape as `mutation-restore-protocol.test.js` and
// `yolo-ship-review-range-origin-main.test.js`: the doc is the single implementation, and
// this guard EXTRACTS the marked blocks and RUNS them against throwaway repos. A prose scan
// would pass against a doc that says the right words and branches on nothing (TASK-392).
//
// WHAT THIS FILE DOES **NOT** VERIFY, stated rather than implied away:
//   - That a reviewer obeys its definition's guest rule. Nothing can, short of removing its
//     `Bash`; the prose checks at the bottom only pin that the rule is still written down.
//   - A mutant written AND correctly restored inside the window. The tree ends clean and
//     the close block says `ok` — pinned below as a deliberate `ok`, because a guard that
//     pretended to see it would be lying. The doc names it as a blind spot.
//   - Gitignored output (`dist/`), which `git status` never shows.
//   - The zsh half does not run on a machine without zsh; only bash is guaranteed.
// ---------------------------------------------------------------------------------

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const YOLO_SKILL = join(REPO_ROOT, '.claude', 'skills', 'yolo-ship', 'SKILL.md');
const REVIEWER = join(REPO_ROOT, '.claude', 'agents', 'ax-code-reviewer.md');
const TEMPLATES = join(REPO_ROOT, '.claude', 'skills', 'auto-ship', 'references', 'templates.md');

const yoloText = readFileSync(YOLO_SKILL, 'utf8');

function binExists(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const SHELLS = ['bash', ...(binExists('zsh') ? ['zsh'] : [])];

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

const OPEN_MARK = '# ax-review-window: open';
const CLOSE_MARK = '# ax-review-window: close';

/** The single block carrying `mark` — keyed on an inert marker, never on a command. */
function markedBlock(mark) {
  const hits = bashBlocks(yoloText).filter((b) => b.includes(mark));
  return hits.length === 1 ? hits[0] : undefined;
}

const OPEN = markedBlock(OPEN_MARK);
const CLOSE = markedBlock(CLOSE_MARK);

function runBlock(shell, block, mark, cwd, sha) {
  if (!block) {
    throw new Error(`no single \`\`\`bash block in ${YOLO_SKILL} carries "${mark}"`);
  }
  let script = block;
  if (sha !== undefined) {
    // The close block opens with the placeholder `SHA="<…>"`; substitute exactly that line.
    script = `SHA=${JSON.stringify(sha)}\n${block
      .split('\n')
      .filter((l) => !/^SHA=/.test(l))
      .join('\n')}`;
  }
  const p = spawnSync(shell, ['-c', script], { cwd, encoding: 'utf8' });
  return { status: p.status, out: `${p.stdout ?? ''}${p.stderr ?? ''}` };
}

const tmpDirs = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const TARGET = 'guard.js';
const V1 = 'export const answer = 42;\n';
const MUTANT = 'export const answer = 43;\n';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ax-review-window-'));
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

const head = (dir) => git(dir, 'rev-parse', 'HEAD').trim();

describe('review-window blocks are present exactly once', () => {
  it('finds the open and close blocks, and the close block has one SHA placeholder', () => {
    expect(OPEN, OPEN_MARK).toBeDefined();
    expect(CLOSE, CLOSE_MARK).toBeDefined();
    expect(CLOSE.split('\n').filter((l) => /^SHA=/.test(l))).toHaveLength(1);
  });

  it('sits in Phase 5, before the reviewer dispatch bullet it gates', () => {
    const phase5 = yoloText.indexOf('### Phase 5');
    const openAt = yoloText.indexOf(OPEN_MARK);
    const dispatchAt = yoloText.indexOf('- **REQUIRED:** Dispatch the **`ax-code-reviewer`**');
    expect(phase5).toBeGreaterThan(-1);
    expect(openAt).toBeGreaterThan(phase5);
    expect(dispatchAt).toBeGreaterThan(openAt);
  });
});

describe.each(SHELLS)('review window under %s', (shell) => {
  describe('open', () => {
    it('passes a committed-clean tree and prints the full HEAD sha', () => {
      const dir = makeRepo();
      const r = runBlock(shell, OPEN, OPEN_MARK, dir);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`review window open at: ${head(dir)}`);
    });

    // The TASK-426 shape: the builder dispatched with uncommitted edits in the tree.
    it('refuses a tree carrying an uncommitted edit — what the reviewer restore ate', () => {
      const dir = makeRepo();
      writeFileSync(join(dir, TARGET), 'export const answer = 42; // builder WIP\n');
      const r = runBlock(shell, OPEN, OPEN_MARK, dir);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(/REFUSE/);
      expect(r.out).toContain(TARGET);
      expect(r.out).not.toMatch(/review window open at/);
    });

    it('refuses a staged-but-uncommitted edit', () => {
      const dir = makeRepo();
      writeFileSync(join(dir, TARGET), 'export const answer = 44;\n');
      git(dir, 'add', TARGET);
      const r = runBlock(shell, OPEN, OPEN_MARK, dir);
      expect(r.status, r.out).toBe(1);
    });

    it('refuses an untracked file — `git clean` or an overwrite would take it too', () => {
      const dir = makeRepo();
      writeFileSync(join(dir, 'new-test.js'), '// not yet committed\n');
      const r = runBlock(shell, OPEN, OPEN_MARK, dir);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain('new-test.js');
    });
  });

  describe('close', () => {
    it('passes when HEAD is unchanged and the tree is clean', () => {
      const dir = makeRepo();
      const r = runBlock(shell, CLOSE, CLOSE_MARK, dir, head(dir));
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/^ok: review window closed clean/m);
    });

    it('refuses a leftover mutant in a tracked file', () => {
      const dir = makeRepo();
      const sha = head(dir);
      writeFileSync(join(dir, TARGET), MUTANT);
      const r = runBlock(shell, CLOSE, CLOSE_MARK, dir, sha);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(/dirty after the review/);
      expect(r.out).not.toMatch(/^ok:/m);
    });

    it('refuses a leftover untracked file', () => {
      const dir = makeRepo();
      const sha = head(dir);
      writeFileSync(join(dir, 'scratch-mutant.js'), MUTANT);
      const r = runBlock(shell, CLOSE, CLOSE_MARK, dir, sha);
      expect(r.status, r.out).toBe(1);
    });

    // A committed mutant leaves `git status` empty — the tree-clean check alone says ok.
    it('refuses a moved HEAD even though the tree is clean', () => {
      const dir = makeRepo();
      const sha = head(dir);
      writeFileSync(join(dir, TARGET), MUTANT);
      git(dir, 'commit', '-q', '-am', 'wip');
      expect(git(dir, 'status', '--porcelain').trim()).toBe('');
      const r = runBlock(shell, CLOSE, CLOSE_MARK, dir, sha);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(/HEAD moved/);
    });

    it.each([
      ['the unsubstituted placeholder', '<the sha the open block printed>'],
      ['an empty sha', ''],
      ['an abbreviated sha', 'SHORT'],
      ['an uppercase sha', 'UPPER'],
    ])('refuses %s', (_label, raw) => {
      const dir = makeRepo();
      let sha = raw;
      if (raw === 'SHORT') sha = head(dir).slice(0, 8);
      if (raw === 'UPPER') sha = head(dir).toUpperCase();
      const r = runBlock(shell, CLOSE, CLOSE_MARK, dir, sha);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(/REFUSE/);
    });

    // The named blind spot, pinned as an honest ok rather than an implied catch.
    it('says ok over a mutant that was written and correctly restored (documented blind spot)', () => {
      const dir = makeRepo();
      const sha = head(dir);
      writeFileSync(join(dir, TARGET), MUTANT);
      git(dir, 'checkout', '--', TARGET);
      const r = runBlock(shell, CLOSE, CLOSE_MARK, dir, sha);
      expect(r.status, r.out).toBe(0);
    });
  });
});

// Prose presence only — these cannot show anyone obeys the rule, just that it is still said.
describe('the rule reaches both roles', () => {
  it("the reviewer's definition carries the guest rule and the own-checkout route", () => {
    const t = readFileSync(REVIEWER, 'utf8');
    expect(t).toMatch(/## You are a guest in someone else's worktree/);
    expect(t).toMatch(/git worktree add --detach/);
    expect(t).toMatch(/git worktree remove --force/);
  });

  it('the code-lane dispatch brief points builders at the review window', () => {
    const t = readFileSync(TEMPLATES, 'utf8');
    expect(t).toMatch(/one reviewer\s*\n?>?\s*in flight at a time/);
    expect(t).toMatch(/\*The review window\*/);
  });

  it('yolo-ship no longer claims the reviewer "runs read-only" as a capability', () => {
    expect(yoloText).not.toMatch(/in its definition\) and runs read-only/);
  });
});
