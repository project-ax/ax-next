// Guard: the repo's living instruction docs must not assign to a zsh-tied variable.
//
// Why this exists (TASK-1032). CLAUDE.md's memory recipe was
//
//     path=$(scripts/memory-write-target.sh --shard decisions TASK-415)
//     mkdir -p "$(dirname "$path")"
//
// The Bash tool runs zsh, and in zsh the lowercase `path` is an array TIED to `PATH`.
// Assigning a string to it replaces the whole command search path, so the very next
// line dies with "command not found: dirname" / "mkdir", and so does every later
// command in that call. The recipe was copied verbatim into the claude-memory skill
// and into two plans, and agents hit it at least four times (TASK-696, TASK-816,
// TASK-951, TASK-1028) before anyone fixed the source. bash does not tie `path`,
// so the snippet looked fine to anyone reading it with bash in mind.
//
// The scan covers the docs agents copy shell from: CLAUDE.md (AGENTS.md is a
// symlink to it), every markdown file under .claude/skills/, and every agent
// definition under .claude/agents/. It looks only at lines that START with the
// assignment, which is how a runnable snippet writes it; prose that quotes the
// broken form inside backticks is not flagged. Historical plans and memory rows are
// out of scope: plans contain JSX `path=` props, and memory rows legitimately quote
// the broken form when they describe the bug (and may not be edited anyway).
//
// Lives in scripts/__tests__/, which CI's `pnpm test:scripts` runs unconditionally.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// zsh's lowercase special parameters that are tied to a colon-separated scalar
// (`path`/PATH, `fpath`/FPATH, …) or are otherwise special arrays. Assigning a
// string to any of them clobbers shell state instead of making a plain variable.
const ZSH_TIED = ['path', 'fpath', 'cdpath', 'manpath', 'module_path', 'mailpath', 'psvar'];

const ASSIGNMENT = new RegExp(
  String.raw`^\s*(?:export\s+|local\s+|typeset\s+|declare\s+)?(` +
    ZSH_TIED.join('|') +
    String.raw`)\+?=`,
);

/** Lines that assign to a zsh-tied variable, with 1-based line numbers. */
function findTiedAssignments(text) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ASSIGNMENT);
    if (m) hits.push({ line: i + 1, name: m[1], text: lines[i].trim() });
  }
  return hits;
}

function instructionDocs() {
  const out = execFileSync('git', ['ls-files', '-z', '.claude/skills', '.claude/agents'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return ['CLAUDE.md', ...out.split('\0').filter((f) => f.endsWith('.md'))];
}

function zshExists() {
  try {
    execFileSync('zsh', ['-c', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('instruction docs: no assignment to a zsh-tied variable', () => {
  const docs = instructionDocs();

  it('finds docs to scan (the scan must not be vacuous)', () => {
    expect(docs).toContain('CLAUDE.md');
    expect(docs).toContain('.claude/skills/claude-memory/SKILL.md');
    expect(docs).toContain('.claude/skills/yolo-ship/SKILL.md');
    expect(docs).toContain('.claude/agents/ax-planner.md');
  });

  it('never assigns to path, fpath, cdpath, manpath, module_path, mailpath or psvar', () => {
    const offenders = [];
    for (const rel of docs) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      for (const hit of findTiedAssignments(text)) {
        offenders.push(`${rel}:${hit.line}: ${hit.text}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the memory recipe in CLAUDE.md and the claude-memory skill uses `target`', () => {
    for (const rel of ['CLAUDE.md', '.claude/skills/claude-memory/SKILL.md']) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      expect(text, rel).toMatch(
        /^\s*target=\$\(scripts\/memory-write-target\.sh --shard decisions TASK-415\)\n\s*mkdir -p "\$\(dirname "\$target"\)"/m,
      );
    }
  });
});

describe('findTiedAssignments', () => {
  it('flags the original recipe line, indented or not', () => {
    expect(findTiedAssignments('path=$(scripts/memory-write-target.sh --shard x Y)')).toHaveLength(1);
    expect(findTiedAssignments('  path=$(echo x)')).toHaveLength(1);
  });

  it('flags export/local/typeset forms and +=', () => {
    expect(findTiedAssignments('export fpath=/x')).toHaveLength(1);
    expect(findTiedAssignments('local cdpath=/x')).toHaveLength(1);
    expect(findTiedAssignments('path+=/x')).toHaveLength(1);
  });

  it('does not flag the fixed name, longer names, uppercase PATH, or quoted prose', () => {
    expect(findTiedAssignments('target=$(scripts/memory-write-target.sh)')).toEqual([]);
    expect(findTiedAssignments('filepath=/x')).toEqual([]);
    expect(findTiedAssignments('path_to=/x')).toEqual([]);
    expect(findTiedAssignments('PATH="/opt/bin:$PATH" cmd')).toEqual([]);
    expect(findTiedAssignments('Never run `path=$(…)` under zsh.')).toEqual([]);
  });

  it('reports the line number', () => {
    expect(findTiedAssignments('a\nb\npath=x')[0]).toMatchObject({ line: 3, name: 'path' });
  });
});

describe('the zsh mechanism (why `path=` is banned)', () => {
  const run = (script) => {
    try {
      return { rc: 0, out: execFileSync('zsh', ['-c', script], { encoding: 'utf8', stdio: 'pipe' }) };
    } catch (err) {
      return { rc: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };

  it.skipIf(!zshExists())('assigning `path` wipes the command search path', () => {
    const r = run('path=$(echo /tmp/x/y.md); dirname "$path"');
    expect(r.rc).toBe(127);
    expect(r.out).toMatch(/command not found: dirname/);
  });

  it.skipIf(!zshExists())('the `target` form the docs now use works', () => {
    const r = run('target=$(echo /tmp/x/y.md); dirname "$target"');
    expect(r).toEqual({ rc: 0, out: '/tmp/x\n' });
  });
});
