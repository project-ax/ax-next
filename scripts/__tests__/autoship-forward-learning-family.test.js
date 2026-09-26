// Guard: auto-ship's forward-learning query reaches a merged card's whole FAMILY, not
// just the cards that happen to carry the same `epic:` marker (TASK-481).
//
// Why this exists. Forward learning used to select still-queued To Do cards with
//
//   jq --arg e "epic: $EPIC" '... select(.status=="To Do") | select(body | contains($e))'
//
// and nothing else. Measured on the live board 2026-09-20: 20 of 36 To Do cards had no
// `epic:` line at all, so they received nothing, ever. Worse, the miss was
// anti-correlated with need: TASK-431 (`parent: TASK-424`, no epic) was the inverse card
// of TASK-436, merged an hour earlier, whose builder had written a learning addressed to
// TASK-431 BY NAME. None of it reached the card; the orchestrator noticed only because
// it grepped the dispatched body and hand-pasted four cards' lessons into the prompt.
//
// The fix is a query, so this test RUNS the query: it extracts the `ax-forward-learning:
// family` block from references/github-project.md -- the text the orchestrator actually
// executes at every merge -- and runs it, under bash and zsh, against fixture boards built
// to each family edge and to each over-broadcast case. A prose scan would pass against a
// broken query (the TASK-392 vacuity mistake); this cannot.
//
// Lives in scripts/__tests__/, which CI's `pnpm test:scripts` runs unconditionally.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUTO_SHIP = join(REPO_ROOT, '.claude', 'skills', 'auto-ship');
const GITHUB_PROJECT_MD = join(AUTO_SHIP, 'references', 'github-project.md');
const SKILL_MD = join(AUTO_SHIP, 'SKILL.md');
const MARKER = '# ax-forward-learning: family';

function commandExists(cmd) {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The fenced bash block whose first line is the family marker. Exactly one. */
function familyBlock() {
  const md = readFileSync(GITHUB_PROJECT_MD, 'utf8');
  const blocks = [...md.matchAll(/```bash\n([\s\S]*?)\n```/g)]
    .map((m) => m[1])
    .filter((b) => b.startsWith(MARKER));
  return blocks;
}

const SHELLS = ['bash', ...(commandExists('zsh') ? ['zsh'] : [])];
const canRun = commandExists('jq');

/**
 * Run the extracted block with the given bindings and return the emitted ids (sorted)
 * plus stderr. Everything goes through env, never string interpolation into the script,
 * so a body containing quotes cannot change what the block means.
 */
function runFamily(shell, { items, taskId, learnings = '' }) {
  const script = `${familyBlock()[0]}\nprintf '%s\\n' "$IDS"`;
  const r = spawnSync(shell, ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ITEMS: typeof items === 'string' ? items : JSON.stringify({ items }),
      TASK_ID: taskId,
      LEARNINGS: learnings,
    },
  });
  if (r.status !== 0) {
    throw new Error(`family block exited ${r.status} under ${shell}: ${r.stderr}`);
  }
  const ids = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
  return { ids, err: r.stderr };
}

const card = (id, task, status, body) => ({
  id,
  title: `[${task}] ${id.toLowerCase()}`,
  status,
  content: { body },
});

// The TASK-431 incident, reconstructed. X = TASK-436, merged (still In Review in the
// snapshot the merge step reads), `parent: TASK-424`, NO epic.
const MERGED = card('PVTI_X', 'TASK-436', 'In Review', 'parent: TASK-424 (#630)\n\nthe clamp work');
const BOARD = [
  MERGED,
  // --- family: each should receive X's learnings ---
  card('PVTI_SIBLING', 'TASK-431', 'To Do', 'parent: TASK-424\n\nthe inverse card'),
  card('PVTI_CHILD_PLAIN', 'TASK-600', 'To Do', 'parent: TASK-436 (#640)\n\nfollow-up'),
  card('PVTI_CHILD_BOLD', 'TASK-601', 'To Do', '**parent:** TASK-436 (walk) · **signature:** `x`'),
  card('PVTI_CHILD_FOLLOWUP', 'TASK-602', 'To Do', 'Follow-up from TASK-436 (PR #640), reviewer Minor #1.'),
  card('PVTI_PARENT', 'TASK-424', 'To Do', 'the parent, waiting on its fix'),
  card('PVTI_NAMED', 'TASK-610', 'To Do', 'no markers at all'),
  // --- not family: each must receive NOTHING ---
  card('PVTI_UNRELATED', 'TASK-620', 'To Do', 'touches Thread.tsx, like TASK-436 did'),
  card('PVTI_MIDLINE', 'TASK-621', 'To Do', 'this is not parent: TASK-436\nuses the parent-useLayoutEffect recorder from TASK-436'),
  card('PVTI_PREFIX', 'TASK-622', 'To Do', 'parent: TASK-4360'),
  card('PVTI_INPROG_CHILD', 'TASK-623', 'In Progress', 'parent: TASK-436'),
  card('PVTI_DONE_SIBLING', 'TASK-624', 'Done', 'parent: TASK-424'),
  card('PVTI_BACKLOG_CHILD', 'TASK-625', 'Backlog', 'parent: TASK-436'),
  card('PVTI_EPIC_OTHER', 'TASK-626', 'To Do', 'epic: dem-first-memory\n\nspec'),
];
const LEARNINGS =
  'TASK-610 (the inverse card) stays separate; WorkspaceAttachmentChip deliberately refuses title=\n' +
  'TASK-6200, sub-TASK-620 and XTASK-620 are other ids (bounded match)';

const FAMILY = [
  'PVTI_CHILD_BOLD',
  'PVTI_CHILD_FOLLOWUP',
  'PVTI_CHILD_PLAIN',
  'PVTI_NAMED',
  'PVTI_PARENT',
  'PVTI_SIBLING',
];

describe('forward-learning family query (TASK-481)', () => {
  it('github-project.md ships exactly one `ax-forward-learning: family` block', () => {
    expect(
      familyBlock().length,
      'zero means this guard has gone vacuous (the block was renamed or removed); two ' +
        'means the orchestrator has a choice of queries and the test only runs one.',
    ).toBe(1);
  });

  it('has jq available (else the behavioural proof below was SKIPPED)', () => {
    expect(canRun).toBe(true);
  });

  for (const shell of SHELLS) {
    describe(shell, () => {
      it.skipIf(!canRun)(
        'a no-epic queued card in the merged card\'s family receives the learnings',
        () => {
          // THE BUG. Against the old `contains("epic: $EPIC")` query with X having no
          // epic, not one of these ids was emitted.
          const { ids } = runFamily(shell, {
            items: BOARD,
            taskId: 'TASK-436',
            learnings: LEARNINGS,
          });
          expect(ids).toEqual(FAMILY);
        },
      );

      it.skipIf(!canRun)('an unrelated queued card does NOT receive them (over-broadcast guard)', () => {
        const { ids } = runFamily(shell, {
          items: BOARD,
          taskId: 'TASK-436',
          learnings: LEARNINGS,
        });
        for (const not of [
          'PVTI_UNRELATED',
          'PVTI_MIDLINE',
          'PVTI_PREFIX',
          'PVTI_EPIC_OTHER',
          'PVTI_X',
        ]) {
          expect(ids, `${not} is not in TASK-436's family`).not.toContain(not);
        }
      });

      it.skipIf(!canRun)('one-writer rule: only To Do cards qualify, never In Progress', () => {
        const { ids } = runFamily(shell, { items: BOARD, taskId: 'TASK-436', learnings: LEARNINGS });
        expect(ids).not.toContain('PVTI_INPROG_CHILD');
        expect(ids).not.toContain('PVTI_DONE_SIBLING');
        expect(ids).not.toContain('PVTI_BACKLOG_CHILD');
      });

      it.skipIf(!canRun)('the epic edge still works, is exact, and `epic: none` matches nothing', () => {
        const items = [
          card('PVTI_M', 'TASK-700', 'In Review', 'epic: workspace-as-sole-interface\ndesign: d.md'),
          card('PVTI_SAME', 'TASK-701', 'To Do', 'epic: workspace-as-sole-interface\ndesign: d.md'),
          card('PVTI_LONGER', 'TASK-702', 'To Do', 'epic: workspace-as-sole-interface-v2'),
          card('PVTI_NONE', 'TASK-703', 'To Do', 'epic: none'),
        ];
        expect(runFamily(shell, { items, taskId: 'TASK-700' }).ids).toEqual(['PVTI_SAME']);

        const none = [
          card('PVTI_M', 'TASK-710', 'In Review', 'epic: none'),
          card('PVTI_NONE', 'TASK-711', 'To Do', 'epic: none'),
        ];
        expect(runFamily(shell, { items: none, taskId: 'TASK-710' }).ids).toEqual([]);
      });

      it.skipIf(!canRun)('a card matching several edges is emitted once', () => {
        const items = [
          card('PVTI_M', 'TASK-800', 'In Review', 'epic: e1\nparent: TASK-799'),
          card('PVTI_ALL', 'TASK-801', 'To Do', 'epic: e1\nparent: TASK-799\nparent: TASK-800'),
        ];
        expect(
          runFamily(shell, { items, taskId: 'TASK-800', learnings: 'see TASK-801' }).ids,
        ).toEqual(['PVTI_ALL']);
      });

      it.skipIf(!canRun)('a merged card missing from $ITEMS warns, and child + named edges still apply', () => {
        const items = BOARD.filter((c) => c.id !== 'PVTI_X');
        const { ids, err } = runFamily(shell, { items, taskId: 'TASK-436', learnings: LEARNINGS });
        expect(err).toMatch(/TASK-436\] is not in \$ITEMS/);
        expect(ids).toEqual([
          'PVTI_CHILD_BOLD',
          'PVTI_CHILD_FOLLOWUP',
          'PVTI_CHILD_PLAIN',
          'PVTI_NAMED',
        ]);
      });

      it.skipIf(!canRun)('an empty $TASK_ID refuses loudly instead of adopting an untitled card as X', () => {
        const items = [
          { id: 'PVTI_UNTITLED', title: '', status: 'In Review', content: { body: 'parent: TASK-1' } },
          card('PVTI_SIB', 'TASK-2', 'To Do', 'parent: TASK-1'),
        ];
        const { ids, err } = runFamily(shell, { items, taskId: '' });
        expect(ids).toEqual([]);
        expect(err).toMatch(/FATAL/);
      });

      it.skipIf(!canRun)('unparseable $ITEMS is FATAL, not a quiet empty family', () => {
        const { ids, err } = runFamily(shell, { items: '{not json', taskId: 'TASK-436' });
        expect(ids).toEqual([]);
        expect(err).toMatch(/FATAL/);
      });
    });
  }
});

describe('forward-learning prose and code agree (TASK-481)', () => {
  // The card's acceptance: SKILL.md's Forward learning section is the prose, §4's block
  // is the code the orchestrator runs, and "the two must not disagree". The old prose
  // said "every still-queued To Do card sharing X's `epic:<slug>`" -- a rule the new
  // query deliberately widens -- so pin that it is gone and that the section points at
  // the block rather than restating it.
  const skill = readFileSync(SKILL_MD, 'utf8');
  const section = skill.slice(
    skill.indexOf('## Forward learning'),
    skill.indexOf('\n## ', skill.indexOf('## Forward learning') + 1),
  );

  it('SKILL.md Forward learning names the family edges and cites the block', () => {
    expect(section.length).toBeGreaterThan(100);
    expect(
      section.includes('ax-forward-learning: family'),
      'Forward learning should cite the §4 block by its marker',
    ).toBe(true);
    for (const edge of ['epic', 'parent', 'Follow-up from', 'sibling', 'named']) {
      expect(section.includes(edge), `Forward learning should name the ${edge} edge`).toBe(true);
    }
  });

  it('no auto-ship doc still describes forward learning as epic-only', () => {
    const docs = [
      SKILL_MD,
      GITHUB_PROJECT_MD,
      join(AUTO_SHIP, 'references', 'templates.md'),
      join(REPO_ROOT, '.claude', 'skills', 'yolo-ship', 'SKILL.md'),
    ];
    for (const f of docs) {
      const text = readFileSync(f, 'utf8');
      expect(/same-epic/i.test(text), `${f} still says "same-epic"`).toBe(false);
      expect(
        /sharing X's `epic:<slug>`/.test(text),
        `${f} still says "sharing X's \`epic:<slug>\`"`,
      ).toBe(false);
    }
  });
});
