// Guard: the auto-ship loop can SEE a card with no Status (TASK-477).
//
// A card with no `Status` is in no lane, and every query the orchestrator runs selects
// by lane -- the ready set (`status == "To Do"`), the poller (hashes the To Do lane),
// triage (To Do candidates) and the failure breakers. MEASURED 2026-09-19: TASK-476 sat
// laneless ~40 min after `scripts/board-task-id.sh claim` created it, because a
// notification landed between `claim` and its routing `board_batch`. It surfaced only
// because a lane tally printed a `1 null` row.
//
// The fix is `board_laneless`, a report-only sweep in the §2b board helper, run on each
// pass's snapshot (§3a). This file executes the helper as the orchestrator regenerates
// it -- extracted from the `cat > .claude/auto-ship-board.sh` block of
// github-project.md, under bash AND zsh (the Bash tool runs zsh) -- against a stubbed
// `gh`. No network, no board.
//
// The failure direction that matters is QUIET: a sweep that prints "none" over a
// truncated/empty/unreadable read reports exactly the cards it cannot see as absent.
// So every can't-sweep case below asserts rc 2 AND no `laneless: 0` line.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC_PATH = join(REPO_ROOT, '.claude/skills/auto-ship/references/github-project.md');
const SKILL_PATH = join(REPO_ROOT, '.claude/skills/auto-ship/SKILL.md');
const DOC = readFileSync(DOC_PATH, 'utf8');
const SKILL = readFileSync(SKILL_PATH, 'utf8');

function hasBin(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const SHELLS = ['bash', ...(hasBin('zsh') ? ['zsh'] : [])];

/** The body of the `cat > .claude/auto-ship-board.sh <<'SH'` heredoc, verbatim. */
function boardHelper() {
  const m = /cat > \.claude\/auto-ship-board\.sh <<'SH'\n([\s\S]*?)\nSH\n/.exec(DOC);
  if (!m) throw new Error('board helper cat block missing from github-project.md');
  return m[1];
}

/** The §3 runnable block: the pass's ONE board read. */
function readBlock() {
  const start = DOC.indexOf('\n## 3. ');
  const end = DOC.indexOf('\n### 3a. ', start + 1);
  if (start < 0 || end < 0) throw new Error('§3 read section missing');
  const m = /```bash\n([\s\S]*?)\n```/.exec(DOC.slice(start, end));
  if (!m) throw new Error('§3 has no bash block');
  return m[1];
}

/** The §4 claim-then-route snippet, from `if CLAIM=` to its closing `fi`. */
function claimBlock() {
  const m = /^(if CLAIM=\$\(scripts\/board-task-id\.sh claim[\s\S]*?\n)fi$/m.exec(DOC);
  if (!m) throw new Error('§4 claim-then-route block missing');
  return `${m[1]}fi`;
}

/** The §3a prose section (no runnable block of its own: the sweep lives in §3's). */
function sweepSection() {
  const start = DOC.indexOf('\n### 3a. ');
  const end = DOC.indexOf('\n## 4. ', start + 1);
  if (start < 0 || end < 0) throw new Error('§3a laneless sweep section missing');
  return DOC.slice(start, end);
}

/** Non-comment lines of a shell block. */
const code = (block) =>
  block
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const BOARD_LIMIT = Number(/^BOARD_LIMIT=(\d+)$/m.exec(boardHelper())?.[1]);

const TMP = mkdtempSync(join(tmpdir(), 'autoship-laneless-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const card = (id, title, status) => ({ id, title, ...(status === undefined ? {} : { status }) });
const board = (...items) => JSON.stringify({ items, totalCount: items.length });
const routed = [card('PVTI_a', '[TASK-1] one', 'Done'), card('PVTI_b', '[TASK-2] two', 'To Do')];
const LANELESS = card('PVTI_z', '[TASK-476] stranded'); // no `status` key, as `gh` emits it
const full = (n, extra = []) =>
  board(...Array.from({ length: n - extra.length }, (_, i) => card(`PVTI_${i}`, `[TASK-${i}] x`, 'Done')), ...extra);

/** Run `script` in a fresh repo-like dir with the regenerated helper and a stub `gh`. */
function run(shell, script, { snapshot, ghOut, graphqlRc = 0 } = {}) {
  const root = mkdtempSync(join(TMP, 'repo-'));
  mkdirSync(join(root, '.claude'));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, '.claude/auto-ship-board.sh'), boardHelper(), { mode: 0o755 });
  if (snapshot !== undefined) writeFileSync(join(root, 'snap.json'), snapshot);
  writeFileSync(join(root, 'gh.out'), ghOut ?? '');
  // `gh project item-list` serves the fixture and logs each call (so a test can count
  // board reads); `gh api graphql` (board_batch) exits graphqlRc; anything else is loud.
  writeFileSync(
    join(root, 'bin/gh'),
    `#!/bin/sh
if [ "$1 $2" = "project item-list" ]; then echo x >> "${join(root, 'gh.calls')}"; cat "${join(root, 'gh.out')}"; exit 0; fi
if [ "$1 $2" = "api graphql" ]; then [ ${graphqlRc} -eq 0 ] || echo "stub graphql error" >&2; exit ${graphqlRc}; fi
echo "unexpected gh $*" >&2; exit 64
`,
    { mode: 0o755 },
  );
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/board-task-id.sh'), '#!/bin/sh\necho "TASK-900 PVTI_new"\n', { mode: 0o755 });
  const r = spawnSync(shell, ['-c', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
  });
  let reads = 0;
  try {
    reads = readFileSync(join(root, 'gh.calls'), 'utf8').split('\n').filter(Boolean).length;
  } catch {
    reads = 0;
  }
  return { rc: r.status, out: r.stdout, err: r.stderr, reads };
}
const sweep = (shell, snapshot, arg = 'snap.json') =>
  run(shell, `. .claude/auto-ship-board.sh; board_laneless ${arg}`, { snapshot });

describe('board_laneless is in the regenerated helper', () => {
  it('the §2b cat block defines it, with the same BOARD_LIMIT board_snapshot uses', () => {
    expect(boardHelper()).toMatch(/^board_laneless\(\) \{$/m);
    expect(BOARD_LIMIT).toBeGreaterThan(0);
  });
});

describe.each(SHELLS)('board_laneless under %s', (shell) => {
  it('by construction: a laneless card fires, and routing it makes the sweep go quiet', () => {
    const red = sweep(shell, board(...routed, LANELESS));
    expect(red.rc).toBe(1);
    expect(red.out).toContain('LANELESS PVTI_z [TASK-476] stranded');
    expect(red.out).toMatch(/laneless: 1 of 3 items have NO Status/);
    expect(red.out).not.toContain('PVTI_a');

    const green = sweep(shell, board(...routed, { ...LANELESS, status: 'Backlog' }));
    expect(green.rc).toBe(0);
    // Quiet still names the count it read, so "clean" != "did not run".
    expect(green.out.trim()).toBe('laneless: 0 of 3 items');
  });

  it('an empty-string status and a null status are laneless too', () => {
    const r = sweep(shell, board(...routed, card('PVTI_e', '[TASK-9] empty', ''), card('PVTI_n', '[TASK-8] nul', null)));
    expect(r.rc).toBe(1);
    expect(r.out).toContain('LANELESS PVTI_e');
    expect(r.out).toContain('LANELESS PVTI_n');
    expect(r.out).toMatch(/laneless: 2 of 4 items/);
  });

  // Every one of these must be LOUD: rc 2, FATAL on stderr, and never the quiet line.
  const cantSweep = [
    ['a board AT BOARD_LIMIT (indistinguishable from truncated)', () => full(BOARD_LIMIT, [LANELESS])],
    ['a board OVER BOARD_LIMIT', () => full(BOARD_LIMIT + 5)],
    ['an empty board', () => board()],
    ['non-JSON', () => 'rate limit exceeded\n'],
    ['.items not an array', () => JSON.stringify({ items: { a: 1 } })],
  ];
  it.each(cantSweep)('fails closed on %s', (_label, make) => {
    const r = sweep(shell, make());
    expect(r.rc).toBe(2);
    expect(r.err).toMatch(/FATAL: board_laneless/);
    expect(r.out).toBe('');
  });

  it('fails closed on a missing file and on no argument (no silent default to a stale cache)', () => {
    for (const r of [sweep(shell, undefined), sweep(shell, undefined, '')]) {
      expect(r.rc).toBe(2);
      expect(r.err).toMatch(/FATAL: board_laneless/);
      expect(r.out).toBe('');
    }
  });

  const pass = () => `${readBlock()}\necho "RC=$LANELESS_RC"`;

  it('the §3 pass block report a laneless card end to end, on ONE board read', () => {
    const r = run(shell, pass(), { ghOut: board(...routed, LANELESS) });
    expect(r.out).toContain('LANELESS PVTI_z [TASK-476] stranded');
    expect(r.out).toContain('RC=1');
    // The sweep must reuse the pass's snapshot, not pay for a second ~102-pt read.
    expect(r.reads).toBe(1);
  });

  it('the laneless count is exact even when a title holds a newline', () => {
    const r = sweep(shell, board(...routed, card('PVTI_nl', '[TASK-7] two\nlines')));
    expect(r.rc).toBe(1);
    expect(r.out).toMatch(/laneless: 1 of 3 items/);
  });

  it('§4: a claim whose route FAILS announces the stranded card; a clean route stays silent', () => {
    const failed = run(shell, `. .claude/auto-ship-board.sh\n${claimBlock()}`, { graphqlRc: 1 });
    expect(failed.err).toContain('⚠ [TASK-900] PVTI_new was CREATED but NOT routed');
    const ok = run(shell, `. .claude/auto-ship-board.sh\n${claimBlock()}`, { graphqlRc: 0 });
    expect(ok.err).not.toContain('NOT routed');
    expect(ok.out).toContain('board_batch: 2 write(s) in 1 request');
  });

  it('the §3 pass block never reach a quiet verdict when the board read is truncated', () => {
    const r = run(shell, pass(), { ghOut: full(BOARD_LIMIT, [LANELESS]) });
    expect(r.out).not.toMatch(/laneless: 0/);
    expect(r.err).toMatch(/FATAL: board_snapshot hit --limit/);
    expect(r.err).toMatch(/laneless sweep NOT run/);
  });
});

describe('the sweep is wired into the loop, not just defined', () => {
  it('SKILL.md control loop runs it every pass and forbids auto-routing', () => {
    expect(SKILL).toMatch(/"Laneless sweep \(report no-Status cards; never auto-route\)"/);
    expect(SKILL).toMatch(/"Merged PRs\? serialized merge queue -> move cards" -> "Laneless sweep/);
    expect(SKILL).toMatch(/Run `board_laneless` on the pass's snapshot/);
  });

  it('§2c run-start completeness check requires board_laneless in the on-disk helper', () => {
    expect(DOC).toMatch(/for f in board_snapshot board_laneless board_batch; do/);
  });

  it('the sweep runs in the SAME block as the one read ($SNAP does not survive a Bash call)', () => {
    const read = code(readBlock());
    expect(read.match(/board_snapshot/g)).toHaveLength(1);
    expect(read).not.toMatch(/item-list/);
    expect(read).toMatch(/board_laneless "\$SNAP"/);
    // A separate §3a block would run in its own call with $SNAP empty -- FATAL every pass.
    expect(sweepSection()).not.toMatch(/```bash/);
  });
});
